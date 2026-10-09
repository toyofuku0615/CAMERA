import { DETECTION, GUIDE, type DetectionSettings } from '../config';
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export interface Box { x: number; y: number; width: number; height: number; area: number }
export interface Analysis { status: 'ok' | 'uncertain'; boxes: Box[]; region: Box; clothBounds?: Box; reason?: string; darkCoverage: number; sharpness: number }

// All coordinates refer to the same (already mirrored) image. No model or network call.
export function analyze(image: Pixels, settings: DetectionSettings = DETECTION): Analysis {
  const { width: w, height: h, data } = image;
  const luminance = new Float32Array(w * h);
  for (let i = 0; i < luminance.length; i++) luminance[i] = data[i * 4] * .2126 + data[i * 4 + 1] * .7152 + data[i * 4 + 2] * .0722;
  const margin = settings.regionMargin;
  const x0 = Math.max(1, Math.floor(w * (GUIDE.x + margin))), y0 = Math.max(1, Math.floor(h * (GUIDE.y + margin)));
  const x1 = Math.min(w - 2, Math.ceil(w * (GUIDE.x + GUIDE.width - margin))), y1 = Math.min(h - 2, Math.ceil(h * (GUIDE.y + GUIDE.height - margin)));
  const region = { x: x0, y: y0, width: x1 - x0, height: y1 - y0, area: (x1 - x0) * (y1 - y0) };
  const visited = new Uint8Array(w * h), cloth = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let largest: number[] = [];
  // Largest connected dark component in the torso guide is a conservative garment proxy.
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const seed = y * w + x;
    if (visited[seed] || luminance[seed] > settings.darkThreshold) continue;
    let head = 0, tail = 1; queue[0] = seed; visited[seed] = 1;
    const component: number[] = [];
    while (head < tail) {
      const p = queue[head++], px = p % w, py = Math.floor(p / w); component.push(p);
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        const n = ny * w + nx;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || visited[n] || luminance[n] > settings.darkThreshold) continue;
        visited[n] = 1; queue[tail++] = n;
      }
    }
    if (component.length > largest.length) largest = component;
  }
  let left = w, right = 0, top = h, bottom = 0;
  for (const p of largest) { cloth[p] = 1; const x = p % w, y = Math.floor(p / w); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  const darkCoverage = largest.length / Math.max(1, region.area);
  let energy = 0, samples = 0;
  for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) {
    const p = y * w + x;
    const lap = luminance[p - 1] + luminance[p + 1] + luminance[p - w] + luminance[p + w] - 4 * luminance[p];
    energy += lap * lap; samples++;
  }
  const sharpness = energy / Math.max(1, samples);
  const result: Analysis = { status: 'ok', boxes: [], region, darkCoverage, sharpness };
  if (largest.length) result.clothBounds = { x: left, y: top, width: right - left + 1, height: bottom - top + 1, area: largest.length };
  if (darkCoverage < settings.minDarkCoverage || bottom - top < region.height * .65 || right - left < region.width * .16) {
    return { ...result, status: 'uncertain', reason: '服の範囲を十分に確認できませんでした。黒いセーターをガイド内に収めてください。' };
  }
  // If garment fills the whole guide, its boundaries cannot be verified: don't certify an empty frame.
  if (left <= x0 + 1 && right >= x1 - 1) return { ...result, status: 'uncertain', reason: '上半身が収まる位置に移動してください。服の両側に背景が見えるようにしてください。' };
  if (sharpness < settings.minSharpness) return { ...result, status: 'uncertain', reason: '画像が不鮮明です。明るい場所で静止し、もう一度撮影してください。' };
  visited.fill(0);
  const areaScale = (w / settings.analysisWidth) ** 2;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const seed = y * w + x;
    if (visited[seed] || luminance[seed] < settings.brightnessThreshold) continue;
    let head = 0, tail = 1, minX = x, maxX = x, minY = y, maxY = y, sum = 0;
    queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], px = p % w, py = Math.floor(p / w);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); sum += luminance[p];
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        const n = ny * w + nx;
        if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || visited[n] || luminance[n] < settings.brightnessThreshold) continue;
        visited[n] = 1; queue[tail++] = n;
      }
    }
    if (tail < settings.minArea * areaScale || tail > settings.maxArea * areaScale || minX <= x0 || maxX >= x1 || minY <= y0 || maxY >= y1) continue;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (Math.max(bw / bh, bh / bw) > 8 || tail / (bw * bh) < .3) continue;
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
    if (darkCount / Math.max(1, ringCount) < settings.minSurroundingDark || sides.some((n, i) => n / Math.max(1, sideTotals[i]) < .55)) continue;
    if (sum / tail - darkSum / Math.max(1, darkCount) < settings.contrastThreshold) continue;
    result.boxes.push({ x: minX, y: minY, width: bw, height: bh, area: tail });
  }
  return result;
}

export function scaleAnalysis(result: Analysis, scaleX: number, scaleY: number): Analysis {
  const scale = (b: Box): Box => ({ x: b.x * scaleX, y: b.y * scaleY, width: b.width * scaleX, height: b.height * scaleY, area: b.area * scaleX * scaleY });
  return { ...result, boxes: result.boxes.map(scale), region: scale(result.region), clothBounds: result.clothBounds && scale(result.clothBounds) };
}
