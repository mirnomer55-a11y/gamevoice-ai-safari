// Local, language-independent evidence of small glyphs arranged in text rows.
// No frame history or images are retained. Scratch buffers are reused.
export class GlyphDetector {
  constructor() { this.seen = new Uint8Array(); this.stack = new Int32Array(); }
  find(pixels, width, height) {
    const size = width * height;
    if (this.seen.length !== size) {
      this.seen = new Uint8Array(size); this.stack = new Int32Array(size);
    } else this.seen.fill(0);
    const { seen, stack } = this, glyphs = [];
    for (let seed = 0; seed < size; seed++) {
      if (seen[seed] || pixels[seed * 4] !== 0) continue;
      let read = 0, write = 1, area = 0;
      let x0 = width, x1 = 0, y0 = height, y1 = 0;
      stack[0] = seed; seen[seed] = 1;
      while (read < write) {
        const pos = stack[read++], x = pos % width, y = (pos / width) | 0;
        area++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
          for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
            const next = yy * width + xx;
            if (!seen[next] && pixels[next * 4] === 0) { seen[next] = 1; stack[write++] = next; }
          }
        }
      }
      const w = x1 - x0 + 1, h = y1 - y0 + 1, fill = area / (w * h);
      // Reject isolated specks, solid bright surfaces, screen borders and long edges.
      if (h >= 6 && h <= Math.min(140, height * 0.95) && w >= 2 && w <= h * 1.9 &&
          fill >= 0.09 && fill <= 0.88 && area >= 9 && x0 > 0 && x1 < width - 1 && y0 > 0 && y1 < height - 1) {
        glyphs.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, h, cy: (y0 + y1) / 2 });
      }
    }
    const groups = [];
    for (const glyph of glyphs.sort((a,b) => a.cy - b.cy)) {
      let group = groups.find(g => Math.abs(g.cy - glyph.cy) <= Math.max(g.h, glyph.h) * 0.34 &&
        glyph.h >= g.h * 0.5 && glyph.h <= g.h * 1.8);
      if (!group) { group = { cy: glyph.cy, h: glyph.h, glyphs: [] }; groups.push(group); }
      group.glyphs.push(glyph);
      const n = group.glyphs.length;
      group.cy += (glyph.cy - group.cy) / n; group.h += (glyph.h - group.h) / n;
    }
    const rows = [];
    for (const group of groups) {
      let run = [];
      const finish = () => {
        if (run.length < 2) return;
        const x0 = run[0].x0, x1 = Math.max(...run.map(g => g.x1));
        const y0 = Math.min(...run.map(g => g.y0)), y1 = Math.max(...run.map(g => g.y1));
        if (x1 - x0 >= group.h * 0.7) rows.push({ x0, y0, x1, y1, glyphs: run.length });
      };
      for (const glyph of group.glyphs.sort((a,b) => a.x0 - b.x0)) {
        if (run.length && glyph.x0 - run.at(-1).x1 > group.h * 2.8) { finish(); run = []; }
        run.push(glyph);
      }
      finish();
    }
    return rows.sort((a,b) => a.y0 - b.y0 || a.x0 - b.x0);
  }
}

// Follow coherent rows within the user's wide ROI. A large bright game object
// must not win just because it contains more white pixels than a short reply.
export function textCrop(rows, width, height) {
  if (!rows.length) return null;
  const best = rows.reduce((a,b) => a.glyphs >= b.glyphs ? a : b);
  const lineHeight = best.y1 - best.y0, selected = new Set([best]);
  let x0 = best.x0, x1 = best.x1, y0 = best.y0, y1 = best.y1;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      const h = row.y1 - row.y0;
      if (selected.has(row) || h < lineHeight * 0.5 || h > lineHeight * 1.9) continue;
      if (row.y0 > y1 + lineHeight * 1.8 || row.y1 < y0 - lineHeight * 1.8 ||
          row.x0 > x1 + lineHeight * 2 || row.x1 < x0 - lineHeight * 2) continue;
      selected.add(row); changed = true;
      x0 = Math.min(x0,row.x0); x1 = Math.max(x1,row.x1);
      y0 = Math.min(y0,row.y0); y1 = Math.max(y1,row.y1);
    }
  }
  const margin = Math.max(12,Math.ceil(lineHeight * 2));
  return { left:Math.max(0,x0-margin),right:Math.min(width,x1+margin),
    top:Math.max(0,y0-6),bottom:Math.min(height,y1+6),rows:[...selected] };
}

export function maskOutsideRows(pixels, width, height, rows) {
  const ranges = Array.from({length:height},() => []);
  for (const row of rows) {
    const h = row.y1-row.y0, dx = Math.max(4,Math.ceil(h*0.35)), dy = Math.max(3,Math.ceil(h*0.18));
    for (let y=Math.max(0,row.y0-dy);y<Math.min(height,row.y1+dy);y++) {
      ranges[y].push([Math.max(0,row.x0-dx),Math.min(width,row.x1+dx)]);
    }
  }
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=4*(y*width+x);
    if(pixels[i]===0 && !ranges[y].some(([left,right])=>x>=left&&x<right)) pixels[i]=pixels[i+1]=pixels[i+2]=255;
  }
}

const letters = text => (String(text).match(/[\p{L}]/gu) || []).length;
const wordTokens = text => String(text).match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || [];
const single = new Set('а в и к о с у я б ж'.split(' '));
const vowelFree = /^(?:хм|мгм|мм|пс|тс|тсс|брр|м-м|хм-м)$/iu;
const shortReply = /^(?:а|и|о|я|да|не|ни|ну|но|ой|ай|эй|ау|ах|ох|эх|ух|фу|фи|хм|мм|мгм|пс|тс|тсс)$/iu;

// A recognizer can return confident letters from a textured game background.
// Require independent word/line geometry, confidence and linguistic evidence.
// Reject an uncertain caption as a whole; never delete its last unknown word.
export function captionEvidence(lines, text, frame) {
  const tokens = wordTokens(text), count = letters(text);
  if (!tokens.length || !count) return { ok: false, reason: 'empty' };
  if (/[^\p{L}\p{N}\p{Sc}\s.,!?…:;"'«»“”„‚‘’()—–\-/%№+]/u.test(text) || /([\p{L}])\1{3,}/iu.test(text)) {
    return { ok: false, reason: 'noise' };
  }
  const russian = (text.match(/[а-яё]/giu) || []).length;
  if (russian / count < 0.65) return { ok: false, reason: 'language' };
  let bad = 0;
  for (const token of tokens) {
    if (!letters(token)) continue;
    const lower = token.toLowerCase();
    if (!/[а-яё]/iu.test(token)) continue;
    if ((/[а-яё]/iu.test(token) && /[a-z]/iu.test(token)) ||
        (letters(token) === 1 && !single.has(lower)) ||
        (letters(token) >= 3 && !/[бвгджзйклмнпрстфхцчшщ]/iu.test(token) && !shortReply.test(lower)) ||
        (letters(token) > 1 && !/[аеёиоуыэюя]/iu.test(token) && !vowelFree.test(token))) bad++;
  }
  if (bad > 0 && (tokens.length < 5 || bad / tokens.length > 0.15)) return { ok: false, reason: 'fragments' };
  if (tokens.length === 1 && count < 3 && !shortReply.test(tokens[0])) return { ok: false, reason: 'fragments' };
  const words = lines.flatMap(line => line.words || []).filter(word => letters(word.text) > 0);
  if (!words.length) return { ok: false, reason: 'no-word-boxes' };
  let total = 0, good = 0, supported = 0, weighted = 0;
  for (const word of words) {
    const n = letters(word.text), box = word.bbox, confidence = Number(word.confidence);
    total += n; weighted += (Number.isFinite(confidence) ? confidence : 0) * n;
    if (!box) continue;
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    if (h < 5 || w <= 0 || w / (h * n) < 0.075 || w / (h * n) > 1.8) continue;
    if (confidence >= 68) good += n;
    if (!frame?.textRows) { supported += n; continue; }
    const x0 = box.x0 + frame.offsetX, x1 = box.x1 + frame.offsetX;
    const y0 = box.y0 + frame.offsetY, y1 = box.y1 + frame.offsetY;
    if (frame.textRows.some(row => {
      const overlapX = Math.max(0, Math.min(x1, row.x1) - Math.max(x0, row.x0));
      const overlapY = Math.max(0, Math.min(y1, row.y1) - Math.max(y0, row.y0));
      return overlapX / w >= 0.45 && overlapY / h >= 0.5 && h <= (row.y1 - row.y0) * 2;
    })) supported += n;
  }
  const confidence = weighted / Math.max(1, total);
  if (good / Math.max(1, total) < 0.6 || confidence < (tokens.length <= 2 ? 80 : 70)) {
    return { ok: false, reason: 'weak-words' };
  }
  if (supported / Math.max(1, total) < 0.65) return { ok: false, reason: 'background' };
  return { ok: true, confidence, wordCount: tokens.length, visual: !!frame?.textRows };
}
