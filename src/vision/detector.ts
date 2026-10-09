import { DETECTION, type DetectionSettings } from '../config';
import { estimateTorso, type Point, type TorsoRegion } from './person';
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export interface Box { x: number; y: number; width: number; height: number; area: number; confidence?: 'confirmed' | 'single-frame'; support?: number }
export interface Candidate { box: Box; accepted: boolean; reason: string; contrast: number; surroundingDark: number }
export interface Analysis {
  status: 'ok' | 'uncertain'; boxes: Box[]; region: Box; reason?: string;
  darkCoverage: number; sharpness: number; torso: Point[]; roiSource: TorsoRegion['source']; maskCoverage: number;
  candidates: Candidate[]; warnings: string[];
}
export function emptyAnalysis(reason: string): Analysis { return { status: 'uncertain', boxes: [], region: { x: 0, y: 0, width: 0, height: 0, area: 0 }, sharpness: 0, darkCoverage: 0, torso: [], roiSource: 'none', maskCoverage: 0, candidates: [], warnings: [], reason }; }
export function sharpness(image: Pixels, roi?: Uint8Array) {
  const { width: w, height: h, data } = image; let sum = 0, count = 0;
  const lum = (p: number) => data[p * 4] * .2126 + data[p * 4 + 1] * .7152 + data[p * 4 + 2] * .0722;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x; if (roi && !roi[p]) continue;
    const lap = lum(p - 1) + lum(p + 1) + lum(p - w) + lum(p + w) - 4 * lum(p); sum += lap * lap; count++;
  }
  return sum / Math.max(1, count);
}
// A person mask + anatomical torso must precede detection. Darkness never defines the ROI.
export function analyze(image: Pixels, settings: DetectionSettings = DETECTION, torso: TorsoRegion = estimateTorso(null, image.width, image.height), diagnostics = false): Analysis {
  const { width: w, height: h, data } = image, { roi } = torso;
  const result: Analysis = { ...emptyAnalysis(torso.reason ?? ''), region: torso.bounds, torso: torso.polygon, roiSource: torso.source, maskCoverage: torso.coverage, sharpness: sharpness(image, roi) };
  if (torso.source === 'none' || torso.width !== w || torso.height !== h || roi.length !== w * h || torso.coverage < (torso.source === 'pose' ? .6 : .15)) return result;
  const luminance = new Float32Array(w * h), neutral = new Uint8Array(w * h);
  let dark = 0, eligible = 0;
  for (let p = 0; p < luminance.length; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    luminance[p] = r * .2126 + g * .7152 + b * .0722;
    neutral[p] = Number((Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, luminance[p]) <= settings.maxSaturation);
    if (roi[p]) { eligible++; if (luminance[p] <= settings.darkThreshold) dark++; }
  }
  result.darkCoverage = dark / Math.max(1, eligible);
  if (result.darkCoverage < settings.minDarkCoverage) return { ...result, reason: '黒い生地を十分に確認できませんでした。無地の黒い服と照明を確認してください。' };
  const stride = w + 1, integral = new Float64Array((w + 1) * (h + 1)), counts = new Uint32Array(integral.length);
  for (let y = 0; y < h; y++) {
    let rowSum = 0, rowCount = 0;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = (y + 1) * stride + x + 1;
      if (roi[p] && luminance[p] <= settings.darkThreshold) { rowSum += luminance[p]; rowCount++; }
      integral[i] = integral[i - stride] + rowSum; counts[i] = counts[i - stride] + rowCount;
    }
  }
  const radius = Math.max(2, Math.round(settings.localWindowRadius * w / settings.analysisWidth)), bright = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (!roi[p] || !neutral[p] || luminance[p] < settings.minLocalBrightness) continue;
    const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius), x1 = Math.min(w, x + radius + 1), y1 = Math.min(h, y + radius + 1);
    const a = y0 * stride + x0, b = y0 * stride + x1, c = y1 * stride + x0, d = y1 * stride + x1;
    const mean = (integral[d] - integral[b] - integral[c] + integral[a]) / Math.max(1, counts[d] - counts[b] - counts[c] + counts[a]);
    bright[p] = Number(luminance[p] >= settings.brightnessThreshold || luminance[p] - mean >= settings.contrastThreshold);
  }
  const visited = new Uint8Array(w * h), queue = new Int32Array(w * h), areaScale = (w / settings.analysisWidth) ** 2;
  for (let seed = 0; seed < bright.length; seed++) {
    if (!bright[seed] || visited[seed]) continue;
    let head = 0, tail = 1, minX = seed % w, maxX = minX, minY = Math.floor(seed / w), maxY = minY, sum = 0;
    visited[seed] = 1; queue[0] = seed;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w); sum += luminance[p];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      // Eight-connectivity keeps tilted stickers intact.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * w + nx;
        if ((!dx && !dy) || nx < 0 || nx >= w || ny < 0 || ny >= h || visited[n] || !bright[n]) continue;
        visited[n] = 1; queue[tail++] = n;
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const box: Box = { x: minX, y: minY, width: bw, height: bh, area: tail };
    const candidate: Candidate = { box, accepted: false, reason: '', contrast: 0, surroundingDark: 0 };
    result.candidates.push(candidate);
    if (tail < settings.minArea * areaScale) { candidate.reason = '最小面積未満'; continue; }
    if (tail > settings.maxArea * areaScale) { candidate.reason = '最大面積超過'; continue; }
    if (Math.max(bw / bh, bh / bw) > 8 || tail / (bw * bh) < .3) { candidate.reason = '形状・充填率が対象外'; continue; }
    const ring = Math.max(2, Math.round(Math.min(bw, bh) * .5));
    let total = 0, inTorso = 0, darkCount = 0, darkSum = 0;
    for (let y = Math.max(0, minY - ring); y <= Math.min(h - 1, maxY + ring); y++) for (let x = Math.max(0, minX - ring); x <= Math.min(w - 1, maxX + ring); x++) {
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
      total++; const p = y * w + x; if (!roi[p]) continue;
      inTorso++; if (luminance[p] <= settings.darkThreshold) { darkCount++; darkSum += luminance[p]; }
    }
    candidate.surroundingDark = darkCount / Math.max(1, inTorso);
    candidate.contrast = sum / tail - darkSum / Math.max(1, darkCount);
    if (inTorso / Math.max(1, total) < .65) { candidate.reason = '人物・胴体の境界に接している'; continue; }
    if (candidate.surroundingDark < settings.minSurroundingDark) { candidate.reason = '周囲の黒い生地が不足'; continue; }
    if (candidate.contrast < settings.contrastThreshold) { candidate.reason = '局所的な明暗差が不足'; continue; }
    candidate.accepted = true; candidate.reason = '局所的な明暗差・面積・形状を確認'; result.boxes.push(box);
  }
  if (diagnostics) {
    const seen = new Uint8Array(w * h);
    for (let seed = 0; seed < luminance.length; seed++) {
      if (seen[seed] || roi[seed] || !neutral[seed] || luminance[seed] < settings.brightnessThreshold) continue;
      let head = 0, tail = 1, minX = seed % w, maxX = minX, minY = Math.floor(seed / w), maxY = minY, personPixels = 0;
      queue[0] = seed; seen[seed] = 1;
      while (head < tail) {
        const p = queue[head++], x = p % w, y = Math.floor(p / w); personPixels += torso.personMask[p];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
          if (n < 0 || seen[n] || roi[n] || !neutral[n] || luminance[n] < settings.brightnessThreshold) continue;
          seen[n] = 1; queue[tail++] = n;
        }
      }
      if (tail >= settings.minArea * areaScale) result.candidates.push({ box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area: tail }, accepted: false, reason: personPixels / tail > .5 ? '人物マスク内・胴体範囲外（顔・手等）' : '人物マスク外（背景）', contrast: 0, surroundingDark: 0 });
    }
  }
  result.status = torso.reason ? 'uncertain' : 'ok'; result.reason = torso.reason;
  if (result.sharpness < settings.minSharpness) { result.status = 'uncertain'; result.reason = '画像が不鮮明です。明るい場所で静止し、もう一度撮影してください。'; }
  return result;
}
export function scaleAnalysis(result: Analysis, scaleX: number, scaleY: number): Analysis {
  const scale = (b: Box): Box => ({ ...b, x: b.x * scaleX, y: b.y * scaleY, width: b.width * scaleX, height: b.height * scaleY, area: b.area * scaleX * scaleY });
  return { ...result, boxes: result.boxes.map(scale), region: scale(result.region), torso: result.torso.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })), candidates: result.candidates.map(c => ({ ...c, box: scale(c.box) })) };
}
