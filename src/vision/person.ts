import { GUIDE, PERSON } from '../config';
import type { Box } from './detector';
export interface Point { x: number; y: number }
export interface ConfidenceMask { width: number; height: number; data: Float32Array }
export interface PersonObservation { mask: ConfidenceMask; clothes: ConfidenceMask; skin?: ConfidenceMask }
export interface TorsoRegion {
  width: number; height: number; personMask: Uint8Array; roi: Uint8Array;
  polygon: Point[]; bounds: Box; source: 'clothes' | 'none';
  coverage: number; excludedHandFraction: number; reason?: string;
}
export function estimateTorso(observation: PersonObservation | null, w: number, h: number, margin = .025): TorsoRegion {
  const personMask = new Uint8Array(w * h), roi = new Uint8Array(w * h);
  const empty: TorsoRegion = { width: w, height: h, personMask, roi, polygon: [], bounds: { x: 0, y: 0, width: 0, height: 0, area: 0 }, source: 'none', coverage: 0, excludedHandFraction: 0 };
  if (!observation || observation.mask.data.length !== observation.mask.width * observation.mask.height || !observation.mask.width || !observation.mask.height) return { ...empty, reason: '服を認識できませんでした。照明と立ち位置を確認して再撮影してください。' };
  const m = observation.mask;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) personMask[y * w + x] = Number(m.data[Math.min(m.height - 1, Math.floor(y * m.height / h)) * m.width + Math.min(m.width - 1, Math.floor(x * m.width / w))] >= PERSON.maskThreshold);
  return estimateClothes(observation, w, h, personMask, empty, margin);
}

// Choose a garment component near the shooting guide, irrespective of its color.
// Skin/background are independently segmented; clothing encloses attachment holes.
function estimateClothes(observation: PersonObservation, w: number, h: number, personMask: Uint8Array, empty: TorsoRegion, margin: number): TorsoRegion {
  const clothes = observation.clothes, skin = observation.skin;
  const valid = (m: ConfidenceMask) => m.width > 0 && m.height > 0 && m.data.length === m.width * m.height;
  if (!valid(clothes) || skin && !valid(skin)) return { ...empty, reason: '服のマスクを取得できませんでした。再撮影してください。' };
  const sample = (m: ConfidenceMask, x: number, y: number) => m.data[Math.min(m.height - 1, Math.floor(y * m.height / h)) * m.width + Math.min(m.width - 1, Math.floor(x * m.width / w))];
  const garment = new Uint8Array(w * h), excludedSkin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    excludedSkin[p] = Number(!!skin && sample(skin, x, y) >= PERSON.skinThreshold);
    garment[p] = Number(personMask[p] && !excludedSkin[p] && sample(clothes, x, y) >= PERSON.clothesThreshold);
  }
  const visited = new Uint8Array(w * h), queue = new Int32Array(w * h);
  const components: { pixels: number[]; guidePixels: number }[] = [];
  for (let seed = 0; seed < garment.length; seed++) {
    if (!garment[seed] || visited[seed]) continue;
    let head = 0, tail = 1, guidePixels = 0; queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w);
      if (x >= w * GUIDE.x && x < w * (GUIDE.x + GUIDE.width) && y >= h * GUIDE.y && y < h * (GUIDE.y + GUIDE.height)) guidePixels++;
      for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (n < 0 || visited[n] || !garment[n]) continue; visited[n] = 1; queue[tail++] = n;
      }
    }
    if (tail >= w * h * PERSON.minTorsoImageArea) components.push({ pixels: Array.from(queue.subarray(0, tail)), guidePixels });
  }
  components.sort((a, b) => b.guidePixels - a.guidePixels);
  const selected = components[0];
  if (!selected || selected.guidePixels < w * h * .01) return { ...empty, reason: '服の範囲を認識できませんでした。上半身を枠に収め、明るい場所で再撮影してください。' };
  if (components[1] && components[1].guidePixels > selected.guidePixels * .5) return { ...empty, reason: '服の範囲が複数に分かれています。1人で、上半身を大きく写して再撮影してください。' };
  const roi = new Uint8Array(w * h); selected.pixels.forEach(p => roi[p] = 1);
  // Fill small enclosed holes independent of foreground classification, excluding skin.
  // This retains a sticker classified as "others" without absorbing background.
  visited.fill(0);
  for (let seed = 0; seed < roi.length; seed++) {
    if (roi[seed] || visited[seed]) continue;
    let head = 0, tail = 1, enclosed = true; queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w);
      if (excludedSkin[p] || x === 0 || y === 0 || x === w - 1 || y === h - 1) enclosed = false;
      for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (n < 0 || visited[n] || roi[n]) continue; visited[n] = 1; queue[tail++] = n;
      }
    }
    if (enclosed && tail <= w * h * .015) for (let i = 0; i < tail; i++) roi[queue[i]] = 1;
  }
  let minX = w, minY = h, maxX = 0, maxY = 0, area = 0, skinCount = 0;
  for (let p = 0; p < roi.length; p++) if (roi[p]) { const x = p % w, y = Math.floor(p / w); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); area++; }
  // Exclude a narrow uncertain model boundary. Never enlarge into background.
  const edgeMargin = Math.max(0, Math.round((maxX - minX + 1) * margin));
  if (edgeMargin) {
    const distance = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (roi[p]) distance[p] = Math.min(x ? distance[p - 1] + 1 : 1, y ? distance[p - w] + 1 : 1);
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      if (roi[p]) distance[p] = Math.min(distance[p], x < w - 1 ? distance[p + 1] + 1 : 1, y < h - 1 ? distance[p + w] + 1 : 1);
    }
    area = 0; for (let p = 0; p < roi.length; p++) { roi[p] = Number(roi[p] && distance[p] > edgeMargin); area += roi[p]; }
  }
  const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area };
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) skinCount += excludedSkin[y * w + x];
  const polygon = [{ x: minX, y: minY }, { x: maxX + 1, y: minY }, { x: maxX + 1, y: maxY + 1 }, { x: minX, y: maxY + 1 }];
  const coverage = area / (bounds.width * bounds.height), excludedHandFraction = skinCount / (bounds.width * bounds.height);
  const result: TorsoRegion = { ...empty, roi, polygon, bounds, source: 'clothes', coverage, excludedHandFraction };
  if (coverage < .3 || bounds.height < h * .18 || bounds.width < w * .06) result.reason = '服の範囲が小さすぎます。上半身を大きく写して再撮影してください。';
  else if (excludedHandFraction > .15) result.reason = '肌や手が服に重なり、一部を確認できませんでした。腕を下ろして再撮影してください。';
  return result;
}
