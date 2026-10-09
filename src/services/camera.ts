import { CAPTURE } from '../config';
export async function openCamera(): Promise<MediaStream> {
  if (!window.isSecureContext) throw new Error('カメラの利用にはHTTPS接続が必要です。');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではカメラを使用できません。Safariで開いてください。');
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const request = navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 }, frameRate: { ideal: 24, max: 30 } } });
  request.then(stream => { if (expired) stopCamera(stream); }, () => {});
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('カメラの応答がありません。利用許可を確認して再試行してください。')); }, 20000); })]);
  } catch (error) {
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') throw new Error('カメラを使用できません。Safariの設定をご確認ください。');
      if (error.name === 'NotFoundError') throw new Error('カメラが見つかりません。カメラを搭載した端末で開いてください。');
      if (error.name === 'NotReadableError') throw new Error('カメラを起動できません。他のアプリのカメラを終了し、再試行してください。');
    }
    throw error;
  } finally { clearTimeout(timer!); }
}
export function stopCamera(stream: MediaStream | null) { stream?.getTracks().forEach(track => track.stop()); }
export function captureFrame(video: HTMLVideoElement): HTMLCanvasElement {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.paused) throw new Error('カメラ画像を取得できませんでした。再撮影してください。');
  const scale = Math.min(1, CAPTURE.maxImageDimension / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('画像処理を開始できませんでした。');
  // Front preview and stored pixels are both mirrored exactly once.
  context.translate(canvas.width, 0); context.scale(-1, 1); context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}
