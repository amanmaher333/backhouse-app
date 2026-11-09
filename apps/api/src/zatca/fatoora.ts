import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { certFromToken, certSubjectAndKey, createTestCa, issueTestCert, readCert, readCsr, signedBy, verifyHash, type TestCa, type ZatcaEnvironment } from './crypto.js';
import { readQr } from './ubl.js';

/*
 * ZATCA's Fatoora e-invoicing API (the "Developer Portal" sandbox, simulation and
 * core/production), and a simulated stand-in that signs certificates with a local
 * test CA and checks invoices locally.
 */

export const FATOORA_URLS: Record<ZatcaEnvironment, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

export interface Credentials {
  binarySecurityToken: string;
  secret: string;
}
export interface CsidResponse extends Credentials {
  requestID: string | number;
  dispositionMessage?: string;
}
export interface ValidationResults {
  status: 'PASS' | 'WARNING' | 'ERROR' | string;
  infoMessages?: unknown;
  warningMessages?: { code?: string; message?: string; category?: string }[];
  errorMessages?: { code?: string; message?: string; category?: string }[];
}
export interface SubmitResponse {
  httpStatus: number;
  validationResults?: ValidationResults;
  clearanceStatus?: string;
  reportingStatus?: string;
  clearedInvoice?: string;
  raw: unknown;
}
export interface SubmitBody {
  invoiceHash: string;
  uuid: string;
  invoice: string; // base64 XML
}

/** Errors from ZATCA's side that are worth retrying (unavailable, timeouts, rate limits). */
export class FatooraUnavailable extends Error {}
export class FatooraRejected extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface Fatoora {
  readonly mode: 'live' | 'simulated';
  compliance(env: ZatcaEnvironment, csrBase64: string, otp: string): Promise<CsidResponse>;
  complianceCheck(env: ZatcaEnvironment, creds: Credentials, body: SubmitBody): Promise<SubmitResponse>;
  productionCsid(env: ZatcaEnvironment, creds: Credentials, complianceRequestId: string): Promise<CsidResponse>;
  clearance(env: ZatcaEnvironment, creds: Credentials, body: SubmitBody): Promise<SubmitResponse>;
  reporting(env: ZatcaEnvironment, creds: Credentials, body: SubmitBody): Promise<SubmitResponse>;
}

const basic = (c: Credentials) => `Basic ${Buffer.from(`${c.binarySecurityToken}:${c.secret}`).toString('base64')}`;

export class HttpFatoora implements Fatoora {
  readonly mode = 'live' as const;
  constructor(private readonly timeoutMs = 30_000) {}

  private async call(env: ZatcaEnvironment, path: string, init: { method?: string; headers: Record<string, string>; body: unknown }) {
    let res: Response;
    try {
      res = await fetch(`${FATOORA_URLS[env]}${path}`, {
        method: init.method ?? 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Version': 'V2', 'Accept-Language': 'en', ...init.headers },
        body: JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new FatooraUnavailable(`ZATCA could not be reached (${(e as Error).message})`);
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* plain text error */
    }
    if (res.status === 429 || res.status >= 500) throw new FatooraUnavailable(`ZATCA is unavailable (HTTP ${res.status})`);
    return { status: res.status, data };
  }

  private csid(r: { status: number; data: any }, what: string): CsidResponse {
    if (r.status !== 200 || !r.data?.binarySecurityToken) {
      const msg = r.data?.errors?.map?.((e: any) => e.message ?? e).join('; ') || r.data?.message || (typeof r.data === 'string' ? r.data : '') || `HTTP ${r.status}`;
      throw new FatooraRejected(`${what} refused: ${msg}`, r.status, r.data);
    }
    return r.data as CsidResponse;
  }

  private submitted(r: { status: number; data: any }): SubmitResponse {
    if (r.status === 401) throw new FatooraRejected('ZATCA did not accept the certificate (401)', 401, r.data);
    return { httpStatus: r.status, validationResults: r.data?.validationResults, clearanceStatus: r.data?.clearanceStatus, reportingStatus: r.data?.reportingStatus, clearedInvoice: r.data?.clearedInvoice, raw: r.data };
  }

  async compliance(env: ZatcaEnvironment, csrBase64: string, otp: string) {
    return this.csid(await this.call(env, '/compliance', { headers: { OTP: otp }, body: { csr: csrBase64 } }), 'Compliance certificate');
  }
  async complianceCheck(env: ZatcaEnvironment, creds: Credentials, body: SubmitBody) {
    return this.submitted(await this.call(env, '/compliance/invoices', { headers: { Authorization: basic(creds) }, body }));
  }
  async productionCsid(env: ZatcaEnvironment, creds: Credentials, complianceRequestId: string) {
    return this.csid(await this.call(env, '/production/csids', { headers: { Authorization: basic(creds) }, body: { compliance_request_id: String(complianceRequestId) } }), 'Production certificate');
  }
  async clearance(env: ZatcaEnvironment, creds: Credentials, body: SubmitBody) {
    return this.submitted(await this.call(env, '/invoices/clearance/single', { headers: { Authorization: basic(creds), 'Clearance-Status': '1' }, body }));
  }
  async reporting(env: ZatcaEnvironment, creds: Credentials, body: SubmitBody) {
    return this.submitted(await this.call(env, '/invoices/reporting/single', { headers: { Authorization: basic(creds), 'Clearance-Status': '0' }, body }));
  }
}

/**
 * Simulated ZATCA: issues certificates from a local test CA (any 6-digit OTP works,
 * "000000" is refused), and checks the hash, signature, chain fields and QR code of
 * submitted documents. Standard invoices are "cleared" as submitted.
 */
export class SimulatedFatoora implements Fatoora {
  readonly mode = 'simulated' as const;
  private readonly ca: TestCa = createTestCa();
  /** Set to make the next N calls fail as unavailable (tests). */
  failNext = 0;

  /** Stateless, so the API and the worker agree: the secret is derived from the token and the certificate kind. */
  private secretFor(token: string, production: boolean) {
    return createHash('sha256').update(`${production ? 'production' : 'compliance'}:${token}`).digest('base64').slice(0, 32);
  }
  private issue(subject: Buffer, spki: Buffer, production: boolean): CsidResponse {
    const token = Buffer.from(issueTestCert(this.ca, subject, spki)).toString('base64');
    return { binarySecurityToken: token, secret: this.secretFor(token, production), requestID: String(Date.now()) + String(Math.floor(Math.random() * 1000)), dispositionMessage: 'ISSUED' };
  }
  private auth(c: Credentials, production: boolean) {
    const cert = certFromToken(c.binarySecurityToken);
    if (c.secret !== this.secretFor(c.binarySecurityToken, production) || !signedBy(cert, this.ca)) throw new FatooraRejected('ZATCA did not accept the certificate (401)', 401, null);
    return cert;
  }
  private unavailable() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new FatooraUnavailable('ZATCA is unavailable (simulated)');
    }
  }

  async compliance(_env: ZatcaEnvironment, csrBase64: string, otp: string) {
    this.unavailable();
    if (!/^\d{6}$/.test(otp) || otp === '000000') throw new FatooraRejected('Compliance certificate refused: Invalid-OTP', 400, null);
    const csr = readCsr(Buffer.from(csrBase64, 'base64').toString('utf8'));
    if (!csr.signatureValid) throw new FatooraRejected('Compliance certificate refused: Invalid-CSR', 400, null);
    return this.issue(csr.subject, csr.spki, false);
  }

  async productionCsid(_env: ZatcaEnvironment, creds: Credentials, _complianceRequestId?: string) {
    this.unavailable();
    const { subject, spki } = certSubjectAndKey(this.auth(creds, false));
    return this.issue(subject, spki, true);
  }

  private check(body: SubmitBody): ValidationResults {
    const errors: { code: string; message: string }[] = [];
    const xml = Buffer.from(body.invoice, 'base64').toString('utf8');
    const doc = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(xml);
    const inv = doc.Invoice;
    if (!inv) return { status: 'ERROR', errorMessages: [{ code: 'XSD', message: 'Not an invoice' }] };
    const sig = inv.UBLExtensions?.UBLExtension?.ExtensionContent?.UBLDocumentSignatures?.SignatureInformation?.Signature;
    const refs = [].concat(sig?.SignedInfo?.Reference ?? []) as any[];
    const digest = refs.find((r) => r['@_Id'] === 'invoiceSignedData')?.DigestValue;
    if (digest !== body.invoiceHash) errors.push({ code: 'invoiceHash', message: 'The hash in the request does not match the signed hash' });
    const certText = sig?.KeyInfo?.X509Data?.X509Certificate;
    try {
      const cert = readCert(String(certText));
      if (!verifyHash(body.invoiceHash, String(sig?.SignatureValue), cert.publicKey)) errors.push({ code: 'signature', message: 'Invalid signature' });
    } catch {
      errors.push({ code: 'certificate', message: 'Invalid certificate' });
    }
    if (inv.UUID !== body.uuid) errors.push({ code: 'uuid', message: 'UUID does not match' });
    const adr = [].concat(inv.AdditionalDocumentReference ?? []) as any[];
    for (const id of ['ICV', 'PIH', 'QR']) if (!adr.some((a) => a.ID === id)) errors.push({ code: id, message: `${id} is missing` });
    const qr = adr.find((a) => a.ID === 'QR')?.Attachment?.EmbeddedDocumentBinaryObject?.['#text'];
    if (qr && readQr(qr)[5]?.toString() !== body.invoiceHash) errors.push({ code: 'QR', message: 'QR hash does not match' });
    return errors.length ? { status: 'ERROR', errorMessages: errors, warningMessages: [] } : { status: 'PASS', errorMessages: [], warningMessages: [] };
  }

  async complianceCheck(_env: ZatcaEnvironment, creds: Credentials, body: SubmitBody) {
    this.unavailable();
    this.auth(creds, false);
    const v = this.check(body);
    const standard = Buffer.from(body.invoice, 'base64').toString('utf8').includes('name="01');
    return { httpStatus: v.status === 'ERROR' ? 400 : 200, validationResults: v, ...(standard ? { clearanceStatus: v.status === 'ERROR' ? 'NOT_CLEARED' : 'CLEARED' } : { reportingStatus: v.status === 'ERROR' ? 'NOT_REPORTED' : 'REPORTED' }), raw: v };
  }
  async clearance(_env: ZatcaEnvironment, creds: Credentials, body: SubmitBody) {
    this.unavailable();
    this.auth(creds, true);
    const v = this.check(body);
    return { httpStatus: v.status === 'ERROR' ? 400 : 200, validationResults: v, clearanceStatus: v.status === 'ERROR' ? 'NOT_CLEARED' : 'CLEARED', clearedInvoice: v.status === 'ERROR' ? undefined : body.invoice, raw: v };
  }
  async reporting(_env: ZatcaEnvironment, creds: Credentials, body: SubmitBody) {
    this.unavailable();
    this.auth(creds, true);
    const v = this.check(body);
    return { httpStatus: v.status === 'ERROR' ? 400 : 200, validationResults: v, reportingStatus: v.status === 'ERROR' ? 'NOT_REPORTED' : 'REPORTED', raw: v };
  }
}

