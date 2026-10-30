ALTER TABLE `thermal_pdf_jobs`
  ADD COLUMN `templateVersion` VARCHAR(64) NULL AFTER `artifactRef`;
