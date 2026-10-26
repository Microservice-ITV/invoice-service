import { inflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import thermalRenderer from '@/services/thermal-react-pdf-renderer.service';

const inspectPdf = (buffer: Buffer) => {
  const source = buffer.toString('latin1');
  const objects = new Map<number, string>();
  for (const match of source.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)\r?\nendobj/g)) objects.set(Number(match[1]), match[2]);
  return [...objects.values()].filter((obj) => /\/Type\s*\/Page\b/.test(obj)).map((page) => {
    const box = page.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
    const reference = page.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const contentObject = reference ? objects.get(Number(reference[1])) : undefined;
    const stream = contentObject?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
    if (!box || !contentObject || !stream) throw new Error('Could not inspect PDF page media box/content stream');
    let bytes = Buffer.from(stream[1], 'latin1');
    if (/\/Filter\s*\/FlateDecode/.test(contentObject)) bytes = inflateSync(bytes);
    const contents = bytes.toString('latin1');
    return { widthPt: Number(box[1]), heightPt: Number(box[2]), textOperators: [...contents.matchAll(/\b(?:Tj|TJ)\b/g)].length };
  });
};

const output = join(process.cwd(), '..', '.thermal-pdf-debug');
const main = async () => {
  await mkdir(output, { recursive: true });
  for (const kind of ['invoice', 'receipt']) {
    for (const width of ['58mm', '80mm'] as const) {
      for (const count of kind === 'invoice' ? [3, 80] : [3]) {
        const url = `http://127.0.0.1:5173/thermal-inspect.html?kind=${kind}&width=${width}&count=${count}`;
        const { buffer, diagnostics } = await thermalRenderer.renderWithDiagnostics(url, width);
        const pages = inspectPdf(buffer);
        const filename = `${kind}-${width}-${count}.pdf`;
        await writeFile(join(output, filename), buffer);
        console.log(JSON.stringify({ kind, width, count, filename, pages, ...diagnostics }));
      }
    }
  }
};
void main().catch((error) => { console.error(error); process.exitCode = 1; });
