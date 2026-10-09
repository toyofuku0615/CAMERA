import { describe, expect, it } from 'vitest';
import { LIVE, LIVE_GUIDE } from '../src/config';
import { LiveDetector } from '../src/vision/live-detector';
import { LiveTracker } from '../src/vision/live-tracker';
import type { Box, Pixels } from '../src/vision/detector';
function image(stickers: { x: number; y: number; w?: number; h?: number; value?: number; color?: number[] }[] = [], scale = 1, background = 225, fabric = 25): Pixels {
  const width = Math.round(320 * scale), height = Math.round(426 * scale), data = new Uint8ClampedArray(width * height * 4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const px=x/scale,py=y/scale,cloth=px>=100&&px<220&&py>=110&&py<340;
    const sticker=stickers.find(b=>px>=b.x&&px<b.x+(b.w??10)&&py>=b.y&&py<b.y+(b.h??11));
    const color=sticker?.color??[sticker ? (sticker.value??245) : (cloth?fabric:background)];
    const p=(y*width+x)*4;for(let c=0;c<3;c++)data[p+c]=color[c]??color[0];data[p+3]=255;
  }
  return {width,height,data};
}
const detector = new LiveDetector();
describe('fast live black fabric / white sticker detection', () => {
  it('detects calculated coordinates on the first frame', () => {const r=detector.analyze(image([{x:140,y:200}]));expect(r.status).toBe('ready');expect(r.boxes).toMatchObject([{x:140,y:200,width:10,height:11,area:110}]);});
  it.each([225,25])('rejects clean cloth with background brightness %s', background=>{expect(detector.analyze(image([],1,background)).boxes).toHaveLength(0);});
  it('separates two stickers and follows relocation and removal without persistence',()=>{expect(detector.analyze(image([{x:120,y:170},{x:190,y:270}])).boxes).toHaveLength(2);expect(detector.analyze(image([{x:170,y:250}])).boxes[0].x).toBe(170);expect(detector.analyze(image()).boxes).toHaveLength(0);});
  it.each([.5,1,2])('preserves pixel coordinates at scale %s',scale=>{const b=detector.analyze(image([{x:140,y:200}],scale)).boxes[0];expect(b.x).toBe(140*scale);expect(b.y).toBe(200*scale);expect(b.width).toBe(10*scale);});
  it('uses local contrast for a dim white sticker',()=>{expect(detector.analyze(image([{x:140,y:200,value:150}])).boxes).toHaveLength(1);});
  it('excludes bright skin/white wall connected to a guide edge',()=>{const r=detector.analyze(image([{x:70,y:190,w:55,h:24}]),LIVE,LIVE_GUIDE,true);expect(r.boxes).toHaveLength(0);expect(r.candidates.some(c=>c.reason.includes('背景・境界'))).toBe(true);});
  it('requires a complete dark ring, even for a disconnected background highlight',()=>{const r=detector.analyze(image([{x:88,y:230,w:8,h:8}],1,110),LIVE,LIVE_GUIDE,true);expect(r.boxes).toHaveLength(0);expect(r.candidates.some(c=>c.reason.includes('周囲が黒い'))).toBe(true);});
  it('rejects colored dots when only neutral white is requested',()=>{expect(detector.analyze(image([{x:140,y:200,color:[255,150,30]}])).boxes).toHaveLength(0);});
  it('rejects tiny noise and large white garment areas with diagnostic reasons',()=>{const tiny=detector.analyze(image([{x:140,y:200,w:1,h:1}]),LIVE,LIVE_GUIDE,true);expect(tiny.boxes).toHaveLength(0);expect(tiny.candidates.some(c=>c.reason==='最小面積未満')).toBe(true);const large=detector.analyze(image([{x:110,y:150,w:90,h:60}]),LIVE,LIVE_GUIDE,true);expect(large.boxes).toHaveLength(0);expect(large.candidates.some(c=>c.reason==='最大面積超過')).toBe(true);});
  it('does not present an invalid or light garment as a recognized black garment',()=>{const r=detector.analyze(image([],1,225,130));expect(r.status).toBe('needs-position');expect(r.reason).toContain('黒い服');expect(detector.analyze({width:0,height:0,data:new Uint8ClampedArray()}).status).toBe('needs-position');});
  it('can tighten contrast independently of the white threshold',()=>{expect(detector.analyze(image([{x:140,y:200,value:150}]),{...LIVE,contrastThreshold:200}).boxes).toHaveLength(0);});
  it('does not leak old buffers after resize or disposal',()=>{detector.analyze(image([{x:140,y:200}]));detector.dispose();expect(detector.analyze(image([], .5)).boxes).toHaveLength(0);});
});
const box=(x=140):Box=>({x,y:200,width:10,height:11,area:110});
describe('immediate live feedback with nonpersistent temporal confidence',()=>{
  it('shows a first-frame candidate and confirms it on the second',()=>{const t=new LiveTracker();expect(t.update([box()],0)[0].confidence).toBe('single-frame');expect(t.update([box(143)],100)[0]).toMatchObject({x:143,confidence:'confirmed',support:2});});
  it('clears a removed sticker immediately and resets its confidence',()=>{const t=new LiveTracker();t.update([box()],0);t.update([box()],100);expect(t.update([],200)).toHaveLength(0);expect(t.update([box()],300)[0].confidence).toBe('single-frame');});
  it('never shows a predicted box on a different current location',()=>{const t=new LiveTracker();t.update([box()],0);expect(t.update([box(190)],100)[0]).toMatchObject({x:190,confidence:'single-frame'});});
  it('does not match two current candidates to one previous candidate',()=>{const t=new LiveTracker();t.update([box()],0);const r=t.update([box(141),box(143)],100);expect(r.filter(b=>b.confidence==='confirmed')).toHaveLength(1);});
  it('does not confirm after a stalled stream or explicit clear',()=>{const t=new LiveTracker();t.update([box()],0);expect(t.update([box()],LIVE.staleAfterMs+1)[0].confidence).toBe('single-frame');t.clear();expect(t.update([box()],1000)[0].confidence).toBe('single-frame');});
});
