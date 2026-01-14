import dgram from 'dgram';
import crypto from 'crypto';

/**
 * STUN servers to try for public IP detection
 * These are well-known public STUN servers
 */
const STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 },
  { host: 'stun2.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 },
  { host: 'stun.stunprotocol.org', port: 3478 },
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
}

/**
 * Creates a STUN Binding Request message
 */
function createBindingRequest(): Buffer {
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

  return buffer;
}

/**
 * Parses a STUN Binding Response to extract the mapped address
 */
function parseBindingResponse(response: Buffer): { ip: string; port: number } | null {
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

    if (attrType === STUN_ATTR_XOR_MAPPED_ADDRESS && attrLength >= 8) {
      // XOR-MAPPED-ADDRESS
      const family = attrValue.readUInt8(1);
      if (family === 0x01) {
        // IPv4
        const xorPort = attrValue.readUInt16BE(2);
        const port = xorPort ^ (STUN_MAGIC_COOKIE >> 16);

        const xorIpBytes = attrValue.slice(4, 8);
        const magicCookieBytes = Buffer.alloc(4);
        magicCookieBytes.writeUInt32BE(STUN_MAGIC_COOKIE, 0);

        const ipBytes = Buffer.alloc(4);
        for (let i = 0; i < 4; i++) {
          ipBytes[i] = xorIpBytes[i] ^ magicCookieBytes[i];
        }

        const ip = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
        return { ip, port };
      }
    } else if (attrType === STUN_ATTR_MAPPED_ADDRESS && attrLength >= 8) {
      // MAPPED-ADDRESS (fallback, non-XOR)
      const family = attrValue.readUInt8(1);
      if (family === 0x01) {
        // IPv4
        const port = attrValue.readUInt16BE(2);
        const ip = `${attrValue[4]}.${attrValue[5]}.${attrValue[6]}.${attrValue[7]}`;
        return { ip, port };
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
 * Queries a single STUN server for the public IP
 */
function queryStunServer(
  host: string,
  port: number,
  timeout: number = 3000
): Promise<StunResult> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const request = createBindingRequest();

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`STUN timeout: ${host}:${port}`));
    }, timeout);

    socket.on('message', (msg) => {
      clearTimeout(timer);
      socket.close();

      const result = parseBindingResponse(msg);
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

    socket.send(request, port, host, (err) => {
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
 */
export async function detectPublicIpViaStun(): Promise<string> {
  for (const server of STUN_SERVERS) {
    try {
      const result = await queryStunServer(server.host, server.port);
      console.log(`Detected public IP via STUN: ${result.ip} (from ${result.server})`);
      return result.ip;
    } catch (error) {
      // Try next server
      console.log(`STUN server ${server.host}:${server.port} failed, trying next...`);
    }
  }

  throw new Error('Failed to detect public IP via STUN from all servers');
}
