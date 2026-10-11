import { CAPTURE } from '../config';
import { captureFrame } from './camera';
import type { Recording } from './capture';

export interface VideoFrame { canvas: HTMLCanvasElement; timestamp: number }
function mediaEvent(video: HTMLVideoElement, name: string, signal: AbortSignal, action: () => void) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('中止', 'AbortError'));
    const cleanup = () => {
      clearTimeout(timer); video.removeEventListener(name, done); video.removeEventListener('error', failed);
      signal.removeEventListener('abort', cancelled);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('動画を読み取れませんでした。もう一度')); };
    const cancelled = () => { cleanup(); reject(new DOMException('中止', 'AbortError')); };
    const timer = setTimeout(failed, 12000);
    video.addEventListener(name, done, { once: true }); video.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', cancelled, { once: true });
    try { action(); } catch { failed(); }
  });
}

/** Decode the recorded Blob, not the live preview. Keep at most one raw frame. */
export async function* recordedFrames(recording: Recording, signal: AbortSignal): AsyncGenerator<VideoFrame> {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  // A mounted, inline element also works with Safari's media decoding lifecycle.
  Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  const url = URL.createObjectURL(recording.blob);
  document.body.append(video);
  try {
    await mediaEvent(video, 'loadedmetadata', signal, () => { video.src = url; video.load(); });
    // WebM MediaRecorder streams can have no duration header. In that case use
    // measured recording duration, while each actual seek must still succeed.
    const duration = Number.isFinite(video.duration) ? video.duration : recording.duration;
    if (duration < CAPTURE.recordingSeconds - .6 || duration > CAPTURE.recordingSeconds + 10)
      throw new Error('動画が途中で止まりました。もう一度');
    const end = Math.min(duration, recording.duration) - .15;
    for (let timestamp = .25; timestamp < end; timestamp += CAPTURE.sampleSeconds) {
      if (signal.aborted) throw new DOMException('中止', 'AbortError');
      await mediaEvent(video, 'seeked', signal, () => { video.currentTime = timestamp; });
      if (Math.abs(video.currentTime - timestamp) > .2 || video.readyState < 2)
        throw new Error('動画を読み取れませんでした。もう一度');
      const canvas = captureFrame(video, true);
      try { yield { canvas, timestamp: video.currentTime }; }
      finally { canvas.width = canvas.height = 0; }
    }
  } finally {
    video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
  }
}
