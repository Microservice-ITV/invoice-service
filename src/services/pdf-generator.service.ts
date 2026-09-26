import puppeteer from 'puppeteer';
import storageService from '@/services/storage.service';
import logger from '@/utils/logger';
import { InvoiceStatus } from '@/types/invoice';

export interface InvoicePdfPayload {
  invoiceNumber: string;
  orderId: string;
  shopId: string;
  shopName?: string | null;
  customerId: string;
  currency: string;
  subtotal: string;
  taxAmount: string;
  deliveryFee: string;
  discountAmount: string;
  grandTotal: string;
  paymentMethod: string | null;
  status: InvoiceStatus;
  createdAt: Date;
  customerName?: string | null;
  customerEmail?: string | null;
  lineItems?: Array<{
    name: string;
    quantity: number;
    unitPrice: string;
    total: string;
  }>;
}

export class PdfGeneratorService {
  async buildAndUploadInvoicePdf(payload: InvoicePdfPayload): Promise<string> {
    const html = this.renderInvoiceHtml(payload);

    const executablePath = puppeteer.executablePath();

logger.info(`Launching PDF browser: ${executablePath}`);

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ],
});
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
      });

      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const destination = `${payload.shopId}/${payload.invoiceNumber}-${uniqueSuffix}.pdf`;
      const pdfUrl = await storageService.uploadPdf(destination, Buffer.from(pdfBuffer));

      logger.info(`Invoice PDF uploaded for ${payload.invoiceNumber}: ${pdfUrl}`);
      return pdfUrl;
    } finally {
      await browser.close();
    }
  }

  private renderInvoiceHtml(payload: InvoicePdfPayload): string {
    const createdDate = new Date(payload.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const lineItems = payload.lineItems ?? [];
    const statusLabel = payload.status.replace(/_/g, ' ');
    const customerName = payload.customerName || 'Customer name unavailable';
    const customerEmail = payload.customerEmail || 'Email unavailable';
    const shopName = payload.shopName || 'Shop name unavailable';
    const lineItemsMarkup = lineItems.length > 0
      ? lineItems.map((item) => `<tr><td><strong>${item.name}</strong><br /><span class="muted">${payload.currency} ${item.unitPrice} each</span></td><td class="qty-cell">${item.quantity}</td><td>${payload.currency} ${item.total}</td></tr>`).join('')
      : '<tr><td><strong>Order items</strong><br /><span class="muted">Item details were not included in the payment event.</span></td><td class="qty-cell">Not provided</td><td>Not provided</td></tr>';

    return `<html><head><meta charset="utf-8" /><style>
      @page { size: A4; margin: 0; } * { box-sizing: border-box; }
      body { margin: 0; background: #edf4f1; color: #15231e; font-family: Arial, Helvetica, sans-serif; }
      .page { width: 100%; min-height: 1120px; padding: 42px 48px 34px; background: #fff; }
      .topbar { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 24px; border-bottom: 3px solid #0b966a; }
      .brand { display: flex; align-items: center; gap: 12px; } .brand-mark { width: 42px; height: 42px; border-radius: 10px; background: #087f5b; color: #fff; text-align: center; line-height: 42px; font-size: 21px; font-weight: 800; }
      .brand-name { color: #087f5b; font-size: 17px; font-weight: 800; } .brand-subtitle { margin-top: 4px; color: #84928d; font-size: 9px; letter-spacing: .14em; text-transform: uppercase; }
      .invoice-heading { text-align: right; } .invoice-heading h1 { margin: 0; color: #10251d; font-size: 36px; letter-spacing: -.02em; } .invoice-heading p { margin: 6px 0 0; color: #718078; font-size: 10px; }
      .summary { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 10px; margin: 24px 0; } .summary-card { min-height: 48px; padding: 13px 15px; border: 1px solid #dce9e2; border-radius: 8px; background: #f7fbf9; }
      .summary-card label { display: block; margin-bottom: 7px; color: #81908a; font-size: 8px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; } .summary-card strong { color: #1a2c25; font-size: 11px; }
      .status { display: inline-block; padding: 5px 9px; border-radius: 99px; background: #d9f6e9; color: #08764f; font-size: 9px; font-weight: 800; letter-spacing: .08em; }
      .details { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 24px 0 28px; } .detail-block { min-height: 116px; padding: 16px; border: 1px solid #dce9e2; border-radius: 8px; background: #fff; }
      .detail-block h2 { margin: 0 0 12px; padding-bottom: 8px; border-bottom: 1px solid #e6efeb; color: #087f5b; font-size: 9px; letter-spacing: .13em; text-transform: uppercase; } .detail-block p { margin: 8px 0 0; color: #253830; font-size: 10px; line-height: 1.5; } .detail-block span { color: #809089; font-size: 8px; text-transform: uppercase; letter-spacing: .08em; }
      table { width: 100%; border-collapse: collapse; margin-top: 4px; } thead { display: table-header-group; } tr { page-break-inside: avoid; } th { padding: 11px 14px; background: #0b8f67; color: #fff; font-size: 9px; letter-spacing: .1em; text-align: left; text-transform: uppercase; } th:first-child { border-radius: 7px 0 0 0; } th:nth-child(2) { width: 64px; text-align: center; } th:last-child { width: 130px; border-radius: 0 7px 0 0; text-align: right; }
      td { padding: 12px 14px; border-bottom: 1px solid #e5ece8; color: #42534b; font-size: 10px; } td:nth-child(2) { text-align: center; } td:last-child { color: #1b2d25; font-weight: 700; text-align: right; } .qty-cell { font-weight: 700; color: #1c2a24; } .muted { color: #83918b; font-size: 8px; font-weight: 400; }
      .total-row td { padding: 16px 14px; border-bottom: 0; background: #e8f7f0; color: #10251d; font-size: 14px; font-weight: 800; } .total-row td:first-child { border-radius: 0 0 0 7px; } .total-row td:last-child { border-radius: 0 0 7px 0; color: #087f5b; font-size: 16px; }
      .footer { display: flex; justify-content: space-between; gap: 24px; margin-top: 42px; padding-top: 16px; border-top: 1px solid #dce9e2; color: #83918b; font-size: 8px; line-height: 1.6; } .footer strong { color: #0a7e5a; }
      @media print { body { background: #fff; } .page { min-height: auto; } }
    </style></head><body><main class="page">
      <header class="topbar"><div class="brand"><div class="brand-mark">D</div><div><div class="brand-name">Daily Need Items</div><div class="brand-subtitle">Commerce platform</div></div></div><div class="invoice-heading"><h1>Invoice</h1><p>Payment receipt and order summary</p></div></header>
      <section class="summary"><div class="summary-card"><label>Invoice number</label><strong>${payload.invoiceNumber}</strong></div><div class="summary-card"><label>Issued</label><strong>${createdDate}</strong></div><div class="summary-card"><label>Payment status</label><span class="status">${statusLabel}</span></div></section>
      <section class="details"><div class="detail-block"><h2>Order details</h2><p><span>Order ID</span><br />${payload.orderId}</p><p><span>Shop</span><br /><strong>${shopName}</strong><br /><span>${payload.shopId}</span></p></div><div class="detail-block"><h2>Customer details</h2><p><span>Customer</span><br /><strong>${customerName}</strong><br /><span>${customerEmail}</span></p></div></section>
      <table><thead><tr><th>Description</th><th>Qty</th><th>Amount</th></tr></thead><tbody>${lineItemsMarkup}<tr><td>Subtotal</td><td class="qty-cell">-</td><td>${payload.currency} ${payload.subtotal}</td></tr><tr><td>Tax</td><td class="qty-cell">-</td><td>${payload.currency} ${payload.taxAmount}</td></tr><tr><td>Delivery Fee</td><td class="qty-cell">-</td><td>${payload.currency} ${payload.deliveryFee}</td></tr><tr><td>Discount</td><td class="qty-cell">-</td><td>${payload.currency} ${payload.discountAmount}</td></tr><tr class="total-row"><td>Total</td><td class="qty-cell">-</td><td>${payload.currency} ${payload.grandTotal}</td></tr></tbody></table>
      <footer class="footer"><div><strong>Thank you for your business.</strong><br />This document was generated electronically.</div><div>Keep this invoice for your records.<br />Daily Need Items</div></footer>
    </main></body></html>`;
  }
}

export default new PdfGeneratorService();
