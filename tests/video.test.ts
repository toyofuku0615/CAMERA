import { describe, expect, it } from 'vitest';
import { VideoTracker, type Observation } from '../src/vision/frames';
import type { Box } from '../src/vision/detector';
const box: Box = { x: 210, y: 300, width: 14, height: 16, area: 224 };
function frame(timestamp: number, facing: Observation['facing'] = 'front', boxes: Box[] = [], sharpness = 10): Observation {
  return { timestamp, facing, complete: true, width: 480, height: 640,
    analysis: { status: 'ok', boxes, region: { x: 150, y: 165, width: 180, height: 345, area: 62100 },
      clothBounds: { x: 150, y: 165, width: 180, height: 345, area: 62100 }, sharpness, darkCoverage: .8 } };
}
function coverage(tracker: VideoTracker) {
  for (const facing of ['front', 'back'] as const) for (const timestamp of [0, .5, 1])
    tracker.observe(frame(timestamp + (facing === 'back' ? 10 : 0), facing), () => 'unused');
}
describe('continuous-video evidence and screenshot association', () => {
  it('requires front and back, never profile shots, with actual temporal coverage', () => {
    const tracker = new VideoTracker(); coverage(tracker);
    expect(tracker.report()).toMatchObject({ complete: true, findings: [], framesAnalyzed: 6 });
  });
  it('does not infer back from duration, profiles, unknowns, or missing full-body frames', () => {
    for (const facing of ['front', 'profile', 'unknown'] as const) {
      const tracker = new VideoTracker();
      for (let t=0;t<18;t+=.5) tracker.observe(frame(t, facing), () => 'unused');
      expect(tracker.report().complete).toBe(false);
    }
    const tracker = new VideoTracker();
    for (const t of [0,.5,1]) { const f=frame(t,'back'); f.complete=false; tracker.observe(f,()=> 'unused'); }
    expect(tracker.report().complete).toBe(false);
  });
  it('rejects repeated timestamps and coverage lasting less than one second', () => {
    const tracker = new VideoTracker();
    for (let i=0;i<4;i++) tracker.observe(frame(0,'front'),()=> 'unused');
    for (const t of [10,10.1,10.2]) tracker.observe(frame(t,'back'),()=> 'unused');
    expect(tracker.report().complete).toBe(false);
  });
  it('keeps a brief two-frame candidate, even if most movie frames are clean', () => {
    const tracker = new VideoTracker(); coverage(tracker);
    tracker.observe(frame(2,'front',[box]),()=> 'actual-frame-2');
    tracker.observe(frame(2.5,'front',[box],20),()=> 'actual-frame-2.5');
    for (let t=3;t<9;t+=.5) tracker.observe(frame(t),()=> 'unused');
    expect(tracker.report().findings).toEqual([{ image:'actual-frame-2.5', box, direction:'front',timestamp:2.5,width:480,height:640 }]);
  });
  it('deduplicates movement with clothing-relative coordinates and keeps exact sharpest-frame pixels', () => {
    const tracker = new VideoTracker();
    tracker.observe(frame(0,'front',[box]),()=> 'first');
    const moved=frame(.5,'front',[{...box,x:250,y:330}],30);
    moved.analysis.clothBounds={...moved.analysis.clothBounds!,x:190,y:195};
    tracker.observe(moved,()=> 'moved-frame');
    expect(tracker.report().findings).toHaveLength(1);
    expect(tracker.report().findings[0]).toMatchObject({ image:'moved-frame',box:{x:250,y:330},timestamp:.5 });
  });
  it('does not merge two candidates or candidates on opposite body surfaces', () => {
    const tracker = new VideoTracker(), second={...box,x:270,y:400};
    for (const t of [0,.5])tracker.observe(frame(t,'front',[box,second]),()=> 'front');
    for (const t of [10,10.5])tracker.observe(frame(t,'back',[box]),()=> 'back');
    expect(tracker.report().findings).toHaveLength(3);
  });
  it('reports real candidates even when framing is incomplete, but never marks coverage complete', () => {
    const tracker=new VideoTracker();
    for (const t of [0,.5]) { const f=frame(t,'unknown',[box]);f.complete=false;f.analysis.status='uncertain';tracker.observe(f,()=> 'partial-body'); }
    expect(tracker.report()).toMatchObject({complete:false,reason:'全身が映る位置で、もう一度'});
    expect(tracker.report().findings).toHaveLength(1);
  });
  it('does not certify a single-frame flash or unassessed bright boundary', () => {
    const tracker=new VideoTracker();coverage(tracker);
    tracker.observe(frame(2,'front',[box]),()=> 'flash');
    expect(tracker.report()).toMatchObject({complete:false,findings:[]});
    const edge=new VideoTracker();coverage(edge);
    const f=frame(3);f.analysis.status='uncertain';f.analysis.reason='服の端や明るい箇所を確認できませんでした';edge.observe(f,()=> 'unused');
    expect(edge.report().complete).toBe(false);
  });
  it('detects and deduplicates candidates while turning without requiring a side direction', () => {
    const tracker=new VideoTracker();coverage(tracker);
    for (const t of [5,5.5,6])tracker.observe(frame(t,'profile',[box]),()=> 'turning-frame');
    expect(tracker.report().findings).toHaveLength(1);
    expect(tracker.report().findings[0].direction).toBe('unknown');
  });
});
