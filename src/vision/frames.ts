import { DETECTION, TEMPORAL, type DetectionSettings, type Direction } from '../config';
import type { Shot } from '../services/capture';
import { analyze, emptyAnalysis, scaleAnalysis, sharpness, type Analysis, type Box } from './detector';
import { estimateTorso, type PersonObservation, type Point, type TorsoRegion } from './person';
import { inferPerson } from './model';
export interface FrameDiagnostic { index: number; image: string; width: number; height: number; analysis: Analysis; maskImage?: string; inferenceMs: number }
export interface CheckResult { direction: Direction; image?: string; width: number; height: number; analysis: Analysis; frameDiagnostics?: FrameDiagnostic[]; additionalViews?: CheckResult[] }
export function resizeForAnalysis(canvas: HTMLCanvasElement, settings: DetectionSettings = DETECTION) {
  const small = document.createElement('canvas');
  small.width = Math.min(settings.analysisWidth, canvas.width); small.height = Math.round(canvas.height * small.width / canvas.width);
  const context = small.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('画像処理を開始できませんでした。');
  context.drawImage(canvas, 0, 0, small.width, small.height); return small;
}
export function analyzeWithObservation(canvas: HTMLCanvasElement, observation: PersonObservation | null, settings: DetectionSettings = DETECTION, diagnostics = false): { analysis: Analysis; torso: TorsoRegion } {
  const small = resizeForAnalysis(canvas, settings), context = small.getContext('2d', { willReadFrequently: true })!;
  const torso = estimateTorso(observation, small.width, small.height, settings.regionMargin);
  const analysis = analyze(context.getImageData(0, 0, small.width, small.height), settings, torso, diagnostics);
  return { analysis: scaleAnalysis(analysis, canvas.width / small.width, canvas.height / small.height), torso };
}
export async function analyzeCanvas(canvas: HTMLCanvasElement, settings: DetectionSettings = DETECTION): Promise<Analysis> {
  return analyzeWithObservation(canvas, await inferPerson(resizeForAnalysis(canvas, settings)), settings).analysis;
}
export function maskOverlay(torso: TorsoRegion) {
  const c = document.createElement('canvas'); c.width = torso.width; c.height = torso.height;
  const ctx = c.getContext('2d')!, image = ctx.createImageData(c.width, c.height);
  for (let p = 0; p < torso.personMask.length; p++) if (torso.personMask[p]) {
    image.data[p * 4] = torso.roi[p] ? 30 : 70; image.data[p * 4 + 1] = torso.roi[p] ? 180 : 110; image.data[p * 4 + 2] = torso.roi[p] ? 110 : 220; image.data[p * 4 + 3] = 100;
  }
  ctx.putImageData(image, 0, 0); return c.toDataURL();
}
export function overlap(a: Box, b: Box) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection);
}
function basis(a: Analysis) {
  if (a.roiSource !== 'pose' || a.torso.length !== 4) return null;
  const [l, r, br, bl] = a.torso;
  const origin = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  const u = { x: r.x - l.x, y: r.y - l.y }, v = { x: (br.x + bl.x) / 2 - origin.x, y: (br.y + bl.y) / 2 - origin.y };
  const determinant = u.x * v.y - u.y * v.x;
  return Math.abs(determinant) > 1 ? { origin, u, v, determinant } : null;
}
// Translate/scale/rotate by torso landmarks, not background. Unreliable poses are
// never registered: another frame's box then stays on that frame's own image.
export function alignBox(box: Box, from: Analysis, to: Analysis): Box | null {
  if (from === to) return { ...box };
  const a = basis(from), b = basis(to); if (!a || !b) return null;
  const transform = (p: Point): Point => {
    const x = p.x - a.origin.x, y = p.y - a.origin.y;
    const u = (x * a.v.y - y * a.v.x) / a.determinant, v = (a.u.x * y - a.u.y * x) / a.determinant;
    return { x: b.origin.x + u * b.u.x + v * b.v.x, y: b.origin.y + u * b.u.y + v * b.v.y };
  };
  const points = [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }].map(transform);
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  const width = Math.max(...points.map(p => p.x)) - x, height = Math.max(...points.map(p => p.y)) - y;
  return { ...box, x, y, width, height, area: box.area * width * height / Math.max(1, box.width * box.height) };
}
export function sameCandidate(a: Box, b: Box, region: Box) {
  const ratio = Math.max(a.area, b.area) / Math.max(1, Math.min(a.area, b.area));
  if (ratio > TEMPORAL.maxAreaRatio) return false;
  const distance = Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
  const tolerance = Math.max(4, Math.hypot(region.width, region.height) * TEMPORAL.centerToleranceRatio, Math.min(a.width, a.height, b.width, b.height) * .8);
  return overlap(a, b) >= TEMPORAL.minimumOverlap || distance <= tolerance;
}
export function stableBoxes(best: Analysis, all: Analysis[]) {
  const boxes = best.boxes.map(box => {
    const support = all.filter(a => a.boxes.some(other => { const aligned = alignBox(other, a, best); return aligned && sameCandidate(box, aligned, best.region); })).length;
    return { ...box, support, confidence: support >= 2 ? 'confirmed' as const : 'single-frame' as const };
  });
  // Never invent a box on a frame where no component was actually measured.
  const otherFrameOnly = all.some(a => a.boxes.some(box => {
    const aligned = alignBox(box, a, best); return !aligned || !boxes.some(b => sameCandidate(b, aligned, best.region));
  }));
  return { boxes, unstable: boxes.some(b => b.confidence === 'single-frame') || otherFrameOnly };
}
export interface ProcessOptions { signal?: AbortSignal; diagnostics?: boolean; infer?: typeof inferPerson; maxFrames?: number }
export async function processShot(shot: Shot, options: ProcessOptions = {}): Promise<CheckResult> {
  if (!shot.frames.length) return { direction: shot.direction, width: 720, height: 960, analysis: emptyAnalysis(shot.error || '撮影できませんでした。もう一度撮影してください。') };
  const ranked = shot.frames.map((canvas, index) => {
    const small = resizeForAnalysis(canvas); return { index, score: sharpness(small.getContext('2d')!.getImageData(0, 0, small.width, small.height)) };
  }).sort((a, b) => b.score - a.score);
  const limit = Math.min(shot.frames.length, options.maxFrames ?? TEMPORAL.maxAnalyzedFrames);
  const selectedIndices = ranked.slice(0, limit).map(r => r.index);
  const frames: { index: number; analysis: Analysis; diagnostic?: FrameDiagnostic }[] = [];
  for (const index of selectedIndices) {
    if (options.signal?.aborted) throw new DOMException('中止', 'AbortError');
    await new Promise(resolve => setTimeout(resolve, 0));
    const canvas = shot.frames[index], start = performance.now();
    const observation = await (options.infer ?? inferPerson)(resizeForAnalysis(canvas));
    const inferenceMs = performance.now() - start;
    if (options.signal?.aborted) throw new DOMException('中止', 'AbortError');
    const { analysis, torso } = analyzeWithObservation(canvas, observation);
    frames.push({ index, analysis, diagnostic: options.diagnostics ? { index, analysis, image: canvas.toDataURL('image/jpeg', .9), width: canvas.width, height: canvas.height, maskImage: maskOverlay(torso), inferenceMs } : undefined });
  }
  frames.sort((a, b) => Number(b.analysis.status === 'ok') - Number(a.analysis.status === 'ok') || b.analysis.sharpness - a.analysis.sharpness);
  // Select the sharpest recognizable frame. If only a secondary frame has a
  // candidate, display that real image rather than projecting a fabricated box.
  let selected = frames[0];
  if (!selected.analysis.boxes.length) selected = frames.find(f => f.analysis.boxes.length) ?? selected;
  const fused = stableBoxes(selected.analysis, frames.map(f => f.analysis));
  const analysis = { ...selected.analysis, boxes: fused.boxes, warnings: [...selected.analysis.warnings] };
  if (fused.unstable) analysis.warnings.push('一部の候補は1枚の画像でのみ確認できました。画像の枠内を目視でご確認ください。');
  if (frames.filter(f => f.analysis.status === 'ok').length < 2) { analysis.status = 'uncertain'; analysis.reason ||= '複数の鮮明な画像で服の範囲を確認できませんでした。再撮影してください。'; }
  if (frames.some(f => f.analysis.status !== 'ok') && analysis.status === 'ok') { analysis.status = 'uncertain'; analysis.reason = '一部の画像で服の範囲を確認できませんでした。'; }
  const canvas = shot.frames[selected.index];
  const additionalViews: CheckResult[] = [];
  const represented: { box: Box; analysis: Analysis }[] = selected.analysis.boxes.map(box => ({ box, analysis: selected.analysis }));
  for (const frame of frames) {
    if (frame === selected) continue;
    const unique = stableBoxes(frame.analysis, frames.map(f => f.analysis)).boxes.filter(box => !represented.some(existing => { const aligned = alignBox(existing.box, existing.analysis, frame.analysis); return aligned && sameCandidate(box, aligned, frame.analysis.region); }));
    if (!unique.length) continue;
    const source = shot.frames[frame.index];
    additionalViews.push({ direction: shot.direction, image: source.toDataURL('image/jpeg', .9), width: source.width, height: source.height, analysis: { ...frame.analysis, boxes: unique, warnings: ['別の撮影画像で確認した候補です。枠内をご確認ください。'] } });
    unique.forEach(box => represented.push({ box, analysis: frame.analysis }));
  }
  return { direction: shot.direction, image: canvas.toDataURL('image/jpeg', .9), width: canvas.width, height: canvas.height, analysis, additionalViews, frameDiagnostics: options.diagnostics ? frames.map(f => f.diagnostic!).sort((a, b) => a.index - b.index) : undefined };
}
