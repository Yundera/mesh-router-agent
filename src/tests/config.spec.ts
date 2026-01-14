import { describe, it } from "mocha";
import { expect } from "chai";
import { parseProvider } from "../config/EnvConfig.js";

describe("EnvConfig", () => {
  describe("parseProvider", () => {
    it("should parse valid provider string", () => {
      const providerString = "https://api.nsl.sh,userid123,signature456";
      const result = parseProvider(providerString);

      expect(result.backendUrl).to.equal("https://api.nsl.sh");
      expect(result.userId).to.equal("userid123");
      expect(result.signature).to.equal("signature456");
    });

    it("should parse provider string with http", () => {
      const providerString = "http://localhost:8192,userid,sig";
      const result = parseProvider(providerString);

      expect(result.backendUrl).to.equal("http://localhost:8192");
      expect(result.userId).to.equal("userid");
      expect(result.signature).to.equal("sig");
    });

    it("should handle signature with special base36 characters", () => {
      const longSignature = "kq45ftriuzor5qniahcudmiw8j7z7jtuk47p12xuqg79yuump1qfbo0glmufk65mptsjf5ewya69volgdtbnlgalp2wm577v1se8";
      const providerString = `https://nsl.sh,n5ZeDHHZ59f9GF0eIaiAU8Mnqjr1,${longSignature}`;
      const result = parseProvider(providerString);

      expect(result.backendUrl).to.equal("https://nsl.sh");
      expect(result.userId).to.equal("n5ZeDHHZ59f9GF0eIaiAU8Mnqjr1");
      expect(result.signature).to.equal(longSignature);
    });

    it("should throw error for missing backend URL", () => {
      const providerString = ",userid,signature";
      expect(() => parseProvider(providerString)).to.throw(
        "Invalid PROVIDER format"
      );
    });

    it("should throw error for missing user ID", () => {
      const providerString = "https://api.nsl.sh,,signature";
      expect(() => parseProvider(providerString)).to.throw(
        "Invalid PROVIDER format"
      );
    });

    it("should throw error for missing signature", () => {
      const providerString = "https://api.nsl.sh,userid,";
      expect(() => parseProvider(providerString)).to.throw(
        "Invalid PROVIDER format"
      );
    });

    it("should throw error for non-http URL", () => {
      const providerString = "ftp://api.nsl.sh,userid,signature";
      expect(() => parseProvider(providerString)).to.throw(
        "backend_url must start with http"
      );
    });

    it("should throw error for empty string", () => {
      expect(() => parseProvider("")).to.throw("Invalid PROVIDER format");
    });

    it("should throw error for string with only commas", () => {
      expect(() => parseProvider(",,")).to.throw("Invalid PROVIDER format");
    });

    it("should throw error for string with only two parts", () => {
      const providerString = "https://api.nsl.sh,userid";
      expect(() => parseProvider(providerString)).to.throw(
        "Invalid PROVIDER format"
      );
    });
  });
});
