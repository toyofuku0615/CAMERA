import type { NormalizedLandmark, Pose, Results } from '@mediapipe/pose';
import type { Detection, FaceDetection } from '@mediapipe/face_detection';
import type { Direction } from '../config';

export interface Subject {
  width: number; height: number;
  /** Person probability AND anatomical clothing region, in the analysis pixels. */
  mask: Uint8Array;
  landmarks: NormalizedLandmark[];
  facing: Direction | 'unknown';
  complete: boolean;
  reason?: string;
}
export interface Inspector { inspect(image: HTMLCanvasElement): Promise<Subject>; close(): Promise<void> }
let library: Promise<void> | undefined;

function loadLibrary() {
  library ??= Promise.all(['pose.js', 'face_detection.js'].map(file => new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${import.meta.env.BASE_URL}vision/${file}`;
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); library = undefined; reject(new Error('解析を準備できませんでした')); };
    document.head.append(script);
  }))).then(() => {});
  return library;
}

// Input is already mirrored once by captureFrame. Anatomical left/right below
// therefore have the opposite screen order to an unmirrored front-facing photo.
// These are conservative pose estimates, not proof of physical rotation.
export function assessPose(points: NormalizedLandmark[]): Pick<Subject, 'facing' | 'complete' | 'reason'> {
  const visible = (i: number, confidence = .6) => {
    const p = points[i];
    return p && [p.x, p.y, p.z, p.visibility].every(Number.isFinite) && (p.visibility ?? 0) >= confidence;
  };
  if (points.length !== 33 || ![11, 12, 23, 24].every(i => visible(i)))
    return { facing: 'unknown', complete: false, reason: '全身が映る位置で、もう一度' };
  // In profile the far leg can be occluded, but each leg must still have evidence.
  if (![25, 26, 27, 28, 31, 32].every(i => visible(i, .45)) || !visible(0, .45))
    return { facing: 'unknown', complete: false, reason: '足元まで映る位置で、もう一度' };
  if (![15, 16].every(i => visible(i, .4))) return { facing: 'unknown', complete: false, reason: '全身が映る位置で、もう一度' };
  const body = [0, 11, 12, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32].map(i => points[i]);
  if (body.some(p => p.x < .035 || p.x > .965 || p.y < .025 || p.y > .965) ||
      Math.max(points[31].y, points[32].y) - points[0].y < .45)
    return { facing: 'unknown', complete: false, reason: '全身が映る位置で、もう一度' };
  const [ls, rs, lh, rh] = [points[11], points[12], points[23], points[24]];
  const torso = (lh.y + rh.y - ls.y - rs.y) / 2;
  if (torso < .1) return { facing: 'unknown', complete: false, reason: '全身が映る位置で、もう一度' };
  // Framing alone does not establish orientation; assessFacing adds face evidence.
  return { facing: 'unknown', complete: true };
}

/** Face evidence disambiguates front/profile. Back requires reversed anatomical
 * shoulder AND hip order relative to the observed frontal calibration, no face,
 * and a broad torso. A timer or simply missing a face can never verify the back. */
export function assessFacing(points: NormalizedLandmark[], faces: Detection[], frontOrder: number): Subject['facing'] {
  if (points.length !== 33 || faces.length > 1) return 'unknown';
  const [ls, rs, lh, rh] = [points[11], points[12], points[23], points[24]];
  const torso = (lh.y + rh.y - ls.y - rs.y) / 2;
  if (torso < .1) return 'unknown';
  const shoulder = (rs.x - ls.x) / torso, hip = (rh.x - lh.x) / torso;
  const depth = Math.abs(rs.z - ls.z) / torso;
  if (!faces.length) return frontOrder && shoulder * frontOrder < -.4 && hip * frontOrder < -.15 && depth < .85 ? 'back' : 'unknown';
  const face = faces[0], p = face.landmarks;
  if (p.length < 6 || p.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y))) return 'unknown';
  // Require the detected face to belong to this pose, not a passerby or poster.
  const nose = points[0];
  if (Math.hypot(p[2].x - nose.x, p[2].y - nose.y) > torso * .35) return 'unknown';
  const eyes = Math.abs(p[0].x - p[1].x);
  const deviation = (p[2].x - (p[0].x + p[1].x) / 2) / Math.max(.001, eyes);
  if (eyes > .012 && Math.abs(deviation) < .3 && Math.abs(shoulder) > .4 && depth < .85) return 'front';
  const offset = (p[2].x - (ls.x + rs.x) / 2) / torso;
  if (Math.abs(shoulder) < .5 && depth > .6 && Math.abs(offset) > .12 && Math.abs(deviation) > .35)
    return offset < 0 ? 'side1' : 'side2';
  return 'unknown';
}

function clothingMask(points: NormalizedLandmark[], person: Uint8ClampedArray, w: number, h: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  if (points.length === 33) {
    const p = points;
    const torso = Math.abs((p[23].y + p[24].y - p[11].y - p[12].y) / 2) * h;
    const radius = Math.max(3, torso * .22);
    // Torso, covered arms, and legs. Face, hands and feet are deliberately excluded.
    const outline = [11, 12, 24, 23];
    ctx.beginPath(); outline.forEach((i, n) => n ? ctx.lineTo(p[i].x * w, p[i].y * h) : ctx.moveTo(p[i].x * w, p[i].y * h));
    ctx.closePath(); ctx.fill(); ctx.lineWidth = radius; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineCap = 'round';
    for (const [a, b, size] of [[11, 13, .8], [13, 15, .55], [12, 14, .8], [14, 16, .55], [23, 25, 1.5], [25, 27, .9], [24, 26, 1.5], [26, 28, .9]]) {
      if ((p[a].visibility ?? 0) < .45 || (p[b].visibility ?? 0) < .45) continue;
      ctx.lineWidth = radius * size; ctx.beginPath(); ctx.moveTo(p[a].x * w, p[a].y * h);
      // Leave a small gap before wrists/ankles so bare hands/feet don't qualify.
      ctx.lineTo((p[a].x * .08 + p[b].x * .92) * w, (p[a].y * .08 + p[b].y * .92) * h); ctx.stroke();
    }
  }
  const anatomical = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = anatomical[i * 4 + 3] > 200 && person[i * 4 + 3] > 210 ? 1 : 0;
  c.width = c.height = 0;
  return mask;
}

export async function createInspector(): Promise<Inspector> {
  await loadLibrary();
  const PoseConstructor = (window as unknown as { Pose: typeof Pose }).Pose;
  const pose = new PoseConstructor({ locateFile: file => `${import.meta.env.BASE_URL}vision/${file}` });
  const FaceConstructor = (window as unknown as { FaceDetection: typeof FaceDetection }).FaceDetection;
  const face = new FaceConstructor({ locateFile: file => `${import.meta.env.BASE_URL}vision/${file}` });
  face.setOptions({ selfieMode: false, model: 'full', minDetectionConfidence: .7 });
  pose.setOptions({ modelComplexity: 0, selfieMode: false, smoothLandmarks: false, enableSegmentation: true, smoothSegmentation: false, minDetectionConfidence: .65, minTrackingConfidence: .65 });
  try { await pose.initialize(); await face.initialize(); } catch (e) { await Promise.allSettled([pose.close(), face.close()]); throw e; }
  let result: Subject | undefined;
  let size = { width: 0, height: 0 };
  let faces: Detection[] | undefined;
  let frontOrder = 0;
  face.onResults(r => { faces = r.detections; });
  pose.onResults((r: Results) => {
    const landmarks = r.poseLandmarks?.map(p => ({ ...p })) ?? [];
    const c = document.createElement('canvas'); c.width = size.width; c.height = size.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    if (r.segmentationMask) ctx.drawImage(r.segmentationMask, 0, 0, c.width, c.height);
    const person = ctx.getImageData(0, 0, c.width, c.height).data;
    const mask = clothingMask(landmarks, person, c.width, c.height);
    result = { ...size, mask, landmarks, ...assessPose(landmarks) };
    c.width = c.height = 0;
  });
  return {
    async inspect(image) {
      result = undefined; size = { width: image.width, height: image.height };
      // Tracking only reuses the ROI. With smoothing disabled each send still
      // estimates this frame; resetting here would rebuild WebGL for every image.
      await pose.send({ image });
      // onResults writes during send; TypeScript cannot track callback side effects.
      const subject = result as Subject | undefined;
      if (!subject) throw new Error('解析できませんでした');
      faces = undefined;
      await face.send({ image });
      if (!faces) throw new Error('解析できませんでした');
      subject.facing = subject.complete ? assessFacing(subject.landmarks, faces, frontOrder) : 'unknown';
      if (subject.facing === 'front') frontOrder = Math.sign(subject.landmarks[12].x - subject.landmarks[11].x);
      if (subject.complete) subject.reason = subject.facing === 'unknown' ? '向きを確認できませんでした' : undefined;
      return subject;
    },
    async close() { await Promise.allSettled([pose.close(), face.close()]); },
  };
}
