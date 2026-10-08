import { Router } from 'express';
import invoiceController from '@/controllers/invoice.controller';
import { auth, requireRoles } from '@/middleware/auth';
import { serviceAuth } from '@/middleware/serviceAuth';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({
    success: true,
    message: 'Invoice Service is running',
    timestamp: new Date().toISOString(),
  });
});

router.get(
  '/invoices/my-invoices',
  auth,
  requireRoles('customer'),
  invoiceController.getMyInvoices.bind(invoiceController)
);
router.get(
  '/invoices/by-number/:invoiceNumber',
  auth,
  requireRoles('customer', 'seller', 'shopAdmin', 'admin'),
  invoiceController.getInvoiceByNumber.bind(invoiceController)
);
router.get(
  '/invoices/shop-invoices',
  auth,
  requireRoles('seller', 'shopAdmin', 'admin'),
  invoiceController.getShopInvoices.bind(invoiceController)
);
router.get(
  '/invoices/manage',
  auth,
  requireRoles('shopAdmin', 'admin'),
  invoiceController.getManageInvoices.bind(invoiceController)
);
router.get(
  '/invoices/admin/all',
  auth,
  requireRoles('admin'),
  invoiceController.getAdminInvoices.bind(invoiceController)
);
router.post(
  '/admin/invoices/replay',
  auth,
  requireRoles('admin'),
  invoiceController.replayInvoices.bind(invoiceController)
);
router.get(
  '/admin/invoices/missing',
  auth,
  requireRoles('admin'),
  invoiceController.getMissingInvoices.bind(invoiceController)
);
router.post(
  '/admin/invoices/missing/replay',
  auth,
  requireRoles('admin'),
  invoiceController.replayMissingInvoice.bind(invoiceController)
);
router.post(
  '/admin/invoices/missing/replay-all',
  auth,
  requireRoles('admin'),
  invoiceController.replayAllMissingInvoices.bind(invoiceController)
);
// Print/PDF route. Authenticated by a short-lived, single-invoice print token
// issued by this service; access is re-checked against the invoice owner.
router.get(
  '/invoices/print/:invoiceNumber',
  invoiceController.getInvoiceForPrint.bind(invoiceController),
);

router.get(
  '/internal/invoices/:id/email-pdf',
  serviceAuth,
  invoiceController.downloadInvoicePdfForNotification.bind(invoiceController),
);
router.get('/invoices/:id/pdf', auth, invoiceController.downloadInvoicePdf.bind(invoiceController));
router.get('/invoices/:id', auth, invoiceController.getInvoice.bind(invoiceController));
router.post(
  '/invoices/:id/verify-slip',
  auth,
  requireRoles('admin', 'shopAdmin', 'seller'),
  invoiceController.verifyInvoice.bind(invoiceController)
);
router.post(
  '/invoices/:id/upload-slip',
  auth,
  requireRoles('customer'),
  invoiceController.uploadPaymentSlip.bind(invoiceController),
);
router.post(
  '/invoices/:id/void',
  auth,
  requireRoles('admin'),
  invoiceController.voidInvoice.bind(invoiceController)
);
router.post(
  '/invoices/:id/refund',
  auth,
  requireRoles('admin'),
  invoiceController.refundInvoice.bind(invoiceController)
);
router.post(
  '/invoices/batch/generate-pdf',
  auth,
  requireRoles('admin', 'shopAdmin', 'seller'),
  invoiceController.generateBatchPdf.bind(invoiceController)
);
router.post(
  '/invoices/batch/download',
  auth,
  requireRoles('admin', 'shopAdmin', 'seller'),
  invoiceController.downloadBatchPdf.bind(invoiceController)
);
router.post(
  '/invoices/:id/generate-pdf',
  auth,
  requireRoles('admin', 'shopAdmin', 'seller'),
  invoiceController.generatePdf.bind(invoiceController)
);
router.post(
  '/invoices/partial',
  auth,
  requireRoles('customer'),
  invoiceController.createPartialInvoice.bind(invoiceController),
);
router.post(
  '/internal/invoices/create',
  serviceAuth,
  invoiceController.createInvoice.bind(invoiceController),
);

export default router;
