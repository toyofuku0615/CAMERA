import { GUIDE, PERSON } from '../config';
import type { Box } from './detector';
export interface Point { x: number; y: number }
export interface Landmark extends Point { visibility?: number; presence?: number }
export interface PersonObservation { landmarks: Landmark[]; mask: { width: number; height: number; data: Float32Array }; personCount: number }
export interface TorsoRegion {
  width: number; height: number; personMask: Uint8Array; roi: Uint8Array;
  polygon: Point[]; bounds: Box; source: 'pose' | 'mask-guide' | 'none';
  coverage: number; excludedHandFraction: number; reason?: string;
}
export function inPolygon(x: number, y: number, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function polygonBounds(polygon: Point[]): Box {
  const x = Math.min(...polygon.map(p => p.x)), y = Math.min(...polygon.map(p => p.y));
  const width = Math.max(...polygon.map(p => p.x)) - x, height = Math.max(...polygon.map(p => p.y)) - y;
  return { x, y, width, height, area: width * height };
}
function usable(p?: Landmark) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1 && (p.visibility ?? 0) >= PERSON.minLandmarkVisibility && (p.presence ?? 1) >= PERSON.minLandmarkPresence; }
export function estimateTorso(observation: PersonObservation | null, w: number, h: number, margin = .025): TorsoRegion {
  const personMask = new Uint8Array(w * h), roi = new Uint8Array(w * h);
  const empty: TorsoRegion = { width: w, height: h, personMask, roi, polygon: [], bounds: { x: 0, y: 0, width: 0, height: 0, area: 0 }, source: 'none', coverage: 0, excludedHandFraction: 0 };
  if (!observation || observation.personCount !== 1 || observation.mask.data.length !== observation.mask.width * observation.mask.height) return { ...empty, reason: observation && observation.personCount > 1 ? '複数の人物が写っています。1人で撮影してください。' : '人物を認識できませんでした。照明と立ち位置を確認して再撮影してください。' };
  const m = observation.mask;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) personMask[y * w + x] = Number(m.data[Math.min(m.height - 1, Math.floor(y * m.height / h)) * m.width + Math.min(m.width - 1, Math.floor(x * m.width / w))] >= PERSON.maskThreshold);
  const points = observation.landmarks;
  const key = [11, 12, 24, 23];
  let source: TorsoRegion['source'] = 'pose', polygon: Point[];
  if (key.every(i => usable(points[i]))) {
    polygon = key.map(i => ({ x: points[i].x * w, y: points[i].y * h }));
    const b = polygonBounds(polygon);
    const shoulderWidth = Math.hypot(polygon[0].x - polygon[1].x, polygon[0].y - polygon[1].y);
    // A collapsed side-on pose cannot define a reliable torso. Use only the person mask fallback.
    if (b.height < h * .12 || shoulderWidth < w * .04 || Math.abs(polygon[2].y + polygon[3].y - polygon[0].y - polygon[1].y) < h * .2) source = 'mask-guide';
    else {
      const cx = polygon.reduce((n, p) => n + p.x, 0) / 4;
      polygon = polygon.map((p, i) => ({ x: Math.max(0, Math.min(w - 1, p.x + Math.sign(p.x - cx) * shoulderWidth * margin)), y: Math.max(0, Math.min(h - 1, p.y + (i < 2 ? -1 : 1) * b.height * margin)) }));
    }
  } else { source = 'mask-guide'; polygon = []; }
  if (source === 'mask-guide') polygon = [
    { x: w * GUIDE.x, y: h * GUIDE.y }, { x: w * (GUIDE.x + GUIDE.width), y: h * GUIDE.y },
    { x: w * (GUIDE.x + GUIDE.width), y: h * (GUIDE.y + GUIDE.height) }, { x: w * GUIDE.x, y: h * (GUIDE.y + GUIDE.height) },
  ];
  const bounds = polygonBounds(polygon!);
  // Fill small enclosed segmentation holes irrespective of brightness: a white sticker
  // must stay inside the garment ROI. Holes connected to background are never filled.
  const visited = new Uint8Array(w * h), queue = new Int32Array(w * h);
  for (let seed = 0; seed < personMask.length; seed++) {
    if (personMask[seed] || visited[seed]) continue;
    let head = 0, tail = 1, boundary = false, withinTorso = true; queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) boundary = true;
      if (!inPolygon(x + .5, y + .5, polygon!)) withinTorso = false;
      for (const n of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (n < 0 || visited[n] || personMask[n]) continue; visited[n] = 1; queue[tail++] = n;
      }
    }
    if (!boundary && withinTorso && tail <= w * h * .015) for (let i = 0; i < tail; i++) personMask[queue[i]] = 1;
  }
  const radius = Math.max(3, bounds.width * PERSON.handRadiusRatio);
  const hands = [15, 16, 17, 18, 19, 20, 21, 22].filter(i => usable(points[i]) && (points[i].visibility ?? 0) > .5).map(i => ({ x: points[i].x * w, y: points[i].y * h }));
  let polygonArea = 0, maskArea = 0, excluded = 0;
  for (let y = Math.max(0, Math.floor(bounds.y)); y <= Math.min(h - 1, Math.ceil(bounds.y + bounds.height)); y++) for (let x = Math.max(0, Math.floor(bounds.x)); x <= Math.min(w - 1, Math.ceil(bounds.x + bounds.width)); x++) {
    if (!inPolygon(x + .5, y + .5, polygon!)) continue;
    polygonArea++; const p = y * w + x;
    if (!personMask[p]) continue;
    maskArea++;
    if (hands.some(hand => (x - hand.x) ** 2 + (y - hand.y) ** 2 <= radius ** 2)) { excluded++; continue; }
    roi[p] = 1;
  }
  const coverage = maskArea / Math.max(1, polygonArea), excludedHandFraction = excluded / Math.max(1, maskArea);
  const result: TorsoRegion = { ...empty, polygon: polygon!, bounds, source, coverage, excludedHandFraction };
  if (coverage < (source === 'pose' ? PERSON.minTorsoMaskCoverage : .15) || maskArea < w * h * PERSON.minTorsoImageArea) result.reason = '服の範囲を十分に確認できませんでした。照明・逆光・人物の遮蔽を確認してください。';
  else if (source === 'mask-guide') result.reason = '肩と腰の位置を十分に確認できませんでした。人物マスクとガイド内の候補のみ表示しています。再撮影してください。';
  else if (excludedHandFraction > .08) result.reason = '手が服に重なり、一部を確認できませんでした。腕を自然に下ろして再撮影してください。';
  return result;
}
