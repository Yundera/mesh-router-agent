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
  loadCertificateState,
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
  console.log(`Target port: ${config.TARGET_PORT}`);
  console.log(`Route priority: ${config.ROUTE_PRIORITY}`);
  console.log(`Refresh interval: ${config.REFRESH_INTERVAL}s (${Math.round(config.REFRESH_INTERVAL / 60)} min)`);
  console.log(`Error retry interval: ${config.ERROR_RETRY_INTERVAL}s (${Math.round(config.ERROR_RETRY_INTERVAL / 60)} min)`);
  if (healthCheck) {
    console.log(`Health check: ${healthCheck.path}${healthCheck.host ? ` (host: ${healthCheck.host})` : ''}`);
  }

  // Initialization with retry loop
  let initialized = false;
  let certState: CertificateState | null = null;
  let route: Route | null = null;

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

      // Certificate management
      console.log('\nInitializing certificate...');
      certState = loadCertificateState();

      if (!certState || needsRenewal(certState.expiresAt)) {
        const reason = !certState ? 'no certificate found' : `renewal needed (expires in ${formatTimeRemaining(certState.expiresAt)})`;
        console.log(`[Cert] Requesting new certificate: ${reason}`);
        const keyPem = await ensureKeyPair();
        certState = await requestCertificate(provider, keyPem);
      } else {
        console.log(`[Cert] Certificate valid, expires in ${formatTimeRemaining(certState.expiresAt)}`);
      }

      // Detect public IP
      const publicIp = config.PUBLIC_IP || (await detectPublicIp());
      console.log(`\nDetected public IP: ${publicIp}`);

      // Build route
      route = buildRoute(
        publicIp,
        config.TARGET_PORT,
        config.ROUTE_PRIORITY,
        'agent',
        healthCheck
      );

      // Initial route registration
      console.log('\nRegistering route...');
      const result = await registerRoutes(provider, [route]);

      if (!result.success) {
        throw new Error(`Route registration failed: ${result.error}`);
      }

      console.log(`[${new Date().toISOString()}] Route registered: ${route.ip}:${route.port} (priority: ${route.priority})`);
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
      // Check certificate renewal
      if (certState && needsRenewal(certState.expiresAt)) {
        console.log(`[${new Date().toISOString()}] Certificate renewal needed (expires in ${formatTimeRemaining(certState.expiresAt)})`);
        const keyPem = await ensureKeyPair();
        certState = await requestCertificate(provider, keyPem);
      }

      // Re-detect IP in case it changed
      const currentIp = config.PUBLIC_IP || (await detectPublicIp());

      if (route && currentIp !== route.ip) {
        console.log(`[${new Date().toISOString()}] IP changed: ${route.ip} -> ${currentIp}`);
        route.ip = currentIp;
      }

      if (route) {
        const result = await registerRoutes(provider, [route]);
        if (result.success) {
          console.log(`[${new Date().toISOString()}] Route registered: ${route.ip}:${route.port} (priority: ${route.priority})`);
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
