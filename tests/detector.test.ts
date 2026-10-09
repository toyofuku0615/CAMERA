import { describe, expect, it } from 'vitest';
import { analyze, scaleAnalysis, type Pixels } from '../src/vision/detector';
import { estimateTorso, type PersonObservation } from '../src/vision/person';
import { DETECTION } from '../src/config';
import { alignBox, stableBoxes } from '../src/vision/frames';
import { wait } from '../src/services/capture';
import { captureFrame } from '../src/services/camera';
function scene(stickers: { x: number; y: number; width?: number; height?: number; value?: number }[] = [], scale = 1, background = 'white') {
  const width = Math.round(480 * scale), height = Math.round(640 * scale), data = new Uint8ClampedArray(width * height * 4), mask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x / scale, py = y / scale, person = px >= 150 && px < 330 && py >= 165 && py < 510;
    let value = background === 'black' ? 24 : background === 'pattern' ? (Math.floor(px / 15) + Math.floor(py / 20)) % 2 ? 230 : 20 : background === 'window' ? Math.min(255, px * .5 + 50) : 225;
    if (person) value = 24 + ((x + y) % 5);
    if (stickers.some(b => px >= b.x && px < b.x + (b.width ?? 14) && py >= b.y && py < b.y + (b.height ?? 16))) value = stickers.find(b => px >= b.x && px < b.x + (b.width ?? 14) && py >= b.y && py < b.y + (b.height ?? 16))?.value ?? 245;
    const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255; mask[y * width + x] = person ? .99 : .01;
  }
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  landmarks[11] = { x: 155 / 480, y: 180 / 640, visibility: .99 }; landmarks[12] = { x: 325 / 480, y: 180 / 640, visibility: .99 };
  landmarks[23] = { x: 155 / 480, y: 500 / 640, visibility: .99 }; landmarks[24] = { x: 325 / 480, y: 500 / 640, visibility: .99 };
  const image: Pixels = { width, height, data }, observation: PersonObservation = { landmarks, personCount: 1, mask: { width, height, data: mask } };
  return { image, observation, torso: estimateTorso(observation, width, height) };
}
const detect = (s: ReturnType<typeof scene>, settings = DETECTION) => analyze(s.image, settings, s.torso);
describe('person-restricted pixel detection (synthetic annotations, not physical accuracy)', () => {
  it.each(['white', 'black', 'pattern', 'window'])('finds the sticker with %s background independently of darkness', background => {
    const a = detect(scene([{ x: 210, y: 300 }], 1, background)); expect(a.status).toBe('ok'); expect(a.roiSource).toBe('pose'); expect(a.boxes).toMatchObject([{ x: 210, y: 300, width: 14, height: 16, area: 224 }]);
  });
  it.each(['white', 'black', 'pattern', 'window'])('keeps %s background out of clean-cloth results', background => { const a = detect(scene([], 1, background)); expect(a.status).toBe('ok'); expect(a.boxes).toHaveLength(0); });
  it('ignores bright background spots even on a black wall', () => { expect(detect(scene([{ x: 80, y: 300 }, { x: 350, y: 300 }], 1, 'black')).boxes).toHaveLength(0); });
  it('tracks changed location and removal', () => { expect(detect(scene([{ x: 180, y: 250 }])).boxes[0].x).toBe(180); expect(detect(scene([{ x: 270, y: 400 }])).boxes[0].x).toBe(270); expect(detect(scene()).boxes).toHaveLength(0); });
  it('separates two stickers', () => { expect(detect(scene([{ x: 180, y: 250 }, { x: 270, y: 400 }])).boxes).toHaveLength(2); });
  it.each([.5, 1, 2])('preserves coordinates at scale %s', scale => { const a = detect(scene([{ x: 210, y: 300 }], scale)); expect(a.boxes[0].x).toBe(210 * scale); expect(a.boxes[0].width).toBe(14 * scale); expect(scaleAnalysis(a, 1 / scale, 1 / scale).boxes[0].area).toBe(224); });
  it('preserves an enclosed white sticker hole in the segmentation mask', () => { const s = scene([{ x: 210, y: 300 }]); for (let y = 300; y < 316; y++) for (let x = 210; x < 224; x++) s.observation.mask.data[y * 480 + x] = 0; s.torso = estimateTorso(s.observation, 480, 640); expect(detect(s).boxes).toHaveLength(1); });
  it('does not fill a mask hole connected to the background', () => { const s = scene([{ x: 150, y: 300, width: 20 }]); for (let y = 300; y < 316; y++) for (let x = 150; x < 170; x++) s.observation.mask.data[y * 480 + x] = 0; s.torso = estimateTorso(s.observation, 480, 640); expect(detect(s).boxes).toHaveLength(0); });
  it('detects underexposed white using local contrast instead of only an absolute threshold', () => { expect(detect(scene([{ x: 210, y: 300, value: 135 }])).boxes).toHaveLength(1); });
  it('excludes visible hands overlapping a bright spot', () => { const s = scene([{ x: 210, y: 300 }]); s.observation.landmarks[15] = { x: 217 / 480, y: 308 / 640, visibility: .99 }; s.torso = estimateTorso(s.observation, 480, 640); expect(detect(s).boxes).toHaveLength(0); });
  it('rejects tiny noise and records the reason', () => { const a = detect(scene([{ x: 210, y: 300, width: 2, height: 2 }])); expect(a.boxes).toHaveLength(0); expect(a.candidates[0].reason).toBe('最小面積未満'); });
  it('rejects oversized patches and insufficient contrast with reasons', () => { expect(detect(scene([{ x: 190, y: 280, width: 100, height: 80 }])).candidates[0].reason).toBe('最大面積超過'); expect(detect(scene([{ x: 210, y: 300 }]), { ...DETECTION, contrastThreshold: 250 }).boxes).toHaveLength(0); });
  it('stays uncertain without a person mask even for a perfectly dark frame', () => { const s = scene(); const a = analyze(s.image); expect(a.status).toBe('uncertain'); expect(a.boxes).toHaveLength(0); });
  it('rejects multiple people rather than assigning a sticker to the wrong person', () => { const s = scene([{ x: 210, y: 300 }]); s.observation.personCount = 2; expect(estimateTorso(s.observation, 480, 640).source).toBe('none'); });
  it('keeps guide fallback candidates but never certifies the whole torso as clear', () => { const s = scene([{ x: 210, y: 300 }]); s.observation.landmarks[11].visibility = .01; s.torso = estimateTorso(s.observation, 480, 640); const a = detect(s); expect(a.status).toBe('uncertain'); expect(a.roiSource).toBe('mask-guide'); expect(a.boxes).toHaveLength(1); });
  it('reports insufficient sharpness', () => { expect(detect(scene(), { ...DETECTION, minSharpness: 999999 }).status).toBe('uncertain'); });
});
describe('temporal fusion', () => {
  it('retains a single-frame candidate as low confidence', () => { const clean = detect(scene()), marked = detect(scene([{ x: 210, y: 300 }])); const fused = stableBoxes(marked, [marked, clean]); expect(fused.boxes).toHaveLength(1); expect(fused.boxes[0].confidence).toBe('single-frame'); expect(fused.unstable).toBe(true); });
  it('confirms consistent candidates', () => { const a = detect(scene([{ x: 210, y: 300 }])), b = detect(scene([{ x: 211, y: 300 }])); expect(stableBoxes(a, [a, b]).boxes[0].confidence).toBe('confirmed'); });
  it('allows small displacement even without overlap', () => { const a = detect(scene([{ x: 210, y: 300, width: 5, height: 5 }])), b = detect(scene([{ x: 216, y: 300, width: 5, height: 5 }])); expect(stableBoxes(a, [a, b]).boxes[0].support).toBe(2); });
  it('registers the moving torso before comparing candidate positions', () => { const a = detect(scene([{ x: 210, y: 300 }])), b = { ...a, torso: a.torso.map(p => ({ x: p.x + 30, y: p.y + 20 })), boxes: a.boxes.map(box => ({ ...box, x: box.x + 30, y: box.y + 20 })) }; expect(alignBox(b.boxes[0], b, a)?.x).toBeCloseTo(210); expect(stableBoxes(a, [a, b]).boxes[0].support).toBe(2); });
  it('does not confirm distant or disproportionate components', () => { const a = detect(scene([{ x: 180, y: 250 }])), b = detect(scene([{ x: 270, y: 400 }])); expect(stableBoxes(a, [a, b]).boxes[0].confidence).toBe('single-frame'); });
  it('does not project a candidate from an invalid anatomical ROI', () => { const a = detect(scene([{ x: 210, y: 300 }])), b = { ...a, roiSource: 'mask-guide' as const }; expect(alignBox(b.boxes[0], b, a)).toBeNull(); });
});
describe('capture failures', () => {
  it('rejects a video without a decoded frame', () => { expect(() => captureFrame({ readyState: 0 } as HTMLVideoElement)).toThrow('カメラ画像を取得できませんでした'); });
  it('aborts pending countdowns', async () => { const c = new AbortController(); const p = wait(10000, c.signal); c.abort(); await expect(p).rejects.toMatchObject({ name: 'AbortError' }); });
  it('rejects already cancelled operations', async () => { const c = new AbortController(); c.abort(); await expect(wait(1, c.signal)).rejects.toMatchObject({ name: 'AbortError' }); });
});
