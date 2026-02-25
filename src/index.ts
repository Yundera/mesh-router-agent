import { config, parseProvider, getHealthCheckConfig } from './config/EnvConfig.js';
import {
  registerRoutes,
  buildRoute,
  detectPublicIp,
  checkBackendHealth,
  checkBackendVersion,
  Route,
} from './services/IpRegistrar.js';
import {
  ensureKeyPair,
  requestCertificate,
  needsRenewal,
  formatTimeRemaining,
  CertificateState,
} from './services/CertificateManager.js';

const VERSION = process.env.BUILD_VERSION || '2.0.0';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main() {
  console.log(`mesh-router-agent v${VERSION}`);
  console.log('================================');

  // Validate configuration
  if (!config.PROVIDER) {
    console.error('ERROR: PROVIDER environment variable is required');
    console.error('Format: <backend_url>,<userid>,<signature>');
    process.exit(1);
  }

  const provider = parseProvider(config.PROVIDER);
  const healthCheck = getHealthCheckConfig();

  console.log(`Backend URL: ${provider.backendUrl}`);
  console.log(`User ID: ${provider.userId}`);
  console.log(`Target port HTTPS: ${config.TARGET_PORT_HTTPS}`);
  console.log(`Target port HTTP: ${config.TARGET_PORT_HTTP}`);
  console.log(`Route priority: ${config.ROUTE_PRIORITY}`);
  console.log(`Refresh interval: ${config.REFRESH_INTERVAL}s (${Math.round(config.REFRESH_INTERVAL / 60)} min)`);
  console.log(`Error retry interval: ${config.ERROR_RETRY_INTERVAL}s (${Math.round(config.ERROR_RETRY_INTERVAL / 60)} min)`);
  if (healthCheck) {
    console.log(`Health check: ${healthCheck.path}${healthCheck.host ? ` (host: ${healthCheck.host})` : ''}`);
  }

  // Initialization with retry loop
  let initialized = false;
  let certState: CertificateState | null = null;
  let routes: Route[] = [];

  while (!initialized) {
    try {
      // Check backend version FIRST - ensures we connect to compatible backend
      console.log('\nChecking backend version...');
      const versionInfo = await checkBackendVersion(provider.backendUrl);

      if (!versionInfo.compatible) {
        throw new Error(`Backend version incompatible (v${versionInfo.version}). Requires v2+. ${versionInfo.error || ''}`);
      }
      console.log(`Backend version: v${versionInfo.version} (compatible)`);

      // Wait for backend to be available
      console.log('\nChecking backend availability...');
      const backendReady = await checkBackendHealth(provider.backendUrl);
      if (!backendReady) {
        throw new Error('Backend health check failed');
      }
      console.log('Backend is available!');

      // Detect public IP first (needed for certificate SAN)
      const publicIp = config.PUBLIC_IP || (await detectPublicIp());
      console.log(`\nDetected public IP: ${publicIp}`);

      // Certificate management - always request fresh cert at startup
      // This ensures we get the latest CA and certificate extensions (e.g., nip.io SAN)
      console.log('\nInitializing certificate...');
      console.log('[Cert] Requesting new certificate at startup...');
      const keyPem = await ensureKeyPair();
      certState = await requestCertificate(provider, keyPem, publicIp);

      // Build dual routes: HTTPS (port 443) and HTTP (port 80)
      routes = [
        buildRoute(
          publicIp,
          config.TARGET_PORT_HTTPS,
          config.ROUTE_PRIORITY,
          'agent',
          healthCheck,
          'https'
        ),
        buildRoute(
          publicIp,
          config.TARGET_PORT_HTTP,
          config.ROUTE_PRIORITY,
          'agent',
          undefined, // No health check for HTTP route
          'http'
        ),
      ];

      // Initial route registration
      console.log('\nRegistering routes...');
      const result = await registerRoutes(provider, routes);

      if (!result.success) {
        throw new Error(`Route registration failed: ${result.error}`);
      }

      for (const route of routes) {
        console.log(`[${new Date().toISOString()}] Route registered: ${route.ip}:${route.port} (scheme: ${route.scheme}, priority: ${route.priority})`);
      }
      if (result.domain) {
        console.log(`  Domain: ${result.domain}`);
      }

      initialized = true;
    } catch (error) {
      const errorMsg = formatError(error);
      console.error(`\n[${new Date().toISOString()}] Initialization failed: ${errorMsg}`);
      console.error(`Retrying in ${config.ERROR_RETRY_INTERVAL}s (${Math.round(config.ERROR_RETRY_INTERVAL / 60)} min)...`);
      await sleep(config.ERROR_RETRY_INTERVAL * 1000);
    }
  }

  // Route refresh loop
  console.log('\nStarting route refresh loop...');

  while (true) {
    await sleep(config.REFRESH_INTERVAL * 1000);

    try {
      // Re-detect IP in case it changed
      const currentIp = config.PUBLIC_IP || (await detectPublicIp());

      // Check certificate renewal
      if (certState && needsRenewal(certState.expiresAt)) {
        console.log(`[${new Date().toISOString()}] Certificate renewal needed (expires in ${formatTimeRemaining(certState.expiresAt)})`);
        const keyPem = await ensureKeyPair();
        certState = await requestCertificate(provider, keyPem, currentIp);
      }

      // Update IP in all routes if changed
      if (routes.length > 0 && currentIp !== routes[0].ip) {
        console.log(`[${new Date().toISOString()}] IP changed: ${routes[0].ip} -> ${currentIp}`);
        for (const route of routes) {
          route.ip = currentIp;
        }
      }

      if (routes.length > 0) {
        const result = await registerRoutes(provider, routes);
        if (result.success) {
          for (const route of routes) {
            console.log(`[${new Date().toISOString()}] Route registered: ${route.ip}:${route.port} (scheme: ${route.scheme}, priority: ${route.priority})`);
          }
          if (result.domain) {
            console.log(`  Domain: ${result.domain}`);
          }
        } else {
          console.error(`[${new Date().toISOString()}] Route registration failed: ${result.error}`);
        }
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Route refresh error: ${formatError(error)}`);
    }
  }
}

// Start the agent
main().catch((error) => {
  console.error('Fatal error:', formatError(error));
  process.exit(1);
});
