DROP INDEX `invoices_orderId_idx` ON `invoices`;
DROP INDEX `invoices_customerId_idx` ON `invoices`;
DROP INDEX `invoices_shopId_status_idx` ON `invoices`;
DROP INDEX `invoices_status_idx` ON `invoices`;
DROP INDEX `invoices_shopId_idx` ON `invoices`;

CREATE INDEX `invoices_orderId_createdAt_idx` ON `invoices`(`orderId`, `createdAt`);

CREATE INDEX `invoices_customerId_createdAt_idx` ON `invoices`(`customerId`, `createdAt`);

CREATE INDEX `invoices_shopId_createdAt_idx` ON `invoices`(`shopId`, `createdAt`);

CREATE INDEX `invoices_shopId_status_createdAt_idx` ON `invoices`(`shopId`, `status`, `createdAt`);

CREATE INDEX `invoices_status_createdAt_idx` ON `invoices`(`status`, `createdAt`);

CREATE INDEX `invoices_createdAt_idx` ON `invoices`(`createdAt`);
