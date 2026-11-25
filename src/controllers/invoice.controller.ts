import { NextFunction, Request, Response } from 'express';
import invoiceService, { MAX_INVOICE_REPLAY_ORDER_IDS } from '@/services/invoice.service';
import { InvoiceListQuery, InvoiceStatus, RefundMethod } from '@/types/invoice';
import { canAccessInvoice } from '@/services/invoice-access-policy';
import invoicePrintTokenService from '@/services/invoice-print-token.service';

export const getThermalInvoiceDownloadFilename = (invoiceNumber: string, width: '58mm' | '80mm'): string => {
  const invoiceSuffix = invoiceNumber.trim().replace(/^DNI-/i, '').replace(/^INV-/i, '');
  const safeSuffix = invoiceSuffix.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `INV-${safeSuffix || 'invoice'}-thermal-${width}.pdf`;
};

const invoiceStatusValues: InvoiceStatus[] = [
  'UNPAID',
  'PENDING_VERIFICATION',
  'PAID',
  'REJECTED',
  'VOID',
  'REFUNDED',
];

const normalizeStatus = (value: string | undefined): InvoiceStatus | undefined => {
  if (!value) {
    return undefined;
  }

  const upperValue = value.toUpperCase() as InvoiceStatus;
  if (!invoiceStatusValues.includes(upperValue)) {
    throw new Error(`Invalid invoice status: ${value}`);
  }

  return upperValue;
};

const parseInvoiceListQuery = (query: Request['query']): { value?: InvoiceListQuery; error?: string } => {
  const stringKeys = ['status', 'search', 'paymentMethod', 'from', 'to', 'sortOrder', 'order'];
  if (stringKeys.some((key) => query[key] !== undefined && typeof query[key] !== 'string')) {
    return { error: 'Invoice filters must be single string values' };
  }
  if (
    (query.page !== undefined && typeof query.page !== 'string')
    || (query.limit !== undefined && typeof query.limit !== 'string')
  ) {
    return { error: 'page and limit must be integer values' };
  }
  const readString = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' ? value : undefined;
  };
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  const fromValue = readString('from');
  const toValue = readString('to');
  const search = readString('search')?.trim();
  const paymentMethod = readString('paymentMethod')?.trim();
  const sortOrder = readString('sortOrder') ?? readString('order') ?? 'desc';

  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { error: 'page must be a positive integer and limit must be between 1 and 100' };
  }
  if ((search && search.length > 120) || (paymentMethod && paymentMethod.length > 80)) {
    return { error: 'Search and payment method filters are too long' };
  }
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    return { error: 'sortOrder must be asc or desc' };
  }
  const parseDate = (value: string | undefined, endOfDay: boolean): Date | undefined => {
    if (!value) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(Number.NaN);
    const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
      ? date
      : new Date(Number.NaN);
  };
  const from = parseDate(fromValue, false);
  const to = parseDate(toValue, true);
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    return { error: 'from and to must be valid YYYY-MM-DD dates' };
  }
  if (from && to && from > to) return { error: 'from cannot be later than to' };

  try {
    const statusValue = readString('status');
    const statuses = statusValue
      ? [...new Set(statusValue.split(',').map((value) => normalizeStatus(value.trim())))].filter(
        (value): value is InvoiceStatus => Boolean(value),
      )
      : undefined;
    return {
      value: {
        page,
        limit,
        sortOrder,
        ...(statuses?.length === 1 ? { status: statuses[0] } : {}),
        ...(statuses && statuses.length > 1 ? { statuses } : {}),
        ...(search ? { search } : {}),
        ...(paymentMethod ? { paymentMethod } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
    };
  } catch {
    return { error: 'Invalid invoice status' };
  }
};

const respondWithInvoicePage = (
  res: Response,
  page: Awaited<ReturnType<typeof invoiceService.getInvoicePage>>,
): void => {
  res.json({
    success: true,
    data: page.items,
    pagination: page.pagination,
    summary: page.summary,
    facets: page.facets,
  });
};

export class InvoiceController {
  async replayInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderIds = req.body?.orderIds;
      if (
        !Array.isArray(orderIds)
        || orderIds.length === 0
        || orderIds.length > MAX_INVOICE_REPLAY_ORDER_IDS
        || orderIds.some((orderId: unknown) => typeof orderId !== 'string' || !orderId.trim())
      ) {
        res.status(400).json({
          success: false,
          message: `orderIds must contain between 1 and ${MAX_INVOICE_REPLAY_ORDER_IDS} non-empty strings`,
        });
        return;
      }

      const summary = await invoiceService.replayInvoices(orderIds.map((orderId: string) => orderId.trim()));
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to replay invoices'));
    }
  }

  async getMissingInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const limitValue = req.query.limit;
      const limit = limitValue === undefined ? 25 : Number(limitValue);
      const cursor = req.query.cursor;
      if (
        !Number.isInteger(limit)
        || limit < 1
        || limit > 100
        || (cursor !== undefined && typeof cursor !== 'string')
        || (typeof cursor === 'string' && cursor.length > 512)
      ) {
        res.status(400).json({ success: false, message: 'Invalid missing invoice query parameters' });
        return;
      }

      const page = await invoiceService.getMissingInvoices(limit, cursor as string | undefined);
      res.json({ success: true, data: page });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to find missing invoices'));
    }
  }

  async replayMissingInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { orderId, shopId } = req.body ?? {};
      if (
        typeof orderId !== 'string' || !orderId.trim()
        || typeof shopId !== 'string' || !shopId.trim()
      ) {
        res.status(400).json({ success: false, message: 'orderId and shopId are required' });
        return;
      }

      const result = await invoiceService.replayMissingInvoice(orderId.trim(), shopId.trim());
      res.json({ success: true, data: result });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to replay missing invoice'));
    }
  }

  async replayAllMissingInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cursor = req.body?.cursor;
      if (
        cursor !== undefined
        && (typeof cursor !== 'string' || cursor.length > 512)
      ) {
        res.status(400).json({ success: false, message: 'Invalid replay cursor' });
        return;
      }

      const summary = await invoiceService.replayAllMissingInvoices(cursor as string | undefined);
      res.json({ success: true, data: summary });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to replay missing invoices'));
    }
  }

  async createInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = req.body as Parameters<typeof invoiceService.createInvoiceFromPayment>[0];
      if (!payload.shopName?.trim()) {
        res.status(400).json({
          success: false,
          message: 'shopName is required for invoice snapshots',
        });
        return;
      }

      const invoice = await invoiceService.createInvoiceFromPayment(payload);
      res.status(201).json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to create invoice'));
    }
  }

  async getGuestInvoicesByOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const orderId = req.body?.orderId;
      const checkoutId = req.body?.checkoutId;
      const phone = req.body?.phone;
      const lookupId = typeof checkoutId === 'string' ? checkoutId : orderId;
      if (
        typeof lookupId !== 'string' || !lookupId.trim() || lookupId.length > 64
        || typeof phone !== 'string' || !phone.trim() || phone.length > 64
      ) {
        res.status(400).json({
          success: false,
          message: 'A valid order or checkout ID and phone number are required',
        });
        return;
      }

      const invoices = typeof checkoutId === 'string'
        ? await invoiceService.getGuestInvoicesByCheckout(checkoutId, phone)
        : await invoiceService.getGuestInvoicesByOrder(lookupId, phone);
      res.json({ success: true, data: invoices });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch guest invoices'));
    }
  }

  async createPartialInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const customerId = req.user?.customerId;
      const idempotencyKey = req.header('Idempotency-Key') ?? '';
      if (!customerId) {
        res.status(400).json({ success: false, message: 'Customer context is required' });
        return;
      }
      const invoice = await invoiceService.createPartialInvoice(req.body, customerId, idempotencyKey);
      res.status(201).json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to create partial invoice'));
    }
  }

  async getMyInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const customerId = req.user?.customerId;

      if (!customerId) {
        res.status(400).json({
          success: false,
          message: 'Customer context is required',
        });
        return;
      }

      const parsed = parseInvoiceListQuery(req.query);
      if (!parsed.value) {
        res.status(400).json({ success: false, message: parsed.error });
        return;
      }

      const page = await invoiceService.getInvoicePage(
        { ...parsed.value, customerId },
        { ...req.user, customerId, role: 'customer' },
        { includePaymentMethods: true },
      );
      respondWithInvoicePage(res, page);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch customer invoices'));
    }
  }

  async getInvoiceByNumber(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = req.user;
      if (!actor) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const invoice = actor.role === 'customer'
        ? await invoiceService.getCustomerInvoiceByNumber(req.params.invoiceNumber, actor.customerId ?? '')
        : await invoiceService.getInvoiceByNumber(req.params.invoiceNumber, actor);
      if (!invoice || !canAccessInvoice(invoice, actor)) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }

      res.json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch customer invoice'));
    }
  }

  async getShopInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shopId = req.user?.shopId;
      const shopIds = [...new Set(req.user?.shopIds ?? [])];

      if (shopIds.length === 0 && !shopId) {
        res.status(400).json({
          success: false,
          message: 'Shop context is required',
        });
        return;
      }

      const parsed = parseInvoiceListQuery(req.query);
      if (!parsed.value) {
        res.status(400).json({ success: false, message: parsed.error });
        return;
      }

      const page = await invoiceService.getInvoicePage(
        { ...parsed.value, ...(shopIds.length > 0 ? { shopIds } : { shopId }) },
        req.user!,
        { includePaymentMethods: true },
      );
      respondWithInvoicePage(res, page);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch shop invoices'));
    }
  }

  async getInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const invoice = await invoiceService.getInvoiceById(req.params.id, req.user);
      if (!invoice || !req.user || !canAccessInvoice(invoice, req.user)) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }
      res.json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch invoice'));
    }
  }

  /**
   * Serves a single invoice to the authenticated print/PDF route.
   *
   * Requires a short-lived, single-invoice print token issued by this service
   * for the server-side renderer. The token is verified here (signature,
   * expiry, scope and invoice number) and access is then re-checked against the
   * caller's recorded owner, so invoices are never exposed publicly.
   */
  async getInvoiceForPrint(req: Request, res: Response): Promise<void> {
    try {
      const invoiceNumber = req.params.invoiceNumber;
      const printToken = req.header('x-print-token') ?? undefined;

      const claims = invoicePrintTokenService.verify(printToken, invoiceNumber);
      if (claims.document && claims.document !== 'invoice') {
        res.status(403).json({ success: false, message: 'Print token is not scoped to an invoice document' });
        return;
      }

      // The token carries the invoice id, so no extra lookup by number is needed;
      // the number is still re-checked so a token cannot be replayed elsewhere.
      const invoice = await invoiceService.getInvoiceById(claims.invoiceId, {
        id: claims.sub,
        customerId: claims.sub,
        role: claims.role,
        shopId: claims.shopId,
      });
      if (!invoice || invoice.invoiceNumber !== invoiceNumber) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }

      const allowed = canAccessInvoice(invoice, {
        id: claims.sub,
        customerId: claims.sub,
        role: claims.role as never,
        shopId: claims.shopId,
      });

      if (!allowed) {
        res.status(403).json({ success: false, message: 'Invoice access denied' });
        return;
      }

      res.json({
        success: true,
        data: {
          ...invoice,
          // Email hidden on print/PDF Bill to for now — restore `customerEmail: invoice.customerEmail`.
          // customerEmail: invoice.customerEmail,
          customerEmail: null,
        },
      });
    } catch (error) {
      res.status(401).json({
        success: false,
        message: error instanceof Error ? error.message : 'Invalid print token',
      });
    }
  }

  async downloadInvoicePdf(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }
      const result = await invoiceService.downloadInvoicePdf(req.params.id, req.user);
      if (!result) {
        res.status(404).json({ success: false, message: 'Invoice PDF not found' });
        return;
      }
      if ('processing' in result && result.processing) {
        res.status(503).json({
          success: false,
          status: result.status,
          message: 'The prepared invoice PDF is temporarily unavailable. Regeneration is queued; please retry shortly.',
          attempts: result.attempts,
          error: result.error,
          retryAt: result.retryAt,
        });
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${result.invoice.invoiceNumber}.pdf"`);
      res.send(result.buffer);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to download invoice PDF'));
    }
  }

  async downloadThermalInvoicePdf(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) { res.status(401).json({ success: false, message: 'Authentication required' }); return; }
      const width = req.query.width === '80mm' ? '80mm' : req.query.width === '58mm' ? '58mm' : null;
      if (!width) { res.status(400).json({ success: false, message: 'width must be 58mm or 80mm' }); return; }
      const result = await invoiceService.downloadThermalInvoicePdf(req.params.id, req.user, width);
      if (!result) { res.status(404).json({ success: false, message: 'Invoice PDF not found' }); return; }
      if (result.processing) {
        res.status(503).json({ success: false, status: result.status, message: 'The prepared thermal invoice PDF is temporarily unavailable. Regeneration is queued; please retry shortly.', attempts: result.attempts, error: result.error, retryAt: result.retryAt });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${getThermalInvoiceDownloadFilename(result.invoice.invoiceNumber, width)}"`);
      res.send(result.buffer);
    } catch (error) { next(error instanceof Error ? error : new Error('Failed to download thermal invoice PDF')); }
  }

  async downloadInvoicePdfForNotification(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const pdfUrl = req.query.pdfUrl;
      if (typeof pdfUrl !== 'string' || !pdfUrl.trim()) {
        res.status(400).json({ success: false, message: 'pdfUrl is required' });
        return;
      }

      const result = await invoiceService.downloadInvoicePdfForNotification(req.params.id, pdfUrl);
      if (!result) {
        res.status(404).json({ success: false, message: 'Invoice PDF is not ready' });
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${result.invoice.invoiceNumber}.pdf"`);
      res.send(result.buffer);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to download invoice PDF'));
    }
  }

  async getManageInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shopId = req.user?.shopId;

      if (!shopId) {
        res.status(400).json({
          success: false,
          message: 'Shop context is required',
        });
        return;
      }

      const parsed = parseInvoiceListQuery(req.query);
      if (!parsed.value) {
        res.status(400).json({ success: false, message: parsed.error });
        return;
      }
      const page = await invoiceService.getInvoicePage(
        { ...parsed.value, shopId },
        req.user!,
        { includePaymentMethods: true },
      );
      respondWithInvoicePage(res, page);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch managed invoices'));
    }
  }

  async getAdminInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = parseInvoiceListQuery(req.query);
      if (!parsed.value) {
        res.status(400).json({ success: false, message: parsed.error });
        return;
      }
      const shopId = req.query.shopId;
      if (shopId !== undefined && typeof shopId !== 'string') {
        res.status(400).json({ success: false, message: 'shopId must be a string' });
        return;
      }
      const page = await invoiceService.getInvoicePage(
        { ...parsed.value, ...(typeof shopId === 'string' && shopId ? { shopId } : {}) },
        req.user!,
        { includeShops: true, includeCustomerEmail: true },
      );
      respondWithInvoicePage(res, page);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch admin invoices'));
    }
  }

  async verifyInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const { approved, reason } = req.body as { approved?: boolean; reason?: string };
      const verifiedBy = req.user?.id ?? 'system';

      if (typeof approved !== 'boolean') {
        res.status(400).json({
          success: false,
          message: 'approved must be a boolean',
        });
        return;
      }

      if (req.user?.role !== 'admin' && !req.user?.shopId) {
        res.status(400).json({ success: false, message: 'Shop context is required' });
        return;
      }

      const invoice = await invoiceService.verifyInvoice(id, approved, verifiedBy, reason, req.user?.shopId);
      res.json({
        success: true,
        data: invoice,
      });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to verify invoice slip'));
    }
  }

  async uploadPaymentSlip(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const paymentSlipUrl = typeof req.body.paymentSlipUrl === 'string' ? req.body.paymentSlipUrl : '';
      if (!paymentSlipUrl.startsWith('data:image/')) {
        res.status(400).json({ success: false, message: 'A valid image payment slip is required' });
        return;
      }

      const invoice = await invoiceService.uploadPaymentSlip(
        req.params.id,
        req.user?.customerId ?? '',
        paymentSlipUrl,
      );
      res.json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to upload invoice slip'));
    }
  }

  async voidInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';

      if (reason.length < 10) {
        res.status(400).json({ success: false, message: 'A reason of at least 10 characters is required' });
        return;
      }

      const invoice = await invoiceService.voidInvoice(req.params.id, req.user?.id ?? 'system', reason);
      res.json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to void invoice'));
    }
  }

  async refundInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const amount = String(req.body.amount ?? '');
      const method = req.body.method as RefundMethod;
      const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
      const allowedMethods: RefundMethod[] = ['BANK_TRANSFER', 'CREDIT_CARD', 'SYSTEM_CREDIT'];

      if (!allowedMethods.includes(method)) {
        res.status(400).json({ success: false, message: 'A valid refund method is required' });
        return;
      }

      if (reason.length < 10) {
        res.status(400).json({ success: false, message: 'A reason of at least 10 characters is required' });
        return;
      }

      const invoice = await invoiceService.refundInvoice(
        req.params.id,
        req.user?.id ?? 'system',
        amount,
        method,
        reason,
      );
      res.json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to refund invoice'));
    }
  }

  async generatePdf(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (req.user?.role !== 'admin' && !req.user?.shopId) {
        res.status(400).json({ success: false, message: 'Shop context is required' });
        return;
      }

      const invoice = await invoiceService.generateInvoicePdf(req.params.id, req.user?.shopId);

      if (!invoice) {
        res.status(404).json({ success: false, message: 'Invoice not found' });
        return;
      }

      res.json({
        success: true,
        data: invoice,
      });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to generate invoice PDF'));
    }
  }

  async generateBatchPdf(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const invoiceIds = Array.isArray(req.body?.invoiceIds)
        ? req.body.invoiceIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        : [];

      if (invoiceIds.length === 0) {
        res.status(400).json({ success: false, message: 'At least one invoice id is required' });
        return;
      }

      if (req.user?.role !== 'admin' && !req.user?.shopId) {
        res.status(400).json({ success: false, message: 'Shop context is required' });
        return;
      }

      const invoices = await invoiceService.generateInvoicePdfBatch(invoiceIds, req.user?.shopId);
      res.json({ success: true, data: invoices });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to generate invoice PDFs'));
    }
  }

  async downloadBatchPdf(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const invoiceIds = Array.isArray(req.body?.invoiceIds)
        ? req.body.invoiceIds.filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        : [];

      if (invoiceIds.length === 0) {
        res.status(400).json({ success: false, message: 'At least one invoice id is required' });
        return;
      }

      if (req.user?.role !== 'admin' && !req.user?.shopId) {
        res.status(400).json({ success: false, message: 'Shop context is required' });
        return;
      }

      const pdfEntries = await invoiceService.buildBatchPdfArchive(invoiceIds, req.user?.shopId);
      if (pdfEntries.length === 0) {
        res.status(400).json({ success: false, message: 'No downloadable PDFs were found for the selected invoices.' });
        return;
      }

      const archiverModule = await import('archiver');
      const archiver = ((archiverModule as any).default ?? archiverModule) as (format: string, options?: any) => any;
      const archive = archiver('zip', { zlib: { level: 9 } });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="invoice-batch-${Date.now()}.zip"`);

      archive.on('error', (error: Error) => {
        next(error instanceof Error ? error : new Error('Failed to build batch PDF archive'));
      });

      archive.pipe(res);
      pdfEntries.forEach((entry) => {
        archive.append(entry.buffer, { name: entry.name });
      });

      await archive.finalize();
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to download invoice PDFs'));
    }
  }
}
export default new InvoiceController();
