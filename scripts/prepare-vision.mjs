import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, cp, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const asset = JSON.parse(await readFile(path.join(root, 'src/vision/model-assets.json'), 'utf8'));
const packageInfo = JSON.parse(await readFile(path.join(root, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8'));
if (packageInfo.version !== asset.runtimeVersion) throw new Error('MediaPipe runtime version does not match the pinned assets.');
const directory = path.join(root, 'public/vision'), model = path.join(directory, asset.modelFile), manifestFile = path.join(directory, 'manifest.json');
await mkdir(directory, { recursive: true });
await cp(path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm'), path.join(directory, `wasm-${asset.runtimeVersion}`), { recursive: true });
const sha = data => createHash('sha256').update(data).digest('hex');
let cached;
try {
  const existing = JSON.parse(await readFile(manifestFile, 'utf8'));
  const bytes = await readFile(model);
  if (existing.modelVersion === asset.modelVersion && existing.runtimeVersion === asset.runtimeVersion && sha(bytes) === existing.sha256 && (!asset.sha256 || sha(bytes) === asset.sha256)) cached = { bytes, hash: sha(bytes) };
} catch { /* Missing or invalid cache is replaced only by a verified official download. */ }
if (!cached) {
  const temporary = `${model}.download`, headers = `${model}.headers`;
  try {
    const result = spawnSync('curl', ['--fail', '--location', '--proto', '=https', '--max-time', '60', '--silent', '--show-error', '--dump-header', headers, '--output', temporary, asset.modelUrl], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (result.status !== 0) throw new Error(`Official model download failed. Allow storage.googleapis.com in environment network settings. ${result.stderr?.toString().trim() ?? ''}`);
    const bytes = await readFile(temporary), hash = sha(bytes);
    if (asset.sha256 && hash !== asset.sha256) throw new Error('Pinned model SHA-256 verification failed.');
    const metadata = await readFile(headers, 'utf8'), expectedMD5 = /\bmd5=([A-Za-z0-9+/=]+)/.exec(metadata)?.[1];
    if (!asset.sha256 && !expectedMD5) throw new Error('Official artifact checksum was not supplied. Refusing an unverified model.');
    if (expectedMD5 && createHash('md5').update(bytes).digest('base64') !== expectedMD5) throw new Error('Google Storage artifact MD5 verification failed.');
    if (bytes.length < 1_000_000 || bytes.subarray(4, 8).toString('ascii') !== 'TFL3') throw new Error('Unexpected model format or size.');
    await rename(temporary, model); cached = { bytes, hash };
  } finally { await rm(temporary, { force: true }); await rm(headers, { force: true }); }
}
await writeFile(manifestFile, JSON.stringify({ runtimeVersion: asset.runtimeVersion, modelVersion: asset.modelVersion, sha256: cached.hash }, null, 2) + '\n');
// Remove the obsolete, generated pose asset when switching an existing checkout.
await rm(path.join(directory, 'pose_landmarker_lite-float16-1.task'), { force: true });
console.log(`Verified ${asset.modelVersion}: ${cached.hash}`);
