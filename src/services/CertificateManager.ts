/**
 * CertificateManager.ts - Certificate lifecycle management for mesh-router-agent
 *
 * Manages the agent's TLS certificate:
 * - Generates and persists RSA keypair
 * - Creates CSR with CN=userid
 * - Requests certificate from backend CA
 * - Handles renewal at 50% lifetime (36h remaining for 72h cert)
 */

import * as fs from 'fs';
import * as path from 'path';
import forge from 'node-forge';
import { ProviderConfig } from '../config/EnvConfig.js';

// Configuration via environment variables with defaults
const DEFAULT_KEY_PATH = './data/key.pem';
const DEFAULT_CERT_PATH = './data/cert.pem';
const DEFAULT_CA_CERT_PATH = './data/ca-cert.pem';

// Renewal threshold: renew when less than 50% lifetime remaining
const RENEWAL_THRESHOLD = 0.5;

// HTTP timeout for certificate requests
const HTTP_TIMEOUT = 30000;

export interface CertificateState {
  privateKey: string;
  certificate: string;
  caCertificate: string;
  expiresAt: Date;
}

export interface CertificatePaths {
  keyPath: string;
  certPath: string;
  caCertPath: string;
}

/**
 * Get certificate file paths from environment or defaults
 */
export function getCertificatePaths(): CertificatePaths {
  return {
    keyPath: process.env.CERT_KEY_PATH || DEFAULT_KEY_PATH,
    certPath: process.env.CERT_PATH || DEFAULT_CERT_PATH,
    caCertPath: process.env.CA_CERT_PATH || DEFAULT_CA_CERT_PATH,
  };
}

/**
 * Ensure the keypair exists, generating if necessary
 * Returns the private key in PEM format
 */
export async function ensureKeyPair(keyPath?: string): Promise<string> {
  const paths = getCertificatePaths();
  const filePath = keyPath || paths.keyPath;

  // Check if key already exists
  if (fs.existsSync(filePath)) {
    console.log(`[Cert] Loading existing keypair from ${filePath}`);
    return fs.readFileSync(filePath, 'utf-8');
  }

  console.log('[Cert] Generating new RSA keypair...');

  // Generate RSA key pair (2048 bits)
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Save private key with restricted permissions
  fs.writeFileSync(filePath, keyPem, { mode: 0o600 });
  console.log(`[Cert] Keypair saved to ${filePath}`);

  return keyPem;
}

/**
 * Generate a Certificate Signing Request (CSR)
 */
function generateCSR(privateKeyPem: string, userId: string): string {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e);

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = publicKey;

  // Set subject with CN=userId
  // Use UTF8String encoding (tag=12) to support special characters like '@' in userId
  // PrintableString (default) doesn't allow '@' and causes x509 validation errors in Caddy/Go
  const UTF8_STRING_TAG = 12; // forge.asn1.Type.UTF8
  csr.setSubject([
    { name: 'commonName', value: userId, valueTagClass: UTF8_STRING_TAG as forge.asn1.Class },
  ]);

  // Sign the CSR with the private key
  csr.sign(privateKey, forge.md.sha256.create());

  return forge.pki.certificationRequestToPem(csr);
}

/**
 * Request a certificate from the backend CA
 */
export async function requestCertificate(
  provider: ProviderConfig,
  keyPem: string
): Promise<CertificateState> {
  const { backendUrl, userId, signature } = provider;

  console.log('[Cert] Generating CSR...');
  const csrPem = generateCSR(keyPem, userId);

  const url = `${backendUrl}/router/api/cert/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;

  console.log(`[Cert] Requesting certificate from ${backendUrl}...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ csr: csrPem }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Certificate request failed: ${response.status} - ${errorData.error || response.statusText}`);
    }

    const data = await response.json() as {
      certificate: string;
      expiresAt: string;
      caCertificate: string;
    };

    const state: CertificateState = {
      privateKey: keyPem,
      certificate: data.certificate,
      caCertificate: data.caCertificate,
      expiresAt: new Date(data.expiresAt),
    };

    // Save certificate state to files
    saveCertificateState(state);

    console.log(`[Cert] Certificate obtained, expires: ${state.expiresAt.toISOString()}`);

    return state;
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Certificate request timed out');
    }
    throw error;
  }
}

/**
 * Check if certificate needs renewal (less than 50% lifetime remaining)
 */
export function needsRenewal(expiresAt: Date): boolean {
  const now = new Date();
  const remaining = expiresAt.getTime() - now.getTime();

  if (remaining <= 0) {
    return true; // Already expired
  }

  // Calculate original validity period (assume 72 hours)
  const validityPeriod = 72 * 60 * 60 * 1000; // 72 hours in ms
  const threshold = validityPeriod * RENEWAL_THRESHOLD;

  return remaining < threshold;
}

/**
 * Load certificate state from files
 * Returns null if any file is missing or invalid
 */
export function loadCertificateState(): CertificateState | null {
  const paths = getCertificatePaths();

  try {
    // Check all files exist
    if (!fs.existsSync(paths.keyPath) ||
        !fs.existsSync(paths.certPath) ||
        !fs.existsSync(paths.caCertPath)) {
      return null;
    }

    const privateKey = fs.readFileSync(paths.keyPath, 'utf-8');
    const certificate = fs.readFileSync(paths.certPath, 'utf-8');
    const caCertificate = fs.readFileSync(paths.caCertPath, 'utf-8');

    // Parse certificate to get expiry date
    const cert = forge.pki.certificateFromPem(certificate);
    const expiresAt = cert.validity.notAfter;

    console.log(`[Cert] Loaded certificate state, expires: ${expiresAt.toISOString()}`);

    return {
      privateKey,
      certificate,
      caCertificate,
      expiresAt,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.log('[Cert] Failed to load certificate state:', message);
    return null;
  }
}

/**
 * Save certificate state to files
 */
export function saveCertificateState(state: CertificateState): void {
  const paths = getCertificatePaths();

  // Ensure directory exists
  const dir = path.dirname(paths.certPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Save files
  fs.writeFileSync(paths.keyPath, state.privateKey, { mode: 0o600 });
  fs.writeFileSync(paths.certPath, state.certificate, { mode: 0o644 });
  fs.writeFileSync(paths.caCertPath, state.caCertificate, { mode: 0o644 });

  console.log(`[Cert] Certificate state saved to ${dir}`);
}

/**
 * Format time remaining until expiry
 */
export function formatTimeRemaining(expiresAt: Date): string {
  const now = new Date();
  const remaining = expiresAt.getTime() - now.getTime();

  if (remaining <= 0) {
    return 'expired';
  }

  const hours = Math.floor(remaining / (60 * 60 * 1000));
  const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }

  return `${hours}h ${minutes}m`;
}
