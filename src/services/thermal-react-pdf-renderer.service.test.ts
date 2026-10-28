import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import env from '@/config/env';
import pdfGeneratorService, { InvoicePdfPayload } from '@/services/pdf-generator.service';
import receiptPdfService, { ReceiptPdfPayload } from '@/services/receipt-pdf.service';
import thermalReactPdfRenderer from '@/services/thermal-react-pdf-renderer.service';
import { getThermalContentHeightPx, getThermalPdfOptions } from '@/services/thermal-react-pdf-renderer.service';
import { buildThermalInvoiceHtml, buildThermalReceiptHtml } from '@/services/thermal-document-template';

env.JWT_SECRET = env.JWT_SECRET ?? 'thermal-print-render-test-secret';
env.FRONTEND_BASE_URL = 'http://frontend-react:5173';

test('production compose retains FRONTEND_BASE_URL for the unchanged A4 invoice renderer', async () => {
  const compose = await readFile(join(process.cwd(), 'docker-compose.prod.yml'), 'utf8');
  assert.match(compose, /^\s+FRONTEND_BASE_URL:\s+\$\{FRONTEND_BASE_URL\}\s*$/m);
});

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

test('thermal invoice and receipt PDF generation uses self-contained HTML at both paper widths', async () => {
  const originalRender = thermalReactPdfRenderer.render;
  const originalFrontendUrl = env.FRONTEND_BASE_URL;
  const requests: Array<{ html: string; width: string }> = [];
  thermalReactPdfRenderer.render = async (html, width) => {
    requests.push({ html, width });
    return Buffer.from('%PDF-react-thermal');
  };
  env.FRONTEND_BASE_URL = '';

  try {
    for (const width of ['58mm', '80mm'] as const) {
      await pdfGeneratorService.renderThermalInvoicePdf(invoicePayload, width);
      await receiptPdfService.renderReceiptPdf(receiptPayload, width, invoicePayload);
    }
    assert.equal(requests.length, 4);
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const expectedWidth = index < 2 ? '58mm' : '80mm';
      const isReceipt = index % 2 === 1;
      assert.equal(request.width, expectedWidth);
      assert.match(request.html, new RegExp(`@page \\{ size: ${expectedWidth}`));
      assert.match(request.html, new RegExp(`data-thermal-document="${isReceipt ? 'receipt' : 'invoice'}"`));
      assert.match(request.html, new RegExp(`font: ${expectedWidth === '58mm' ? '15px' : '16\\.5px'}/`), 'paper width should select its stable width-specific typography profile');
      assert.match(request.html, /data:image\/png;base64,/);
      assert.match(request.html, /'Courier New', Courier, monospace/, 'thermal output should use a compact monochrome POS typeface');
      assert.match(request.html, /Quality products/);
      assert.match(request.html, /Scan to visit our store/);
      assert.match(request.html, /border-top: 1px dashed/);
      assert.match(request.html, /Pet Supplies sample/);
      assert.doesNotMatch(request.html, /https?:\/\//, 'thermal templates must not depend on remote services or assets');
    }
  } finally {
    env.FRONTEND_BASE_URL = originalFrontendUrl;
    thermalReactPdfRenderer.render = originalRender;
  }
});

test('A4 invoice PDF download returns a readable PDF from the shared print route', async () => {
  const originalFrontendUrl = env.FRONTEND_BASE_URL;
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; }
      .invoice-document { width: 100%; font-family: Inter, sans-serif; }
      .invoice-document section { break-inside: avoid; }
    </style></head><body><article class="invoice-document"><h1>Invoice ${invoicePayload.invoiceNumber}</h1>
      <section><p>Customer and invoice details</p></section><section><p>MMK 190,000</p></section>
    </article><script>window.__INVOICE_READY__=true</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  env.FRONTEND_BASE_URL = `http://127.0.0.1:${address.port}`;

  try {
    const buffer = await pdfGeneratorService.renderInvoicePdf(invoicePayload);
    const pdf = buffer.toString('latin1');
    assert.ok(pdf.startsWith('%PDF-'));
    assert.match(pdf, /\/Type\s*\/Page\b/);
    assert.match(pdf, /\/MediaBox\s*\[\s*0\s+0\s+595\./);
    assert.match(pdf, /%%EOF/);
  } finally {
    env.FRONTEND_BASE_URL = originalFrontendUrl;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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

test('thermal PDF cache deduplicates identical renders and keys updates and paper width separately', async () => {
  const originalRender = thermalReactPdfRenderer.renderWithDiagnostics;
  let renderCount = 0;
  thermalReactPdfRenderer.renderWithDiagnostics = async () => ({
    buffer: Buffer.from(`thermal-pdf-${++renderCount}`),
    diagnostics: {} as never,
  });

  try {
    const currentData = { invoiceId: 'cache-test-invoice', updatedAt: 'revision-1' };
    const [first, concurrent] = await Promise.all([
      thermalReactPdfRenderer.render('http://print.local/invoice', '58mm', currentData),
      thermalReactPdfRenderer.render('http://print.local/invoice', '58mm', currentData),
    ]);
    assert.equal(first.toString(), 'thermal-pdf-1');
    assert.equal(concurrent.toString(), 'thermal-pdf-1');
    assert.equal((await thermalReactPdfRenderer.render('http://print.local/invoice', '58mm', currentData)).toString(), 'thermal-pdf-1');
    assert.equal(renderCount, 1);

    await thermalReactPdfRenderer.render('http://print.local/invoice', '58mm', { ...currentData, updatedAt: 'revision-2' });
    await thermalReactPdfRenderer.render('http://print.local/invoice', '80mm', currentData);
    assert.equal(renderCount, 3);
  } finally {
    thermalReactPdfRenderer.renderWithDiagnostics = originalRender;
  }
});

test('Puppeteer renders self-contained thermal templates at both widths without blank pages', async () => {
  const readPdf = async (html: string, width: '58mm' | '80mm') => {
    const { buffer, diagnostics } = await thermalReactPdfRenderer.renderWithDiagnostics(html, width);
    const source = buffer.toString('latin1');
    assert.match(source, /\/OpenAction\s+\[\d+\s+\d+\s+R\s+\/FitH\s+null\]/, 'thermal PDFs should open fitted to the viewer width');
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

  for (const width of ['58mm', '80mm'] as const) {
    const invoice = { ...invoicePayload, customerName: 'Rendered customer', shippingAddress: { city: 'Yangon' } };
    const receipt = { ...receiptPayload, customerName: 'Rendered customer' };
    for (const [kind, html] of [
      ['invoice', buildThermalInvoiceHtml(invoice, width)],
      ['receipt', buildThermalReceiptHtml(receipt, width, invoice)],
    ] as const) {
      const result = await readPdf(html, width);
      assert.equal(result.pageCount, 1, `${kind} ${width} should fit on one content-sized page`);
      assert.ok(result.pageDetails[0].textOperatorCount > 0, `${kind} ${width} page must contain printable text`);
      assert.ok(Math.abs(result.pageDetails[0].widthPt - Number.parseInt(width, 10) * 72 / 25.4) < 1, `${kind} should use ${width} paper width`);
      assert.ok(result.diagnostics.contentBounds.right <= Number.parseInt(width, 10) * 96 / 25.4 + 1, `${kind} ${width} content should stay inside the physical paper width`);
      assert.ok(result.pageDetails[0].heightPt > 0 && result.pageDetails[0].heightPt < 800, `${kind} should use content height`);
      assert.match(result.diagnostics.contentText, /Rendered customer/);
      assert.match(result.diagnostics.contentText, /Pet Supplies sample/);
      assert.match(result.diagnostics.contentText, /× 1/);
      assert.match(result.diagnostics.contentText, /190,000/);
    }

    const longInvoice = {
      ...invoicePayload,
      lineItems: Array.from({ length: 80 }, (_, index) => ({
        name: `Long product ${index + 1} with a descriptive name`, quantity: 1, total: '190000',
      })),
    };
    const longResult = await readPdf(buildThermalInvoiceHtml(longInvoice, width), width);
    assert.equal(longResult.pageCount, 1, `long ${width} invoice stays on one dynamic-height page`);
    assert.ok(longResult.pageDetails[0].heightPt > 300, 'long invoice should grow to include every item');
    assert.match(longResult.diagnostics.contentText, /Long product 80 with a descriptive name/);
  }
});

test('thermal templates safely escape invoice and product text and include local assets only', () => {
  const malicious = { ...invoicePayload, customerName: '<script>alert("x")</script>&', lineItems: [{
    name: '<img src=x onerror=alert(1)>', quantity: 1, total: '12',
  }] };
  const html = buildThermalInvoiceHtml(malicious, '58mm');
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&amp;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert|<img src=x/);
  assert.doesNotMatch(html, /https?:\/\//);
});
