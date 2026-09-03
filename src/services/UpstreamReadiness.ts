import tls from 'node:tls';

/**
 * Readiness gate between "we have a certificate" and "we tell the backend we
 * are reachable".
 *
 * WHY THIS EXISTS. Registering a route is a claim: "traffic sent to
 * <ip>.nip.io:443 will be served, with a certificate that chains to the mesh
 * CA". The backend does not take that on trust — it connects to the address
 * and validates the presented chain against the CA (mesh-router-backend
 * RouteValidator), and if the connection is refused it rejects the route.
 *
 * On a PCS the thing that actually serves :443 is mesh-router-caddy, which is
 * a SIBLING container, and docker-compose starts it AFTER this agent —
 * `mesh-router-caddy` declares `depends_on: mesh-router-agent` because it
 * mounts the certificate this agent writes. So on every stack recreate the
 * process that announces the endpoint starts before the process that serves
 * it. Without a gate, whether registration succeeds comes down to which side
 * of caddy's ~1-2s bind window the announcement lands on.
 *
 * That is not hypothetical. On 2026-09-02 a demo PCS lost the race by roughly
 * 0.9 seconds:
 *
 *   15:04:31.218  Container mesh-router-caddy Started
 *   15:04:32.324  ✗ REJECT agent/https 185-194-219-244.nip.io - Connection refused
 *
 * and because every route was rejected the backend answers 400 ("All routes
 * failed validation"), which this agent treats as an initialization failure and
 * follows with a 600s ERROR_RETRY_INTERVAL sleep. Ten minutes of tunnel-only
 * routing out of a one-second window — and, that day, a failed provision.
 *
 * WHY A TLS PROBE AND NOT A TCP CONNECT. A plain connect proves something is
 * listening, which is strictly weaker than what the backend checks. Caddy
 * answering :443 with its own auto-TLS certificate — before it has loaded the
 * mesh cert — would satisfy a TCP probe and still be rejected downstream. So
 * the probe verifies the same predicate the validator does: a full handshake,
 * chain pinned to the mesh CA, hostname checked against the SNI name we are
 * about to register.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. This runs inside the `pcs` docker
 * network, so it exercises caddy but not the host port publish, the host
 * firewall, or public DNS. Those are stable across a container lifecycle and
 * are not the flapping component; probing the real public URL would cover them
 * but depends on the box being able to hairpin to its own public IP, which
 * would time out on every start where it cannot. The narrower check removes the
 * observed failure mode without introducing a new one.
 *
 * The gate is an optimisation, never a veto: see waitForUpstreamTls.
 */

/** Outcome of a single handshake attempt. */
export interface ProbeResult {
    ok: boolean;
    error?: string;
}

export interface WaitOptions {
    /** Host serving the TLS port — the caddy container, not localhost. */
    host: string;
    port: number;
    /** SNI to present; the presented certificate must be valid for this name. */
    serverName: string;
    /** PEM of the mesh CA. Passing it makes it the ONLY trust anchor. */
    caCertificate: string;
    /** Total budget. The caller decides what to do when it runs out. */
    timeoutMs: number;
    /** Delay between attempts. */
    intervalMs: number;
    /** Per-attempt cap, so one hung connect cannot eat the whole budget. */
    connectTimeoutMs?: number;
}

export interface WaitResult {
    ready: boolean;
    attempts: number;
    elapsedMs: number;
    lastError?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** How often to say something while waiting, so a long wait is not a silent hang. */
const PROGRESS_NOTICE_MS = 10000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One TLS handshake against the upstream. Resolves — never rejects — so the
 * caller's loop stays simple and no failure mode can escape as an exception.
 */
export function probeTlsOnce(opts: WaitOptions): Promise<ProbeResult> {
    const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise((resolve) => {
        const socket = tls.connect({
            host: opts.host,
            port: opts.port,
            servername: opts.serverName,
            ca: opts.caCertificate,
            // The whole point: chain + hostname must satisfy the same rules the
            // backend's validator applies. A failure here surfaces as 'error'.
            rejectUnauthorized: true,
        });

        let settled = false;
        const finish = (result: ProbeResult): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(connectTimeoutMs);

        socket.on('secureConnect', () => {
            if (socket.authorized) {
                finish({ ok: true });
                return;
            }
            finish({ ok: false, error: socket.authorizationError?.message ?? 'certificate not authorized' });
        });
        socket.on('timeout', () => finish({ ok: false, error: `handshake timed out after ${connectTimeoutMs}ms` }));
        socket.on('error', (err: Error) => finish({ ok: false, error: err.message }));
    });
}

/**
 * Poll until the upstream serves a certificate we would be happy to advertise,
 * or the budget runs out.
 *
 * Returning `ready: false` is NOT an error and must not be treated as one. A
 * readiness gate that can deny the thing it gates converts a timing bug into a
 * hard outage — a box that never announces itself is far worse than one that
 * announces a second early. The caller registers regardless; on timeout the
 * behaviour is exactly what it was before this gate existed.
 */
export async function waitForUpstreamTls(
    opts: WaitOptions,
    log: (message: string) => void = console.log,
): Promise<WaitResult> {
    const start = Date.now();
    const deadline = start + opts.timeoutMs;
    let attempts = 0;
    let lastError: string | undefined;
    let nextNoticeAt = start + PROGRESS_NOTICE_MS;

    for (;;) {
        attempts += 1;
        const probe = await probeTlsOnce(opts);
        if (probe.ok) {
            return { ready: true, attempts, elapsedMs: Date.now() - start };
        }
        lastError = probe.error;

        const now = Date.now();
        if (now >= deadline) {
            return { ready: false, attempts, elapsedMs: now - start, lastError };
        }

        if (now >= nextNoticeAt) {
            log(
                `[Readiness] still waiting for ${opts.serverName} via ${opts.host}:${opts.port} ` +
                `after ${Math.round((now - start) / 1000)}s (last error: ${lastError})`,
            );
            nextNoticeAt = now + PROGRESS_NOTICE_MS;
        }

        await sleep(Math.min(opts.intervalMs, Math.max(0, deadline - now)));
    }
}
