import { readFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const directory = new URL('../private-fixtures/', import.meta.url);
const file = new URL('reference-pose.jpg', directory);
const expected = 'c8a830ed683c0276d713dd5aeda28f415f10cd6291972084a40d0d8b934ed62b';
const hash = data => createHash('sha256').update(data).digest('hex');
try { if (hash(await readFile(file)) === expected) process.exit(0); } catch { /* Download only if absent. */ }
await mkdir(directory, { recursive: true });
const { fileURLToPath } = await import('node:url');
const temporary = `${fileURLToPath(file)}.download`;
try {
  const r = spawnSync('curl', ['--fail', '--location', '--proto', '=https', '--max-time', '30', '--silent', '--show-error', '--output', temporary, 'https://storage.googleapis.com/mediapipe-assets/pose.jpg'], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Reference photograph download failed.');
  if (hash(await readFile(temporary)) !== expected) throw new Error('Reference photograph SHA-256 mismatch.');
  await rename(temporary, file);
} finally { await rm(temporary, { force: true }); }
