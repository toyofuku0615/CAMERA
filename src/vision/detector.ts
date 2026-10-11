import { DETECTION, GUIDE, type DetectionSettings } from '../config';
import type { Subject } from './subject';
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export interface Box { x: number; y: number; width: number; height: number; area: number }
export interface Analysis { status: 'ok' | 'uncertain'; boxes: Box[]; region: Box; clothBounds?: Box; reason?: string; darkCoverage: number; sharpness: number }

// All coordinates refer to the same (already mirrored) image. No model or network call.
export function analyze(image: Pixels, settings: DetectionSettings = DETECTION, subject?: Subject): Analysis {
  const { width: w, height: h, data } = image;
  const luminance = new Float32Array(w * h);
  for (let i = 0; i < luminance.length; i++) luminance[i] = data[i * 4] * .2126 + data[i * 4 + 1] * .7152 + data[i * 4 + 2] * .0722;
  const margin = settings.regionMargin;
  let x0 = Math.max(1, Math.floor(w * (GUIDE.x + margin))), y0 = Math.max(1, Math.floor(h * (GUIDE.y + margin)));
  let x1 = Math.min(w - 2, Math.ceil(w * (GUIDE.x + GUIDE.width - margin))), y1 = Math.min(h - 2, Math.ceil(h * (GUIDE.y + GUIDE.height - margin)));
  const eligible = (p: number) => !subject || subject.mask[p] === 1;
  if (subject) {
    x0 = w; y0 = h; x1 = y1 = 0;
    for (let p = 0; p < w * h; p++) if (eligible(p)) {
      const x = p % w, y = Math.floor(p / w);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    x0 = Math.max(1, x0); y0 = Math.max(1, y0); x1 = Math.min(w - 2, x1); y1 = Math.min(h - 2, y1);
    if (!subject.complete || subject.width !== w || subject.height !== h || x1 <= x0 || y1 <= y0)
      return { status: 'uncertain', boxes: [], region: { x: 0, y: 0, width: w, height: h, area: w * h }, darkCoverage: 0, sharpness: 0, reason: subject.reason ?? '全身が映る位置で、もう一度' };
  }
  const region = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, area: (x1 - x0) * (y1 - y0) };
  const visited = new Uint8Array(w * h), cloth = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let largest: number[] = [];
  // Largest connected dark component in the torso guide is a conservative garment proxy.
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const seed = y * w + x;
    if (visited[seed] || !eligible(seed) || luminance[seed] > settings.darkThreshold) continue;
    let head = 0, tail = 1; queue[0] = seed; visited[seed] = 1;
    const component: number[] = [];
    while (head < tail) {
      const p = queue[head++], px = p % w, py = Math.floor(p / w); component.push(p);
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        const n = ny * w + nx;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || visited[n] || !eligible(n) || luminance[n] > settings.darkThreshold) continue;
        visited[n] = 1; queue[tail++] = n;
      }
    }
    if (component.length > largest.length) largest = component;
    // Segmentation keeps disconnected sleeves/trousers while excluding dark walls.
    if (subject && component.length >= settings.minArea * 2) for (const p of component) cloth[p] = 1;
  }
  let left = w, right = 0, top = h, bottom = 0;
  for (const p of largest) { cloth[p] = 1; const x = p % w, y = Math.floor(p / w); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  const eligibleCount = subject ? subject.mask.reduce((n, p) => n + p, 0) : region.area;
  const darkCoverage = (subject ? cloth.reduce((n, p) => n + p, 0) : largest.length) / Math.max(1, eligibleCount);
  let energy = 0, samples = 0;
  for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) {
    const p = y * w + x;
    if (subject && !cloth[p]) continue;
    const lap = luminance[p - 1] + luminance[p + 1] + luminance[p - w] + luminance[p + w] - 4 * luminance[p];
    energy += lap * lap; samples++;
  }
  const sharpness = energy / Math.max(1, samples);
  const result: Analysis = { status: 'ok', boxes: [], region, darkCoverage, sharpness };
  if (largest.length) result.clothBounds = { x: left, y: top, width: right - left + 1, height: bottom - top + 1, area: largest.length };
  if (darkCoverage < (subject ? .65 : settings.minDarkCoverage) || (!subject && (bottom - top < region.height * .65 || right - left < region.width * .16))) {
    return { ...result, status: 'uncertain', reason: subject ? '黒い服を、明るい場所で' : '服の範囲を十分に確認できませんでした。黒いセーターをガイド内に収めてください。' };
  }
  // If garment fills the whole guide, its boundaries cannot be verified: don't certify an empty frame.
  if (!subject && left <= x0 + 1 && right >= x1 - 1) return { ...result, status: 'uncertain', reason: '上半身が収まる位置に移動してください。服の両側に背景が見えるようにしてください。' };
  if (sharpness < settings.minSharpness) return { ...result, status: 'uncertain', reason: '明るい場所で静止して、もう一度' };
  visited.fill(0);
  const areaScale = (w / settings.analysisWidth) ** 2;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const seed = y * w + x;
    if (visited[seed] || !eligible(seed) || luminance[seed] < settings.brightnessThreshold) continue;
    let head = 0, tail = 1, minX = x, maxX = x, minY = y, maxY = y, sum = 0;
    queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], px = p % w, py = Math.floor(p / w);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); sum += luminance[p];
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        const n = ny * w + nx;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || visited[n] || !eligible(n) || luminance[n] < settings.brightnessThreshold) continue;
        visited[n] = 1; queue[tail++] = n;
      }
    }
    if (tail < (subject ? Math.min(settings.minArea, 8) : settings.minArea) * areaScale) continue;
    const ambiguous = () => {
      if (subject) { result.status = 'uncertain'; result.reason = '服の端や明るい箇所を確認できませんでした'; }
    };
    if (tail > settings.maxArea * areaScale || minX <= x0 || maxX >= x1 || minY <= y0 || maxY >= y1) { ambiguous(); continue; }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (Math.max(bw / bh, bh / bw) > (subject ? 18 : 8) || tail / (bw * bh) < .3) { ambiguous(); continue; }
    const ring = Math.max(2, Math.round(Math.min(bw, bh) * .35));
    let ringCount = 0, darkCount = 0, darkSum = 0;
    const sides = [0, 0, 0, 0], sideTotals = [0, 0, 0, 0];
    for (let ry = minY - ring; ry <= maxY + ring; ry++) for (let rx = minX - ring; rx <= maxX + ring; rx++) {
      if (rx >= minX && rx <= maxX && ry >= minY && ry <= maxY) continue;
      if (rx < x0 || rx > x1 || ry < y0 || ry > y1) continue;
      const p = ry * w + rx; ringCount++;
      const side = rx < minX ? 0 : rx > maxX ? 1 : ry < minY ? 2 : 3; sideTotals[side]++;
      if (cloth[p]) { darkCount++; darkSum += luminance[p]; sides[side]++; }
    }
    // Bright walls, skin, and garment-edge reflections are rejected unless enclosed by cloth.
    if (darkCount / Math.max(1, ringCount) < settings.minSurroundingDark || sides.some((n, i) => n / Math.max(1, sideTotals[i]) < .55)) { ambiguous(); continue; }
    if (sum / tail - darkSum / Math.max(1, darkCount) < settings.contrastThreshold) continue;
    result.boxes.push({ x: minX, y: minY, width: bw, height: bh, area: tail });
  }
  return result;
}

export function scaleAnalysis(result: Analysis, scaleX: number, scaleY: number): Analysis {
  const scale = (b: Box): Box => ({ x: b.x * scaleX, y: b.y * scaleY, width: b.width * scaleX, height: b.height * scaleY, area: b.area * scaleX * scaleY });
  return { ...result, boxes: result.boxes.map(scale), region: scale(result.region), clothBounds: result.clothBounds && scale(result.clothBounds) };
}
