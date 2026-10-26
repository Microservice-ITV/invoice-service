import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import env from '@/config/env';
import invoicePrintTokenService from '@/services/invoice-print-token.service';
import pdfGeneratorService, { InvoicePdfPayload } from '@/services/pdf-generator.service';
import receiptPdfService, { ReceiptPdfPayload } from '@/services/receipt-pdf.service';
import thermalReactPdfRenderer from '@/services/thermal-react-pdf-renderer.service';
import { getThermalContentHeightPx, getThermalPdfOptions } from '@/services/thermal-react-pdf-renderer.service';

env.JWT_SECRET = env.JWT_SECRET ?? 'thermal-print-render-test-secret';
env.FRONTEND_BASE_URL = 'http://frontend-react:5173';

const invoicePayload: InvoicePdfPayload = {
  invoiceId: 'invoice-1', invoiceNumber: 'INV-20261008-000035', orderReference: null,
  orderId: 'order-1', shopId: 'shop-1', customerId: 'customer-1', currency: 'MMK',
  subtotal: '190000', taxAmount: '0', deliveryFee: '0', discountAmount: '0', grandTotal: '190000',
  paymentMethod: 'CARD', status: 'PAID', createdAt: new Date('2026-10-08T00:00:00.000Z'),
  customerName: 'Real customer', shippingAddress: { city: 'Yangon' },
  lineItems: [{ name: 'Pet Supplies sample', quantity: 1, unitPrice: '190000', total: '190000' }],
};
const receiptPayload: ReceiptPdfPayload = {
  receiptId: 'receipt-1', receiptNumber: 'REC-20261008-000035', invoiceId: invoicePayload.invoiceId,
  invoiceNumber: invoicePayload.invoiceNumber, orderId: 'order-1', orderReference: null,
  shopId: 'shop-1', shopName: 'Daily Need Items', customerId: 'customer-1', customerName: 'Real customer',
  customerEmail: null, currency: 'MMK', subtotal: '190000', deliveryFee: '0', taxAmount: '0',
  discountAmount: '0', grandTotal: '190000', paymentMethod: 'CARD', paymentGatewayRef: null,
  status: 'ISSUED', issuedAt: new Date('2026-10-08T00:00:00.000Z'),
};

test('invoice and receipt PDF downloads render their shared React print route at both thermal widths', async () => {
  const originalRender = thermalReactPdfRenderer.render;
  const requests: Array<{ url: string; width: string }> = [];
  thermalReactPdfRenderer.render = async (url, width) => {
    requests.push({ url, width });
    return Buffer.from('%PDF-react-thermal');
  };

  try {
    for (const width of ['58mm', '80mm'] as const) {
      await pdfGeneratorService.renderThermalInvoicePdf(invoicePayload, width);
      await receiptPdfService.renderReceiptPdf(receiptPayload, width);
    }
    assert.equal(requests.length, 4);
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const expectedWidth = index < 2 ? '58mm' : '80mm';
      const isReceipt = index % 2 === 1;
      const parsed = new URL(request.url);
      assert.equal(request.width, expectedWidth);
      assert.equal(parsed.searchParams.get('width'), expectedWidth);
      assert.equal(parsed.pathname.endsWith(isReceipt ? '/receipt/print' : '/print'), true);
      if (!isReceipt) assert.equal(parsed.searchParams.get('format'), 'thermal');
      const claims = invoicePrintTokenService.verify(parsed.searchParams.get('token') ?? undefined, invoicePayload.invoiceNumber);
      assert.equal(claims.document, isReceipt ? 'receipt' : 'invoice');
      if (isReceipt) assert.equal(claims.receiptId, receiptPayload.receiptId);
    }
  } finally {
    thermalReactPdfRenderer.render = originalRender;
  }
});

test('thermal PDF dimensions honor the selected width and use the full content height without margins', () => {
  for (const width of ['58mm', '80mm'] as const) {
    const options = getThermalPdfOptions(width, 480);
    assert.equal(options.width, width);
    assert.equal(options.height, '127.00mm');
    assert.deepEqual(options.margin, { top: 0, right: 0, bottom: 0, left: 0 });
    assert.equal(options.printBackground, true);
  }
});

test('thermal PDF height follows final descendant bounds and ignores viewport or wrapper height', () => {
  assert.equal(getThermalContentHeightPx({ top: 0, left: 3, right: 208, bottom: 717.58, height: 717.58 }), 718);
  assert.equal(getThermalContentHeightPx({ top: -2, left: 3, right: 208, bottom: 717.58, height: 719.58 }), 720);
});

test('Puppeteer outputs one correctly sized page for short thermal docs and retains long invoice content', async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const width = url.searchParams.get('width') === '80mm' ? '80mm' : '58mm';
    const kind = url.searchParams.get('kind') === 'receipt' ? 'receipt' : 'invoice';
    const count = url.searchParams.get('many') === 'true' ? 80 : 3;
    const paperWidth = width === '58mm' ? '52mm' : '70mm';
    const margin = width === '58mm' ? '3mm' : '5mm';
    const rows = Array.from({ length: count }, (_, index) => `<div class="row">Item ${index + 1} <span>MMK 190,000</span></div>`).join('');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
      html,body { margin:0; width:${width}; height:auto; min-height:0; overflow:visible; }
      body { min-height:1200px; font:10px Arial,sans-serif; }
      #root,#root>div { min-height:1200px; }
      .thermal-receipt { width:${paperWidth}; padding:2mm; box-sizing:border-box; }
      .row { min-height:18px; display:flex; justify-content:space-between; break-inside:avoid; }
      @media print {
        html:has(body.thermal-printing),body.thermal-printing,body.thermal-printing #root,body.thermal-printing #root>div { width:${width}!important; height:auto!important; min-height:0!important; margin:0!important; padding:0!important; overflow:visible!important; }
        body.thermal-printing [data-print-hide] { display:none!important; }
        body.thermal-printing .thermal-receipt { position:absolute!important; inset:0 auto auto ${margin}!important; width:${paperWidth}!important; }
      }
    </style></head><body><div id="root"><div><article class="thermal-receipt"><h1>${kind} ${width}</h1>${rows}</article></div></div><script>window.__THERMAL_READY__=true</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const readPdf = async (url: string) => {
    const { buffer, diagnostics } = await thermalReactPdfRenderer.renderWithDiagnostics(url, new URL(url).searchParams.get('width') as '58mm' | '80mm');
    const source = buffer.toString('latin1');
    const objects = new Map<number, string>();
    for (const match of source.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)\r?\nendobj/g)) objects.set(Number(match[1]), match[2]);
    const pageObjects = [...objects.values()].filter((body) => /\/Type\s*\/Page\b/.test(body));
    const pageDetails = pageObjects.map((pageBody) => {
      const mediaBox = pageBody.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
      assert.ok(mediaBox, 'every PDF page should include its physical page box');
      const contentRef = pageBody.match(/\/Contents\s+(\d+)\s+0\s+R/);
      assert.ok(contentRef, 'every PDF page should have a content stream');
      const streamObject = objects.get(Number(contentRef[1]));
      assert.ok(streamObject, 'every PDF page content stream should resolve');
      const stream = streamObject.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
      assert.ok(stream, 'PDF page content should contain a stream');
      let streamBytes = Buffer.from(stream[1], 'latin1');
      if (/\/Filter\s*\/FlateDecode/.test(streamObject)) streamBytes = inflateSync(streamBytes);
      const streamText = streamBytes.toString('latin1');
      return {
        widthPt: Number(mediaBox[1]), heightPt: Number(mediaBox[2]),
        textOperatorCount: [...streamText.matchAll(/\b(?:Tj|TJ)\b/g)].length,
      };
    });
    return { pageCount: pageDetails.length, pageDetails, diagnostics };
  };

  try {
    for (const kind of ['invoice', 'receipt']) {
      for (const width of ['58mm', '80mm'] as const) {
        const result = await readPdf(`${baseUrl}/?kind=${kind}&width=${width}`);
        assert.equal(result.pageCount, 1, `${kind} ${width} should fit on one content-sized page`);
        assert.ok(result.pageDetails[0].textOperatorCount > 0, `${kind} ${width} page must contain printable text`);
        assert.ok(Math.abs(result.pageDetails[0].widthPt - Number.parseInt(width, 10) * 72 / 25.4) < 1, `${kind} should use ${width} paper width`);
        assert.ok(result.pageDetails[0].heightPt > 0 && result.pageDetails[0].heightPt < 300, `${kind} should not retain the 1200px viewport height`);
        assert.ok(result.diagnostics.contentText.includes(kind), 'the rendered thermal document text should be measured');
        assert.ok(result.diagnostics.document.scrollHeight <= result.diagnostics.contentBounds.bottom + 2, 'print document extent should end with the thermal content, not the old viewport');
      }
    }
    for (const width of ['58mm', '80mm'] as const) {
      const result = await readPdf(`${baseUrl}/?kind=invoice&width=${width}&many=true`);
      assert.equal(result.pageCount, 1, `long ${width} invoice content remains on the custom roll page`);
      assert.ok(result.pageDetails[0].textOperatorCount > 0, 'long invoice page must contain extracted text operators');
      assert.ok(result.pageDetails[0].heightPt > 1000, 'long invoice should grow to include all product rows');
      assert.ok(Math.abs(result.pageDetails[0].widthPt - Number.parseInt(width, 10) * 72 / 25.4) < 1);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
