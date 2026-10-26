import { NextFunction, Request, Response } from 'express';
import receiptService from '@/services/receipt.service';
import invoicePrintTokenService from '@/services/invoice-print-token.service';
import invoiceService from '@/services/invoice.service';

/**
 * Receipt endpoints reuse the invoice access policy: `auth` resolves the
 * actor, then `canAccessInvoice` (inside receiptService) enforces admin /
 * owning-customer / owning-shop authorization for both the JSON document and
 * the PDF bytes.
 */
export class ReceiptController {
  async getReceiptForPrint(req: Request, res: Response): Promise<void> {
    try {
      const invoiceNumber = req.params.invoiceNumber;
      const claims = invoicePrintTokenService.verify(req.header('x-print-token') ?? undefined, invoiceNumber);
      if (claims.document !== 'receipt' || !claims.receiptId) {
        res.status(403).json({ success: false, message: 'Print token is not scoped to a receipt' });
        return;
      }
      const invoice = await invoiceService.getInvoiceById(claims.invoiceId);
      if (!invoice || invoice.invoiceNumber !== invoiceNumber || invoice.status !== 'PAID' || invoice.customerId !== claims.sub) {
        res.status(404).json({ success: false, message: 'Receipt not found' });
        return;
      }
      const result = await receiptService.getReceiptForInvoice(invoice.id, {
        id: claims.sub, customerId: claims.sub, role: 'customer',
      });
      if (!result?.receipt || result.receipt.id !== claims.receiptId) {
        res.status(404).json({ success: false, message: 'Receipt not found' });
        return;
      }
      // Use the document-shaped invoice read above: receiptService's access
      // lookup intentionally returns the database row without hydrated items.
      res.json({ success: true, data: { invoice, receipt: result.receipt } });
    } catch (error) {
      res.status(401).json({ success: false, message: error instanceof Error ? error.message : 'Invalid print token' });
    }
  }

  async getReceiptByInvoice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const result = await receiptService.getReceiptForInvoice(req.params.id, req.user);
      if (!result) {
        res.status(404).json({ success: false, message: 'Receipt not found' });
        return;
      }

      if (!result.receipt) {
        res.status(404).json({
          success: false,
          message: 'No receipt exists for this invoice because it is not paid',
        });
        return;
      }

      res.json({ success: true, data: result.receipt });
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to fetch receipt'));
    }
  }

  async downloadReceiptPdf(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        res.status(401).json({ success: false, message: 'Authentication required' });
        return;
      }

      const widthValue = req.query.width;
      if (widthValue !== undefined && widthValue !== '58mm' && widthValue !== '80mm') {
        res.status(400).json({ success: false, message: 'width must be 58mm or 80mm' });
        return;
      }
      const result = await receiptService.downloadReceiptPdf(req.params.id, req.user, widthValue as '58mm' | '80mm' | undefined);
      if (!result) {
        res.status(404).json({ success: false, message: 'Receipt not found' });
        return;
      }

      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${result.receipt.receiptNumber}${widthValue ? `-receipt-${widthValue}` : ''}.pdf"`,
      );
      res.send(result.buffer);
    } catch (error) {
      next(error instanceof Error ? error : new Error('Failed to download receipt PDF'));
    }
  }
}

export default new ReceiptController();
