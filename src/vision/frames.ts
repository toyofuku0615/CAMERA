import { DETECTION, type DetectionSettings, type Direction } from '../config';
import type { Shot } from '../services/capture';
import { analyze, scaleAnalysis, type Analysis, type Box } from './detector';
export interface CheckResult { direction: Direction; image?: string; width: number; height: number; analysis: Analysis }
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
