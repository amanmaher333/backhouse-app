'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useI18n, type TKey } from '@/lib/i18n';
import type { SaleStatus } from '@/lib/types-sales';

export function SaleStatusTag({ status }: { status: SaleStatus }) {
  const { t } = useI18n();
  const tone = ['cleared', 'reported'].includes(status) ? 'tag-accent' : ['rejected', 'issued'].includes(status) ? 'tag-late' : '';
  return (
    <span className={`tag ${tone}`}>
      <span className="dot" />
      {t(`sale_${status}` as TKey)}
    </span>
  );
}

/** The ZATCA QR code (TLV, base64) as an SVG. */
export function ZatcaQr({ value, size = 148 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(value, { type: 'svg', margin: 1, width: size, errorCorrectionLevel: 'M' }).then(setSvg);
  }, [value, size]);
  return <div className="invoice-qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
