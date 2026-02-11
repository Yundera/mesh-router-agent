import dotenv from 'dotenv';
dotenv.config();

export interface ProviderConfig {
  backendUrl: string;
  userId: string;
  signature: string;
}

export interface HealthCheckConfig {
  path: string;
  host?: string;
}

interface EnvConfig {
  /** Provider connection string: <backend_url>,<userid>,<signature> */
  PROVIDER: string;
  /** Public IP to register (empty = auto-detect) */
  PUBLIC_IP: string;
  /** Target port where Caddy listens for incoming traffic (default: 10443) */
  TARGET_PORT: number;
  /** Route priority (lower = higher priority, default: 1 for direct connection) */
  ROUTE_PRIORITY: number;
  /** Route refresh interval in seconds (default: 300 = 5 minutes) */
  REFRESH_INTERVAL: number;
  /** Optional health check HTTP path (e.g., /.well-known/health) */
  HEALTH_CHECK_PATH: string;
  /** Optional health check Host header override */
  HEALTH_CHECK_HOST: string;
  // Legacy: kept for backward compatibility, use REFRESH_INTERVAL instead
  /** @deprecated Use REFRESH_INTERVAL instead */
  HEARTBEAT_INTERVAL: number;
  /** Path to store the agent's private key (default: ./data/key.pem) */
  CERT_KEY_PATH: string;
  /** Path to store the agent's certificate (default: ./data/cert.pem) */
  CERT_PATH: string;
  /** Path to store the CA certificate (default: ./data/ca-cert.pem) */
  CA_CERT_PATH: string;
}

export const config: EnvConfig = {
  PROVIDER: process.env.PROVIDER || '',
  PUBLIC_IP: process.env.PUBLIC_IP || '',
  TARGET_PORT: parseInt(process.env.TARGET_PORT || '10443', 10),
  ROUTE_PRIORITY: parseInt(process.env.ROUTE_PRIORITY || '1', 10),
  REFRESH_INTERVAL: parseInt(process.env.REFRESH_INTERVAL || process.env.HEARTBEAT_INTERVAL || '300', 10),
  HEALTH_CHECK_PATH: process.env.HEALTH_CHECK_PATH || '',
  HEALTH_CHECK_HOST: process.env.HEALTH_CHECK_HOST || '',
  // Legacy support
  HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL || '300', 10),
  // Certificate paths
  CERT_KEY_PATH: process.env.CERT_KEY_PATH || './data/key.pem',
  CERT_PATH: process.env.CERT_PATH || './data/cert.pem',
  CA_CERT_PATH: process.env.CA_CERT_PATH || './data/ca-cert.pem',
};

/**
 * Build health check config from environment if configured
 */
export function getHealthCheckConfig(): HealthCheckConfig | undefined {
  if (!config.HEALTH_CHECK_PATH) {
    return undefined;
  }

  return {
    path: config.HEALTH_CHECK_PATH,
    ...(config.HEALTH_CHECK_HOST && { host: config.HEALTH_CHECK_HOST }),
  };
}

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
