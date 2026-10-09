import { DETECTION, type DetectionSettings } from '../config';
import { estimateTorso, type Point, type TorsoRegion } from './person';
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export interface Box { x: number; y: number; width: number; height: number; area: number; confidence?: 'confirmed' | 'single-frame'; support?: number }
export interface Candidate { box: Box; accepted: boolean; reason: string; contrast: number; surroundingFabric: number; colorDifference: number }
export interface Analysis {
  status: 'ok' | 'uncertain'; boxes: Box[]; region: Box; reason?: string;
  fabricBrightness: number; plainCoverage: number; sharpness: number; torso: Point[]; roiSource: TorsoRegion['source']; maskCoverage: number;
  candidates: Candidate[]; warnings: string[];
}
export function emptyAnalysis(reason: string): Analysis { return { status: 'uncertain', boxes: [], region: { x: 0, y: 0, width: 0, height: 0, area: 0 }, sharpness: 0, fabricBrightness: 0, plainCoverage: 0, torso: [], roiSource: 'none', maskCoverage: 0, candidates: [], warnings: [], reason }; }
export function sharpness(image: Pixels, roi?: Uint8Array) {
  const { width: w, height: h, data } = image; let sum = 0, count = 0;
  const lum = (p: number) => data[p * 4] * .2126 + data[p * 4 + 1] * .7152 + data[p * 4 + 2] * .0722;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x; if (roi && !roi[p]) continue;
    const lap = lum(p - 1) + lum(p + 1) + lum(p - w) + lum(p + w) - 4 * lum(p); sum += lap * lap; count++;
  }
  return sum / Math.max(1, count);
}
// Robust illumination plane: smooth lighting variation is treated as fabric,
// rather than an attachment. Small anomalies have bounded influence on the fit.
function illumination(lum: Float32Array, roi: Uint8Array, w: number, h: number, initial: number) {
  let coefficients = [initial, 0, 0];
  for (let iteration = 0; iteration < 4; iteration++) {
    const m = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
    for (let p = 0; p < roi.length; p += 3) {
      if (!roi[p]) continue;
      const v = [1, (p % w) / w - .5, Math.floor(p / w) / h - .5];
      const residual = lum[p] - v.reduce((n, x, i) => n + x * coefficients[i], 0), weight = Math.min(1, 12 / Math.max(1, Math.abs(residual)));
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) m[i][j] += weight * v[i] * v[j]; m[i][3] += weight * v[i] * lum[p]; }
    }
    for (let col = 0; col < 3; col++) {
      const pivot = m[col][col]; if (Math.abs(pivot) < 1e-6) return coefficients;
      for (let j = col; j < 4; j++) m[col][j] /= pivot;
      for (let row = 0; row < 3; row++) if (row !== col) { const k = m[row][col]; for (let j = col; j < 4; j++) m[row][j] -= k * m[col][j]; }
    }
    coefficients = m.map(row => row[3]);
  }
  return coefficients;
}
function median(values: number[]) { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)] ?? 0; }
function chroma(r: number, g: number, b: number): [number, number] {
  const total = Math.max(60, r + g + b); return [(r - g) * 255 / total, (b - g) * 255 / total];
}
// The garment mask defines eligibility. Garment color never defines its outline.
export function analyze(image: Pixels, settings: DetectionSettings = DETECTION, torso: TorsoRegion = estimateTorso(null, image.width, image.height), diagnostics = false): Analysis {
  const { width: w, height: h, data } = image, { roi } = torso;
  const result: Analysis = { ...emptyAnalysis(torso.reason ?? ''), region: torso.bounds, torso: torso.polygon, roiSource: torso.source, maskCoverage: torso.coverage, sharpness: sharpness(image, roi) };
  if (torso.source === 'none' || torso.width !== w || torso.height !== h || roi.length !== w * h || torso.coverage < .3) return result;
  const luminance = new Float32Array(w * h), redChroma = new Float32Array(w * h), blueChroma = new Float32Array(w * h);
  const lValues: number[] = [], rValues: number[] = [], bValues: number[] = [];
  let eligible = 0;
  for (let p = 0; p < luminance.length; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    luminance[p] = r * .2126 + g * .7152 + b * .0722;
    [redChroma[p], blueChroma[p]] = chroma(r, g, b);
    if (roi[p]) { eligible++; if (p % 3 === 0) { lValues.push(luminance[p]); rValues.push(redChroma[p]); bValues.push(blueChroma[p]); } }
  }
  const base = median(lValues), cr = median(rValues), cb = median(bValues);
  result.fabricBrightness = base;
  // A low garment median can simply mean black fabric. Judge underexposure
  // from the whole image; keep real candidates even when quality is uncertain.
  const frameSamples = Array.from(luminance).filter((_, p) => p % 13 === 0).sort((a, b) => a - b);
  const frameBright = frameSamples[Math.floor(frameSamples.length * .95)] ?? 0;
  const exposureReason = frameBright < settings.minExposure || base > 250 ? '画像の明るさを十分に確認できませんでした。照明や逆光を調整して再撮影してください。' : undefined;
  const plane = illumination(luminance, roi, w, h, base), different = new Uint8Array(w * h);
  let anomalyPixels = 0;
  for (let p = 0; p < roi.length; p++) if (roi[p]) {
    const expected = plane[0] + plane[1] * ((p % w) / w - .5) + plane[2] * (Math.floor(p / w) / h - .5);
    different[p] = Number(Math.abs(luminance[p] - expected) >= settings.contrastThreshold || Math.hypot(redChroma[p] - cr, blueChroma[p] - cb) >= settings.colorDifferenceThreshold);
    anomalyPixels += different[p];
  }
  result.plainCoverage = 1 - anomalyPixels / Math.max(1, eligible);
  const visited = new Uint8Array(w * h), queue = new Int32Array(w * h), areaScale = (w / settings.analysisWidth) ** 2;
  for (let seed = 0; seed < different.length; seed++) {
    if (!different[seed] || visited[seed]) continue;
    let head = 0, tail = 1, minX = seed % w, maxX = minX, minY = Math.floor(seed / w), maxY = minY, sum = 0, sumR = 0, sumB = 0;
    visited[seed] = 1; queue[0] = seed;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w); sum += luminance[p]; sumR += redChroma[p]; sumB += blueChroma[p];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * w + nx;
        if ((!dx && !dy) || nx < 0 || nx >= w || ny < 0 || ny >= h || visited[n] || !different[n]) continue;
        const colorStep = Math.hypot(data[p * 4] - data[n * 4], data[p * 4 + 1] - data[n * 4 + 1], data[p * 4 + 2] - data[n * 4 + 2]) / Math.sqrt(3);
        if (colorStep > settings.maxComponentColorStep) continue;
        visited[n] = 1; queue[tail++] = n;
      }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const box: Box = { x: minX, y: minY, width: bw, height: bh, area: tail };
    const candidate: Candidate = { box, accepted: false, reason: '', contrast: 0, colorDifference: 0, surroundingFabric: 0 };
    result.candidates.push(candidate);
    if (tail < settings.minArea * areaScale) { candidate.reason = '最小面積未満'; continue; }
    if (tail > settings.maxArea * areaScale) { candidate.reason = '最大面積超過'; continue; }
    if (Math.max(bw / bh, bh / bw) > 8 || tail / (bw * bh) < settings.minFillRatio) { candidate.reason = '形状・充填率が対象外'; continue; }
    const ring = Math.max(2, Math.min(Math.round(settings.localWindowRadius * w / settings.analysisWidth), Math.round(Math.min(bw, bh) * .5)));
    let total = 0, inClothes = 0, fabric = 0;
    const ringLum: number[] = [], ringRed: number[] = [], ringBlue: number[] = [];
    for (let y = Math.max(0, minY - ring); y <= Math.min(h - 1, maxY + ring); y++) for (let x = Math.max(0, minX - ring); x <= Math.min(w - 1, maxX + ring); x++) {
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
      total++; const p = y * w + x; if (!roi[p]) continue;
      inClothes++; if (!different[p]) fabric++;
      ringLum.push(luminance[p]); ringRed.push(redChroma[p]); ringBlue.push(blueChroma[p]);
    }
    const localLum = median(ringLum), localRed = median(ringRed), localBlue = median(ringBlue);
    candidate.surroundingFabric = fabric / Math.max(1, inClothes);
    candidate.contrast = Math.abs(sum / tail - localLum);
    candidate.colorDifference = Math.hypot(sumR / tail - localRed, sumB / tail - localBlue);
    const variation = median(ringLum.map(l => Math.abs(l - localLum))) * 1.4826;
    if (inClothes / Math.max(1, total) < .65) { candidate.reason = '服の境界に接している'; continue; }
    if (candidate.surroundingFabric < settings.minSurroundingFabric || variation > settings.maxSurroundingVariation) { candidate.reason = '周囲が均一な生地ではない'; continue; }
    if (candidate.contrast < settings.contrastThreshold && candidate.colorDifference < settings.colorDifferenceThreshold) { candidate.reason = '周囲との明暗差・色差が不足'; continue; }
    candidate.accepted = true; candidate.reason = '周囲の無地の生地との明暗差・色差、面積、形状を確認'; result.boxes.push(box);
  }
  if (diagnostics) {
    // Keep the excluded bright regions visible for background/mask diagnosis.
    const seen = new Uint8Array(w * h);
    for (let seed = 0; seed < roi.length; seed++) {
      if (seen[seed] || roi[seed] || luminance[seed] < 170) continue;
      let head = 0, tail = 1, minX = seed % w, maxX = minX, minY = Math.floor(seed / w), maxY = minY, personPixels = 0;
      queue[0] = seed; seen[seed] = 1;
      while (head < tail) {
        const p = queue[head++], x = p % w, y = Math.floor(p / w); personPixels += torso.personMask[p];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
          if (n < 0 || seen[n] || roi[n] || luminance[n] < 170) continue; seen[n] = 1; queue[tail++] = n;
        }
      }
      if (tail >= settings.minArea * areaScale) result.candidates.push({ box: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area: tail }, accepted: false, reason: personPixels / tail > .5 ? '人物マスク内・服の範囲外（顔・肌等）' : '人物マスク外（背景）', contrast: 0, colorDifference: 0, surroundingFabric: 0 });
    }
  }
  result.status = torso.reason || exposureReason ? 'uncertain' : 'ok'; result.reason = torso.reason || exposureReason;
  if (result.plainCoverage < settings.minPlainCoverage) { result.status = 'uncertain'; result.reason = '生地の色が大きく変化しています。無地の服を均一に照らして再撮影してください。'; }
  // Low texture is natural for plain garments. Laplacian ranks frames, but alone
  // cannot prove blur and must never block a clean uniform garment.
  return result;
}

export function scaleAnalysis(result: Analysis, scaleX: number, scaleY: number): Analysis {
  const scale = (b: Box): Box => ({ ...b, x: b.x * scaleX, y: b.y * scaleY, width: b.width * scaleX, height: b.height * scaleY, area: b.area * scaleX * scaleY });
  return { ...result, boxes: result.boxes.map(scale), region: scale(result.region), torso: result.torso.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })), candidates: result.candidates.map(c => ({ ...c, box: scale(c.box) })) };
}
