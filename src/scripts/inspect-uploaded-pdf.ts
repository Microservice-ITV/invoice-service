import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const sourcePath = 'C:/Users/DELL/Downloads/INV-20261008-000039-receipt-80mm.pdf';
const decodeHexUnicode = (hex: string) => (hex.match(/.{4}/g) ?? []).map((unit) => String.fromCharCode(parseInt(unit, 16))).join('');
const main = async () => {
  const buffer = await readFile(sourcePath);
  const source = buffer.toString('latin1');
  const objects = new Map<number, string>();
  for (const m of source.matchAll(/(\d+)\s+0\s+obj\b([\s\S]*?)\r?\nendobj/g)) objects.set(Number(m[1]), m[2]);
  const unicodeMaps = new Map<number, Map<string, string>>();
  for (const [id, body] of objects) {
    const cmapId = Number(body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/)?.[1]);
    if (!cmapId) continue;
    const cmapObj = objects.get(cmapId)!;
    const stream = cmapObj.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)?.[1];
    if (!stream) continue;
    let bytes = Buffer.from(stream, 'latin1');
    if (/\/Filter\s*\/FlateDecode/.test(cmapObj)) bytes = inflateSync(bytes);
    const cmap = bytes.toString('latin1');
    const mapping = new Map<string, string>();
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>/g)) mapping.set(pair[1].toUpperCase(), decodeHexUnicode(pair[2]));
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const line of block[1].split(/\r?\n/)) {
        const range = line.match(/<([\da-fA-F]+)>\s*<([\da-fA-F]+)>\s*<([\da-fA-F]+)>/);
        if (!range) continue;
        const start = parseInt(range[1], 16), end = parseInt(range[2], 16), target = parseInt(range[3], 16);
        for (let code = start; code <= end; code++) mapping.set(code.toString(16).toUpperCase().padStart(range[1].length, '0'), decodeHexUnicode((target + code - start).toString(16).toUpperCase().padStart(range[3].length, '0')));
      }
    }
    unicodeMaps.set(id, mapping);
  }
  const fontRefs = new Map([...source.matchAll(/\/(F\w+)\s+(\d+)\s+0\s+R/g)].map((m) => [m[1], Number(m[2])]));
  const pages = [...objects.entries()].filter(([, body]) => /\/Type\s*\/Page\b/.test(body));
  console.log(`file=${sourcePath} bytes=${buffer.length} pages=${pages.length}`);
  for (const [pageId, page] of pages) {
    const mediaBox = page.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)/);
    const contentsId = Number(page.match(/\/Contents\s+(\d+)\s+0\s+R/)?.[1]);
    const object = objects.get(contentsId);
    const raw = object?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)?.[1];
    let pageContent = raw ? Buffer.from(raw, 'latin1') : Buffer.alloc(0);
    if (raw && object && /\/Filter\s*\/FlateDecode/.test(object)) pageContent = inflateSync(pageContent);
    const streamText = pageContent.toString('latin1');
    let activeFont = '';
    let extractedText = '';
    const operators = /\/(F\w+)\s+[\d.]+\s+Tf|<([\da-fA-F]+)>\s*Tj/g;
    for (const op of streamText.matchAll(operators)) {
      if (op[1]) activeFont = op[1];
      else if (op[2]) {
        const map = unicodeMaps.get(fontRefs.get(activeFont) ?? -1);
        extractedText += (op[2].match(/.{4}/g) ?? []).map((glyph) => map?.get(glyph.toUpperCase()) ?? '�').join('') + ' ';
      }
    }
    console.log(JSON.stringify({ pageId, mediaBoxPt: mediaBox ? [Number(mediaBox[1]), Number(mediaBox[2])] : null, contentsId, streamBytes: pageContent.length, textOperators: [...streamText.matchAll(/\b(?:Tj|TJ)\b/g)].length, extractedText: extractedText.trim() }));
  }
};
void main().catch((error) => { console.error(error); process.exitCode = 1; });
