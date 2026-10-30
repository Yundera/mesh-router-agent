import dotenv from 'dotenv';
dotenv.config();

export interface ProviderConfig {
  backendUrl: string;
  userId: string;
  signature: string;
}

interface EnvConfig {
  /** Provider connection string: <backend_url>,<userid>,<signature> */
  PROVIDER: string;
  /** Public IP to register (empty = auto-detect) */
  PUBLIC_IP: string;
  /** Target port for HTTPS traffic (default: 443) */
  TARGET_PORT_HTTPS: number;
  /** Target port for HTTP traffic (default: 80) */
  TARGET_PORT_HTTP: number;
  /** @deprecated Use TARGET_PORT_HTTPS instead. Kept for backward compat. */
  TARGET_PORT: number;
  /** Route priority (lower = higher priority, default: 1 for direct connection) */
  ROUTE_PRIORITY: number;
  /**
   * Zone served by the mesh-router-nameserver (e.g. ip.nsl.sh) the box registers its
   * <ip-dashed>.<IP_ZONE> domain routes on. Empty = the zone the backend publishes in
   * /router/api/version; with neither, no direct route is registered.
   */
  IP_ZONE: string;
  /** Route refresh interval in seconds (default: 300 = 5 minutes) */
  REFRESH_INTERVAL: number;
  // Legacy: kept for backward compatibility, use REFRESH_INTERVAL instead
  /** @deprecated Use REFRESH_INTERVAL instead */
  HEARTBEAT_INTERVAL: number;
  /** Path to store the agent's private key (default: ./data/key.pem) */
  CERT_KEY_PATH: string;
  /** Path to store the agent's certificate (default: ./data/cert.pem) */
  CERT_PATH: string;
  /** Path to store the CA certificate (default: ./data/ca-cert.pem) */
  CA_CERT_PATH: string;
  /** Retry interval in seconds when initialization fails (default: 600 = 10 minutes) */
  ERROR_RETRY_INTERVAL: number;
  /**
   * Host serving TARGET_PORT_HTTPS on the local stack — the reverse proxy this
   * agent is advertising, reached over the shared docker network (NOT
   * localhost: the agent has its own network namespace).
   */
  TARGET_HOST: string;
  /**
   * How long to wait for that host to serve our certificate before registering
   * routes, in seconds (default: 120). 0 disables the wait entirely and
   * restores the pre-gate behaviour. Timing out is not fatal — see
   * UpstreamReadiness.waitForUpstreamTls.
   */
  READINESS_TIMEOUT: number;
  /** Delay between readiness probes in seconds (default: 2) */
  READINESS_INTERVAL: number;
  /**
   * Usage (DAU) reporting: `on` (default) or `off`. On, the agent reads Caddy's access
   * log on USAGE_LOG_PORT (UDP) and reports the apps opened per day to the backend.
   */
  MESH_USAGE_REPORT: 'on' | 'off';
  /** UDP port Caddy's access log is streamed to (default: 5140) */
  USAGE_LOG_PORT: number;
  /** Seconds between usage reports; a report is sent only when the day's set grew (default: 300) */
  USAGE_REPORT_INTERVAL: number;
  /** Usage state file, read by mesh-console (default: ./usage/state.json) */
  USAGE_STATE_PATH: string;
  /**
   * The box's domain (e.g. alice.nsl.sh), to tell which app a request was for. Empty =
   * learnt from the backend's answer to route registration.
   */
  DOMAIN: string;
}

// Parse TARGET_PORT with backward compat: TARGET_PORT defaults to TARGET_PORT_HTTPS
const legacyTargetPort = process.env.TARGET_PORT ? parseInt(process.env.TARGET_PORT, 10) : null;

export const config: EnvConfig = {
  PROVIDER: process.env.PROVIDER || '',
  PUBLIC_IP: process.env.PUBLIC_IP || '',
  // New dual-port config
  TARGET_PORT_HTTPS: parseInt(process.env.TARGET_PORT_HTTPS || '443', 10),
  TARGET_PORT_HTTP: parseInt(process.env.TARGET_PORT_HTTP || '80', 10),
  // Legacy: TARGET_PORT defaults to TARGET_PORT_HTTPS value for backward compat
  TARGET_PORT: legacyTargetPort ?? parseInt(process.env.TARGET_PORT_HTTPS || '443', 10),
  ROUTE_PRIORITY: parseInt(process.env.ROUTE_PRIORITY || '1', 10),
  IP_ZONE: (process.env.IP_ZONE || '').trim(),
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || process.env.HEARTBEAT_INTERVAL || '300', 10),
  // Legacy support
  HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL || '300', 10),
  // Certificate paths
  CERT_KEY_PATH: process.env.CERT_KEY_PATH || './data/key.pem',
  CERT_PATH: process.env.CERT_PATH || './data/cert.pem',
  CA_CERT_PATH: process.env.CA_CERT_PATH || './data/ca-cert.pem',
  // Retry interval on errors
  ERROR_RETRY_INTERVAL: parseInt(process.env.ERROR_RETRY_INTERVAL || '600', 10),
  // Upstream readiness gate
  TARGET_HOST: process.env.TARGET_HOST || 'mesh-router-caddy',
  READINESS_TIMEOUT: parseInt(process.env.READINESS_TIMEOUT || '120', 10),
  READINESS_INTERVAL: parseInt(process.env.READINESS_INTERVAL || '2', 10),
  // Usage (DAU) reporting; anything but "off" is on
  MESH_USAGE_REPORT: (process.env.MESH_USAGE_REPORT || '').trim().toLowerCase() === 'off' ? 'off' : 'on',
  USAGE_LOG_PORT: parseInt(process.env.USAGE_LOG_PORT || '5140', 10),
  USAGE_REPORT_INTERVAL: parseInt(process.env.USAGE_REPORT_INTERVAL || '300', 10),
  USAGE_STATE_PATH: process.env.USAGE_STATE_PATH || './usage/state.json',
  DOMAIN: (process.env.DOMAIN || '').trim().toLowerCase(),
};

/**
 * Parse the PROVIDER connection string into its components
 * Format: <backend_url>,<userid>,<signature>
 */
export function parseProvider(providerString: string): ProviderConfig {
  const [backendUrl, userId, signature] = providerString.split(',');

  if (!backendUrl || !userId || !signature) {
    throw new Error(
      'Invalid PROVIDER format. Expected: <backend_url>,<userid>,<signature>'
    );
  }

  if (!backendUrl.startsWith('http')) {
    throw new Error('PROVIDER backend_url must start with http:// or https://');
  }

  return { backendUrl, userId, signature };
}
