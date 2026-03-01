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
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || process.env.HEARTBEAT_INTERVAL || '300', 10),
  // Legacy support
  HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL || '300', 10),
  // Certificate paths
  CERT_KEY_PATH: process.env.CERT_KEY_PATH || './data/key.pem',
  CERT_PATH: process.env.CERT_PATH || './data/cert.pem',
  CA_CERT_PATH: process.env.CA_CERT_PATH || './data/ca-cert.pem',
  // Retry interval on errors
  ERROR_RETRY_INTERVAL: parseInt(process.env.ERROR_RETRY_INTERVAL || '600', 10),
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
