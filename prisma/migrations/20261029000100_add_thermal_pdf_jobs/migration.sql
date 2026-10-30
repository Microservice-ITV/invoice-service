CREATE TABLE `thermal_pdf_jobs` (
  `id` CHAR(36) NOT NULL,
  `invoiceId` CHAR(36) NULL,
  `receiptId` CHAR(36) NULL,
  `width` VARCHAR(4) NOT NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED') NOT NULL DEFAULT 'PENDING',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `leaseToken` CHAR(36) NULL,
  `leaseUntil` DATETIME(3) NULL,
  `artifactRef` VARCHAR(255) NULL,
  `lastError` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `thermal_pdf_jobs_invoiceId_width_key` (`invoiceId`, `width`),
  UNIQUE INDEX `thermal_pdf_jobs_receiptId_width_key` (`receiptId`, `width`),
  INDEX `thermal_pdf_jobs_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `thermal_pdf_jobs_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `thermal_pdf_jobs_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `receipts` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `thermal_pdf_jobs` (`id`, `invoiceId`, `width`, `status`, `attempts`, `nextAttemptAt`, `updatedAt`)
SELECT UUID(), i.`id`, widths.`width`, 'PENDING', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `invoices` i
CROSS JOIN (SELECT '58mm' AS `width` UNION ALL SELECT '80mm') widths;

INSERT INTO `thermal_pdf_jobs` (`id`, `receiptId`, `width`, `status`, `attempts`, `nextAttemptAt`, `updatedAt`)
SELECT UUID(), r.`id`, widths.`width`, 'PENDING', 0, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `receipts` r
CROSS JOIN (SELECT '58mm' AS `width` UNION ALL SELECT '80mm') widths;
