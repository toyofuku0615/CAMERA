import type { NormalizedLandmark, Pose, Results } from '@mediapipe/pose';
import type { Detection, FaceDetection } from '@mediapipe/face_detection';
import type { Direction } from '../config';

export interface Subject {
  width: number; height: number;
  /** Person probability AND anatomical clothing region, in the analysis pixels. */
  mask: Uint8Array;
  landmarks: NormalizedLandmark[];
  facing: Direction | 'profile' | 'unknown';
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
  // The video includes turning frames, but only actual full-body frames certify
  // front/back coverage. Occluded hands alone shouldn't reject the whole video.
  const head = [0, 7, 8].filter(i => visible(i, .35));
  const feet = [[31, 29], [32, 30]].map(alternatives => alternatives.find(i => visible(i, .35)));
  if (![25, 26, 27, 28].every(i => visible(i, .45)) || !head.length || feet.some(i => i === undefined))
    return { facing: 'unknown', complete: false, reason: '足元まで映る位置で、もう一度' };
  // Back-facing people can have occluded noses/toes. Actual ears and heels are
  // valid head/foot evidence, rather than requiring front-only landmarks.
  const foot = feet as number[];
  const body = [...head, 11, 12, 23, 24, 25, 26, 27, 28, ...foot, ...[15, 16].filter(i => visible(i, .4))].map(i => points[i]);
  if (body.some(p => p.x < .035 || p.x > .965 || p.y < .025 || p.y > .965) ||
      Math.max(...foot.map(i => points[i].y)) - Math.min(...head.map(i => points[i].y)) < .45)
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
  if (!faces.length) {
    if (frontOrder && shoulder * frontOrder < -.4 && hip * frontOrder < -.15 && depth < 1.1) return 'back';
    return Math.abs(shoulder) < .5 && depth > .6 ? 'profile' : 'unknown';
  }
  const face = faces[0], p = face.landmarks;
  if (p.length < 6 || p.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y))) return 'unknown';
  // Require the detected face to belong to this pose, not a passerby or poster.
  const nose = points[0];
  if (Math.hypot(p[2].x - nose.x, p[2].y - nose.y) > torso * .35) return 'unknown';
  const eyes = Math.abs(p[0].x - p[1].x);
  const deviation = (p[2].x - (p[0].x + p[1].x) / 2) / Math.max(.001, eyes);
  if (eyes > .012 && Math.abs(deviation) < .45 && Math.abs(shoulder) > .4 && depth < 1.1) return 'front';
  const offset = (p[2].x - (ls.x + rs.x) / 2) / torso;
  if (Math.abs(shoulder) < .5 && depth > .6 && Math.abs(offset) > .12 && Math.abs(deviation) > .35)
    return 'profile';
  return 'unknown';
}

/** A white tape patch can become a small hole in person segmentation against a
 * white wall. Fill only enclosed holes inside the anatomical clothing proxy;
 * never expand the silhouette into the background. */
export function fillSmallMaskHoles(mask: Uint8Array, allowed: Uint8Array, w: number, h: number, maxArea: number) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] || visited[seed]) continue;
    let head = 0, tail = 1, open = false;
    queue[0] = seed; visited[seed] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = Math.floor(p / w);
      if (!allowed[p] || x === 0 || x === w - 1 || y === 0 || y === h - 1) open = true;
      for (const [nx, ny] of [[x-1,y], [x+1,y], [x,y-1], [x,y+1]]) {
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (!mask[n] && !visited[n]) { visited[n] = 1; queue[tail++] = n; }
      }
    }
    if (!open && tail <= maxArea) for (let i = 0; i < tail; i++) mask[queue[i]] = 1;
  }
  return mask;
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
  const mask = new Uint8Array(w * h), allowed = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    allowed[i] = anatomical[i * 4 + 3] > 200 ? 1 : 0;
    mask[i] = allowed[i] && person[i * 4 + 3] > 210 ? 1 : 0;
  }
  fillSmallMaskHoles(mask, allowed, w, h, Math.round(w * h * .006));
  c.width = c.height = 0;
  return mask;
}

export async function createInspector(): Promise<Inspector> {
  await loadLibrary();
  const PoseConstructor = (window as unknown as { Pose: typeof Pose }).Pose;
  const pose = new PoseConstructor({ locateFile: file => `${import.meta.env.BASE_URL}vision/${file}` });
  const FaceConstructor = (window as unknown as { FaceDetection: typeof FaceDetection }).FaceDetection;
  const face = new FaceConstructor({ locateFile: file => `${import.meta.env.BASE_URL}vision/${file}` });
  face.setOptions({ selfieMode: false, model: 'full', minDetectionConfidence: .55 });
  pose.setOptions({ modelComplexity: 0, selfieMode: false, smoothLandmarks: false, enableSegmentation: true, smoothSegmentation: false, minDetectionConfidence: .5, minTrackingConfidence: .5 });
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
