import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { PERSON_MODEL } from '../config';
import type { PersonObservation } from './person';
let instance: PoseLandmarker | null = null;
let pending: Promise<PoseLandmarker> | null = null;
let epoch = 0;
let loadingAbort: AbortController | null = null;
export function disposePersonModel() { epoch++; loadingAbort?.abort(); loadingAbort = null; pending = null; instance?.close(); instance = null; }
export class ModelLoadError extends Error { constructor(message = '人物認識モデルを読み込めませんでした。接続を確認し、モデルを再試行してください。') { super(message); this.name = 'ModelLoadError'; } }
export function loadPersonModel(): Promise<PoseLandmarker> {
  if (instance) return Promise.resolve(instance);
  if (pending) return pending;
  const token = ++epoch, abort = new AbortController(); loadingAbort = abort;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new ModelLoadError('人物認識モデルの読み込みがタイムアウトしました。接続を確認して再試行してください。')); }, PERSON_MODEL.loadTimeoutMs); });
  const initialization = (async () => {
    try {
      const manifestResponse = await fetch('/vision/manifest.json', { signal: abort.signal });
      if (!manifestResponse.ok) throw new ModelLoadError();
      const manifest: { sha256: string; runtimeVersion: string; modelVersion: string } = await manifestResponse.json();
      if (manifest.runtimeVersion !== PERSON_MODEL.runtimeVersion || manifest.modelVersion !== PERSON_MODEL.modelVersion || manifest.sha256 !== PERSON_MODEL.sha256) throw new ModelLoadError();
      const response = await fetch(PERSON_MODEL.modelPath, { signal: abort.signal });
      if (!response.ok) throw new ModelLoadError();
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== manifest.sha256) throw new ModelLoadError('人物認識モデルの整合性を確認できませんでした。再読み込みしてください。');
      const files = await FilesetResolver.forVisionTasks(PERSON_MODEL.wasmPath);
      const model = await PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: new Uint8Array(bytes), delegate: 'CPU' },
        runningMode: 'IMAGE', numPoses: 2, outputSegmentationMasks: true,
        minPoseDetectionConfidence: .5, minPosePresenceConfidence: .5,
      });
      if (abort.signal.aborted || token !== epoch) { model.close(); throw new ModelLoadError(); }
      instance = model; return model;
    } catch (error) { throw error instanceof ModelLoadError ? error : new ModelLoadError(); }
    finally { /* The deadline is managed by the outer promise. */ }
  })();
  pending = Promise.race([initialization, timeout]).finally(() => { clearTimeout(timer!); if (token === epoch) { pending = null; loadingAbort = null; } });
  return pending;
}
export async function inferPerson(canvas: HTMLCanvasElement): Promise<PersonObservation | null> {
  const model = await loadPersonModel();
  let result: ReturnType<PoseLandmarker['detect']> | undefined;
  try {
    result = model.detect(canvas);
    const mask = result.segmentationMasks?.[0];
    if (!mask || !result.landmarks.length) return null;
    return { landmarks: result.landmarks[0], personCount: result.landmarks.length, mask: { width: mask.width, height: mask.height, data: new Float32Array(mask.getAsFloat32Array()) } };
  } catch {
    if (instance === model) { instance = null; model.close(); }
    throw new ModelLoadError('人物認識を実行できませんでした。モデルを再試行し、明るい場所で再撮影してください。');
  } finally { result?.close(); }
}
