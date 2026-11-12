CREATE TABLE `invoice_number_sequences` (
  `date` CHAR(8) NOT NULL,
  `lastNumber` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_reference_sequences` (
  `date` CHAR(8) NOT NULL,
  `lastNumber` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `invoice_number_sequences` (`date`, `lastNumber`, `createdAt`, `updatedAt`)
SELECT `sequence_date`, MAX(`sequence_number`), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM (
  SELECT
    CASE
      WHEN `invoiceNumber` LIKE 'DNI-INV-%' THEN SUBSTRING(`invoiceNumber`, 9, 8)
      ELSE SUBSTRING(`invoiceNumber`, 5, 8)
    END AS `sequence_date`,
    CAST(SUBSTRING_INDEX(`invoiceNumber`, '-', -1) AS UNSIGNED) AS `sequence_number`
  FROM `invoices`
  WHERE `invoiceNumber` REGEXP '^(DNI-)?INV-[0-9]{8}-[0-9]+$'
) AS `invoice_numbers`
GROUP BY `sequence_date`;

INSERT INTO `order_reference_sequences` (`date`, `lastNumber`, `createdAt`, `updatedAt`)
SELECT `sequence_date`, MAX(`sequence_number`), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM (
  SELECT
    CASE
      WHEN `orderReference` LIKE 'DNI-ORD-%' THEN SUBSTRING(`orderReference`, 9, 8)
      ELSE SUBSTRING(`orderReference`, 5, 8)
    END AS `sequence_date`,
    CAST(SUBSTRING_INDEX(`orderReference`, '-', -1) AS UNSIGNED) AS `sequence_number`
  FROM `invoice_order_references`
  WHERE `orderReference` REGEXP '^(DNI-)?ORD-[0-9]{8}-[0-9]+$'

  UNION ALL

  SELECT
    CASE
      WHEN `orderReference` LIKE 'DNI-ORD-%' THEN SUBSTRING(`orderReference`, 9, 8)
      ELSE SUBSTRING(`orderReference`, 5, 8)
    END AS `sequence_date`,
    CAST(SUBSTRING_INDEX(`orderReference`, '-', -1) AS UNSIGNED) AS `sequence_number`
  FROM `invoices`
  WHERE `orderReference` REGEXP '^(DNI-)?ORD-[0-9]{8}-[0-9]+$'
) AS `order_references`
GROUP BY `sequence_date`;
