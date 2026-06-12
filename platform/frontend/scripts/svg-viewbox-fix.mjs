// Expand each SVG's viewBox to cover its true rendered geometry (getBBox).
// Fix is applied in place, only when paths overflow the declared viewBox.
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const roots = process.argv.slice(2);
const files = [];
for (const root of roots) {
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.svg')) files.push(p);
    }
  };
  walk(root);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const EPS = 0.01;
let fixed = 0;

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const vbm = src.match(/viewBox="([^"]+)"/);
  if (!vbm) { console.log(`SKIP (no viewBox): ${f}`); continue; }
  const [x, y, w, h] = vbm[1].split(/[\s,]+/).map(Number);

  await page.setContent(`<!DOCTYPE html><body>${src}</body>`);
  const bb = await page.evaluate(() => {
    const svg = document.querySelector('svg');
    const r = svg.getBBox();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  const nx = Math.min(x, bb.x), ny = Math.min(y, bb.y);
  const nx2 = Math.max(x + w, bb.x + bb.w), ny2 = Math.max(y + h, bb.y + bb.h);
  const overflow = (x - nx) + (y - ny) + (nx2 - (x + w)) + (ny2 - (y + h));
  if (overflow <= EPS) continue;

  const r3 = n => Math.round(n * 1000) / 1000;
  const newVb = `${r3(nx)} ${r3(ny)} ${r3(nx2 - nx)} ${r3(ny2 - ny)}`;
  let out = src.replace(vbm[0], `viewBox="${newVb}"`);
  // keep width/height attrs consistent with the new aspect when present
  out = out
    .replace(/(<svg[^>]*?)\swidth="[^"]*"/, `$1 width="${r3(nx2 - nx)}"`)
    .replace(/(<svg[^>]*?)\sheight="[^"]*"/, `$1 height="${r3(ny2 - ny)}"`);
  fs.writeFileSync(f, out);
  fixed++;
  console.log(`FIXED ${path.relative(process.cwd(), f)}: vb [${vbm[1]}] -> [${newVb}]`);
}
await browser.close();
console.log(`\n${fixed}/${files.length} files fixed`);
