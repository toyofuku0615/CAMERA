import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import { PERSON_MODEL } from '../config';
import type { PersonObservation } from './person';
let instance: ImageSegmenter | null = null;
let pending: Promise<ImageSegmenter> | null = null;
let epoch = 0;
let loadingAbort: AbortController | null = null;
export function disposePersonModel() { epoch++; loadingAbort?.abort(); loadingAbort = null; pending = null; instance?.close(); instance = null; }
export class ModelLoadError extends Error { constructor(message = '服認識モデルを読み込めませんでした。接続を確認し、モデルを再試行してください。') { super(message); this.name = 'ModelLoadError'; } }
export function loadPersonModel(): Promise<ImageSegmenter> {
  if (instance) return Promise.resolve(instance);
  if (pending) return pending;
  const token = ++epoch, abort = new AbortController(); loadingAbort = abort;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new ModelLoadError('服認識モデルの読み込みがタイムアウトしました。接続を確認して再試行してください。')); }, PERSON_MODEL.loadTimeoutMs); });
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
      if (hash !== manifest.sha256) throw new ModelLoadError('服認識モデルの整合性を確認できませんでした。再読み込みしてください。');
      const files = await FilesetResolver.forVisionTasks(PERSON_MODEL.wasmPath);
      const model = await ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetBuffer: new Uint8Array(bytes), delegate: 'CPU' },
        runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
      });
      if (abort.signal.aborted || token !== epoch) { model.close(); throw new ModelLoadError(); }
      if (model.getLabels().join(',') !== 'background,hair,body-skin,face-skin,clothes,others') { model.close(); throw new ModelLoadError('服認識モデルのラベルを確認できませんでした。'); }
      instance = model; return model;
    } catch (error) { throw error instanceof ModelLoadError ? error : new ModelLoadError(); }
    finally { /* The deadline is managed by the outer promise. */ }
  })();
  pending = Promise.race([initialization, timeout]).finally(() => { clearTimeout(timer!); if (token === epoch) { pending = null; loadingAbort = null; } });
  return pending;
}
export async function inferPerson(canvas: HTMLCanvasElement): Promise<PersonObservation | null> {
  const model = await loadPersonModel();
  let result: ReturnType<ImageSegmenter['segment']> | undefined;
  try {
    result = model.segment(canvas);
    const masks = result.confidenceMasks;
    if (!masks || masks.length !== 6) return null;
    const width = masks[0].width, height = masks[0].height;
    const background = masks[0].getAsFloat32Array(), clothes = new Float32Array(masks[4].getAsFloat32Array());
    const body = masks[2].getAsFloat32Array(), face = masks[3].getAsFloat32Array();
    const foreground = new Float32Array(width * height), skin = new Float32Array(width * height);
    for (let p = 0; p < foreground.length; p++) { foreground[p] = 1 - background[p]; skin[p] = Math.max(body[p], face[p]); }
    // Garment segmentation is independent of shoulder/hip or full-body pose detection.
    return { mask: { width, height, data: foreground }, clothes: { width, height, data: clothes }, skin: { width, height, data: skin } };
  } catch {
    if (instance === model) { instance = null; model.close(); }
    throw new ModelLoadError('服認識を実行できませんでした。モデルを再試行し、明るい場所で再撮影してください。');
  } finally { result?.close(); }
}
