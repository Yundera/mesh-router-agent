import { config, parseProvider } from './config/EnvConfig.js';
import {
  registerRoutes,
  buildDomainRoute,
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
import { waitForUpstreamTls } from './services/UpstreamReadiness.js';

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

  console.log(`Backend URL: ${provider.backendUrl}`);
  console.log(`User ID: ${provider.userId}`);
  console.log(`Target port HTTPS: ${config.TARGET_PORT_HTTPS}`);
  console.log(`Target port HTTP: ${config.TARGET_PORT_HTTP}`);
  console.log(`Route priority: ${config.ROUTE_PRIORITY}`);
  console.log(`Refresh interval: ${config.REFRESH_INTERVAL}s (${Math.round(config.REFRESH_INTERVAL / 60)} min)`);
  console.log(`Error retry interval: ${config.ERROR_RETRY_INTERVAL}s (${Math.round(config.ERROR_RETRY_INTERVAL / 60)} min)`);
  console.log(
    config.READINESS_TIMEOUT > 0
      ? `Upstream readiness: ${config.TARGET_HOST}:${config.TARGET_PORT_HTTPS}, up to ${config.READINESS_TIMEOUT}s`
      : 'Upstream readiness: disabled (READINESS_TIMEOUT=0)',
  );

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

      // Build nip.io domain routes (HTTPS and HTTP)
      // Raw IP routes are not registered because Caddy serves its own auto-TLS cert
      // for non-SNI connections, which doesn't chain to our CA.
      const basePriority = config.ROUTE_PRIORITY;
      routes = [
        buildDomainRoute(publicIp, config.TARGET_PORT_HTTPS, basePriority, 'agent', 'https', 'nip.io'),
        buildDomainRoute(publicIp, config.TARGET_PORT_HTTP, basePriority, 'agent', 'http', 'nip.io'),
      ];

      // Do not announce an endpoint before it is actually being served.
      //
      // mesh-router-caddy is what answers :443, and compose starts it AFTER
      // this agent (it depends_on us for the certificate above), so at this
      // point it may still be seconds away from binding. The backend validates
      // every route by connecting, so registering now is a coin flip; losing it
      // costs the box its direct route for a full ERROR_RETRY_INTERVAL.
      // UpstreamReadiness carries the full account.
      //
      // Not reaching readiness is deliberately NOT an error: we log it and
      // register anyway, which is exactly the behaviour that predates this gate.
      if (config.READINESS_TIMEOUT > 0) {
        const httpsRoute = routes.find((route) => route.scheme === 'https' && route.domain);
        if (httpsRoute?.domain) {
          console.log(`\nWaiting for ${config.TARGET_HOST}:${config.TARGET_PORT_HTTPS} to serve ${httpsRoute.domain}...`);
          const readiness = await waitForUpstreamTls({
            host: config.TARGET_HOST,
            port: config.TARGET_PORT_HTTPS,
            serverName: httpsRoute.domain,
            caCertificate: certState.caCertificate,
            timeoutMs: config.READINESS_TIMEOUT * 1000,
            intervalMs: config.READINESS_INTERVAL * 1000,
          });
          if (readiness.ready) {
            console.log(`[Readiness] upstream serving our certificate after ${(readiness.elapsedMs / 1000).toFixed(1)}s (${readiness.attempts} probe(s))`);
          } else {
            console.warn(`[Readiness] upstream not ready after ${(readiness.elapsedMs / 1000).toFixed(1)}s (${readiness.attempts} probes, last error: ${readiness.lastError}) — registering anyway`);
          }
        }
      }

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
        // Rebuild all routes with new IP
        const basePriority = config.ROUTE_PRIORITY;
        routes = [
          buildDomainRoute(currentIp, config.TARGET_PORT_HTTPS, basePriority, 'agent', 'https', 'nip.io'),
          buildDomainRoute(currentIp, config.TARGET_PORT_HTTP, basePriority, 'agent', 'http', 'nip.io'),
        ];
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
