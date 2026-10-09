import { LIVE, LIVE_GUIDE, type LiveSettings } from '../config';
import type { Box, Pixels } from './detector';
export interface LiveCandidate { box: Box; accepted: boolean; reason: string; contrast: number; darkSurround: number }
export interface LiveAnalysis {
  width: number; height: number; boxes: Box[]; darkCoverage: number;
  status: 'ready' | 'needs-position'; reason?: string; candidates: LiveCandidate[];
}
export type LiveRegion = typeof LIVE_GUIDE;

// No garment/person inference: this mode explicitly assumes black clothing is
// inside the guide. A white component must be enclosed by locally dark fabric.
// Buffers are reused between video frames, so allocation does not grow with time.
export class LiveDetector {
  private luminance = new Float32Array(0);
  private white = new Uint8Array(0);
  private visited = new Uint8Array(0);
  private queue = new Int32Array(0);
  analyze(image: Pixels, settings: LiveSettings = LIVE, guide: LiveRegion = LIVE_GUIDE, debug = false): LiveAnalysis {
    const { width: w, height: h, data } = image, size = w * h;
    const result: LiveAnalysis = { width: w, height: h, boxes: [], darkCoverage: 0, status: 'needs-position', candidates: [] };
    if (!w || !h || data.length !== size * 4 || guide.width <= 0 || guide.height <= 0) return { ...result, reason: '映像を取得できませんでした。カメラを再起動してください。' };
    if (this.luminance.length !== size) {
      this.luminance = new Float32Array(size); this.white = new Uint8Array(size);
      this.visited = new Uint8Array(size); this.queue = new Int32Array(size);
    }
    const { luminance: lum, white, visited, queue } = this;
    white.fill(0); visited.fill(0);
    const left = Math.max(0, Math.floor(guide.x * w)), top = Math.max(0, Math.floor(guide.y * h));
    const right = Math.min(w, Math.ceil((guide.x + guide.width) * w)), bottom = Math.min(h, Math.ceil((guide.y + guide.height) * h));
    if (right <= left || bottom <= top) return { ...result, reason: '解析枠を画像内に収めてください。' };
    let dark = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const p = y * w + x, i = p * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      const value = r * .2126 + g * .7152 + b * .0722; lum[p] = value;
      if (value <= settings.darkThreshold) dark++;
      white[p] = Number(value >= settings.whiteThreshold && (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, value) <= settings.maxSaturation);
    }
    result.darkCoverage = dark / ((right - left) * (bottom - top));
    result.status = result.darkCoverage >= settings.minDarkCoverage ? 'ready' : 'needs-position';
    if (result.status === 'needs-position') result.reason = '黒い服を枠の中に大きく写してください。';
    const scale = w / settings.analysisWidth, areaScale = scale * scale;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const seed = y * w + x; if (!white[seed] || visited[seed]) continue;
      let head = 0, tail = 1, minX = x, maxX = x, minY = y, maxY = y, sum = 0;
      queue[0] = seed; visited[seed] = 1;
      while (head < tail) {
        const p = queue[head++], px = p % w, py = Math.floor(p / w); sum += lum[p];
        minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy, n = ny * w + nx;
          if ((!dx && !dy) || nx < left || nx >= right || ny < top || ny >= bottom || visited[n] || !white[n]) continue;
          visited[n] = 1; queue[tail++] = n;
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const box: Box = { x: minX, y: minY, width: bw, height: bh, area: tail };
      const candidate: LiveCandidate = { box, accepted: false, reason: '', contrast: 0, darkSurround: 0 };
      const reject = (reason: string) => { candidate.reason = reason; if (debug) result.candidates.push(candidate); };
      if (minX === left || maxX === right - 1 || minY === top || maxY === bottom - 1) { reject('ガイド外につながる領域（背景・境界）'); continue; }
      if (tail < settings.minArea * areaScale) { reject('最小面積未満'); continue; }
      if (tail > settings.maxArea * areaScale) { reject('最大面積超過'); continue; }
      if (tail / (bw * bh) < settings.minFillRatio || Math.max(bw / bh, bh / bw) > settings.maxAspectRatio) { reject('形状・充填率が対象外'); continue; }
      const ring = Math.max(2, Math.min(Math.round(settings.ringRadius * scale), Math.round(Math.min(bw, bh) * .65)));
      // A candidate near the guide boundary cannot have a complete fabric ring.
      if (minX - ring < left || maxX + ring >= right || minY - ring < top || maxY + ring >= bottom) { reject('周囲の生地を十分に確認できない'); continue; }
      let count = 0, darkCount = 0, ringSum = 0;
      for (let ry = minY - ring; ry <= maxY + ring; ry++) for (let rx = minX - ring; rx <= maxX + ring; rx++) {
        if (rx >= minX && rx <= maxX && ry >= minY && ry <= maxY) continue;
        const value = lum[ry * w + rx]; count++; ringSum += value;
        if (value <= settings.darkThreshold) darkCount++;
      }
      candidate.darkSurround = darkCount / Math.max(1, count);
      candidate.contrast = sum / tail - ringSum / Math.max(1, count);
      if (candidate.darkSurround < settings.minSurroundingDark) { reject('周囲が黒い生地ではない'); continue; }
      if (candidate.contrast < settings.contrastThreshold) { reject('周囲との明暗差が不足'); continue; }
      candidate.accepted = true; candidate.reason = '黒い周辺領域との明暗差を確認';
      result.boxes.push(box); if (debug) result.candidates.push(candidate);
    }
    return result;
  }
  dispose() { this.luminance = new Float32Array(0); this.white = new Uint8Array(0); this.visited = new Uint8Array(0); this.queue = new Int32Array(0); }
}
