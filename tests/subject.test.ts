import { describe, expect, it } from 'vitest';
import type { NormalizedLandmark } from '@mediapipe/pose';
import type { Detection } from '@mediapipe/face_detection';
import { assessFacing, assessPose, fillSmallMaskHoles } from '../src/vision/subject';
import { canSendOff, type CheckResult } from '../src/vision/frames';
import { DIRECTIONS } from '../src/config';

function body(): NormalizedLandmark[] {
  const p = Array.from({ length: 33 }, () => ({ x: .5, y: .5, z: 0, visibility: .99 }));
  p[0] = { ...p[0], y: .12 };
  for (const [i, x, y] of [[11, .4, .26], [12, .6, .26], [23, .43, .51], [24, .57, .51], [15, .32, .53], [16, .68, .53], [25, .43, .7], [26, .57, .7], [27, .43, .88], [28, .57, .88], [31, .43, .92], [32, .57, .92]]) p[i] = { x, y, z: 0, visibility: .99 };
  return p;
}
function face(): Detection {
  return { boundingBox: { xCenter: .5, yCenter: .12, width: .1, height: .1, rotation: 0, rectId: 0 }, landmarks: [
    { x: .48, y: .1, z: 0 }, { x: .52, y: .1, z: 0 }, { x: .5, y: .12, z: 0 }, { x: .5, y: .14, z: 0 }, { x: .46, y: .12, z: 0 }, { x: .54, y: .12, z: 0 },
  ] };
}
describe('full-body and orientation evidence (synthetic landmarks)', () => {
  it('requires feet and visible wrists inside the actual image', () => {
    expect(assessPose(body()).complete).toBe(true);
    for (const i of [15, 27, 31]) { const p = body(); p[i].y = 1.03; expect(assessPose(p).complete).toBe(false); }
    const p = body(); p[28].visibility = .1; expect(assessPose(p).complete).toBe(false);
  });
  it('does not reject an otherwise complete body just because a wrist is occluded', () => {
    const p = body(); p[15].visibility = .1; expect(assessPose(p).complete).toBe(true);
  });
  it('accepts actual ear and heel evidence when the nose and toes are occluded from the back', () => {
    const p=body();p[0].visibility=p[31].visibility=p[32].visibility=.1;
    p[7].y=p[8].y=.12;p[29].y=p[30].y=.92;
    expect(assessPose(p).complete).toBe(true);
    p[7].visibility=p[8].visibility=.1;expect(assessPose(p).complete).toBe(false);
  });
  it('rejects a foot with neither a visible heel nor a visible toe', () => {
    const p=body();p[29].visibility=p[31].visibility=.1;expect(assessPose(p).complete).toBe(false);
  });
  it('rejects missing, invalid, and tiny poses', () => {
    expect(assessPose([]).complete).toBe(false);
    const p = body(); p[11].x = NaN; expect(assessPose(p).complete).toBe(false);
    const tiny = body().map(p => ({ ...p, y: p.y * .3 + .3 })); expect(assessPose(tiny).complete).toBe(false);
  });
  it('front needs a matching frontal face; a face elsewhere is not evidence', () => {
    expect(assessFacing(body(), [face()], 0)).toBe('front');
    const other = face(); other.landmarks.forEach(p => { p.x += .3; });
    expect(assessFacing(body(), [other], 0)).toBe('unknown');
    expect(assessFacing(body(), [face(), face()], 0)).toBe('unknown');
  });
  it('missing a face cannot by itself verify back; reversed calibrated torso can', () => {
    expect(assessFacing(body(), [], 1)).toBe('unknown');
    const back = body(); [back[11], back[12]] = [back[12], back[11]]; [back[23], back[24]] = [back[24], back[23]];
    expect(assessFacing(back, [], 0)).toBe('unknown');
    expect(assessFacing(back, [], 1)).toBe('back');
    expect(assessFacing(back, [face()], 1)).toBe('front'); // Face evidence always rules out back.
  });
  it.each([-1, 1])('profile needs depth and facial asymmetry, sign %s', sign => {
    const p = body(); p[11].x = .48; p[12].x = .52; p[12].z = .2;
    p[0].x = .5 + sign * .07;
    const f = face(); f.landmarks[2].x = p[0].x;
    expect(assessFacing(p, [f], 1)).toBe('profile');
    p[12].z = 0; expect(assessFacing(p, [f], 1)).toBe('unknown');
  });
});
describe('the sendoff is conditional, never a timer result', () => {
  const clean = (): CheckResult[] => DIRECTIONS.map(d => ({ direction: d.id, width: 480, height: 640, facingVerified: true, findings: [], analysis: { status: 'ok', boxes: [], region: { x: 0, y: 0, width: 1, height: 1, area: 1 }, darkCoverage: .8, sharpness: 10 } }));
  it('allows independently verified front and back without side shots', () => { expect(canSendOff(clean())).toBe(true); });
  it('rejects missing, duplicated, uncertain, unverified, and detected directions', () => {
    expect(canSendOff(clean().slice(0, 1))).toBe(false);
    const duplicate = clean(); duplicate[1] = duplicate[0]; expect(canSendOff(duplicate)).toBe(false);
    const uncertain = clean(); uncertain[1].analysis.status = 'uncertain'; expect(canSendOff(uncertain)).toBe(false);
    const unverified = clean(); unverified[1].facingVerified = false; expect(canSendOff(unverified)).toBe(false);
    const detected = clean(); detected[0].analysis.boxes.push({ x: 1, y: 1, width: 8, height: 8, area: 64 }); expect(canSendOff(detected)).toBe(false);
  });
});

describe('small enclosed segmentation holes', () => {
  it('recovers a small interior tape hole without expanding the silhouette', () => {
    const mask = new Uint8Array(49), allowed = new Uint8Array(49);
    for (let y=1;y<6;y++)for(let x=1;x<6;x++)mask[y*7+x]=allowed[y*7+x]=1;
    mask[24]=0;
    fillSmallMaskHoles(mask, allowed, 7, 7, 2);
    expect(mask[24]).toBe(1); expect(mask[0]).toBe(0); expect(mask.reduce((n,p)=>n+p,0)).toBe(25);
  });
  it('never fills background connected to an edge, excluded anatomy, or a large hole', () => {
    const edge = new Uint8Array(49).fill(1), allowed=edge.slice();edge[0]=edge[1]=0;
    fillSmallMaskHoles(edge,allowed,7,7,2);expect(edge[0]).toBe(0);
    const excluded=allowed.slice(), anatomical=allowed.slice();excluded[24]=anatomical[24]=0;
    fillSmallMaskHoles(excluded,anatomical,7,7,2);expect(excluded[24]).toBe(0);
    const large=allowed.slice();for(const p of [16,17,23,24])large[p]=0;
    fillSmallMaskHoles(large,allowed,7,7,2);expect(large[24]).toBe(0);
  });
});
