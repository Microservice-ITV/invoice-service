-- Allow one order to have multiple invoices.
DROP INDEX `invoices_orderId_key` ON `invoices`;

-- Align invoice number length with the Prisma schema.
ALTER TABLE `invoices`
    MODIFY `invoiceNumber` VARCHAR(50) NOT NULL;

-- Normalized invoice line items.
CREATE TABLE `invoice_items` (
    `id` CHAR(36) NOT NULL,
    `invoiceId` CHAR(36) NOT NULL,
    `orderItemId` CHAR(36) NOT NULL,
    `productId` CHAR(36) NOT NULL,
    `productName` VARCHAR(255) NOT NULL,
    `productSku` VARCHAR(100) NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `discountAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `totalPrice` DECIMAL(12, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invoice_items_invoiceId_orderItemId_key` (`invoiceId`, `orderItemId`),
    INDEX `invoice_items_orderItemId_idx` (`orderItemId`),
    INDEX `invoice_items_productId_idx` (`productId`),

    PRIMARY KEY (`id`),

    CONSTRAINT `invoice_items_invoiceId_fkey`
        FOREIGN KEY (`invoiceId`) REFERENCES `invoices` (`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX `invoices_orderId_shopId_idx`
    ON `invoices` (`orderId`, `shopId`);

CREATE INDEX `invoices_shopId_status_idx`
    ON `invoices` (`shopId`, `status`);
