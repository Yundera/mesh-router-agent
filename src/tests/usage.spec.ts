import { describe, it, afterEach } from "mocha";
import { expect } from "chai";
import { BlockList } from "node:net";
import { createSocket } from "node:dgram";
import { createServer, IncomingMessage, Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DailyAppSet,
  hostToApp,
  isInternal,
  isNavigation,
  parseAccessLine,
  AccessEntry,
} from "../services/UsageCollector.js";
import { UsageReporter, UsageState } from "../services/UsageReporter.js";

const CTX = { domain: "alice.nsl.sh", publicIpDash: "88-187-147-189" };
const NOW = new Date("2026-10-30T12:00:00Z");

/** A Caddy access-log line as `format filter { wrap json }` writes it. */
function line(over: { host?: string; status?: number; method?: string; ip?: string; headers?: Record<string, string[]>; ts?: number } = {}): string {
  return JSON.stringify({
    level: "info",
    ts: over.ts ?? NOW.getTime() / 1000,
    logger: "http.log.access",
    msg: "handled request",
    request: {
      remote_ip: "172.18.0.4",
      client_ip: over.ip ?? "203.0.113.7",
      proto: "HTTP/2.0",
      method: over.method ?? "GET",
      host: over.host ?? "nextcloud-alice.nsl.sh",
      uri: "/",
      headers: over.headers ?? { Accept: ["text/html,application/xhtml+xml"], "Sec-Fetch-Mode": ["navigate"] },
    },
    status: over.status ?? 200,
  });
}

function entry(over: Partial<AccessEntry>): AccessEntry {
  return { ts: 0, host: "x", method: "GET", status: 200, clientIp: "203.0.113.7", secFetchMode: "", accept: "", ...over };
}

function testNetworks(): BlockList {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("172.18.0.0", 16, "ipv4");
  return list;
}

describe("UsageCollector", () => {
  describe("parseAccessLine", () => {
    it("reads the fields of a Caddy access entry", () => {
      const e = parseAccessLine(line())!;
      expect(e.host).to.equal("nextcloud-alice.nsl.sh");
      expect(e.clientIp).to.equal("203.0.113.7");
      expect(e.secFetchMode).to.equal("navigate");
      expect(e.accept).to.contain("text/html");
      expect(e.status).to.equal(200);
    });

    it("falls back to remote_ip and ignores non-access lines", () => {
      const raw = JSON.parse(line());
      delete raw.request.client_ip;
      expect(parseAccessLine(JSON.stringify(raw))!.clientIp).to.equal("172.18.0.4");
      expect(parseAccessLine('{"level":"info","msg":"admin"}')).to.equal(null);
      expect(parseAccessLine("not json")).to.equal(null);
    });
  });

  describe("isNavigation", () => {
    it("counts a successful GET navigation", () => {
      expect(isNavigation(entry({ secFetchMode: "navigate" }))).to.equal(true);
      expect(isNavigation(entry({ accept: "text/html" }))).to.equal(true);
    });

    it("ignores sub-resources, API calls, redirects and errors", () => {
      expect(isNavigation(entry({ secFetchMode: "cors", accept: "text/html" }))).to.equal(false);
      expect(isNavigation(entry({ accept: "application/json" }))).to.equal(false);
      expect(isNavigation(entry({ secFetchMode: "navigate", status: 302 }))).to.equal(false);
      expect(isNavigation(entry({ secFetchMode: "navigate", status: 404 }))).to.equal(false);
      expect(isNavigation(entry({ secFetchMode: "navigate", method: "POST" }))).to.equal(false);
    });
  });

  describe("isInternal", () => {
    const local = testNetworks();
    it("treats the box's own networks as internal", () => {
      expect(isInternal("127.0.0.1", local)).to.equal(true);
      expect(isInternal("172.18.0.9", local)).to.equal(true);
      expect(isInternal("::ffff:172.18.0.9", local)).to.equal(true);
      expect(isInternal("", local)).to.equal(true);
    });

    it("keeps public and home-LAN visitors", () => {
      expect(isInternal("203.0.113.7", local)).to.equal(false);
      expect(isInternal("192.168.1.20", local)).to.equal(false);
      expect(isInternal("2001:db8::1", local)).to.equal(false);
    });
  });

  describe("hostToApp", () => {
    const cases: Array<[string, string | null]> = [
      ["alice.nsl.sh", "_root"],
      ["nextcloud-alice.nsl.sh", "nextcloud"],
      ["nextcloud.alice.nsl.sh", "nextcloud"],
      ["deep.nextcloud.alice.nsl.sh", "nextcloud"],
      ["NextCloud-Alice.nsl.sh:443", "nextcloud"],
      ["my-app-alice.nsl.sh", "my-app"],
      ["88-187-147-189.ip.nsl.sh", "_root"],
      ["jellyfin-88-187-147-189.ip.nsl.sh", "jellyfin"],
      ["jellyfin-88-187-147-189.sslip.io", "jellyfin"],
      ["jellyfin-10-0-0-1.sslip.io", "jellyfin"],
      ["88.187.147.189", "_root"],
      ["cloud.example.com", "_custom"],
      ["bad_name-alice.nsl.sh", null],
    ];
    for (const [host, app] of cases) {
      it(`${host} → ${app}`, () => {
        expect(hostToApp(host, CTX)).to.equal(app);
      });
    }

    it("still maps IP-encoded names before the domain is known", () => {
      expect(hostToApp("files-88-187-147-189.ip.nsl.sh", { domain: "", publicIpDash: "" })).to.equal("files");
    });
  });

  describe("DailyAppSet", () => {
    it("adds once per day and tracks what is pending", () => {
      const days = new DailyAppSet();
      expect(days.add("2026-10-30", "a")).to.equal(true);
      expect(days.add("2026-10-30", "a")).to.equal(false);
      days.add("2026-10-29", "b");
      expect(days.pendingDays().map((d) => d.date)).to.deep.equal(["2026-10-29", "2026-10-30"]);

      days.markSent("2026-10-30", ["a"]);
      expect(days.pendingDays().map((d) => d.date)).to.deep.equal(["2026-10-29"]);
    });

    it("stays pending when the day grew during a send", () => {
      const days = new DailyAppSet();
      days.add("2026-10-30", "a");
      days.add("2026-10-30", "b");
      days.markSent("2026-10-30", ["a"]);
      expect(days.pendingDays()).to.have.length(1);
    });

    it("keeps only today and yesterday", () => {
      const days = new DailyAppSet();
      days.add("2026-10-28", "old");
      days.add("2026-10-29", "y");
      days.add("2026-10-30", "t");
      days.prune("2026-10-30");
      expect(days.snapshot().map((d) => d.date)).to.deep.equal(["2026-10-29", "2026-10-30"]);
    });
  });
});

describe("UsageReporter", function () {
  this.timeout(10000);

  let backend: Server | null = null;
  let reporter: UsageReporter | null = null;
  let dir = "";

  afterEach(async () => {
    await reporter?.stop();
    reporter = null;
    if (backend) {
      await new Promise<void>((resolve) => backend!.close(() => resolve()));
      backend = null;
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  /** A stand-in backend recording what it receives. */
  async function startBackend(status: number, body = '{"recorded":1}'): Promise<{ url: string; requests: Array<{ path: string; body: any }> }> {
    const requests: Array<{ path: string; body: any }> = [];
    backend = createServer((req: IncomingMessage, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        requests.push({ path: req.url || "", body: JSON.parse(data || "{}") });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => backend!.listen(0, "127.0.0.1", () => resolve()));
    const addr = backend.address() as { port: number };
    return { url: `http://127.0.0.1:${addr.port}`, requests };
  }

  async function startReporter(backendUrl: string, enabled = true): Promise<UsageReporter> {
    dir = await mkdtemp(join(tmpdir(), "usage-"));
    reporter = new UsageReporter({
      provider: { backendUrl, userId: "u1", signature: "sig" },
      enabled,
      port: 0,
      intervalSeconds: 3600,
      statePath: join(dir, "state.json"),
      host: { ...CTX },
      local: testNetworks(),
      now: () => NOW,
    });
    await reporter.start();
    return reporter;
  }

  async function readState(): Promise<UsageState> {
    return JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  }

  it("collects datagrams and reports the day's apps", async () => {
    const be = await startBackend(200);
    const r = await startReporter(be.url);

    const sock = createSocket("udp4");
    const send = (msg: string) =>
      new Promise<void>((resolve) => sock.send(msg, r.port(), "127.0.0.1", () => resolve()));
    // A duplicate, two entries in one datagram, an internal probe, a sub-resource.
    await send(line({ host: "nextcloud-alice.nsl.sh" }) + "\n");
    await send(line({ host: "nextcloud-alice.nsl.sh" }));
    await send(line({ host: "jellyfin.alice.nsl.sh" }) + "\n" + line({ host: "probe-alice.nsl.sh", ip: "172.18.0.7" }));
    await send(line({ host: "api-alice.nsl.sh", headers: { "Sec-Fetch-Mode": ["cors"] } }));
    sock.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    await r.tick();
    expect(be.requests).to.have.length(1);
    expect(be.requests[0].path).to.equal("/router/api/usage/u1/sig");
    expect(be.requests[0].body).to.deep.equal({ date: "2026-10-30", apps: ["jellyfin", "nextcloud"] });

    // Nothing new: no second report.
    await r.tick();
    expect(be.requests).to.have.length(1);

    const state = await readState();
    expect(state.enabled).to.equal(true);
    expect(state.lastError).to.equal(null);
    expect(state.days).to.deep.equal([{ date: "2026-10-30", apps: ["jellyfin", "nextcloud"], pending: false }]);
  });

  it("keeps the apps and retries after a failure", async () => {
    const be = await startBackend(500, '{"error":"boom"}');
    const r = await startReporter(be.url);
    r.ingest(line());
    await r.tick();
    await r.tick();
    expect(be.requests).to.have.length(2);
    const state = await readState();
    expect(state.lastError).to.contain("HTTP 500");
    expect(state.days[0].pending).to.equal(true);
  });

  it("backs off when the backend has no usage endpoint", async () => {
    const be = await startBackend(404, "Cannot POST /router/api/usage/u1/sig");
    const r = await startReporter(be.url);
    r.ingest(line());
    await r.tick();
    await r.tick();
    expect(be.requests).to.have.length(1);
  });

  it("restores unsent days after a restart", async () => {
    const be = await startBackend(500);
    const r = await startReporter(be.url);
    r.ingest(line());
    await r.tick();
    await r.stop();

    const again = new UsageReporter({
      provider: { backendUrl: be.url, userId: "u1", signature: "sig" },
      enabled: true,
      port: 0,
      intervalSeconds: 3600,
      statePath: join(dir, "state.json"),
      host: { ...CTX },
      local: testNetworks(),
      now: () => NOW,
    });
    reporter = again;
    await again.start();
    await again.tick();
    expect(be.requests).to.have.length(2);
    expect(be.requests[1].body.apps).to.deep.equal(["nextcloud"]);
  });

  it("does not listen or send when disabled", async () => {
    const be = await startBackend(200);
    const r = await startReporter(be.url, false);
    r.ingest(line());
    await r.tick();
    expect(be.requests).to.have.length(0);
    const state = await readState();
    expect(state.enabled).to.equal(false);
    expect(state.days).to.deep.equal([]);
  });
});
