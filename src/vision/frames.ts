import { DETECTION, type DetectionSettings, type Direction } from '../config';
import type { Shot } from '../services/capture';
import { analyze, scaleAnalysis, type Analysis, type Box } from './detector';
import type { Inspector } from './subject';
export interface Finding { image: string; width: number; height: number; box: Box }
export interface CheckResult { direction: Direction; image?: string; width: number; height: number; analysis: Analysis; findings?: Finding[]; facingVerified?: boolean }
export function analyzeCanvas(canvas: HTMLCanvasElement, settings: DetectionSettings = DETECTION): Analysis {
  const small = document.createElement('canvas');
  small.width = Math.min(settings.analysisWidth, canvas.width); small.height = Math.round(canvas.height * small.width / canvas.width);
  const context = small.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('画像処理を開始できませんでした。');
  context.drawImage(canvas, 0, 0, small.width, small.height);
  const result = analyze(context.getImageData(0, 0, small.width, small.height), settings);
  return scaleAnalysis(result, canvas.width / small.width, canvas.height / small.height);
}
export function overlap(a: Box, b: Box) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection);
}
export function stableBoxes(best: Analysis, all: Analysis[]): { boxes: Box[]; unstable: boolean } {
  const valid = all.filter(a => a.status === 'ok');
  const boxes = best.boxes.filter(b => valid.filter(a => a.boxes.some(other => overlap(b, other) > .3)).length >= Math.max(2, Math.ceil(valid.length / 2)));
  const unmatched = valid.some(a => a.boxes.some(b => !boxes.some(stable => overlap(b, stable) > .3)));
  return { boxes, unstable: unmatched || boxes.length < best.boxes.length };
}
export function processShot(shot: Shot): CheckResult {
  const empty: Analysis = { status: 'uncertain', boxes: [], region: { x: 0, y: 0, width: 0, height: 0, area: 0 }, sharpness: 0, darkCoverage: 0, reason: shot.error || '撮影できませんでした。もう一度撮影してください。' };
  if (!shot.frames.length) return { direction: shot.direction, width: 720, height: 960, analysis: empty };
  const analyses = shot.frames.map(c => analyzeCanvas(c));
  const order = analyses.map((a, i) => ({ a, i })).sort((a, b) => Number(b.a.status === 'ok') - Number(a.a.status === 'ok') || b.a.sharpness - a.a.sharpness);
  const selected = order[0], canvas = shot.frames[selected.i];
  const stable = stableBoxes(selected.a, analyses);
  let analysis = { ...selected.a, boxes: stable.boxes };
  if (selected.a.status === 'ok' && (analyses.filter(a => a.status === 'ok').length < 2 || stable.unstable)) analysis = { ...analysis, status: 'uncertain', reason: '複数の画像で状態を確認できませんでした。静止して再撮影してください。' };
  return { direction: shot.direction, image: canvas.toDataURL('image/jpeg', .9), width: canvas.width, height: canvas.height, analysis };
}

/** Each stable finding retains the sharpest actual frame in its own coordinates. */
export async function inspectShot(shot: Shot, inspector: Inspector, signal: AbortSignal): Promise<CheckResult> {
  const analyses: Analysis[] = [], facing: boolean[] = [];
  for (const frame of shot.frames) {
    if (signal.aborted) throw new DOMException('中止', 'AbortError');
    const small = document.createElement('canvas');
    small.width = Math.min(DETECTION.analysisWidth, frame.width);
    small.height = Math.round(frame.height * small.width / frame.width);
    const context = small.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(frame, 0, 0, small.width, small.height);
    try {
      const subject = await inspector.inspect(small);
      const pixels = context.getImageData(0, 0, small.width, small.height);
      const a = analyze(pixels, DETECTION, subject);
      const matched = subject.complete && subject.facing === shot.direction;
      facing.push(matched);
      analyses.push(scaleAnalysis(matched ? a : { ...a, status: 'uncertain', reason: subject.reason ?? `${shot.direction === 'back' ? '背面' : '向き'}を確認できませんでした` }, frame.width / small.width, frame.height / small.height));
    } finally { small.width = small.height = 0; }
  }
  if (!analyses.length) return processShot({ ...shot, frames: [] });
  const valid = analyses.map((a, i) => ({ a, i })).filter(v => v.a.status === 'ok');
  const selected = [...analyses.map((a, i) => ({ a, i }))].sort((a, b) => Number(b.a.status === 'ok') - Number(a.a.status === 'ok') || b.a.sharpness - a.a.sharpness)[0];
  const tracks: { frame: number; box: Box }[][] = [];
  for (const { a, i } of valid) for (const box of a.boxes) {
    const track = tracks.find(t => !t.some(v => v.frame === i) && t.some(v => overlap(v.box, box) > .3));
    if (track) track.push({ frame: i, box }); else tracks.push([{ frame: i, box }]);
  }
  const minimum = Math.max(2, Math.ceil(valid.length / 2));
  const stable = tracks.filter(t => t.length >= minimum);
  const findings = stable.map(t => {
    const best = [...t].sort((a, b) => analyses[b.frame].sharpness - analyses[a.frame].sharpness)[0];
    const canvas = shot.frames[best.frame];
    return { box: best.box, image: canvas.toDataURL('image/jpeg', .92), width: canvas.width, height: canvas.height };
  });
  const facingVerified = facing.filter(Boolean).length >= minimum;
  const sufficient = valid.length >= minimum && facingVerified && tracks.every(t => t.length >= minimum);
  const canvas = shot.frames[selected.i];
  return { direction: shot.direction, width: canvas.width, height: canvas.height, findings, facingVerified,
    analysis: { ...selected.a, boxes: findings.map(f => f.box), status: sufficient ? 'ok' : 'uncertain', reason: sufficient ? undefined : selected.a.reason ?? '静止して、もう一度' } };
}

export function canSendOff(results: CheckResult[]) {
  if (results.length !== 4 || new Set(results.map(r => r.direction)).size !== 4) return false;
  return ['front', 'side1', 'back', 'side2'].every(direction => {
    const r = results.find(r => r.direction === direction);
    return r?.analysis.status === 'ok' && r.facingVerified === true && !r.analysis.boxes.length && !r.findings?.length;
  });
}
