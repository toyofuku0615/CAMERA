import { describe, expect, it } from 'vitest';
import { analyze, scaleAnalysis, type Pixels } from '../src/vision/detector';
import { estimateTorso, type PersonObservation } from '../src/vision/person';
import { DETECTION } from '../src/config';
import { alignBox, stableBoxes } from '../src/vision/frames';
import { wait } from '../src/services/capture';
import { captureFrame } from '../src/services/camera';
function scene(stickers: { x: number; y: number; width?: number; height?: number; value?: number }[] = [], scale = 1, background = 'white') {
  const width = Math.round(480 * scale), height = Math.round(640 * scale), data = new Uint8ClampedArray(width * height * 4), mask = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const px = x / scale, py = y / scale, person = px >= 150 && px < 330 && py >= 165 && py < 510;
    let value = background === 'black' ? 24 : background === 'pattern' ? (Math.floor(px / 15) + Math.floor(py / 20)) % 2 ? 230 : 20 : background === 'window' ? Math.min(255, px * .5 + 50) : 225;
    if (person) value = 24 + ((x + y) % 5);
    if (stickers.some(b => px >= b.x && px < b.x + (b.width ?? 14) && py >= b.y && py < b.y + (b.height ?? 16))) value = stickers.find(b => px >= b.x && px < b.x + (b.width ?? 14) && py >= b.y && py < b.y + (b.height ?? 16))?.value ?? 245;
    const i = (y * width + x) * 4; data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255; mask[y * width + x] = person ? .99 : .01;
  }
  const image: Pixels = { width, height, data }, observation: PersonObservation = { mask: { width, height, data: mask }, clothes: { width, height, data: mask.slice() }, skin: { width, height, data: new Float32Array(width * height) } };
  return { image, observation, torso: estimateTorso(observation, width, height) };
}
const detect = (s: ReturnType<typeof scene>, settings = DETECTION) => analyze(s.image, settings, s.torso);
describe('person-restricted pixel detection (synthetic annotations, not physical accuracy)', () => {
  it.each(['white', 'black', 'pattern', 'window'])('finds the sticker with %s background independently of darkness', background => {
    const a = detect(scene([{ x: 210, y: 300 }], 1, background)); expect(a.status).toBe('ok'); expect(a.roiSource).toBe('clothes'); expect(a.boxes).toMatchObject([{ x: 210, y: 300, width: 14, height: 16, area: 224 }]);
  });
  it.each(['white', 'black', 'pattern', 'window'])('keeps %s background out of clean-cloth results', background => { const a = detect(scene([], 1, background)); expect(a.status).toBe('ok'); expect(a.boxes).toHaveLength(0); });
  it('ignores bright background spots even on a black wall', () => { expect(detect(scene([{ x: 80, y: 300 }, { x: 350, y: 300 }], 1, 'black')).boxes).toHaveLength(0); });
  it('tracks changed location and removal', () => { expect(detect(scene([{ x: 180, y: 250 }])).boxes[0].x).toBe(180); expect(detect(scene([{ x: 270, y: 400 }])).boxes[0].x).toBe(270); expect(detect(scene()).boxes).toHaveLength(0); });
  it('separates two stickers', () => { expect(detect(scene([{ x: 180, y: 250 }, { x: 270, y: 400 }])).boxes).toHaveLength(2); });
  it.each([.5, 1, 2])('preserves coordinates at scale %s', scale => { const a = detect(scene([{ x: 210, y: 300 }], scale)); expect(a.boxes[0].x).toBe(210 * scale); expect(a.boxes[0].width).toBe(14 * scale); expect(scaleAnalysis(a, 1 / scale, 1 / scale).boxes[0].area).toBe(224); });
  it('preserves an enclosed white sticker hole in the segmentation mask', () => { const s = scene([{ x: 210, y: 300 }]); for (let y = 300; y < 316; y++) for (let x = 210; x < 224; x++) s.observation.clothes.data[y * 480 + x] = 0; s.torso = estimateTorso(s.observation, 480, 640); expect(detect(s).boxes).toHaveLength(1); });
  it('does not fill a mask hole connected to the background', () => { const s = scene([{ x: 150, y: 300, width: 20 }]); for (let y = 300; y < 316; y++) for (let x = 150; x < 170; x++) s.observation.clothes.data[y * 480 + x] = 0; s.torso = estimateTorso(s.observation, 480, 640); expect(detect(s).boxes).toHaveLength(0); });
  it('detects underexposed white using local contrast instead of only an absolute threshold', () => { expect(detect(scene([{ x: 210, y: 300, value: 135 }])).boxes).toHaveLength(1); });
  it('excludes visible hands overlapping a bright spot', () => { const s = scene([{ x: 210, y: 300 }]); for(let y=290;y<326;y++) for(let x=200;x<234;x++) s.observation.skin!.data[y*480+x]=.99; s.torso = estimateTorso(s.observation, 480, 640); expect(detect(s).boxes).toHaveLength(0); });
  it('rejects tiny noise and records the reason', () => { const a = detect(scene([{ x: 210, y: 300, width: 2, height: 2 }])); expect(a.boxes).toHaveLength(0); expect(a.candidates[0].reason).toBe('最小面積未満'); });
  it('rejects oversized patches and insufficient contrast with reasons', () => { expect(detect(scene([{ x: 190, y: 280, width: 100, height: 80 }])).candidates[0].reason).toBe('最大面積超過'); expect(detect(scene([{ x: 210, y: 300 }]), { ...DETECTION, contrastThreshold: 250 }).boxes).toHaveLength(0); });
  it('stays uncertain without a person mask even for a perfectly dark frame', () => { const s = scene(); const a = analyze(s.image); expect(a.status).toBe('uncertain'); expect(a.boxes).toHaveLength(0); });
  it('rejects ambiguous garment components', () => { const s=scene([{x:210,y:300}]);for(let y=165;y<510;y++)for(let x=235;x<245;x++)s.observation.clothes.data[y*480+x]=0;expect(estimateTorso(s.observation,480,640).source).toBe('none'); });
  it('recognizes clothing when shoulders and hips are unavailable', () => {const a=detect(scene([{x:210,y:300}]));expect(a.status).toBe('ok');expect(a.roiSource).toBe('clothes');expect(a.boxes).toHaveLength(1);});
  it('does not confuse a textureless plain garment with blur', () => { const s = scene(); for(let p=0;p<s.torso.roi.length;p++) if(s.torso.roi[p]) { s.image.data[p*4]=s.image.data[p*4+1]=s.image.data[p*4+2]=30; } expect(detect(s).status).toBe('ok'); expect(detect(s).boxes).toHaveLength(0); });
});
describe('temporal fusion', () => {
  it('retains a single-frame candidate as low confidence', () => { const clean = detect(scene()), marked = detect(scene([{ x: 210, y: 300 }])); const fused = stableBoxes(marked, [marked, clean]); expect(fused.boxes).toHaveLength(1); expect(fused.boxes[0].confidence).toBe('single-frame'); expect(fused.unstable).toBe(true); });
  it('confirms consistent candidates', () => { const a = detect(scene([{ x: 210, y: 300 }])), b = detect(scene([{ x: 211, y: 300 }])); expect(stableBoxes(a, [a, b]).boxes[0].confidence).toBe('confirmed'); });
  it('allows small displacement even without overlap', () => { const a = detect(scene([{ x: 210, y: 300, width: 5, height: 5 }])), b = detect(scene([{ x: 216, y: 300, width: 5, height: 5 }])); expect(stableBoxes(a, [a, b]).boxes[0].support).toBe(2); });
  it('registers the moving torso before comparing candidate positions', () => { const a = detect(scene([{ x: 210, y: 300 }])), b = { ...a, torso: a.torso.map(p => ({ x: p.x + 30, y: p.y + 20 })), boxes: a.boxes.map(box => ({ ...box, x: box.x + 30, y: box.y + 20 })) }; expect(alignBox(b.boxes[0], b, a)?.x).toBeCloseTo(210); expect(stableBoxes(a, [a, b]).boxes[0].support).toBe(2); });
  it('does not confirm distant or disproportionate components', () => { const a = detect(scene([{ x: 180, y: 250 }])), b = detect(scene([{ x: 270, y: 400 }])); expect(stableBoxes(a, [a, b]).boxes[0].confidence).toBe('single-frame'); });
  it('does not project a candidate from an invalid anatomical ROI', () => { const a = detect(scene([{ x: 210, y: 300 }])), b = { ...a, roiSource: 'none' as const }; expect(alignBox(b.boxes[0], b, a)).toBeNull(); });
});
describe('capture failures', () => {
  it('rejects a video without a decoded frame', () => { expect(() => captureFrame({ readyState: 0 } as HTMLVideoElement)).toThrow('カメラ画像を取得できませんでした'); });
  it('aborts pending countdowns', async () => { const c = new AbortController(); const p = wait(10000, c.signal); c.abort(); await expect(p).rejects.toMatchObject({ name: 'AbortError' }); });
  it('rejects already cancelled operations', async () => { const c = new AbortController(); c.abort(); await expect(wait(1, c.signal)).rejects.toMatchObject({ name: 'AbortError' }); });
});

function clothingScene(fabric: number[], attachment?: number[], gradient = false) {
  const s = scene(attachment ? [{ x: 210, y: 300 }] : []);
  s.observation.clothes = { ...s.observation.mask, data: s.observation.mask.data.slice() };
  s.observation.skin = { ...s.observation.mask, data: new Float32Array(480 * 640) };
  for (let y=165;y<510;y++) for (let x=150;x<330;x++) {
    const item = attachment && x>=210 && x<224 && y>=300 && y<316;
    const color = item ? attachment! : fabric;
    const offset = !item && gradient ? (x-240)*.3 + (y-337)*.15 : 0;
    for(let channel=0;channel<3;channel++) s.image.data[(y*480+x)*4+channel]=Math.max(0,Math.min(255,color[channel]+offset));
  }
  s.torso = estimateTorso(s.observation, 480, 640); return s;
}
describe('direct garment segmentation and plain-fabric anomalies', () => {
  it.each([
    {name:'black / white',fabric:[25,25,25],item:[245,245,245]},
    {name:'white / black',fabric:[235,235,235],item:[25,25,25]},
    {name:'navy / red',fabric:[25,35,75],item:[220,35,35]},
    {name:'beige / blue',fabric:[200,180,150],item:[40,70,200]},
    {name:'gray / equal-luminance red',fabric:[95,95,95],item:[235,55,60]},
    {name:'green / white',fabric:[40,120,65],item:[240,240,240]},
  ])('detects $name without requiring shoulder/hip landmarks', ({fabric,item}) => {
    const a=detect(clothingScene(fabric,item)); expect(a.status).toBe('ok');expect(a.roiSource).toBe('clothes');expect(a.boxes).toMatchObject([{x:210,y:300,width:14,height:16}]);
  });
  it.each([[25,25,25],[235,235,235],[25,35,75],[200,180,150],[40,120,65]].map(fabric => ({fabric})))('accepts a clean textureless garment $fabric', ({fabric}) => {const a=detect(clothingScene(fabric));expect(a.status).toBe('ok');expect(a.boxes).toHaveLength(0);});
  it('absorbs smooth lighting variation, while keeping an attachment', () => {expect(detect(clothingScene([140,140,140],undefined,true)).boxes).toHaveLength(0);expect(detect(clothingScene([140,140,140],[245,245,245],true)).boxes).toHaveLength(1);});
  it('fills a foreground attachment hole in the clothes class', () => {
    const s=clothingScene([25,25,25],[245,245,245]);for(let y=300;y<316;y++)for(let x=210;x<224;x++)s.observation.clothes!.data[y*480+x]=0;
    s.torso=estimateTorso(s.observation,480,640);expect(detect(s).boxes).toHaveLength(1);
  });
  it('does not fill exposed skin classified outside clothing', () => {
    const s=clothingScene([25,25,25],[245,245,245]);for(let y=300;y<316;y++)for(let x=210;x<224;x++) {s.observation.clothes!.data[y*480+x]=0;s.observation.skin!.data[y*480+x]=.99;}
    s.torso=estimateTorso(s.observation,480,640);expect(detect(s).boxes).toHaveLength(0);
  });
  it('does not infer clothing just from a foreground mask', () => {const s=clothingScene([25,25,25]);s.observation.clothes!.data.fill(0);s.torso=estimateTorso(s.observation,480,640);expect(detect(s).status).toBe('uncertain');});
  it('reports actual underexposure or clipping instead of claiming no objects', () => {const s=clothingScene([3,3,3]);for(let p=0;p<s.image.data.length;p+=4)s.image.data[p]=s.image.data[p+1]=s.image.data[p+2]=3;expect(detect(s).status).toBe('uncertain');expect(detect(clothingScene([255,255,255])).status).toBe('uncertain');});
  it('does not equate black fabric with inadequate room lighting', () => {const a=detect(clothingScene([3,3,3],[245,245,245]));expect(a.status).toBe('ok');expect(a.boxes).toHaveLength(1);});
  it('does not certify a strongly patterned garment as plain', () => {const s=clothingScene([100,100,100]);for(let y=165;y<510;y++)for(let x=150;x<330;x++){const v=(Math.floor(x/15)+Math.floor(y/15))%2?230:25;for(let c=0;c<3;c++)s.image.data[(y*480+x)*4+c]=v;}expect(detect(s).status).toBe('uncertain');});
  it('registers a moving clothes mask and retains measured coordinates', () => {const a=detect(clothingScene([25,25,25],[245,245,245]));const b={...a,torso:a.torso.map(p=>({x:p.x+20,y:p.y+15})),boxes:a.boxes.map(b=>({...b,x:b.x+20,y:b.y+15}))};expect(stableBoxes(a,[a,b]).boxes[0].support).toBe(2);});
});

it('preserves a sticker even when the segmenter calls its enclosed pixels background', () => {
  const s=clothingScene([25,25,25],[245,245,245]);for(let y=300;y<316;y++)for(let x=210;x<224;x++){s.observation.clothes.data[y*480+x]=0;s.observation.mask.data[y*480+x]=0;}
  s.torso=estimateTorso(s.observation,480,640);expect(detect(s).boxes).toHaveLength(1);
});
