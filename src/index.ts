import { config, parseProvider, getHealthCheckConfig } from './config/EnvConfig.js';
import {
  registerRoutes,
  buildRoute,
  detectPublicIp,
  checkBackendHealth,
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
  if (healthCheck) {
    console.log(`Health check: ${healthCheck.path}${healthCheck.host ? ` (host: ${healthCheck.host})` : ''}`);
  }

  // Wait for backend to be available
  console.log('\nChecking backend availability...');
  let backendReady = false;
  while (!backendReady) {
    backendReady = await checkBackendHealth(provider.backendUrl);
    if (!backendReady) {
      console.log('Backend not available, retrying in 30s...');
      await sleep(30000);
    }
  }
  console.log('Backend is available!');

  // Certificate management
  console.log('\nInitializing certificate...');
  let certState: CertificateState | null = loadCertificateState();

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
  const route: Route = buildRoute(
    publicIp,
    config.TARGET_PORT,
    config.ROUTE_PRIORITY,
    'agent',  // Source identifier for route replacement
    healthCheck
  );

  // Register route function (used for initial and refresh)
  async function doRegisterRoute(): Promise<boolean> {
    const result = await registerRoutes(provider, [route]);

    if (result.success) {
      console.log(`[${new Date().toISOString()}] Route registered: ${route.ip}:${route.port} (priority: ${route.priority})`);
      if (result.domain) {
        console.log(`  Domain: ${result.domain}`);
      }
      return true;
    } else {
      console.error(`[${new Date().toISOString()}] Route registration failed: ${result.error}`);
      return false;
    }
  }

  // Initial route registration
  console.log('\nRegistering route...');
  const initialSuccess = await doRegisterRoute();
  if (!initialSuccess) {
    console.error('Initial route registration failed, exiting...');
    process.exit(1);
  }

  // Route refresh loop (replaces heartbeat)
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

      if (currentIp !== route.ip) {
        console.log(`[${new Date().toISOString()}] IP changed: ${route.ip} -> ${currentIp}`);
        route.ip = currentIp;
      }

      await doRegisterRoute();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Route refresh error:`, error);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start the agent
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
