import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';

/** AES-256-GCM sealing for third-party tokens kept in the database. */
export class Sealer {
  private readonly key: Buffer;
  constructor(config: AppConfig, purpose: string) {
    const secret = config.INTEGRATIONS_SECRET_KEY ?? config.ZATCA_SECRET_KEY ?? `${purpose}:${config.JWT_ACCESS_SECRET}`;
    this.key = createHash('sha256').update(`${purpose}:${secret}`).digest();
  }
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
  }
  open(sealed: string): string {
    const [, iv, tag, ct] = sealed.split(':');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv!, 'base64'));
    d.setAuthTag(Buffer.from(tag!, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct!, 'base64')), d.final()]).toString('utf8');
  }
}
