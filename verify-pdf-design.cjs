/** Extract visible text from a PDF (inflates content streams) to verify the design. */
const fs = require('fs');
const zlib = require('zlib');

const pdf = fs.readFileSync(process.argv[2]);
const chunks = [];
let out = '';

const re = /stream\r?\n([\s\S]*?)endstream/g;
let m;
while ((m = re.exec(pdf.toString('latin1'))) !== null) {
  const raw = Buffer.from(m[1], 'latin1');
  try {
    chunks.push(zlib.inflateSync(raw).toString('latin1'));
  } catch {
    chunks.push(raw.toString('latin1'));
  }
}

out = chunks.join('\n');
// Pull text-showing operators: (....) Tj  and  [(..)..] TJ
const shown = [];
for (const seg of out.split(/\r?\n/)) {
  for (const t of seg.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) shown.push(t[1]);
  for (const t of seg.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ/g)) {
    for (const p of t[1].matchAll(/\(((?:\\.|[^\\)])*)\)/g)) shown.push(p[1]);
  }
}

const text = shown
  .join(' ')
  .replace(/\\([()\\])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

const markers = process.argv.slice(3);
const lines = [];
lines.push('--- extracted text (first 1200 chars) ---');
lines.push(text.slice(0, 1200));
lines.push('');
lines.push('--- design markers ---');

let fails = 0;
for (const marker of markers) {
  const idx = marker.indexOf('=');
  const label = idx === -1 ? marker : marker.slice(0, idx);
  const expected = idx === -1 ? 'present' : marker.slice(idx + 1);
  const wantAbsent = expected === 'absent';
  const has = text.includes(label);
  const ok = wantAbsent ? !has : has;
  if (!ok) fails += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label} (${wantAbsent ? 'should be absent' : 'should be present'})`);
}
lines.push(fails === 0 ? '\nALL PDF DESIGN MARKERS PASSED' : `\n${fails} MARKER(S) FAILED`);

fs.writeFileSync(__dirname + '/pdfreport.txt', lines.join('\n'));
process.exit(fails === 0 ? 0 : 1);