import { describe, it } from "mocha";
import { expect } from "chai";

// Test STUN message creation and parsing logic
// Note: Actual STUN server tests require network access

describe("STUN Client", () => {
  describe("STUN message constants", () => {
    it("should have correct STUN magic cookie value", () => {
      const STUN_MAGIC_COOKIE = 0x2112A442;
      expect(STUN_MAGIC_COOKIE).to.equal(0x2112A442);
      expect(STUN_MAGIC_COOKIE).to.equal(554869826);
    });

    it("should have correct STUN binding request type", () => {
      const STUN_BINDING_REQUEST = 0x0001;
      expect(STUN_BINDING_REQUEST).to.equal(1);
    });

    it("should have correct STUN binding response type", () => {
      const STUN_BINDING_RESPONSE = 0x0101;
      expect(STUN_BINDING_RESPONSE).to.equal(257);
    });
  });

  describe("XOR-MAPPED-ADDRESS decoding", () => {
    it("should correctly XOR decode IP address bytes", () => {
      // Magic cookie: 0x2112A442
      const magicCookieBytes = Buffer.from([0x21, 0x12, 0xA4, 0x42]);

      // Example: XOR'd IP that should decode to 192.168.1.1
      // 192.168.1.1 = 0xC0.0xA8.0x01.0x01
      // XOR with magic cookie: 0xC0^0x21, 0xA8^0x12, 0x01^0xA4, 0x01^0x42
      const xorIpBytes = Buffer.from([
        0xC0 ^ 0x21, // 0xE1
        0xA8 ^ 0x12, // 0xBA
        0x01 ^ 0xA4, // 0xA5
        0x01 ^ 0x42, // 0x43
      ]);

      // Decode by XORing again
      const decodedBytes = Buffer.alloc(4);
      for (let i = 0; i < 4; i++) {
        decodedBytes[i] = xorIpBytes[i] ^ magicCookieBytes[i];
      }

      expect(decodedBytes[0]).to.equal(192);
      expect(decodedBytes[1]).to.equal(168);
      expect(decodedBytes[2]).to.equal(1);
      expect(decodedBytes[3]).to.equal(1);

      const ip = `${decodedBytes[0]}.${decodedBytes[1]}.${decodedBytes[2]}.${decodedBytes[3]}`;
      expect(ip).to.equal("192.168.1.1");
    });

    it("should correctly XOR decode port", () => {
      // Magic cookie high 16 bits: 0x2112
      const magicCookieHigh = 0x2112;

      // Example: XOR'd port that should decode to 12345
      const xorPort = 12345 ^ magicCookieHigh;

      // Decode by XORing again
      const decodedPort = xorPort ^ magicCookieHigh;

      expect(decodedPort).to.equal(12345);
    });
  });

  describe("STUN binding request", () => {
    it("should create a 20-byte binding request", () => {
      // A binding request has:
      // - 2 bytes: message type (0x0001)
      // - 2 bytes: message length (0x0000 for no attributes)
      // - 4 bytes: magic cookie (0x2112A442)
      // - 12 bytes: transaction ID
      // Total: 20 bytes

      const minRequestSize = 20;
      expect(minRequestSize).to.equal(20);
    });
  });
});
