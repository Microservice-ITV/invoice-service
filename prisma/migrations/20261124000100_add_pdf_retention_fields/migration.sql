ALTER TABLE `invoices`
  ADD COLUMN `pdfCleanupToken` CHAR(36) NULL,
  ADD COLUMN `pdfCleanupLeaseUntil` DATETIME(3) NULL;

ALTER TABLE `receipts`
  ADD COLUMN `pdfCleanupToken` CHAR(36) NULL,
  ADD COLUMN `pdfCleanupLeaseUntil` DATETIME(3) NULL;

ALTER TABLE `thermal_pdf_jobs`
  MODIFY COLUMN `status` ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED', 'CLEANING') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `cleanupToken` CHAR(36) NULL,
  ADD COLUMN `cleanupLeaseUntil` DATETIME(3) NULL;

CREATE TABLE `pdf_artifacts` (
  `id` CHAR(36) NOT NULL,
  `kind` ENUM('INVOICE_A4', 'INVOICE_THERMAL', 'RECEIPT_PDF', 'RECEIPT_THERMAL') NOT NULL,
  `sourceId` CHAR(36) NOT NULL,
  `width` VARCHAR(4) NOT NULL,
  `artifactRef` VARCHAR(255) NOT NULL,
  `status` ENUM('UPLOADING', 'READY', 'CLEANING') NOT NULL DEFAULT 'READY',
  `generatedAt` DATETIME(3) NOT NULL,
  `cleanupToken` CHAR(36) NULL,
  `cleanupLeaseUntil` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `pdf_artifacts_artifactRef_key` (`artifactRef`),
  INDEX `pdf_artifacts_status_generatedAt_idx` (`status`, `generatedAt`),
  INDEX `pdf_artifacts_status_updatedAt_idx` (`status`, `updatedAt`),
  INDEX `pdf_artifacts_kind_sourceId_width_idx` (`kind`, `sourceId`, `width`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `pdf_artifacts`
  (`id`, `kind`, `sourceId`, `width`, `artifactRef`, `status`, `generatedAt`, `createdAt`, `updatedAt`)
SELECT UUID(), 'INVOICE_A4', `id`, 'A4', `pdfUrl`, 'READY',
  COALESCE(`pdfUpdatedAt`, `updatedAt`), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `invoices`
WHERE `pdfUrl` REGEXP '^invoice-pdfs/[^/]+/react-print-v[0-9]+/[^/]+-[0-9]+-[a-z0-9]+[.]pdf$';

INSERT IGNORE INTO `pdf_artifacts`
  (`id`, `kind`, `sourceId`, `width`, `artifactRef`, `status`, `generatedAt`, `createdAt`, `updatedAt`)
SELECT UUID(), 'RECEIPT_PDF', `id`, '80mm', `pdfUrl`, 'READY',
  COALESCE(`pdfUpdatedAt`, `updatedAt`), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `receipts`
WHERE `pdfUrl` REGEXP '^invoice-pdfs/receipts/[^/]+/receipt-v1/[^/]+-[0-9]+-[a-z0-9]+[.]pdf$';

INSERT IGNORE INTO `pdf_artifacts`
  (`id`, `kind`, `sourceId`, `width`, `artifactRef`, `status`, `generatedAt`, `createdAt`, `updatedAt`)
SELECT UUID(),
  CASE
    WHEN `invoiceId` IS NOT NULL AND `width` = 'A4' THEN 'INVOICE_A4'
    WHEN `invoiceId` IS NOT NULL THEN 'INVOICE_THERMAL'
    WHEN `receiptId` IS NOT NULL THEN 'RECEIPT_THERMAL'
  END,
  COALESCE(`invoiceId`, `receiptId`), `width`, `artifactRef`, 'READY',
  `updatedAt`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `thermal_pdf_jobs`
WHERE (
    `invoiceId` IS NOT NULL AND `width` = 'A4'
    AND `artifactRef` REGEXP '^invoice-pdfs/[^/]+/react-print-v[0-9]+/[^/]+-[0-9]+-[a-z0-9]+[.]pdf$'
  )
   OR `artifactRef` REGEXP '^invoice-pdfs/thermal/[^/]+/[^/]+/(58mm|80mm)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]pdf$'
   OR `artifactRef` REGEXP '^invoice-pdfs/thermal/receipts/[^/]+/[^/]+/(58mm|80mm)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]pdf$';
