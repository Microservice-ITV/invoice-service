ALTER TABLE `invoices`
    ADD COLUMN `refundAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `refundMethod` VARCHAR(50) NULL,
    ADD COLUMN `refundReason` VARCHAR(191) NULL;