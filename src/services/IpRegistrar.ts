import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { ProviderConfig } from '../config/EnvConfig.js';
import { detectPublicIpViaStun } from './StunClient.js';

const exec = promisify(execCallback);

export interface RegistrationResult {
  success: boolean;
  message: string;
  vpnIp?: string;
  domain?: string;
  error?: string;
}

/**
 * Detects the public IP address using STUN protocol (primary)
 * Falls back to HTTP services if STUN fails
 */
export async function detectPublicIp(): Promise<string> {
  // Try STUN first (faster and more reliable)
  try {
    return await detectPublicIpViaStun();
  } catch (stunError) {
    console.log('STUN detection failed, falling back to HTTP services...');
  }

  // Fallback to HTTP services
  const httpServices = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
  ];

  for (const service of httpServices) {
    try {
      const { stdout } = await exec(`curl -s --max-time 10 ${service}`);
      const ip = stdout.trim();
      if (isValidIp(ip)) {
        console.log(`Detected public IP: ${ip} (via HTTP ${service})`);
        return ip;
      }
    } catch {
      // Try next service
    }
  }

  throw new Error('Failed to detect public IP from all STUN and HTTP services');
}

/**
 * Validates an IPv4 or IPv6 address
 */
function isValidIp(ip: string): boolean {
  // IPv4 regex
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  // Simple IPv6 check (contains colons and valid hex chars)
  const ipv6Regex = /^[0-9a-fA-F:]+$/;

  return ipv4Regex.test(ip) || (ip.includes(':') && ipv6Regex.test(ip));
}

/**
 * Registers the IP with mesh-router-backend
 * POST /ip/:userid/:sig { vpnIp: string }
 */
export async function registerIp(
  provider: ProviderConfig,
  publicIp: string
): Promise<RegistrationResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/ip/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const jsonData = JSON.stringify({ vpnIp: publicIp }).replace(/"/g, '\\"');
    const curlCommand = `curl -s -X POST -H "Content-Type: application/json" -d "${jsonData}" "${url}"`;

    const { stdout } = await exec(curlCommand);
    const response = JSON.parse(stdout);

    if (response.error) {
      return {
        success: false,
        message: 'Registration failed',
        error: response.error,
      };
    }

    return {
      success: true,
      message: response.message || 'IP registered successfully',
      vpnIp: response.vpnIp,
      domain: response.domain,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Registration request failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Checks if the backend is reachable
 */
export async function checkBackendHealth(backendUrl: string): Promise<boolean> {
  try {
    const { stdout } = await exec(`curl -s --max-time 10 "${backendUrl}/available/healthcheck"`);
    // Any valid JSON response means backend is up
    JSON.parse(stdout);
    return true;
  } catch {
    return false;
  }
}

export interface HeartbeatResult {
  success: boolean;
  message: string;
  lastSeenOnline?: string;
  error?: string;
}

/**
 * Sends a heartbeat to mesh-router-backend
 * POST /heartbeat/:userid/:sig
 */
export async function sendHeartbeat(
  provider: ProviderConfig
): Promise<HeartbeatResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/heartbeat/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const curlCommand = `curl -s -X POST "${url}"`;
    const { stdout } = await exec(curlCommand);
    const response = JSON.parse(stdout);

    if (response.error) {
      return {
        success: false,
        message: 'Heartbeat failed',
        error: response.error,
      };
    }

    return {
      success: true,
      message: response.message || 'Heartbeat sent',
      lastSeenOnline: response.lastSeenOnline,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Heartbeat request failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
