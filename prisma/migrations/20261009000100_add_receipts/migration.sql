CREATE TABLE `receipts` (
  `id` CHAR(36) NOT NULL,
  `receiptNumber` VARCHAR(50) NOT NULL,
  `invoiceId` CHAR(36) NOT NULL,
  `invoiceNumber` VARCHAR(50) NOT NULL,
  `orderId` CHAR(36) NOT NULL,
  `orderReference` VARCHAR(32) NULL,
  `shopId` CHAR(36) NOT NULL,
  `shopName` VARCHAR(255) NULL,
  `customerId` CHAR(36) NOT NULL,
  `customerName` VARCHAR(255) NULL,
  `customerEmail` VARCHAR(255) NULL,
  `subtotal` DECIMAL(12, 2) NOT NULL,
  `deliveryFee` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `discountAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `grandTotal` DECIMAL(12, 2) NOT NULL,
  `currency` VARCHAR(10) NOT NULL DEFAULT 'MMK',
  `paymentMethod` VARCHAR(50) NULL,
  `paymentGatewayRef` VARCHAR(255) NULL,
  `status` ENUM('ISSUED', 'VOID', 'REFUNDED') NOT NULL DEFAULT 'ISSUED',
  `pdfUrl` VARCHAR(255) NULL,
  `pdfStatus` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  `pdfError` TEXT NULL,
  `pdfAttemptCount` INTEGER NOT NULL DEFAULT 0,
  `pdfUpdatedAt` DATETIME(3) NULL,
  `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `receipts_receiptNumber_key`(`receiptNumber`),
  UNIQUE INDEX `receipts_invoiceId_key`(`invoiceId`),
  INDEX `receipts_orderId_idx`(`orderId`),
  INDEX `receipts_shopId_status_idx`(`shopId`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `receipts_invoiceId_fkey`
    FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `receipt_sequences` (
  `date` CHAR(8) NOT NULL,
  `lastNumber` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
