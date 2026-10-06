ALTER TABLE `invoices`
  ADD COLUMN `orderReference` VARCHAR(32) NULL,
  ADD COLUMN `customerPhone` VARCHAR(64) NULL,
  ADD COLUMN `billingAddress` JSON NULL,
  ADD COLUMN `shippingAddress` JSON NULL,
  ADD COLUMN `shopContactName` VARCHAR(255) NULL,
  ADD COLUMN `shopContactEmail` VARCHAR(255) NULL,
  ADD COLUMN `shopContactPhone` VARCHAR(64) NULL,
  ADD COLUMN `shopAddress` TEXT NULL;

CREATE TABLE `invoice_sequences` (
  `date` CHAR(8) NOT NULL,
  `lastNumber` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `invoice_order_references` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `orderId` CHAR(36) NOT NULL,
  `orderReference` VARCHAR(50) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `invoice_order_references_orderId_key` (`orderId`),
  UNIQUE INDEX `invoice_order_references_orderReference_key` (`orderReference`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;