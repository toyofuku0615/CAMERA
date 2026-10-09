import { CAPTURE, DIRECTIONS, type Direction } from '../config';
import { captureFrame } from './camera';
import { VoiceGuide } from './speech';
export interface Progress { direction: Direction; index: number; total: number; countdown: number | null; instruction: string; preparing: boolean }
export interface Shot { direction: Direction; frames: HTMLCanvasElement[]; error?: string }
export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('中止', 'AbortError'));
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('中止', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export async function captureSequence(video: HTMLVideoElement, voice: VoiceGuide, signal: AbortSignal, update: (p: Progress) => void, onShot: (shot: Shot) => void, directions: Direction[] = DIRECTIONS.map(d => d.id)) {
  const first = DIRECTIONS.find(d => d.id === directions[0])!;
  for (let n = CAPTURE.preparationSeconds; n > 0; n--) {
    update({ direction: first.id, index: 0, total: directions.length, countdown: n, instruction: '撮影位置に立ってください', preparing: true });
    await wait(1000, signal);
  }
  for (let index = 0; index < directions.length; index++) {
    const direction = DIRECTIONS.find(d => d.id === directions[index])!;
    const instruction = directions.length === 1 ? `${direction.label}をカメラに向けてください` : direction.instruction;
    update({ direction: direction.id, index, total: directions.length, countdown: null, instruction, preparing: false });
    voice.say(instruction);
    await wait((CAPTURE.directionSeconds - CAPTURE.countdownSeconds) * 1000, signal);
    for (let n = CAPTURE.countdownSeconds; n > 0; n--) {
      update({ direction: direction.id, index, total: directions.length, countdown: n, instruction: 'そのまま静止してください', preparing: false });
      voice.say(String(n), 800);
      await wait(n === 1 ? 1000 - CAPTURE.burstMilliseconds : 1000, signal);
    }
    const frames: HTMLCanvasElement[] = [];
    try {
      for (let f = 0; f < CAPTURE.frameCount; f++) {
        if (signal.aborted) throw new DOMException('中止', 'AbortError');
        frames.push(captureFrame(video));
        if (f < CAPTURE.frameCount - 1) await wait(CAPTURE.burstMilliseconds / Math.max(1, CAPTURE.frameCount - 1), signal);
      }
      onShot({ direction: direction.id, frames });
    } catch (error) {
      if (signal.aborted) throw error;
      onShot({ direction: direction.id, frames: [], error: error instanceof Error ? error.message : '撮影できませんでした。' });
    }
  }
  voice.say('撮影が完了しました');
}
