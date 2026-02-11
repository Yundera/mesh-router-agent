import { ProviderConfig, HealthCheckConfig } from '../config/EnvConfig.js';
import { detectPublicIpViaStun } from './StunClient.js';

/** HTTP request timeout in milliseconds */
const HTTP_TIMEOUT = 10000;

export interface RegistrationResult {
  success: boolean;
  message: string;
  hostIp?: string;
  targetPort?: number;
  domain?: string;
  error?: string;
}

export interface Route {
  ip: string;
  port: number;
  priority: number;
  healthCheck?: HealthCheckConfig;
  source: string;
}

export interface RouteRegistrationResult {
  success: boolean;
  message: string;
  routes?: Route[];
  domain?: string;
  error?: string;
}

/**
 * Creates an AbortController with timeout
 */
function createTimeoutController(ms: number): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller;
}

/**
 * Performs a GET request with timeout
 */
async function httpGet(url: string, timeoutMs: number = HTTP_TIMEOUT): Promise<string> {
  const controller = createTimeoutController(timeoutMs);
  const response = await fetch(url, {
    method: 'GET',
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.text();
}

/**
 * Performs a POST request with JSON body and timeout
 */
async function httpPost<T>(
  url: string,
  body: unknown,
  timeoutMs: number = HTTP_TIMEOUT
): Promise<T> {
  const controller = createTimeoutController(timeoutMs);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  const data = await response.json() as T;
  return data;
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
      const text = await httpGet(service);
      const ip = text.trim();
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
 * Registers the IP and target port with mesh-router-backend
 * POST /router/api/ip/:userid/:sig { hostIp: string, targetPort: number }
 * @deprecated Use registerRoutes instead for v2 API
 */
export async function registerIp(
  provider: ProviderConfig,
  publicIp: string,
  targetPort: number = 443
): Promise<RegistrationResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/router/api/ip/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const response = await httpPost<{ error?: string; message?: string; hostIp?: string; targetPort?: number; domain?: string }>(
      url,
      { hostIp: publicIp, targetPort }
    );

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
      hostIp: response.hostIp,
      targetPort: response.targetPort,
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
 * Registers routes with mesh-router-backend (v2 API)
 * POST /router/api/routes/:userid/:sig { routes: Route[] }
 *
 * This replaces the old registerIp function and supports:
 * - Multiple routes with priority
 * - Optional health check configuration
 * - TTL-based expiry (routes must be refreshed every 5 minutes)
 */
export async function registerRoutes(
  provider: ProviderConfig,
  routes: Route[]
): Promise<RouteRegistrationResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/router/api/routes/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const response = await httpPost<{ error?: string; message?: string; routes?: Route[]; domain?: string }>(
      url,
      { routes }
    );

    if (response.error) {
      return {
        success: false,
        message: 'Route registration failed',
        error: response.error,
      };
    }

    return {
      success: true,
      message: response.message || 'Routes registered successfully',
      routes: response.routes,
      domain: response.domain,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Route registration request failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build a route object from configuration
 */
export function buildRoute(
  ip: string,
  port: number,
  priority: number,
  source: string,
  healthCheck?: HealthCheckConfig
): Route {
  const route: Route = { ip, port, priority, source };
  if (healthCheck) {
    route.healthCheck = healthCheck;
  }
  return route;
}

/**
 * Checks if the backend is reachable
 */
export async function checkBackendHealth(backendUrl: string): Promise<boolean> {
  try {
    const text = await httpGet(`${backendUrl}/router/api/available/healthcheck`);
    // Any valid JSON response means backend is up
    JSON.parse(text);
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
 * POST /router/api/heartbeat/:userid/:sig
 */
export async function sendHeartbeat(
  provider: ProviderConfig
): Promise<HeartbeatResult> {
  const { backendUrl, userId, signature } = provider;
  const url = `${backendUrl}/router/api/heartbeat/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  try {
    const response = await httpPost<{ error?: string; message?: string; lastSeenOnline?: string }>(
      url,
      {}
    );

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
