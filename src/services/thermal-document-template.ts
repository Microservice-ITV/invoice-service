import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const loadMyanmarFont = (): string => {
  const fontPaths = [
    join(process.cwd(), 'assets', 'fonts', 'myanmar', 'NotoSansMyanmar.ttf'),
    join(process.cwd(), 'src', 'assets', 'fonts', 'myanmar', 'NotoSansMyanmar.ttf'),
  ];

  for (const fontPath of fontPaths) {
    try {
      return readFileSync(fontPath).toString('base64');
    } catch {
      // Try the next supported font location.
    }
  }

  throw new Error('Noto Sans Myanmar font file was not found');
};

const MYANMAR_FONT_BASE64 = loadMyanmarFont();

export type ThermalDocumentWidth = '58mm' | '80mm';

export const DEFAULT_THERMAL_SELLER_MESSAGE = 'Customers may inspect the package before making payment, subject to the delivery provider’s inspection policy.';

export interface ThermalLineItem {
  name?: string | null;
  sku?: string | null;
  variantName?: string | null;
  color?: string | null;
  size?: string | null;
  quantity: number;
  unitPrice?: string | number | null;
  total: string | number;
}

export interface ThermalInvoiceData {
  invoiceId: string;
  invoiceNumber: string;
  orderReference: string | null;
  shopName?: string | null;
  shopContactPhone?: string | null;
  shopAddress?: Record<string, unknown> | string | null;
  currency: string;
  subtotal: string;
  taxAmount: string;
  deliveryFee: string;
  discountAmount: string;
  grandTotal: string;
  createdAt: Date | string;
  paymentMethod?: string | null;
  status?: string | null;
  paymentGatewayRef?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  shippingAddress?: Record<string, unknown> | string | null;
  sellerMessage?: string | null;
  lineItems?: ThermalLineItem[] | null;
}

export interface ThermalOtherCharge {
  label: string;
  amount: string | number;
}

export interface ThermalReceiptData {
  receiptId: string;
  receiptNumber: string;
  invoiceNumber: string;
  orderReference: string | null;
  shopName?: string | null;
  currency: string;
  subtotal: string;
  deliveryFee: string;
  taxAmount: string;
  discountAmount: string;
  grandTotal: string;
  issuedAt: Date | string;
  paymentMethod?: string | null;
  paymentGatewayRef?: string | null;
  status?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  shippingAddress?: Record<string, unknown> | string | null;
  sellerMessage?: string | null;
  lineItems?: ThermalLineItem[] | null;
}

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const clean = (value: string | null | undefined): string => value?.trim() ?? '';

const thermalSizeLabel = (value: string | null | undefined): string => {
  const raw = clean(value);
  if (!raw) return '';
  const normalized = raw.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  const labels: Record<string, string> = {
    xs: 'XS', sm: 'S', s: 'S', small: 'S',
    md: 'M', m: 'M', medium: 'M',
    lg: 'L', l: 'L', large: 'L',
    xl: 'XL', 'x large': 'XL', 'extra large': 'XL',
    '2xl': '2XL', xxl: '2XL', '3xl': '3XL', xxxl: '3XL',
    '4xl': '4XL', xxxxl: '4XL',
  };
  return labels[normalized] ?? raw;
};

const withDocumentPrefix = (value: string | null | undefined, code: 'INV' | 'REC'): string => {
  const raw = clean(value);
  if (!raw) return '';
  const withoutDni = raw.replace(/^DNI-/i, '');
  const withCode = new RegExp(`^${code}-`, 'i').test(withoutDni) ? withoutDni : `${code}-${withoutDni}`;
  return `DNI-${withCode}`;
};

const formatDateTime = (value: Date | string | null | undefined): string => {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yangon',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Yangon',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${formatter.format(date)}, ${timeFormatter.format(date)}`;
};

const defaultSellerMessage = (): string => DEFAULT_THERMAL_SELLER_MESSAGE;

const resolveSellerMessage = (value?: string | null): string => {
  const cleaned = String(value ?? '').replace(/\r\n/g, '\n').trim();
  return cleaned || defaultSellerMessage();
};

const formatAmountText = (value: string | number | null | undefined, currency: string): string => {
  const amount = Number(value);
  const formatted = Number.isFinite(amount)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(amount)
    : '—';
  return `${clean(currency) || 'MMK'} ${formatted}`;
};

const formatAmount = (value: string | number | null | undefined, currency: string): string =>
  escapeHtml(formatAmountText(value, currency));

const addressLines = (address: ThermalInvoiceData['shippingAddress']): string[] => {
  if (!address) return [];
  const keys = [
    'address_line_1', 'addressLine1', 'address_line_2', 'addressLine2', 'ward', 'ward_name', 'wardName',
    'township', 'township_name', 'townshipName', 'district', 'district_name', 'districtName', 'city',
    'city_name', 'cityName', 'state', 'state_name', 'stateName', 'region', 'region_name', 'regionName',
    'location', 'location_name', 'locationName', 'postal_code', 'postalCode', 'country', 'country_name', 'countryName',
  ];
  const values = typeof address === 'string' ? address.split(/\r?\n/) : keys.map((key) => address[key]);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = typeof raw === 'string' || typeof raw === 'number'
      ? String(raw)
      : raw && typeof raw === 'object'
        ? ['name', 'label', 'value'].map((key) => (raw as Record<string, unknown>)[key]).find((part) => typeof part === 'string')
        : null;
    if (typeof value !== 'string') continue;
    for (const part of value.split(/\r?\n/)) {
      const line = part.replace(/\s+/g, ' ').trim();
      const dedupeKey = line.normalize('NFKC').toLowerCase();
      if (line && !seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        lines.push(line);
      }
    }
  }
  return lines;
};

const qrImageDataUri = (): string => {
  const image = readFileSync(join(process.cwd(), 'src', 'assets', 'dni_website_qr.png'));
  return `data:image/png;base64,${image.toString('base64')}`;
};

const baseStyles = (width: ThermalDocumentWidth): string => {
  const paperWidth = width === '58mm' ? '58mm' : '80mm';
  const contentWidth = width === '58mm' ? '52mm' : '70mm';
  const sideMargin = width === '58mm' ? '3mm' : '5mm';
  const qrSize = width === '58mm' ? '12mm' : '15mm';
  const type = width === '58mm'
    ? { body: '15px', line: '1.22', brand: '14.5px', tagline: '5.5px', title: '15px', meta: '10.5px', metadata: '8px', section: '12.5px', sectionPadding: '.7mm 1mm', sectionTitleGap: '.5mm', shippingPadding: '.35mm 1mm', address: '10px', addressLine: '1.15', customer: '13px', item: '11.5px', itemLabel: '10px', itemRowPadding: '.6mm 0', amount: '10px', total: '13.5px', qrCaption: '9.5px', footer: '12px', small: '9px', itemAmountWidth: '22mm', itemGap: '.7mm' }
    : { body: '16.5px', line: '1.22', brand: '20px', tagline: '7px', title: '19px', meta: '13px', metadata: '10.5px', section: '14.5px', sectionPadding: '1mm 1.5mm', sectionTitleGap: '.8mm', shippingPadding: '.65mm 1.5mm', address: '11.5px', addressLine: '1.2', customer: '14px', item: '13.5px', itemLabel: '11.5px', itemRowPadding: '.8mm 0', amount: '12px', total: '16px', qrCaption: '11px', footer: '14px', small: '10.5px', itemAmountWidth: '25mm', itemGap: '1.5mm' };
  return `
    @page { size: ${paperWidth} auto; margin: 0; }
    * { box-sizing: border-box; }
    html, body { width: ${paperWidth}; min-height: 0; height: auto; margin: 0; padding: 0; overflow: visible; }
    @font-face {
      font-family: 'Noto Sans Myanmar';
      src: url('data:font/ttf;base64,${MYANMAR_FONT_BASE64}') format('truetype');
      font-style: normal;
      font-weight: 100 900;
      font-display: block;
    }

    body {
      color: #000;
      background: #fff;
      font: ${type.body}/${type.line} 'Noto Sans Myanmar', Arial, Helvetica, sans-serif;
    }

    .thermal-receipt,
    .thermal-receipt * {
      font-family: 'Noto Sans Myanmar', Arial, Helvetica, sans-serif;
    }
    .thermal-receipt { width: ${contentWidth}; margin: 0; padding: 6mm 0; color: #000; background: #fff; overflow: visible; font-size: ${type.body}; }
    header, section, footer { padding: ${type.sectionPadding}; }
    .center { text-align: center; }
    .brand { display: flex; align-items: center; justify-content: center; gap: 2mm; margin: 0 0 1mm; }
    .brand-mark { width: 8mm; height: 8mm; flex: none; }
    .brand-copy { min-width: 0; text-align: left; }
    .store-name { margin: 0; font-size: ${type.brand}; line-height: 1.1; font-weight: 700; letter-spacing: -.3px; }
    .document-title { margin: 1mm 0 1.5mm; font-size: ${type.title}; line-height: 1.15; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; }
    .tagline { margin: 1px 0 0; font-size: ${type.tagline}; line-height: 1.2; letter-spacing: .35px; text-transform: uppercase; }
    .metadata { display: grid; gap: 1px; }
    .meta-row, .total-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.55fr); gap: 1.5mm; align-items: baseline; }
    .meta-label, .label { color: #222; font-size: ${type.meta}; }
    .meta-value, .value { min-width: 0; text-align: left; font-size: ${type.meta}; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; font-family: 'Courier New', Courier, monospace; }
    .meta-row .meta-label, .meta-row .meta-value { font-size: ${type.metadata}; }
    .total-row .value { text-align: right; }
    .bold { font-weight: 700; }
    .divider { border-top: 1px dashed #333; margin: 1.5mm 0; }
    .section-title { margin: 0 0 ${type.sectionTitleGap}; font-size: ${type.section}; font-weight: 700; }
    .customer { font-size: ${type.customer}; font-weight: 400; overflow-wrap: anywhere; }
    .customer-label-row { display: flex; align-items: center; gap: 4px; }
    .customer-icon { width: 12px; height: 12px; flex: none; }
    .customer-label { color: #444; font-size: ${type.meta}; }
    .customer-label-row + .customer { margin-top: 3px; }
    .customer-phone { font-size: ${type.small}; color: #444; overflow-wrap: anywhere; }
    .seller-details { margin-top: 1mm; color: #222; font-size: ${type.small}; line-height: 1.25; overflow-wrap: anywhere; }
    .muted { color: #444; }
    .shipping-section { padding: ${type.shippingPadding}; }
    .shipping-section .section-title { margin-bottom: ${type.sectionTitleGap}; }
    .address { font-size: ${type.address}; overflow-wrap: anywhere; line-height: ${type.addressLine}; }
    .items-heading, .item-wide-row { display: grid; grid-template-columns: minmax(0,1fr) auto minmax(${type.itemAmountWidth},max-content); align-items: baseline; column-gap: ${type.itemGap}; }
    .items-heading { border-bottom: 1px dashed #333; padding: 0 0 1mm; margin-bottom: 1px; font-size: ${type.itemLabel}; font-weight: 700; text-transform: none; }
    .item-block { padding: ${type.itemRowPadding}; break-inside: avoid; page-break-inside: avoid; }
    .item-wide-row, .item-narrow-details { break-inside: avoid; page-break-inside: avoid; }
    .item-wide-row .item-name { display: block; min-width: 0; max-width: 100%; overflow-wrap: anywhere; white-space: normal; word-break: break-word; }
    .item-name { display: block; min-width: 0; max-width: 100%; overflow-wrap: anywhere; white-space: normal; word-break: break-word; }
    .item-qty, .item-amount { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .item-name { font-size: ${type.item}; }
    .item-qty { font-size: ${type.item}; }
    .item-amount { min-width: ${type.itemAmountWidth}; font-size: ${type.amount}; font-weight: 700; }
    .item-narrow-name { font-size: ${type.item}; line-height: 1.2; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    .item-narrow-details { display: flex; justify-content: space-between; align-items: baseline; gap: ${type.itemGap}; }
    .item-narrow-details .item-qty { min-width: 0; font-size: ${type.item}; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    .item-total { white-space: nowrap; text-align: right; font-size: ${type.amount}; font-weight: 700; font-family: 'Courier New', Courier, monospace; font-variant-numeric: tabular-nums; }
    .item-secondary { display: flex; flex-wrap: wrap; justify-content: flex-start; gap: 0 2mm; overflow-wrap: anywhere; color: #444; font-size: ${type.small}; line-height: 1.2; }
    .item-attributes { display: flex; flex-wrap: wrap; column-gap: 2mm; min-width: 0; }
    .item-attribute { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
    .seller-message { white-space: pre-line; overflow-wrap: anywhere; line-height: 1.25; font-size: 9px; color: #444; text-align: center; }
    .totals { display: grid; gap: 1mm; padding-top: 1mm; }
    .double-divider { border-top: 1px dashed #333; margin: 1mm 0; }
    .grand-total .label, .grand-total .value { color: #000; font-size: ${type.total}; font-weight: 700; }
    .grand-total .value { text-align: right; }
    .footer { border-top: 1px dashed #333; text-align: center; }
    .qr-row { display: flex; flex-direction: column; align-items: center; gap: 1mm; margin: 1mm 0; }
    .qr { display: block; flex: none; width: ${qrSize}; height: ${qrSize}; image-rendering: pixelated; }
    .qr-caption { margin: 0; font-size: ${type.qrCaption}; }
    .footer-copy { min-width: 0; display: flex; flex-direction: column; gap: 1mm; overflow-wrap: anywhere; }
    .footer-title { margin: 0; font-size: ${type.footer}; font-weight: 700; }
    .footer-subtitle, .policy { margin: 0; color: #222; font-size: ${type.small}; line-height: 1.25; overflow-wrap: anywhere; }
    .policy { border-top: 1px dashed #333; margin-top: 1mm; padding: 1mm 1.5mm; text-align: center; break-inside: avoid; page-break-inside: avoid; }
    .copyright { margin: 1.5mm 0 0; font-size: ${type.small}; }
    @media print {
      html, body { width: ${paperWidth} !important; height: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; }
      .thermal-receipt { position: absolute; top: 0; left: ${sideMargin}; width: ${contentWidth} !important; break-inside: avoid; page-break-inside: avoid; }
    }
  `;
};

const itemRows = (items: ThermalLineItem[], currency: string, width: ThermalDocumentWidth): string => items.map((item) => {
  const name = escapeHtml(clean(item.name));
  const color = clean(item.color);
  const size = thermalSizeLabel(item.size);
  const variantName = clean(item.variantName);
  const duplicateVariant = variantName && (
    variantName.toLowerCase() === color.toLowerCase()
    || (size && thermalSizeLabel(variantName) === size)
  );
  const metadataParts = [
    color ? `<span class="item-attribute"><strong>Color:</strong> ${escapeHtml(color)}</span>` : '',
    size ? `<span class="item-attribute"><strong>Size:</strong> ${escapeHtml(size)}</span>` : '',
    variantName && !duplicateVariant ? `<span class="item-attribute"><strong>Variant:</strong> ${escapeHtml(variantName)}</span>` : '',
  ].filter(Boolean);
  const secondary = metadataParts.length
    ? `<div class="item-secondary"><div class="item-attributes">${metadataParts.join('')}</div></div>`
    : '';
  const narrowSecondary = metadataParts.length
    ? `<div class="item-secondary"><div class="item-attributes">${metadataParts.join('')}</div></div>`
    : '';

  if (width === '58mm') {
    return `<div class="item-block">
      <div class="item-name item-narrow-name">${name}</div>
      ${narrowSecondary}
      <div class="item-narrow-details">
        <span class="item-qty">Qty: ${escapeHtml(item.quantity)}</span>
        <span class="item-total">${formatAmount(item.total, currency)}</span>
      </div>
    </div>`;
  }

  return `<div class="item-block">
    <div class="item-wide-row">
      <span class="item-name">${name}</span>
      <span class="item-qty">×${escapeHtml(item.quantity)}</span>
      <span class="item-total">${formatAmount(item.total, currency)}</span>
    </div>
    ${secondary}
  </div>`;
}).join('');

const metaRow = (label: string, value: unknown, strong = false): string => `
  <div class="meta-row"><span class="meta-label">${escapeHtml(label)}</span><span class="meta-value${strong ? ' bold' : ''}">${escapeHtml(value)}</span></div>`;

const totalRow = (label: string, value: string | number, currency: string, strong = false): string => `
  <div class="total-row${strong ? ' grand-total' : ''}"><span class="label">${escapeHtml(label)}</span><span class="value">${formatAmount(value, currency)}</span></div>`;

const brandHeader = (title: string, shopName?: string | null): string => `
  <div class="brand"><svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><path d="M5 8h8l7 34h29l8-25H17" fill="none" stroke="#000" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="25" cy="53" r="4" fill="#000"/><circle cx="48" cy="53" r="4" fill="#000"/></svg><div class="brand-copy"><h1 class="store-name">${escapeHtml(clean(shopName) || 'Daily Need Items')}</h1><p class="tagline">QUALITY PRODUCTS • BETTER EVERYDAY</p></div></div>
  <h2 class="document-title">${escapeHtml(title)}</h2>`;

const thermalQrFooter = (qr: string, subtitle: string): string => `
  <footer class="footer"><div class="qr-row"><img class="qr" src="${qr}" alt="Daily Need Items website QR"><p class="qr-caption">Scan to visit our store</p><div class="footer-copy"><p class="footer-title">Thank you for your purchase!</p><p class="footer-subtitle">${escapeHtml(subtitle)}</p><p class="copyright">${new Date().getFullYear()} © Daily Need Items</p></div></div></footer>`;

export const escapeThermalHtml = escapeHtml;

export const buildThermalInvoiceHtml = (invoice: ThermalInvoiceData, width: ThermalDocumentWidth): string => {
  const currency = invoice.currency || 'MMK';
  const items = invoice.lineItems ?? [];
  const shippingAddress = addressLines(invoice.shippingAddress);
  const rows = [
    metaRow('Invoice No:', withDocumentPrefix(invoice.invoiceNumber || invoice.invoiceId, 'INV'), true),
    metaRow('Date:', formatDateTime(invoice.createdAt)),
    ...(invoice.orderReference ? [metaRow('Order:', invoice.orderReference)] : []),
  ].join('');
  const totals = [
    totalRow('Subtotal:', invoice.subtotal, currency),
    ...(Number(invoice.deliveryFee) !== 0 ? [totalRow('Delivery:', invoice.deliveryFee, currency)] : []),
    ...(Number(invoice.taxAmount) !== 0 ? [totalRow('Tax:', invoice.taxAmount, currency)] : []),
    ...(Number(invoice.discountAmount) !== 0 ? [`<div class="total-row"><span class="label">Discount:</span><span class="value">-${formatAmount(invoice.discountAmount, currency)}</span></div>`] : []),
    '<div class="double-divider"></div>',
    totalRow('Total:', invoice.grandTotal, currency, true),
  ].join('');
  const qr = qrImageDataUri();
  const itemContent = items.length
    ? `${width === '80mm' ? '<div class="items-heading"><span>Item</span><span class="item-qty">Qty</span><span class="item-amount">Total</span></div>' : ''}${itemRows(items, currency, width)}`
    : '';
  const documentTitle = `Invoice ${clean(invoice.invoiceNumber) || clean(invoice.invoiceId)}`;
  const sellerMessage = resolveSellerMessage(invoice.sellerMessage);
  const shopAddress = addressLines(invoice.shopAddress);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(documentTitle)}</title><style>${baseStyles(width)}</style></head><body>
    <article class="thermal-receipt" data-thermal-document="invoice">
      <header><div class="center">${brandHeader('Invoice', invoice.shopName)}</div><div class="metadata">${rows}</div></header>
      <div class="divider"></div>
      <section><h3 class="section-title">Bill To</h3><div class="customer">${escapeHtml(clean(invoice.customerName) || 'Customer')}</div>${invoice.customerPhone ? `<div class="customer-phone">${escapeHtml(invoice.customerPhone)}</div>` : ''}</section>
      <section class="shipping-section"><h3 class="section-title">Shipping Address</h3><div class="address">${shippingAddress.length ? shippingAddress.map(escapeHtml).join(', ') : '—'}</div></section>
      ${shopAddress.length ? `<section class="shipping-section"><h3 class="section-title">Shop</h3><div class="address">${shopAddress.map(escapeHtml).join(', ')}</div>${invoice.shopContactPhone ? `<div class="customer-phone">${escapeHtml(invoice.shopContactPhone)}</div>` : ''}</section>` : ''}
      <div class="divider"></div>
      <section>${itemContent}</section>
      <div class="divider"></div>
      <section class="totals">${totals}</section>
      ${thermalQrFooter(qr, 'This invoice is for your records.')}
      <section class="policy seller-message">${sellerMessage.split('\n').map((line) => escapeHtml(line)).join('<br>')}</section>
    </article></body></html>`;
};

export const buildThermalReceiptHtml = (
  receipt: ThermalReceiptData,
  width: ThermalDocumentWidth,
  invoice?: Pick<ThermalInvoiceData, 'shopName' | 'shopAddress' | 'shopContactPhone' | 'customerName' | 'customerPhone' | 'shippingAddress' | 'lineItems' | 'sellerMessage'> | null,
): string => {
  const currency = receipt.currency || 'MMK';
  const items = invoice?.lineItems ?? receipt.lineItems ?? [];
  const shippingAddress = addressLines(invoice?.shippingAddress ?? receipt.shippingAddress);
  const customerPhone = invoice?.customerPhone ?? receipt.customerPhone ?? null;
  const sellerMessage = resolveSellerMessage(invoice ? invoice.sellerMessage : receipt.sellerMessage);
  const shopAddress = addressLines(invoice?.shopAddress);
  const rows = [
    metaRow('Receipt No:', withDocumentPrefix(receipt.receiptNumber || receipt.receiptId, 'REC'), true),
    metaRow('Invoice No:', withDocumentPrefix(receipt.invoiceNumber, 'INV')),
    metaRow('Date:', formatDateTime(receipt.issuedAt)),
    ...(receipt.orderReference ? [metaRow('Order:', receipt.orderReference)] : []),
  ].join('');
  const totals = [
    totalRow('Subtotal:', receipt.subtotal, currency),
    ...(Number(receipt.deliveryFee) !== 0 ? [totalRow('Delivery:', receipt.deliveryFee, currency)] : []),
    ...(Number(receipt.discountAmount) !== 0 ? [`<div class="total-row"><span class="label">Discount:</span><span class="value">-${formatAmount(receipt.discountAmount, currency)}</span></div>`] : []),
    ...(Number(receipt.taxAmount) !== 0 ? [totalRow('Tax:', receipt.taxAmount, currency)] : []),
    '<div class="double-divider"></div>',
    totalRow('Total Collected:', receipt.grandTotal, currency, true),
  ].join('');
  const itemContent = items.length
    ? `${width === '80mm' ? '<div class="items-heading"><span>Item</span><span class="item-qty">Qty</span><span class="item-amount">Total</span></div>' : ''}${itemRows(items, currency, width)}`
    : '';
  const qr = qrImageDataUri();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${baseStyles(width)}</style></head><body>
    <article class="thermal-receipt" data-thermal-document="receipt">
      <header><div class="center">${brandHeader('Payment Receipt', invoice?.shopName ?? receipt.shopName)}</div><div class="divider"></div><div class="metadata">${rows}</div></header>
      <div class="divider"></div>
      <section><div class="customer-label-row"><svg class="customer-icon" viewBox="0 0 24 24" fill="none" stroke="#444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 20a6 6 0 0 0-12 0"/><circle cx="12" cy="10" r="4"/></svg><span class="customer-label">Bill To</span></div><div class="customer">${escapeHtml(clean(invoice?.customerName) || clean(receipt.customerName) || 'Customer')}</div>${customerPhone ? `<div class="customer-phone">${escapeHtml(customerPhone)}</div>` : ''}</section>
      ${shippingAddress.length ? `<section class="shipping-section"><h3 class="section-title">Shipping Address</h3><div class="address">${shippingAddress.map(escapeHtml).join(', ')}</div></section>` : ''}
      ${shopAddress.length ? `<section class="shipping-section"><h3 class="section-title">Shop</h3><div class="address">${shopAddress.map(escapeHtml).join(', ')}</div>${invoice?.shopContactPhone ? `<div class="customer-phone">${escapeHtml(invoice.shopContactPhone)}</div>` : ''}</section>` : ''}
      ${items.length ? `<div class="divider"></div><section>${itemContent}</section>` : ''}
      <div class="divider"></div>
      <section class="totals">${totals}</section>
      ${thermalQrFooter(qr, 'This receipt confirms payment has been received.')}
      <section class="policy seller-message">${sellerMessage.split('\n').map((line) => escapeHtml(line)).join('<br>')}</section>
    </article></body></html>`;
};
