ALTER TABLE `invoices`
    ADD COLUMN `deliveryFee` DECIMAL(12, 2) NOT NULL DEFAULT 0 AFTER `subtotal`;

ALTER TABLE `invoices`
    MODIFY `paymentMethod` VARCHAR(50) NULL;