import { createSocket, Socket } from 'node:dgram';
import { BlockList } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProviderConfig } from '../config/EnvConfig.js';
import {
  DailyAppSet,
  DaySet,
  HostContext,
  hostToApp,
  isInternal,
  isNavigation,
  localNetworks,
  parseAccessLine,
  utcDay,
} from './UsageCollector.js';

/** HTTP request timeout in milliseconds */
const HTTP_TIMEOUT = 10000;
/** Wait before trying again after the backend answered 404 (it has no usage endpoint). */
const NO_ENDPOINT_BACKOFF_MS = 60 * 60 * 1000;

export interface UsageReporterOptions {
  provider: ProviderConfig;
  /** false = do not listen, do not send; the state file says so */
  enabled: boolean;
  /** UDP port Caddy's `output net udp/…` writes to (0 = pick one, for tests) */
  port: number;
  /** Seconds between report attempts */
  intervalSeconds: number;
  /** Where the state is kept (read by mesh-console, reloaded at start) */
  statePath: string;
  host: HostContext;
  /** Override for tests; default = the agent's own networks */
  local?: BlockList;
  /** Override for tests */
  now?: () => Date;
}

/** What mesh-console shows, and what a restart picks up again. */
export interface UsageState {
  enabled: boolean;
  days: DaySet[];
  lastSentAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

export type ReportOutcome = 'sent' | 'rejected' | 'no-endpoint' | 'failed';

/**
 * POST one day's apps to the backend, signed like route registration.
 * POST /router/api/usage/:userid/:sig { date, apps }
 */
export async function postUsage(
  provider: ProviderConfig,
  day: { date: string; apps: string[] },
): Promise<{ outcome: ReportOutcome; error?: string }> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/router/api/usage/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: day.date, apps: day.apps }),
      signal: controller.signal,
    });
    if (response.ok) {
      return { outcome: 'sent' };
    }
    const body = await response.text().catch(() => '');
    const error = `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
    if (response.status === 404 && !body.includes('User not found')) {
      return { outcome: 'no-endpoint', error };
    }
    // 400/413: this day can never be accepted as it is (too old, malformed).
    if (response.status === 400 || response.status === 413) {
      return { outcome: 'rejected', error };
    }
    return { outcome: 'failed', error };
  } catch (error) {
    return { outcome: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collects "app opened" signals from Caddy's access log and reports them.
 *
 * Runs on its own timer, independent of route registration: a box whose agent never
 * gets a direct route (behind NAT) is used all the same and must still report.
 */
export class UsageReporter {
  private readonly days = new DailyAppSet();
  private readonly local: BlockList;
  private readonly now: () => Date;
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private notBefore = 0;
  private lastSentAt: string | null = null;
  private lastError: string | null = null;
  private dirty = false;

  constructor(private readonly opts: UsageReporterOptions) {
    this.local = opts.local ?? localNetworks();
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Update what the box knows about its names. The domain learnt from route
   * registration only fills a gap: DOMAIN from the env wins.
   */
  setHostContext(host: Partial<HostContext>): void {
    if (host.domain && !this.opts.host.domain) {
      this.opts.host.domain = host.domain;
    }
    if (host.publicIpDash) {
      this.opts.host.publicIpDash = host.publicIpDash;
    }
  }

  /** Start listening and reporting. Resolves once the listener is bound. */
  async start(): Promise<void> {
    if (!this.opts.enabled) {
      console.log('[Usage] Reporting disabled (MESH_USAGE_REPORT=off)');
      await this.saveState();
      return;
    }
    await this.loadState();
    await this.listen();
    this.timer = setInterval(() => void this.tick(), this.opts.intervalSeconds * 1000);
    this.timer.unref();
    console.log(`[Usage] Listening for access logs on udp/${this.port()}, reporting every ${this.opts.intervalSeconds}s`);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  }

  /** The bound port (useful when started with port 0). */
  port(): number {
    return this.socket ? this.socket.address().port : this.opts.port;
  }

  /** Feed one access-log line. Returns true when it added an app to a day. */
  ingest(line: string): boolean {
    const entry = parseAccessLine(line);
    if (!entry || !isNavigation(entry) || isInternal(entry.clientIp, this.local)) {
      return false;
    }
    const app = hostToApp(entry.host, this.opts.host);
    if (!app) {
      return false;
    }
    // The box's clock names the day; an entry stamped far off it is not trusted.
    const today = utcDay(this.now().getTime() / 1000);
    const day = Math.abs(entry.ts * 1000 - this.now().getTime()) < 36 * 3600 * 1000 ? utcDay(entry.ts) : today;
    const added = this.days.add(day, app);
    if (added) {
      this.dirty = true;
    }
    return added;
  }

  /** One report pass: send every day with apps the backend has not acknowledged. */
  async tick(): Promise<void> {
    if (!this.opts.enabled || this.sending || this.now().getTime() < this.notBefore) {
      return;
    }
    this.sending = true;
    try {
      this.days.prune(utcDay(this.now().getTime() / 1000));
      for (const day of this.days.pendingDays()) {
        const { outcome, error } = await postUsage(this.opts.provider, day);
        if (outcome === 'sent' || outcome === 'rejected') {
          this.days.markSent(day.date, day.apps);
        }
        if (outcome === 'sent') {
          this.lastSentAt = this.now().toISOString();
          this.lastError = null;
          console.log(`[Usage] Reported ${day.apps.length} app(s) for ${day.date}`);
        } else {
          this.lastError = error ?? outcome;
          console.warn(`[Usage] Report for ${day.date} ${outcome}: ${this.lastError}`);
        }
        if (outcome === 'no-endpoint') {
          // An older backend: try again in an hour, keep the apps.
          this.notBefore = this.now().getTime() + NO_ENDPOINT_BACKOFF_MS;
          break;
        }
        if (outcome === 'failed') {
          break;
        }
      }
      this.dirty = true;
    } finally {
      this.sending = false;
      if (this.dirty) {
        await this.saveState();
      }
    }
  }

  /** The current state, as written to the state file. */
  state(): UsageState {
    return {
      enabled: this.opts.enabled,
      days: this.opts.enabled ? this.days.snapshot() : [],
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
      updatedAt: this.now().toISOString(),
    };
  }

  /**
   * UDP, one access entry per datagram (Caddy writes each entry in one write). Not TCP
   * on purpose: Caddy's net writer dumps every entry it cannot deliver to stderr, and a
   * stalled TCP reader would block its logging. A datagram to a stopped agent is just
   * lost, and losing one costs nothing (an app counts once per day).
   */
  private async listen(): Promise<void> {
    const socket = createSocket('udp4');
    socket.on('message', (msg) => {
      for (const line of msg.toString('utf8').split('\n')) {
        if (line) {
          this.ingest(line);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.opts.port, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    socket.on('error', (err) => console.warn(`[Usage] Listener error: ${err.message}`));
    this.socket = socket;
  }

  private async loadState(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.opts.statePath, 'utf8')) as Partial<UsageState>;
      this.days.restore(Array.isArray(saved.days) ? saved.days : []);
      this.days.prune(utcDay(this.now().getTime() / 1000));
      this.lastSentAt = typeof saved.lastSentAt === 'string' ? saved.lastSentAt : null;
    } catch {
      // No state yet (first start) or unreadable: start empty.
    }
  }

  private async saveState(): Promise<void> {
    this.dirty = false;
    try {
      await mkdir(dirname(this.opts.statePath), { recursive: true });
      const tmp = `${this.opts.statePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.state(), null, 2)}\n`);
      await rename(tmp, this.opts.statePath);
    } catch (error) {
      console.warn(`[Usage] Could not write ${this.opts.statePath}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
