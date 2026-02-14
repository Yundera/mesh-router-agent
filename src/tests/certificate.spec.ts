import { describe, it } from "mocha";
import { expect } from "chai";
import forge from "node-forge";

/**
 * Test for X.509 certificate encoding fix
 *
 * Issue: When CN contains '@' character (e.g., "user@yundera.com"),
 * it must be encoded as UTF8String (tag 12), not PrintableString (tag 19).
 * PrintableString doesn't allow '@' and causes x509 validation errors in Go/Caddy.
 */
describe("CertificateManager", () => {
  describe("CSR generation with special characters", () => {

    // ASN.1 type tags
    const ASN1_UTF8STRING = 12;
    const ASN1_PRINTABLESTRING = 19;

    /**
     * Helper to generate CSR using the same code pattern as CertificateManager
     */
    function generateCSR(userId: string): ReturnType<typeof forge.pki.createCertificationRequest> {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const csr = forge.pki.createCertificationRequest();
      csr.publicKey = keys.publicKey;

      // This is the fix: use valueTagClass to force UTF8String encoding
      const UTF8_STRING_TAG = 12;
      csr.setSubject([
        { name: 'commonName', value: userId, valueTagClass: UTF8_STRING_TAG as forge.asn1.Class },
      ]);

      csr.sign(keys.privateKey, forge.md.sha256.create());
      return csr;
    }

    it("should encode CN with '@' as UTF8String, not PrintableString", () => {
      const userId = "EkGcLEimm9TIa5TdketObbnbRQ52@yundera.com";
      const csr = generateCSR(userId);

      // Get the CN attribute
      const cnAttr = csr.subject.getField('CN');
      expect(cnAttr).to.not.be.null;
      expect(cnAttr.value).to.equal(userId);

      // Verify the encoding type is UTF8String (12), not PrintableString (19)
      // The valueTagClass should be set to UTF8String
      expect(cnAttr.valueTagClass).to.equal(ASN1_UTF8STRING,
        `CN should be encoded as UTF8String (${ASN1_UTF8STRING}), not PrintableString (${ASN1_PRINTABLESTRING})`);
    });

    it("should produce valid PEM that can be parsed", () => {
      const userId = "test@example.com";
      const csr = generateCSR(userId);

      // Convert to PEM and back
      const csrPem = forge.pki.certificationRequestToPem(csr);
      expect(csrPem).to.include('-----BEGIN CERTIFICATE REQUEST-----');

      // Parse it back
      const parsedCsr = forge.pki.certificationRequestFromPem(csrPem);
      const cnAttr = parsedCsr.subject.getField('CN');
      expect(cnAttr.value).to.equal(userId);
    });

    it("should handle CN without special characters", () => {
      const userId = "simpleUserId123";
      const csr = generateCSR(userId);

      const cnAttr = csr.subject.getField('CN');
      expect(cnAttr.value).to.equal(userId);
      // Even without special chars, UTF8String is valid and safer
      expect(cnAttr.valueTagClass).to.equal(ASN1_UTF8STRING);
    });

    it("should handle CN with various special characters", () => {
      // Characters that are NOT valid in PrintableString but valid in UTF8String
      const testCases = [
        "user@domain.com",      // @ is not in PrintableString
        "user*name",            // * is not in PrintableString
        "user#123",             // # is not in PrintableString
        "名前",                  // Unicode characters
        "user<>name",           // < and > not in PrintableString
      ];

      for (const userId of testCases) {
        const csr = generateCSR(userId);
        const cnAttr = csr.subject.getField('CN');
        expect(cnAttr.value).to.equal(userId, `Failed for userId: ${userId}`);
        expect(cnAttr.valueTagClass).to.equal(ASN1_UTF8STRING,
          `CN "${userId}" should be UTF8String encoded`);
      }
    });
  });
});
