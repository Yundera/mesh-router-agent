import dgram from 'dgram';
import crypto from 'crypto';
import dns from 'dns';

/**
 * STUN servers to try for public IP detection
 * These are well-known public STUN servers
 * Family: 4 = IPv4, 6 = IPv6
 */
const STUN_SERVERS = [
  // IPv4 servers (preferred for stability)
  { host: 'stun.l.google.com', port: 19302, family: 4 },
  { host: 'stun1.l.google.com', port: 19302, family: 4 },
  { host: 'stun2.l.google.com', port: 19302, family: 4 },
  { host: 'stun.cloudflare.com', port: 3478, family: 4 },
  { host: 'stun.stunprotocol.org', port: 3478, family: 4 },
  // IPv6 servers (fallback)
  { host: 'stun.l.google.com', port: 19302, family: 6 },
  { host: 'stun1.l.google.com', port: 19302, family: 6 },
  { host: 'stun.cloudflare.com', port: 3478, family: 6 },
];

// STUN message types
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const STUN_MAGIC_COOKIE = 0x2112A442;

// STUN attribute types
const STUN_ATTR_MAPPED_ADDRESS = 0x0001;
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;

interface StunResult {
  ip: string;
  port: number;
  server: string;
  family: 4 | 6;
}

interface ParsedAddress {
  ip: string;
  port: number;
  family: 4 | 6;
}

/**
 * Format IPv6 address bytes to string representation
 */
function formatIpv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push(bytes.readUInt16BE(i).toString(16));
  }
  // Basic compression - join with colons (full form, no :: compression)
  return groups.join(':');
}

/**
 * Creates a STUN Binding Request message
 * Returns both the request buffer and the transaction ID (needed for IPv6 decoding)
 */
function createBindingRequest(): { buffer: Buffer; transactionId: Buffer } {
  const buffer = Buffer.alloc(20);

  // Message Type: Binding Request (0x0001)
  buffer.writeUInt16BE(STUN_BINDING_REQUEST, 0);

  // Message Length: 0 (no attributes)
  buffer.writeUInt16BE(0, 2);

  // Magic Cookie
  buffer.writeUInt32BE(STUN_MAGIC_COOKIE, 4);

  // Transaction ID (96 bits / 12 bytes)
  const transactionId = crypto.randomBytes(12);
  transactionId.copy(buffer, 8);

  return { buffer, transactionId };
}

/**
 * Parses a STUN Binding Response to extract the mapped address
 * @param response - The raw STUN response buffer
 * @param transactionId - The transaction ID from the request (needed for IPv6 XOR decoding)
 */
function parseBindingResponse(response: Buffer, transactionId: Buffer): ParsedAddress | null {
  if (response.length < 20) {
    return null;
  }

  // Check message type
  const messageType = response.readUInt16BE(0);
  if (messageType !== STUN_BINDING_RESPONSE) {
    return null;
  }

  // Check magic cookie
  const magicCookie = response.readUInt32BE(4);
  if (magicCookie !== STUN_MAGIC_COOKIE) {
    return null;
  }

  // Parse attributes
  const messageLength = response.readUInt16BE(2);
  let offset = 20;
  const endOffset = 20 + messageLength;

  while (offset < endOffset && offset + 4 <= response.length) {
    const attrType = response.readUInt16BE(offset);
    const attrLength = response.readUInt16BE(offset + 2);
    const attrValue = response.slice(offset + 4, offset + 4 + attrLength);

    if (attrType === STUN_ATTR_XOR_MAPPED_ADDRESS) {
      // XOR-MAPPED-ADDRESS
      const family = attrValue.readUInt8(1);
      const xorPort = attrValue.readUInt16BE(2);
      const port = xorPort ^ (STUN_MAGIC_COOKIE >> 16);

      if (family === 0x01 && attrLength >= 8) {
        // IPv4: XOR with magic cookie only
        const xorIpBytes = attrValue.slice(4, 8);
        const magicCookieBytes = Buffer.alloc(4);
        magicCookieBytes.writeUInt32BE(STUN_MAGIC_COOKIE, 0);

        const ipBytes = Buffer.alloc(4);
        for (let i = 0; i < 4; i++) {
          ipBytes[i] = xorIpBytes[i] ^ magicCookieBytes[i];
        }

        const ip = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
        return { ip, port, family: 4 };
      } else if (family === 0x02 && attrLength >= 20) {
        // IPv6: XOR with magic cookie (4 bytes) + transaction ID (12 bytes)
        const xorKey = Buffer.alloc(16);
        xorKey.writeUInt32BE(STUN_MAGIC_COOKIE, 0);
        transactionId.copy(xorKey, 4);

        const xorIpBytes = attrValue.slice(4, 20);
        const ipBytes = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) {
          ipBytes[i] = xorIpBytes[i] ^ xorKey[i];
        }

        const ip = formatIpv6(ipBytes);
        return { ip, port, family: 6 };
      }
    } else if (attrType === STUN_ATTR_MAPPED_ADDRESS) {
      // MAPPED-ADDRESS (fallback, non-XOR)
      const family = attrValue.readUInt8(1);
      const port = attrValue.readUInt16BE(2);

      if (family === 0x01 && attrLength >= 8) {
        // IPv4
        const ip = `${attrValue[4]}.${attrValue[5]}.${attrValue[6]}.${attrValue[7]}`;
        return { ip, port, family: 4 };
      } else if (family === 0x02 && attrLength >= 20) {
        // IPv6
        const ipBytes = attrValue.slice(4, 20);
        const ip = formatIpv6(ipBytes);
        return { ip, port, family: 6 };
      }
    }

    // Move to next attribute (4-byte aligned)
    offset += 4 + attrLength;
    if (attrLength % 4 !== 0) {
      offset += 4 - (attrLength % 4);
    }
  }

  return null;
}

/**
 * Resolves a hostname to IP address with specified family
 */
function resolveHost(host: string, family: 4 | 6): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { family }, (err, address) => {
      if (err) {
        reject(err);
      } else {
        resolve(address);
      }
    });
  });
}

/**
 * Queries a single STUN server for the public IP
 * @param host - STUN server hostname
 * @param port - STUN server port
 * @param family - IP family (4 for IPv4, 6 for IPv6)
 * @param timeout - Timeout in milliseconds
 */
function queryStunServer(
  host: string,
  port: number,
  family: 4 | 6 = 4,
  timeout: number = 3000
): Promise<StunResult> {
  return new Promise(async (resolve, reject) => {
    let resolvedHost: string;

    // Resolve hostname to the correct IP family
    try {
      resolvedHost = await resolveHost(host, family);
    } catch (err) {
      reject(new Error(`DNS resolution failed for ${host} (IPv${family}): ${err}`));
      return;
    }

    const socketType = family === 6 ? 'udp6' : 'udp4';
    const socket = dgram.createSocket(socketType);
    const { buffer: request, transactionId } = createBindingRequest();

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`STUN timeout: ${host}:${port} (IPv${family})`));
    }, timeout);

    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();

      const result = parseBindingResponse(msg, transactionId);
      if (result) {
        resolve({ ...result, server: `${host}:${port}` });
      } else {
        reject(new Error(`Invalid STUN response from ${host}:${port}`));
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.send(request, port, resolvedHost, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.close();
        reject(err);
      }
    });
  });
}

/**
 * Detects the public IP using STUN protocol
 * Tries multiple STUN servers until one succeeds
 * Prefers IPv4 for stability (IPv4 servers are listed first)
 */
export async function detectPublicIpViaStun(): Promise<string> {
  for (const server of STUN_SERVERS) {
    try {
      const result = await queryStunServer(server.host, server.port, server.family as 4 | 6);
      console.log(`Detected public IP via STUN: ${result.ip} (IPv${result.family} from ${result.server})`);
      return result.ip;
    } catch (error) {
      // Try next server
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`STUN server ${server.host}:${server.port} (IPv${server.family}) failed: ${errMsg}`);
    }
  }

  throw new Error('Failed to detect public IP via STUN from all servers');
}
