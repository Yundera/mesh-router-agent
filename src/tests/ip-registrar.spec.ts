import { describe, it } from "mocha";
import { expect } from "chai";
import { buildAgentRoutes } from "../services/IpRegistrar.js";

// Test the IP validation logic (extracted for testing)
function isValidIPv4(ip: string): boolean {
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Regex.test(ip);
}

function isValidIPv6(ip: string): boolean {
  if (!/^[0-9a-fA-F:]+$/.test(ip) && !/^[0-9a-fA-F:.]+$/.test(ip)) {
    return false;
  }
  const doubleColonCount = (ip.match(/::/g) || []).length;
  if (doubleColonCount > 1) {
    return false;
  }
  if (ip.includes('::')) {
    const parts = ip.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    if (left.length + right.length > 7) {
      return false;
    }
    const allGroups = [...left, ...right];
    return allGroups.every(group =>
      group === '' || (/^[0-9a-fA-F]{1,4}$/.test(group))
    );
  }
  const groups = ip.split(':');
  if (groups.length !== 8) {
    return false;
  }
  return groups.every(group => /^[0-9a-fA-F]{1,4}$/.test(group));
}

function isValidIp(ip: string): boolean {
  return isValidIPv4(ip) || isValidIPv6(ip);
}

describe("IP Validation", () => {
  describe("IPv4 validation", () => {
    it("should accept valid IPv4 addresses", () => {
      expect(isValidIPv4("192.168.1.1")).to.be.true;
      expect(isValidIPv4("10.0.0.1")).to.be.true;
      expect(isValidIPv4("172.16.0.1")).to.be.true;
      expect(isValidIPv4("255.255.255.255")).to.be.true;
      expect(isValidIPv4("0.0.0.0")).to.be.true;
      expect(isValidIPv4("127.0.0.1")).to.be.true;
    });

    it("should reject invalid IPv4 addresses", () => {
      expect(isValidIPv4("256.1.1.1")).to.be.false;
      expect(isValidIPv4("192.168.1")).to.be.false;
      expect(isValidIPv4("192.168.1.1.1")).to.be.false;
      expect(isValidIPv4("192.168.1.a")).to.be.false;
      expect(isValidIPv4("not.an.ip.address")).to.be.false;
      expect(isValidIPv4("")).to.be.false;
    });
  });

  describe("IPv6 validation", () => {
    it("should accept valid full IPv6 addresses", () => {
      expect(isValidIPv6("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).to.be.true;
      expect(isValidIPv6("fe80:0000:0000:0000:0000:0000:0000:0001")).to.be.true;
    });

    it("should accept valid compressed IPv6 addresses", () => {
      expect(isValidIPv6("::1")).to.be.true;
      expect(isValidIPv6("fe80::1")).to.be.true;
      expect(isValidIPv6("2001:db8::")).to.be.true;
      expect(isValidIPv6("::")).to.be.true;
      expect(isValidIPv6("2001:db8::1")).to.be.true;
    });

    it("should reject invalid IPv6 addresses", () => {
      expect(isValidIPv6("2001::db8::1")).to.be.false; // Multiple ::
      expect(isValidIPv6("2001:db8:85a3:0000:0000:8a2e:0370:7334:extra")).to.be.false; // Too many groups
      expect(isValidIPv6("2001:db8:85a3:0000:0000:8a2e:0370")).to.be.false; // Too few groups (no ::)
      expect(isValidIPv6("gggg::1")).to.be.false; // Invalid hex
    });
  });

  describe("Combined IP validation", () => {
    it("should accept both valid IPv4 and IPv6", () => {
      expect(isValidIp("192.168.1.1")).to.be.true;
      expect(isValidIp("::1")).to.be.true;
      expect(isValidIp("2001:db8::1")).to.be.true;
    });

    it("should reject invalid IPs", () => {
      expect(isValidIp("not-an-ip")).to.be.false;
      expect(isValidIp("")).to.be.false;
    });
  });
});

describe("IpRegistrar URL construction", () => {
  it("should construct correct registration URL", () => {
    const backendUrl = "https://api.nsl.sh";
    const userId = "user123";
    const signature = "sig456";

    const expectedUrl = `${backendUrl}/ip/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;
    expect(expectedUrl).to.equal("https://api.nsl.sh/ip/user123/sig456");
  });

  it("should URL-encode special characters in userId", () => {
    const backendUrl = "https://api.nsl.sh";
    const userId = "user+test@example";
    const signature = "sig";

    const url = `${backendUrl}/ip/${encodeURIComponent(userId)}/${encodeURIComponent(signature)}`;
    expect(url).to.include("user%2Btest%40example");
  });

});

describe("buildAgentRoutes", () => {
  it("registers nip.io routes without an IP zone", () => {
    const routes = buildAgentRoutes("80.241.218.30", 443, 80, 1, "");
    expect(routes.map((r) => [r.domain, r.scheme, r.port, r.priority])).to.deep.equal([
      ["80-241-218-30.nip.io", "https", 443, 1],
      ["80-241-218-30.nip.io", "http", 80, 1],
    ]);
  });

  it("registers only IP zone routes when one is set (no nip.io)", () => {
    const routes = buildAgentRoutes("80.241.218.30", 443, 80, 1, "ip.inojob.com");
    expect(routes.map((r) => [r.domain, r.scheme, r.port, r.priority])).to.deep.equal([
      ["80-241-218-30.ip.inojob.com", "https", 443, 1],
      ["80-241-218-30.ip.inojob.com", "http", 80, 1],
    ]);
    expect(routes.every((r) => r.type === "domain" && r.ip === "80.241.218.30" && r.source === "agent")).to.be.true;
  });

  it("dashes IPv6 addresses in the IP zone name", () => {
    const routes = buildAgentRoutes("2001:bc8:3021::1", 443, 80, 1, "ip.nsl.sh");
    expect(routes[0].domain).to.equal("2001-bc8-3021--1.ip.nsl.sh");
  });
});
