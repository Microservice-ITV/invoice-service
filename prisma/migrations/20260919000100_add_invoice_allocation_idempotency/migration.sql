CREATE TABLE `invoice_order_item_allocations` (
    `id` CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
    `orderItemId` VARCHAR(50) COLLATE utf8mb4_unicode_ci NOT NULL,
    `orderId` CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
    `shopId` CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
    `orderedQuantity` INTEGER NOT NULL,
    `allocatedQuantity` INTEGER NOT NULL DEFAULT 0,
    `productId` CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
    `productName` VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    `productSku` VARCHAR(100) COLLATE utf8mb4_unicode_ci NULL,
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(10) COLLATE utf8mb4_unicode_ci NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `invoice_order_item_allocations_orderItemId_key` (`orderItemId`),
    INDEX `invoice_order_item_allocations_orderId_idx` (`orderId`),
    INDEX `invoice_order_item_allocations_orderId_shopId_idx` (`orderId`, `shopId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `invoice_idempotency` (
    `id` CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
    `idempotencyKey` VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
    `requestHash` CHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
    `invoiceId` CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `invoice_idempotency_idempotencyKey_key` (`idempotencyKey`),
    UNIQUE INDEX `invoice_idempotency_invoiceId_key` (`invoiceId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `invoice_idempotency_invoiceId_fkey`
      FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`)
      ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
