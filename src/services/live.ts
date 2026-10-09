import { LIVE, LIVE_GUIDE, type LiveSettings } from '../config';
import { LiveDetector, type LiveAnalysis, type LiveRegion } from '../vision/live-detector';
import { LiveTracker } from '../vision/live-tracker';
export interface LiveSample { analysis: LiveAnalysis; canvas: HTMLCanvasElement; processingMs: number; timestamp: number; frame: number }
export function startLiveAnalysis(video: HTMLVideoElement, callbacks: {
  onSample: (sample: LiveSample) => void; onStale: () => void; onError: (error: Error) => void;
}, options: { settings?: LiveSettings; guide?: LiveRegion; debug?: boolean } = {}) {
  const settings = options.settings ?? LIVE, guide = options.guide ?? LIVE_GUIDE;
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('映像を解析できませんでした。カメラを再起動してください。');
  const detector = new LiveDetector(), tracker = new LiveTracker();
  let stopped = false, callbackId = 0, lastAnalyzed = -Infinity, lastMediaTime = -1, lastFresh = performance.now(), stale = false, frame = 0;
  const hasVideoCallback = typeof video.requestVideoFrameCallback === 'function';
  const schedule = () => { if (!stopped) callbackId = hasVideoCallback ? video.requestVideoFrameCallback(step) : requestAnimationFrame(step); };
  const step = (now: number) => {
    if (stopped) return;
    if (video.readyState >= 2 && !video.paused && video.videoWidth && video.videoHeight && video.currentTime !== lastMediaTime) {
      if (now - lastAnalyzed >= settings.intervalMs) {
        try {
          const start = performance.now(), scale = Math.min(1, settings.analysisWidth / video.videoWidth, settings.maxAnalysisHeight / video.videoHeight);
          const w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          ctx.setTransform(-1, 0, 0, 1, w, 0); ctx.drawImage(video, 0, 0, w, h);
          const analysis = detector.analyze(ctx.getImageData(0, 0, w, h), settings, guide, options.debug);
          analysis.boxes = tracker.update(analysis.boxes, now, { ...settings, matchDistance: settings.matchDistance * w / settings.analysisWidth });
          lastAnalyzed = now; lastMediaTime = video.currentTime; lastFresh = performance.now(); stale = false;
          callbacks.onSample({ analysis, canvas, timestamp: now, frame: ++frame, processingMs: performance.now() - start });
        } catch (error) { stop(); callbacks.onError(error instanceof Error ? error : new Error('映像を解析できませんでした。')); return; }
      }
    }
    schedule();
  };
  const watchdog = setInterval(() => {
    if (!stopped && !stale && performance.now() - lastFresh > settings.staleAfterMs) { stale = true; tracker.clear(); callbacks.onStale(); }
  }, Math.min(200, settings.staleAfterMs));
  const stop = () => {
    if (stopped) return;
    stopped = true; clearInterval(watchdog);
    if (hasVideoCallback) video.cancelVideoFrameCallback(callbackId); else cancelAnimationFrame(callbackId);
    detector.dispose(); tracker.clear(); canvas.width = canvas.height = 0;
  };
  schedule(); return stop;
}
