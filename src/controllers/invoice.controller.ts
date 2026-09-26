import { NextFunction, Request, Response } from 'express';
import invoiceService from '@/services/invoice.service';
import { InvoiceStatus, RefundMethod } from '@/types/invoice';

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

export class InvoiceController {
  async createInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = req.body as Parameters<typeof invoiceService.createInvoiceFromPayment>[0];
      if (!payload.shopName?.trim() || !payload.customerName?.trim() || !payload.customerEmail?.trim()) {
        res.status(400).json({
          success: false,
          message: 'shopName, customerName, and customerEmail are required for invoice snapshots',
        });
        return;
      }

      const invoice = await invoiceService.createInvoiceFromPayment(payload);
      res.status(201).json({ success: true, data: invoice });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to create invoice'));
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

      const invoices = await invoiceService.getInvoicesByCustomer(customerId);
      res.json({ success: true, data: invoices });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch customer invoices'));
    }
  }

  async getShopInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shopId = req.user?.shopId;

      if (!shopId) {
        res.status(400).json({
          success: false,
          message: 'Shop context is required',
        });
        return;
      }

      const invoices = await invoiceService.getInvoicesByShop(shopId);
      res.json({ success: true, data: invoices });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch shop invoices'));
    }
  }

  async getManageInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const shopId = req.user?.shopId;
      const status = normalizeStatus(req.query.status as string | undefined);

      if (!shopId) {
        res.status(400).json({
          success: false,
          message: 'Shop context is required',
        });
        return;
      }

      const invoices = await invoiceService.getInvoicesByShop(shopId, status);
      res.json({ success: true, data: invoices });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch managed invoices'));
    }
  }

  async getAdminInvoices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const status = normalizeStatus(req.query.status as string | undefined);
      const invoices = await invoiceService.getAllInvoices(status);

      res.json({ success: true, data: invoices });
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
