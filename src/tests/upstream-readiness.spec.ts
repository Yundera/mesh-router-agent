import { describe, it, before, afterEach } from "mocha";
import { expect } from "chai";
import forge from "node-forge";
import net from "node:net";
import tls from "node:tls";

import { probeTlsOnce, waitForUpstreamTls, WaitOptions } from "../services/UpstreamReadiness.js";

/**
 * The readiness gate has to answer one question correctly: "would the backend
 * accept this route right now?" The backend answers it by completing a TLS
 * handshake and validating the chain against the mesh CA, so these tests use a
 * real TLS server and a real CA rather than stubbing the probe out — a mocked
 * handshake would not catch the two ways this can silently pass when it should
 * fail (trusting the wrong CA, skipping the hostname check).
 */

/** The name the agent would register — an ip-dash nip.io host. */
const SERVER_NAME = "203-0-113-10.nip.io";

interface Pki {
    caPem: string;
    keyPem: string;
    certPem: string;
}

function buildPki(serverName: string): Pki {
    const caKeys = forge.pki.rsa.generateKeyPair(2048);
    const caAttrs = [{ name: "commonName", value: "test-mesh-ca" }];
    const caCert = forge.pki.createCertificate();
    caCert.publicKey = caKeys.publicKey;
    caCert.serialNumber = "01";
    caCert.validity.notBefore = new Date(Date.now() - 3600_000);
    caCert.validity.notAfter = new Date(Date.now() + 3600_000);
    caCert.setSubject(caAttrs);
    caCert.setIssuer(caAttrs);
    caCert.setExtensions([
        { name: "basicConstraints", cA: true },
        { name: "keyUsage", keyCertSign: true, digitalSignature: true },
    ]);
    caCert.sign(caKeys.privateKey, forge.md.sha256.create());

    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    const leaf = forge.pki.createCertificate();
    leaf.publicKey = leafKeys.publicKey;
    leaf.serialNumber = "02";
    leaf.validity.notBefore = new Date(Date.now() - 3600_000);
    leaf.validity.notAfter = new Date(Date.now() + 3600_000);
    leaf.setSubject([{ name: "commonName", value: serverName }]);
    leaf.setIssuer(caAttrs);
    leaf.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        // type 2 = dNSName
        { name: "subjectAltName", altNames: [{ type: 2, value: serverName }] },
    ]);
    leaf.sign(caKeys.privateKey, forge.md.sha256.create());

    return {
        caPem: forge.pki.certificateToPem(caCert),
        keyPem: forge.pki.privateKeyToPem(leafKeys.privateKey),
        certPem: forge.pki.certificateToPem(leaf),
    };
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const port = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolve(port));
        });
    });
}

function startTlsServer(pki: Pki, port: number): Promise<tls.Server> {
    return new Promise((resolve, reject) => {
        const server = tls.createServer({ key: pki.keyPem, cert: pki.certPem }, (socket) => socket.end());
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => resolve(server));
    });
}

function closeServer(server: tls.Server | null): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
}

describe("UpstreamReadiness", () => {
    let pki: Pki;
    let otherCaPem: string;
    let server: tls.Server | null = null;

    before(function () {
        // Two 2048-bit keypairs in software; generated once and reused.
        this.timeout(120_000);
        pki = buildPki(SERVER_NAME);
        otherCaPem = buildPki("someone-else.nip.io").caPem;
    });

    afterEach(async () => {
        await closeServer(server);
        server = null;
    });

    function baseOptions(port: number): WaitOptions {
        return {
            host: "127.0.0.1",
            port,
            serverName: SERVER_NAME,
            caCertificate: pki.caPem,
            timeoutMs: 5000,
            intervalMs: 100,
            connectTimeoutMs: 2000,
        };
    }

    describe("probeTlsOnce", () => {
        it("accepts a server presenting a certificate signed by the mesh CA", async () => {
            const port = await freePort();
            server = await startTlsServer(pki, port);

            const result = await probeTlsOnce(baseOptions(port));

            expect(result.ok).to.equal(true);
            expect(result.error).to.equal(undefined);
        });

        it("rejects a certificate that does not chain to the supplied CA", async () => {
            const port = await freePort();
            server = await startTlsServer(pki, port);

            // Same server, but we only trust an unrelated CA — this is the case
            // where caddy is up and serving its own auto-TLS cert. A TCP-connect
            // probe would call that ready; the backend would still reject it.
            const result = await probeTlsOnce({ ...baseOptions(port), caCertificate: otherCaPem });

            expect(result.ok).to.equal(false);
            expect(result.error).to.be.a("string");
        });

        it("rejects when the certificate is not valid for the name being registered", async () => {
            const port = await freePort();
            server = await startTlsServer(pki, port);

            const result = await probeTlsOnce({ ...baseOptions(port), serverName: "198-51-100-7.nip.io" });

            expect(result.ok).to.equal(false);
            expect(result.error).to.be.a("string");
        });

        it("reports connection refused rather than throwing", async () => {
            const port = await freePort(); // nothing listening

            const result = await probeTlsOnce(baseOptions(port));

            expect(result.ok).to.equal(false);
            expect(result.error).to.be.a("string");
        });
    });

    describe("waitForUpstreamTls", () => {
        it("gives up within its budget instead of hanging or throwing", async () => {
            const port = await freePort(); // nothing will ever listen
            const started = Date.now();

            const result = await waitForUpstreamTls(
                { ...baseOptions(port), timeoutMs: 600, intervalMs: 100 },
                () => undefined,
            );

            expect(result.ready).to.equal(false);
            expect(result.attempts).to.be.greaterThan(0);
            expect(result.lastError).to.be.a("string");
            // Bounded: a caller relying on this to be non-fatal also relies on it
            // returning near its deadline rather than drifting.
            expect(Date.now() - started).to.be.lessThan(5000);
        });

        it("returns immediately when the upstream is already serving", async () => {
            const port = await freePort();
            server = await startTlsServer(pki, port);

            const result = await waitForUpstreamTls(baseOptions(port), () => undefined);

            expect(result.ready).to.equal(true);
            expect(result.attempts).to.equal(1);
        });

        it("waits out an upstream that binds late — the demostaging1 race", async function () {
            this.timeout(20_000);
            const port = await freePort();

            // The agent starts probing while nothing is listening, exactly as it
            // does when compose has started it ahead of caddy. Caddy binds ~1.2s
            // later — the margin that decided the 2026-09-02 provisioning failure.
            const bindDelayMs = 1200;
            const pending = waitForUpstreamTls(
                { ...baseOptions(port), timeoutMs: 15_000, intervalMs: 100 },
                () => undefined,
            );
            setTimeout(() => {
                void startTlsServer(pki, port).then((s) => {
                    server = s;
                });
            }, bindDelayMs);

            const result = await pending;

            expect(result.ready).to.equal(true);
            expect(result.attempts).to.be.greaterThan(1);
            expect(result.elapsedMs).to.be.greaterThanOrEqual(bindDelayMs - 100);
        });
    });
});
