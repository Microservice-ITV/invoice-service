/**
 * One-off generator: embeds frontend-react/public/logo.svg into the invoice
 * service as a base64 data URI, so the PDF never depends on an external URL.
 *
 * Usage: node scripts/embed-logo.js   (run from invoice-service root)
 */
const fs = require('fs');
const path = require('path');

const sourcePath = path.resolve(__dirname, '../../frontend-react/public/logo.svg');
const targetPath = path.resolve(__dirname, '../src/assets/logo.ts');

const svg = fs.readFileSync(sourcePath);
const base64 = svg.toString('base64');

const file = [
  '/**',
  ' * Base64-embedded application logo (frontend-react `public/logo.svg`).',
  ' *',
  ' * Embedded directly so the generated invoice PDF never depends on an',
  ' * external URL, nor on the frontend build output existing at runtime.',
  ' *',
  ' * Generated from the real project asset by `scripts/embed-logo.js`.',
  ' */',
  "export const LOGO_DATA_URI = 'data:image/svg+xml;base64," + base64 + "';",
  '',
].join('\n');

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, file);

console.log('source:', sourcePath);
console.log('raw bytes:', svg.length);
console.log('base64 length:', base64.length);
console.log('wrote:', targetPath);