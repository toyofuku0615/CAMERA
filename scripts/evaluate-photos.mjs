// Local-only evaluation of annotated physical photographs. Never uploads an image.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const file = path.resolve(process.argv[2] ?? 'private-fixtures/manifest.json');
let manifest;
try { manifest = JSON.parse(await readFile(file, 'utf8')); }
catch { console.error('Provide private-fixtures/manifest.json using docs/PHOTO_VALIDATION.md. No physical trials have been run.'); process.exit(2); }
if (!Array.isArray(manifest.photos) || !manifest.photos.length) throw new Error('photos must be a nonempty array.');
const url = process.env.BACKSTAGE_TEST_URL ?? 'http://127.0.0.1:5173';
if (!['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Use a local development server. Images must not be submitted to a remote website.');
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
const seen = new Set(), records = [];
try {
  const page = await browser.newPage(); await page.goto(`${url}/dev`);
  for (const entry of manifest.photos) {
    if (typeof entry.background !== 'string' || !entry.background.trim() || !['one', 'two', 'none'].includes(entry.condition) || !Array.isArray(entry.expected) || entry.expected.length !== ({ one: 1, two: 2, none: 0 })[entry.condition]) throw new Error('Every photograph requires its condition and the matching number of annotated expected boxes.');
    const buffer = await readFile(path.resolve(path.dirname(file), entry.file)), hash = createHash('sha256').update(buffer).digest('hex');
    if (seen.has(hash)) throw new Error(`Repeated photograph cannot count as a new capture: ${entry.file}`); seen.add(hash);
    const analysis = await page.evaluate(async ({ encoded, mime }) => {
      const { analyzeCanvas } = await import('/src/vision/frames.ts');
      const image = new Image(); image.src = `data:${mime};base64,${encoded}`; await image.decode();
      const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; c.getContext('2d').drawImage(image, 0, 0);
      return { ...await analyzeCanvas(c), imageWidth: c.width, imageHeight: c.height };
    }, { encoded: buffer.toString('base64'), mime: buffer[0] === 0x89 ? 'image/png' : 'image/jpeg' });
    for (const box of entry.expected) if (!Number.isFinite(box.x + box.y + box.width + box.height) || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.x + box.width > analysis.imageWidth || box.y + box.height > analysis.imageHeight) throw new Error(`Invalid annotation: ${entry.file}`);
    const unmatched = [...analysis.boxes];
    const matched = entry.expected.every(expected => {
      const index = unmatched.findIndex(actual => {
        const intersection = Math.max(0, Math.min(expected.x + expected.width, actual.x + actual.width) - Math.max(expected.x, actual.x)) * Math.max(0, Math.min(expected.y + expected.height, actual.y + actual.height) - Math.max(expected.y, actual.y));
        return intersection / Math.max(1, expected.width * expected.height + actual.width * actual.height - intersection) > .2;
      });
      if (index < 0) return false; unmatched.splice(index, 1); return true;
    });
    records.push({ file: entry.file, hash, background: entry.background, condition: entry.condition, sourceLabel: manifest.sourceLabel ?? 'unspecified; cannot be assumed physical', expected: entry.expected, analysis, success: analysis.status === 'ok' && matched && unmatched.length === 0 });
  }
} finally { await browser.close(); }
const summary = [];
for (const background of new Set(records.map(r => r.background))) for (const condition of ['one', 'two', 'none']) {
  const trials = records.filter(r => r.background === background && r.condition === condition), required = condition === 'one' ? .9 : .8;
  summary.push({ background, condition, trials: trials.length, successes: trials.filter(r => r.success).length, target: required, evaluated: trials.length >= 10, achieved: trials.length >= 10 && trials.filter(r => r.success).length / trials.length >= required });
}
await mkdir('validation-results', { recursive: true });
await writeFile('validation-results/physical-photos.json', JSON.stringify({ sourceLabel: manifest.sourceLabel, records, summary }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (records.some(r => !r.success)) process.exitCode = 1;
