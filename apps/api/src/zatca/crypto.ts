import { X509Certificate, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { bitString, explicit, implicitConstructed, integer, octets, oid, parse, pem, printable, seq, set, unpem, utcTime, utf8, type Der } from './der.js';

/*
 * ZATCA phase 2 cryptography: secp256k1 keys, the certificate signing request
 * ZATCA's onboarding expects, reading the certificates it returns, and ECDSA
 * signatures. Following ZATCA's "E-invoice Security Features Implementation
 * Standards" and the CSR configuration of its SDK.
 */

export type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';

/** certificateTemplateName per environment. */
const TEMPLATE: Record<ZatcaEnvironment, string> = {
  sandbox: 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
};

const OID = {
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  country: '2.5.4.6',
  org: '2.5.4.10',
  orgUnit: '2.5.4.11',
  commonName: '2.5.4.3',
  serialNumber: '2.5.4.4', // ZATCA uses "SN" (surname OID) for the EGS serial
  uid: '0.9.2342.19200300.100.1.1',
  title: '2.5.4.12',
  registeredAddress: '2.5.4.26',
  businessCategory: '2.5.4.15',
  extensionRequest: '1.2.840.113549.1.9.14',
  certificateTemplateName: '1.3.6.1.4.1.311.20.2',
  subjectAltName: '2.5.29.17',
};

export function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

const rdn = (type: string, value: Der) => set(seq(oid(type), value));

export interface CsrInput {
  privateKeyPem: string;
  environment: ZatcaEnvironment;
  /** Common name: a unique name for this EGS unit. */
  commonName: string;
  /** Legal name of the taxpayer. */
  organizationName: string;
  /** Branch name; for a VAT group, the 10-digit TIN. */
  organizationUnit: string;
  /** "1-<solution>|2-<model/version>|3-<unique serial>" */
  egsSerial: string;
  vatNumber: string;
  /** Four flags: standard, simplified, (reserved), (reserved). "1100" = both. */
  invoiceTypes: string;
  /** Branch address (registeredAddress), e.g. "RRRD2929, Riyadh". */
  location: string;
  /** Business category (industry). */
  industry: string;
}

/** A PKCS#10 request with ZATCA's template name and EGS details in the subject alternative name. */
export function buildCsr(i: CsrInput): { pem: string; base64ForApi: string } {
  const privateKey = createPrivateKey(i.privateKeyPem);
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const subject = seq(rdn(OID.country, printable('SA')), rdn(OID.orgUnit, utf8(i.organizationUnit)), rdn(OID.org, utf8(i.organizationName)), rdn(OID.commonName, utf8(i.commonName)));
  const dirName = seq(rdn(OID.serialNumber, utf8(i.egsSerial)), rdn(OID.uid, utf8(i.vatNumber)), rdn(OID.title, utf8(i.invoiceTypes)), rdn(OID.registeredAddress, utf8(i.location)), rdn(OID.businessCategory, utf8(i.industry)));
  const extensions = seq(
    seq(oid(OID.certificateTemplateName), octets(printable(TEMPLATE[i.environment]))),
    seq(oid(OID.subjectAltName), octets(seq(implicitConstructed(4, dirName)))),
  );
  const attributes = implicitConstructed(0, seq(oid(OID.extensionRequest), set(extensions)));
  const info = seq(integer(0), subject, spki, attributes);
  const signature = sign('sha256', info, privateKey); // DER-encoded ECDSA
  const der = seq(info, seq(oid(OID.ecdsaSha256)), bitString(signature));
  const text = pem('CERTIFICATE REQUEST', der);
  return { pem: text, base64ForApi: Buffer.from(text).toString('base64') };
}

export interface CertInfo {
  /** The certificate as base64 DER (the text ZATCA puts in X509Certificate). */
  base64: string;
  /** Issuer as ZATCA writes it: "CN=…, DC=…". */
  issuer: string;
  /** Serial number in decimal. */
  serialNumber: string;
  /** base64 of the hex SHA-256 of the base64 text (ZATCA's certificate digest). */
  digest: string;
  /** SubjectPublicKeyInfo DER (QR tag 8). */
  publicKeyDer: Buffer;
  /** The CA's signature over the certificate (QR tag 9). */
  signature: Buffer;
  notAfter: Date;
  publicKey: KeyObject;
}

/** ZATCA returns binarySecurityToken = base64(base64 certificate). */
export const certFromToken = (binarySecurityToken: string) => Buffer.from(binarySecurityToken, 'base64').toString('utf8');

export function readCert(base64Cert: string): CertInfo {
  const clean = base64Cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Buffer.from(clean, 'base64');
  const x = new X509Certificate(der);
  const top = parse(der);
  const sigBits = top.children[2]!.value; // BIT STRING: unused-bits byte, then the signature
  return {
    base64: clean,
    issuer: x.issuer.split('\n').reverse().join(', '),
    serialNumber: BigInt(`0x${x.serialNumber}`).toString(10),
    digest: Buffer.from(createHash('sha256').update(clean).digest('hex')).toString('base64'),
    publicKeyDer: x.publicKey.export({ type: 'spki', format: 'der' }),
    signature: sigBits.subarray(1),
    notAfter: new Date(x.validTo),
    publicKey: x.publicKey,
  };
}

/** ECDSA (secp256k1, SHA-256) over the invoice hash bytes, DER, base64. */
export function signHash(hashBase64: string, privateKeyPem: string): string {
  return sign('sha256', Buffer.from(hashBase64, 'base64'), createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyHash(hashBase64: string, signatureBase64: string, publicKey: KeyObject): boolean {
  return verify('sha256', Buffer.from(hashBase64, 'base64'), publicKey, Buffer.from(signatureBase64, 'base64'));
}

// ---------------------------------------------------------------------------
// Simulated mode: a local test CA that signs CSRs the way ZATCA's would.
// ---------------------------------------------------------------------------

export interface TestCa {
  keyPem: string;
  name: Der;
}

/** The simulated ZATCA's CA key. Test-only: certificates it signs mean nothing outside simulated mode. */
const TEST_CA_KEY = `-----BEGIN PRIVATE KEY-----
MIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQg26usbm4ABxSCIhE0qovi
QaRmnnAKpy0RIbV/LBvSAp+hRANCAATEpNsw+Mcrat3iHTFZB9J1JZAibfDIrc6f
9Sw929mI/BxEOnD2P6uT7D/F+hy4bkI5Gj2bypgUi7ksUQlwOjZU
-----END PRIVATE KEY-----`;

export function createTestCa(): TestCa {
  return { keyPem: TEST_CA_KEY, name: seq(rdn('0.9.2342.19200300.100.1.25', utf8('local')), rdn('0.9.2342.19200300.100.1.25', utf8('backhouse')), rdn(OID.commonName, utf8('Backhouse-Simulated-ZATCA-CA'))) };
}

/** Issue a certificate for a subject and public key (simulated onboarding). */
export function issueTestCert(ca: TestCa, subject: Buffer, spki: Buffer, days = 365): string {
  const now = new Date();
  const tbs = seq(
    explicit(0, integer(2)),
    integer(randomBytes(8)),
    seq(oid(OID.ecdsaSha256)),
    ca.name,
    seq(utcTime(new Date(now.getTime() - 60_000)), utcTime(new Date(now.getTime() + days * 86_400_000))),
    subject,
    spki,
  );
  const signature = sign('sha256', tbs, createPrivateKey(ca.keyPem));
  return seq(tbs, seq(oid(OID.ecdsaSha256)), bitString(signature)).toString('base64');
}

/** Subject and public key of a certificate (DER, base64). */
export function certSubjectAndKey(base64Cert: string) {
  const tbs = parse(Buffer.from(base64Cert, 'base64')).children[0]!;
  return { subject: tbs.children[5]!.raw, spki: tbs.children[6]!.raw };
}

/** True if the certificate was signed by the CA. */
export function signedBy(base64Cert: string, ca: TestCa): boolean {
  const top = parse(Buffer.from(base64Cert, 'base64'));
  return verify('sha256', top.children[0]!.raw, createPublicKey(createPrivateKey(ca.keyPem)), top.children[2]!.value.subarray(1));
}

/** Read the EGS details back out of a CSR (used by the simulated ZATCA). */
export function readCsr(csrPem: string) {
  const csr = parse(unpem(csrPem));
  const info = csr.children[0]!;
  const spki = info.children[2]!.raw;
  const ok = verify('sha256', info.raw, createPublicKey({ key: spki, format: 'der', type: 'spki' }), csr.children[2]!.value.subarray(1));
  return { signatureValid: ok, subject: info.children[1]!.raw, spki };
}
