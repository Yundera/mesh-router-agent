import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Usage (DAU) collection from the box's Caddy access log.
 *
 * mesh-router-caddy streams its access log (JSON, one entry per line) to the agent.
 * The KPI is "a box where someone opened app X today", so each entry is reduced to
 * one question: was this a person opening a page of app X? Everything here is pure
 * so it can be tested without a socket or a backend; UsageReporter does the I/O.
 */

/** The fields of a Caddy access-log entry this module reads. */
export interface AccessEntry {
  /** Unix seconds (Caddy `ts`) */
  ts: number;
  host: string;
  method: string;
  status: number;
  /** Real client: Caddy resolves PROXY v2 / X-Forwarded-For from the gateways and tunnel */
  clientIp: string;
  secFetchMode: string;
  accept: string;
}

/** What the box knows about its own names, to turn a host into an app. */
export interface HostContext {
  /** The box's domain, e.g. alice.nsl.sh (empty = unknown yet) */
  domain: string;
  /** The box's public IP in dashed form, e.g. 88-187-147-189 (empty = unknown) */
  publicIpDash: string;
}

/** App names the backend accepts: a host label, or `_root` / `_custom`. */
const APP_NAME = /^[a-z0-9_][a-z0-9-]{0,62}$/;

/** `<app>-<a-b-c-d>.<zone>` or `<a-b-c-d>.<zone>` (ip.<zone> and sslip.io names). */
const IPV4_DASH_NAME = /^(?:(.+)-)?(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\.[^.]+(?:\.[^.]+)*$/;

function header(headers: unknown, name: string): string {
  if (!headers || typeof headers !== 'object') {
    return '';
  }
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === want) {
      return Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
  }
  return '';
}

/**
 * Parse one access-log line. Returns null for anything that is not a Caddy access
 * entry (other loggers, partial lines, garbage).
 */
export function parseAccessLine(line: string): AccessEntry | null {
  let raw: any;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const req = raw?.request;
  if (!req || typeof req !== 'object' || typeof req.host !== 'string') {
    return null;
  }
  return {
    ts: typeof raw.ts === 'number' ? raw.ts : Date.now() / 1000,
    host: req.host,
    method: String(req.method || ''),
    status: typeof raw.status === 'number' ? raw.status : 0,
    clientIp: String(req.client_ip || req.remote_ip || ''),
    secFetchMode: header(req.headers, 'Sec-Fetch-Mode'),
    accept: header(req.headers, 'Accept'),
  };
}

/**
 * A person opening a page: a successful GET navigation. Browsers send
 * Sec-Fetch-Mode: navigate for those; without the header (old clients), fall back to
 * the edge worker's old test, an Accept that asks for HTML. Only 2xx counts: a
 * scanner on a gated app gets a redirect to the login page, not the app.
 */
export function isNavigation(entry: AccessEntry): boolean {
  if (entry.method !== 'GET' || entry.status < 200 || entry.status > 299) {
    return false;
  }
  if (entry.secFetchMode) {
    return entry.secFetchMode.toLowerCase() === 'navigate';
  }
  return entry.accept.toLowerCase().includes('text/html');
}

/**
 * The networks the box's own traffic comes from: loopback and every subnet the agent
 * sits on (the docker networks, so the admin app's runners, mesh-console's probes or
 * an audit tool on the box are not visitors). Private ranges in general are NOT
 * internal: a box at home is used from the LAN.
 */
export function localNetworks(): BlockList {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addAddress('::1', 'ipv6');
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs || []) {
      if (!addr.cidr) {
        continue;
      }
      const [network, prefix] = addr.cidr.split('/');
      const family = addr.family === 'IPv6' ? 'ipv6' : 'ipv4';
      // Link-local v6 (fe80::/10) carries a zone id; the subnet is the same everywhere.
      list.addSubnet(network.split('%')[0], parseInt(prefix, 10), family);
    }
  }
  return list;
}

/** Whether a client address belongs to the box itself. Unparseable counts as internal. */
export function isInternal(ip: string, local: BlockList): boolean {
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(addr);
  if (family === 0) {
    return true;
  }
  return local.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Turn a request host into the app it belongs to.
 *   <domain>, a bare IP               → _root
 *   <app>-<domain>, <app>.<domain>    → app  (dash and dot forms)
 *   <a-b-c-d>.<zone>                  → _root (ip.<zone>, sslip.io)
 *   <app>-<a-b-c-d>.<zone>            → app
 *   anything else (custom domains)    → _custom
 * Returns null for a name that cannot be an app (dropped, not reported).
 */
export function hostToApp(rawHost: string, ctx: HostContext): string | null {
  const host = rawHost.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host) {
    return null;
  }
  const domain = ctx.domain.toLowerCase();
  let app: string | undefined;

  if ((domain && host === domain) || isIP(host.replace(/^\[|\]$/g, ''))) {
    return '_root';
  }
  if (domain && host.endsWith(`.${domain}`)) {
    // Dot form; a deeper name (x.app.<domain>) belongs to its nearest label.
    const prefix = host.slice(0, -domain.length - 1);
    app = prefix.slice(prefix.lastIndexOf('.') + 1);
  } else if (domain && host.endsWith(`-${domain}`) && !host.slice(0, -domain.length - 1).includes('.')) {
    app = host.slice(0, -domain.length - 1);
  } else if (ctx.publicIpDash && host.startsWith(`${ctx.publicIpDash}.`)) {
    return '_root';
  } else if (ctx.publicIpDash && host.includes(`-${ctx.publicIpDash}.`)) {
    app = host.slice(0, host.indexOf(`-${ctx.publicIpDash}.`));
  } else {
    const m = IPV4_DASH_NAME.exec(host);
    if (m) {
      if (!m[1]) {
        return '_root';
      }
      app = m[1];
    } else {
      return '_custom';
    }
  }
  return app && APP_NAME.test(app) ? app : null;
}

/** UTC calendar day (YYYY-MM-DD) of a Unix-seconds timestamp. */
export function utcDay(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().slice(0, 10);
}

/** One day's apps and whether the backend already has all of them. */
export interface DaySet {
  date: string;
  apps: string[];
  /** true = changed since the last successful report */
  pending: boolean;
}

/**
 * The apps opened per UTC day. Only today and yesterday are kept: the backend
 * accepts nothing older, and yesterday is there for the report sent after midnight.
 */
export class DailyAppSet {
  private days = new Map<string, { apps: Set<string>; pending: boolean }>();

  /** Add an app to a day. Returns true when it was new for that day. */
  add(date: string, app: string): boolean {
    let day = this.days.get(date);
    if (!day) {
      day = { apps: new Set(), pending: false };
      this.days.set(date, day);
    }
    if (day.apps.has(app)) {
      return false;
    }
    day.apps.add(app);
    day.pending = true;
    return true;
  }

  /** Drop every day other than `today` and the day before it. */
  prune(today: string): void {
    const yesterday = utcDay(Date.parse(`${today}T00:00:00Z`) / 1000 - 86400);
    for (const date of this.days.keys()) {
      if (date !== today && date !== yesterday) {
        this.days.delete(date);
      }
    }
  }

  /** Days with apps the backend has not acknowledged, oldest first. */
  pendingDays(): DaySet[] {
    return this.snapshot().filter((d) => d.pending);
  }

  /** Mark a day reported, unless it grew again with apps not in `sent`. */
  markSent(date: string, sent: string[]): void {
    const day = this.days.get(date);
    if (day && [...day.apps].every((app) => sent.includes(app))) {
      day.pending = false;
    }
  }

  /** Every kept day, oldest first. */
  snapshot(): DaySet[] {
    return [...this.days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => ({ date, apps: [...day.apps].sort(), pending: day.pending }));
  }

  /** Restore days saved by a previous run (state file). */
  restore(days: DaySet[]): void {
    for (const d of days) {
      if (typeof d?.date !== 'string' || !Array.isArray(d.apps)) {
        continue;
      }
      const apps = d.apps.filter((a) => typeof a === 'string' && APP_NAME.test(a));
      this.days.set(d.date, { apps: new Set(apps), pending: d.pending !== false && apps.length > 0 });
    }
  }
}
