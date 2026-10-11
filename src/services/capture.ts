import { CAPTURE } from '../config';
import { VoiceGuide } from './speech';

export interface Progress { countdown: number | null; instruction: string; preparing: boolean }
export interface Recording { blob: Blob; duration: number }
const aborted = () => new DOMException('中止', 'AbortError');

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); reject(aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Safari records MP4; Chromium can use WebM. No still-image fallback. */
function createRecorder(stream: MediaStream) {
  if (!window.MediaRecorder) throw new Error('動画を撮れるSafariで開いてください');
  for (const mimeType of ['video/mp4', 'video/webm;codecs=vp8', 'video/webm']) {
    if (!MediaRecorder.isTypeSupported(mimeType)) continue;
    try { return new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 }); } catch { /* Try another supported container. */ }
  }
  return new MediaRecorder(stream, { videoBitsPerSecond: 4_000_000 });
}

/** One uninterrupted video: front, turn, back. No side shots or burst captures. */
export async function captureSequence(video: HTMLVideoElement, voice: VoiceGuide, signal: AbortSignal,
  update: (p: Progress) => void): Promise<Recording> {
  for (let n = CAPTURE.preparationSeconds; n > 0; n--) {
    update({ countdown: n, instruction: '少し離れて、全身を画面に', preparing: true });
    await wait(1000, signal);
  }
  if (signal.aborted) throw aborted();
  const stream = video.srcObject;
  if (!(stream instanceof MediaStream) || !stream.getVideoTracks().some(t => t.readyState === 'live'))
    throw new Error('カメラが止まりました。もう一度');
  const recorder = createRecorder(stream);
  return new Promise<Recording>((resolve, reject) => {
    const chunks: Blob[] = [];
    const guide = new AbortController();
    const tracks = stream.getVideoTracks();
    let bytes = 0, settled = false, completed = false;
    const started = performance.now();
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      guide.abort(); clearTimeout(stopTimer);
      signal.removeEventListener('abort', onAbort);
      tracks.forEach(t => t.removeEventListener('ended', onEnded));
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true; cleanup(); chunks.length = 0;
      if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Already stopped. */ } }
      reject(error);
    };
    const onAbort = () => fail(aborted());
    const onEnded = () => fail(new Error('撮影が止まりました。もう一度'));
    signal.addEventListener('abort', onAbort, { once: true });
    tracks.forEach(t => t.addEventListener('ended', onEnded, { once: true }));
    recorder.onerror = () => fail(new Error('動画を撮れませんでした。もう一度'));
    recorder.ondataavailable = event => {
      if (settled || !event.data.size) return;
      bytes += event.data.size;
      if (bytes > CAPTURE.maxVideoBytes) return fail(new Error('動画を撮れませんでした。もう一度'));
      chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (settled) return;
      const duration = (performance.now() - started) / 1000;
      if (!completed || duration < CAPTURE.recordingSeconds - .5 || !bytes) return fail(new Error('撮影が止まりました。もう一度'));
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
      settled = true; cleanup(); chunks.length = 0;
      voice.say('撮影が終わりました');
      resolve({ blob, duration });
    };
    try { recorder.start(1000); } catch { fail(new Error('動画を撮れませんでした。もう一度')); return; }
    void (async () => {
      for (let second = 0; second < CAPTURE.recordingSeconds; second++) {
        const instruction = second < CAPTURE.frontSeconds ? '正面を向いて、少し静止'
          : second < CAPTURE.frontSeconds + CAPTURE.turnSeconds ? 'ゆっくり、背中を向けてください' : '背中を向けたまま、少し静止';
        update({ countdown: null, instruction, preparing: false });
        if (second === 0) voice.say('撮影開始。正面を向いてください', 3500);
        if (second === CAPTURE.frontSeconds) voice.say('ゆっくり、背中を向けてください', 3500);
        if (second === CAPTURE.frontSeconds + CAPTURE.turnSeconds) voice.say('背中を向けたまま、少し止まってください', 4000);
        await wait(1000, guide.signal);
      }
      completed = true;
      // Safari can deliver the last dataavailable asynchronously after stop.
      stopTimer = setTimeout(() => fail(new Error('動画を取得できませんでした。もう一度')), 8000);
      recorder.stop();
    })().catch(error => { if (!settled) fail(error instanceof Error ? error : new Error('撮影が止まりました。もう一度')); });
  });
}
