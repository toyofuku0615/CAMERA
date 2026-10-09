import { describe, expect, it } from 'vitest';
import { analyze, scaleAnalysis, type Pixels } from '../src/vision/detector';
import { DETECTION } from '../src/config';
import { stableBoxes } from '../src/vision/frames';
import { wait } from '../src/services/capture';
import { captureFrame } from '../src/services/camera';
function scene(stickers: { x: number; y: number; width?: number; height?: number }[] = [], scale = 1): Pixels {
  const width = Math.round(480 * scale), height = Math.round(640 * scale), data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x / scale, py = y / scale;
    let value = px >= 150 && px < 330 && py >= 165 && py < 510 ? 24 + ((x + y) % 5) : 225;
    if (stickers.some(b => px >= b.x && px < b.x + (b.width ?? 14) && py >= b.y && py < b.y + (b.height ?? 16))) value = 245;
    const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  return { width, height, data };
}
describe('real pixel detection (synthetic scenes, not physical accuracy)', () => {
  it('detects a white sticker surrounded by black cloth', () => { const a = analyze(scene([{ x: 210, y: 300 }])); expect(a.status).toBe('ok'); expect(a.boxes).toEqual([{ x: 210, y: 300, width: 14, height: 16, area: 224 }]); });
  it('has no detections on clean cloth against a white wall', () => { const a = analyze(scene()); expect(a.status).toBe('ok'); expect(a.boxes).toHaveLength(0); });
  it('tracks changed location and removal', () => { const a = analyze(scene([{ x: 180, y: 250 }])), b = analyze(scene([{ x: 270, y: 400 }])); expect(a.boxes[0].x).toBe(180); expect(b.boxes[0].x).toBe(270); expect(analyze(scene()).boxes).toHaveLength(0); });
  it('separates two stickers', () => { expect(analyze(scene([{ x: 180, y: 250 }, { x: 270, y: 400 }])).boxes).toHaveLength(2); });
  it.each([.5, 1, 2])('preserves coordinates at scale %s', scale => { const a = analyze(scene([{ x: 210, y: 300 }], scale)); expect(a.boxes[0].x).toBe(210 * scale); expect(a.boxes[0].width).toBe(14 * scale); const mapped = scaleAnalysis(a, 1 / scale, 1 / scale); expect(mapped.boxes[0].x).toBe(210); expect(mapped.boxes[0].area).toBe(224); });
  it('rejects a white wall and all-bright images as uncertain', () => { const p = scene(); p.data.fill(255); const a = analyze(p); expect(a.status).toBe('uncertain'); expect(a.boxes).toHaveLength(0); });
  it('does not certify a uniform, unframed black image', () => { const p = scene(); for (let i = 0; i < p.data.length; i += 4) p.data[i] = p.data[i + 1] = p.data[i + 2] = 20; expect(analyze(p).status).toBe('uncertain'); });
  it('excludes a sticker touching the background', () => { expect(analyze(scene([{ x: 145, y: 300, width: 20 }])).boxes).toHaveLength(0); });
  it('rejects tiny bright noise and oversized bright patches', () => { expect(analyze(scene([{ x: 210, y: 300, width: 2, height: 2 }])).boxes).toHaveLength(0); expect(analyze(scene([{ x: 190, y: 280, width: 100, height: 80 }])).boxes).toHaveLength(0); });
  it('requires sufficient contrast', () => { expect(analyze(scene([{ x: 210, y: 300 }]), { ...DETECTION, contrastThreshold: 250 }).boxes).toHaveLength(0); });
  it('reports insufficient sharpness', () => { expect(analyze(scene(), { ...DETECTION, minSharpness: 999999 }).status).toBe('uncertain'); });
  it('requires temporal confirmation and flags inconsistent candidates', () => { const clean = analyze(scene()), marked = analyze(scene([{ x: 210, y: 300 }])); expect(stableBoxes(marked, [marked, marked, marked, clean]).boxes).toHaveLength(1); expect(stableBoxes(marked, [marked, clean, clean, clean])).toEqual({ boxes: [], unstable: true }); expect(stableBoxes(clean, [clean, marked, marked]).unstable).toBe(true); });
});
describe('capture failures', () => {
  it('rejects a video without a decoded frame', () => { expect(() => captureFrame({ readyState: 0 } as HTMLVideoElement)).toThrow('カメラ画像を取得できませんでした'); });
  it('aborts pending countdowns', async () => { const c = new AbortController(); const p = wait(10000, c.signal); c.abort(); await expect(p).rejects.toMatchObject({ name: 'AbortError' }); });
  it('rejects already cancelled operations', async () => { const c = new AbortController(); c.abort(); await expect(wait(1, c.signal)).rejects.toMatchObject({ name: 'AbortError' }); });
});
