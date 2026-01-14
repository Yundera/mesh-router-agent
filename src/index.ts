import { config, parseProvider } from './config/EnvConfig.js';
import {
  registerIp,
  detectPublicIp,
  checkBackendHealth,
  sendHeartbeat,
} from './services/IpRegistrar.js';

const VERSION = process.env.BUILD_VERSION || '1.0.0';

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
  console.log(`Heartbeat interval: ${config.HEARTBEAT_INTERVAL}s (${config.HEARTBEAT_INTERVAL / 60} min)`);

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

  // Initial IP registration
  const publicIp = config.PUBLIC_IP || (await detectPublicIp());
  console.log(`\nRegistering IP: ${publicIp}`);

  const regResult = await registerIp(provider, publicIp);
  if (regResult.success) {
    console.log(`✓ ${regResult.message}`);
    if (regResult.domain) {
      console.log(`  Domain: ${regResult.domain}`);
    }
  } else {
    console.error(`✗ ${regResult.message}: ${regResult.error}`);
    process.exit(1);
  }

  // Heartbeat loop
  console.log('\nStarting heartbeat loop...');

  while (true) {
    await sleep(config.HEARTBEAT_INTERVAL * 1000);

    try {
      const result = await sendHeartbeat(provider);

      if (result.success) {
        console.log(`[${new Date().toISOString()}] Heartbeat OK`);
      } else {
        console.error(`[${new Date().toISOString()}] Heartbeat failed: ${result.error}`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Heartbeat error:`, error);
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
