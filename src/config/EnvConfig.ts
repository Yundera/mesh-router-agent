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
  /** Heartbeat interval in seconds (default: 1800 = 30 minutes) */
  HEARTBEAT_INTERVAL: number;
}

export const config: EnvConfig = {
  PROVIDER: process.env.PROVIDER || '',
  PUBLIC_IP: process.env.PUBLIC_IP || '',
  HEARTBEAT_INTERVAL: parseInt(process.env.HEARTBEAT_INTERVAL || '1800', 10),
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
