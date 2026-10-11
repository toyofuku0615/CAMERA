import { CAPTURE, DETECTION, DIRECTIONS, type DetectionSettings, type Direction } from '../config';
import type { Recording } from '../services/capture';
import { recordedFrames } from '../services/video';
import { analyze, scaleAnalysis, type Analysis, type Box } from './detector';
import type { Inspector, Subject } from './subject';
export interface Finding { image: string; width: number; height: number; box: Box; timestamp: number; direction: Direction | 'unknown' }
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
export interface VideoReport { findings: Finding[]; checks: CheckResult[]; complete: boolean; reason?: string; framesAnalyzed: number }
export interface Observation { timestamp: number; width: number; height: number; analysis: Analysis; complete: boolean; facing: Subject['facing'] }
interface Track { relative: Box; first: number; last: number; count: number; direction: Finding['direction']; best: Finding; sharpness: number }

function relativeBox(box: Box, region: Box): Box {
  return { x: (box.x - region.x) / Math.max(1, region.width), y: (box.y - region.y) / Math.max(1, region.height),
    width: box.width / Math.max(1, region.width), height: box.height / Math.max(1, region.height), area: box.area / Math.max(1, region.width * region.height) };
}
function sameCandidate(a: Box, b: Box) {
  const ratio = a.area / Math.max(.000001, b.area);
  const distance = Math.hypot(a.x + a.width / 2 - b.x - b.width / 2, a.y + a.height / 2 - b.y - b.height / 2);
  return ratio > .3 && ratio < 3.3 && (overlap(a, b) > .15 || distance < .045);
}

/** Association uses clothing-relative coordinates; screenshots retain original
 * pixel coordinates. Two distinct timestamps suffice, not half the whole movie. */
export class VideoTracker {
  private tracks: Track[] = [];
  private coverage = new Map<Direction, { times: number[]; analysis?: Analysis; width: number; height: number }>(DIRECTIONS.map(d => [d.id, { times: [], width: 0, height: 0 }]));
  private framesAnalyzed = 0;
  private framing = false;
  private ambiguity = false;
  private overflow = false;
  observe(o: Observation, image: () => string) {
    this.framesAnalyzed++;
    this.framing ||= o.complete;
    const direction: Finding['direction'] = o.facing === 'front' || o.facing === 'back' ? o.facing : 'unknown';
    if (direction !== 'unknown') {
      const c = this.coverage.get(direction)!;
      c.width = o.width; c.height = o.height;
      if (o.complete && o.analysis.status === 'ok' && !c.times.includes(o.timestamp)) c.times.push(o.timestamp);
      if (!c.analysis || o.analysis.status === 'ok') c.analysis = o.analysis;
    }
    if (o.analysis.reason === '服の端や明るい箇所を確認できませんでした') this.ambiguity = true;
    const used = new Set<Track>();
    let jpeg: string | undefined;
    for (const box of o.analysis.boxes) {
      const relative = relativeBox(box, o.analysis.clothBounds ?? o.analysis.region);
      const track = this.tracks.find(t => !used.has(t) && t.last < o.timestamp &&
        (t.direction === direction || t.direction === 'unknown' || direction === 'unknown') &&
        ((t.direction !== 'unknown' && direction !== 'unknown') || o.timestamp - t.last <= 2) && sameCandidate(t.relative, relative));
      if (track) {
        used.add(track); track.count++; track.last = o.timestamp; track.relative = relative;
        if (track.direction === 'unknown' && direction !== 'unknown') track.direction = direction;
        if (o.analysis.sharpness > track.sharpness) {
          jpeg ??= image();
          track.best = { image: jpeg, width: o.width, height: o.height, box, timestamp: o.timestamp, direction: track.direction };
          track.sharpness = o.analysis.sharpness;
        }
        track.best.direction = track.direction;
      } else if (this.tracks.length < 48) {
        jpeg ??= image();
        const added: Track = { relative, first: o.timestamp, last: o.timestamp, count: 1, direction, sharpness: o.analysis.sharpness,
          best: { image: jpeg, width: o.width, height: o.height, box, timestamp: o.timestamp, direction } };
        this.tracks.push(added); used.add(added);
      } else this.overflow = true;
    }
  }
  report(): VideoReport {
    const stable = this.tracks.filter(t => t.count >= 2 && t.last - t.first >= CAPTURE.sampleSeconds * .7);
    const findings = stable.slice(0, 16).map(t => t.best);
    const unresolved = this.ambiguity || this.overflow || stable.length > 16 || stable.length !== this.tracks.length;
    const checks: CheckResult[] = DIRECTIONS.map(d => {
      const c = this.coverage.get(d.id)!;
      const facingVerified = c.times.length >= CAPTURE.minVerifiedFrames && c.times.at(-1)! - c.times[0] >= CAPTURE.minVerifiedSeconds;
      const analysis: Analysis = c.analysis ?? { status: 'uncertain', boxes: [], region: { x: 0, y: 0, width: 0, height: 0, area: 0 }, sharpness: 0, darkCoverage: 0 };
      const local = findings.filter(f => f.direction === d.id);
      return { direction: d.id, width: c.width, height: c.height, facingVerified, findings: local,
        analysis: { ...analysis, boxes: local.map(f => f.box), status: facingVerified && !unresolved ? 'ok' : 'uncertain' } };
    });
    const missing = checks.find(c => !c.facingVerified);
    const reason = !this.framing ? '全身が映る位置で、もう一度'
      : missing ? (missing.analysis.reason ?? `${missing.direction === 'back' ? '背面' : '正面'}を確認できませんでした`)
      : unresolved ? '付着物候補を確認できませんでした。ゆっくりもう一度' : undefined;
    return { findings, checks, framesAnalyzed: this.framesAnalyzed,
      complete: !unresolved && checks.every(c => c.facingVerified && c.analysis.status === 'ok'), reason };
  }
}

export async function inspectVideo(recording: Recording, inspector: Inspector, signal: AbortSignal): Promise<VideoReport> {
  const tracker = new VideoTracker();
  for await (const { canvas, timestamp } of recordedFrames(recording, signal)) {
    const small = document.createElement('canvas');
    small.width = Math.min(DETECTION.analysisWidth, canvas.width);
    small.height = Math.round(canvas.height * small.width / canvas.width);
    const context = small.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('解析できませんでした。もう一度');
    context.drawImage(canvas, 0, 0, small.width, small.height);
    try {
      const subject = await inspector.inspect(small);
      if (signal.aborted) throw new DOMException('中止', 'AbortError');
      const analysis = scaleAnalysis(analyze(context.getImageData(0, 0, small.width, small.height), DETECTION, subject), canvas.width / small.width, canvas.height / small.height);
      tracker.observe({ timestamp, width: canvas.width, height: canvas.height, analysis, complete: subject.complete, facing: subject.facing }, () => canvas.toDataURL('image/jpeg', .92));
    } finally { small.width = small.height = 0; }
    // Give Safari a chance to paint and handle cancellation between frames.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return tracker.report();
}

export function canSendOff(results: CheckResult[]) {
  if (results.length !== DIRECTIONS.length || new Set(results.map(r => r.direction)).size !== DIRECTIONS.length) return false;
  return DIRECTIONS.every(({ id }) => {
    const r = results.find(r => r.direction === id);
    return r?.analysis.status === 'ok' && r.facingVerified === true && !r.analysis.boxes.length && !r.findings?.length;
  });
}
