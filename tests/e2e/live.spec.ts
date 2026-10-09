import { expect, test, type Page } from '@playwright/test';
async function videoPixels(page: Page, fallback = false) {
  await page.addInitScript(({fallback}) => {
    type State = { x: number; attached: boolean; streams: MediaStream[] };
    const state: State = { x:210, attached:true, streams:[] };
    (window as unknown as {liveTest:State}).liveTest=state;
    if(fallback)Object.defineProperty(HTMLVideoElement.prototype,'requestVideoFrameCallback',{value:undefined,configurable:true});
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
      const c=document.createElement('canvas');c.width=480;c.height=640;const ctx=c.getContext('2d')!;
      const draw=()=>{ctx.fillStyle='#e2e2e2';ctx.fillRect(0,0,480,640);ctx.fillStyle='#191919';ctx.fillRect(150,165,180,345);if(state.attached){ctx.fillStyle='#fafafa';ctx.fillRect(state.x,300,14,16);}};
      draw();const interval=setInterval(draw,33),stream=c.captureStream(30),track=stream.getVideoTracks()[0],stop=track.stop.bind(track);
      track.stop=()=>{clearInterval(interval);stop();};state.streams.push(stream);return stream;
    }});
  },{fallback});
}
const boxes=(page:Page)=>page.locator('.live-detection');
const allStopped=(page:Page)=>page.evaluate(()=>(window as unknown as {liveTest:{streams:MediaStream[]}}).liveTest.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));

test('live video finds, moves and removes a sticker without model requests or four-direction capture',async({page})=>{
  await videoPixels(page);const models:string[]=[];page.on('request',r=>{if(/\.(wasm|tflite|task)(\?|$)|\/vision\/manifest/.test(r.url()))models.push(r.url());});
  await page.goto('/?debug=1');const start=Date.now();await page.getByRole('button',{name:'チェックを開始',exact:true}).click();
  await expect(boxes(page)).toHaveCount(1,{timeout:5000});const firstMs=Date.now()-start;
  await expect(page.locator('.live-detection.provisional')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('白いシールの候補が1件あります');
  const width=Number((await page.locator('.live-overlay').getAttribute('viewBox'))!.split(' ')[2]);
  const originalX=(Number(await boxes(page).getAttribute('x'))+2)*480/width;
  expect(Math.abs(originalX-256)).toBeLessThanOrEqual(2);
  expect(firstMs).toBeLessThan(2500);
  await expect(page.getByRole('timer')).toHaveCount(0);
  const before=Number(await boxes(page).getAttribute('x'));
  await page.evaluate(()=>{(window as unknown as {liveTest:{x:number}}).liveTest.x=270;});
  await expect.poll(async()=>Number(await boxes(page).getAttribute('x'))).toBeLessThan(before-30);
  await page.evaluate(()=>{(window as unknown as {liveTest:{attached:boolean}}).liveTest.attached=false;});
  await expect(boxes(page)).toHaveCount(0,{timeout:1000});
  await expect(page.getByRole('status')).toContainText('白いシールの候補を探しています');
  expect(models).toEqual([]);
  await page.screenshot({path:'test-results/live-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'終了して映像を破棄'}).click();expect(await allStopped(page)).toBe(true);
  await expect(page.getByRole('button',{name:'チェックを開始',exact:true})).toBeVisible();
  const {mkdir,writeFile}=await import('node:fs/promises');await mkdir('validation-results',{recursive:true});await writeFile('validation-results/live-camera.json',JSON.stringify({kind:'Chromium synthetic video, not physical iPhone accuracy',firstCandidateMs:firstMs,mirroredPixelX:originalX,modelRequests:models.length},null,2));
});

test('freeze keeps the measured frame, releases camera, then resume clears removed sticker',async({page})=>{
  await videoPixels(page);await page.goto('/');await page.getByRole('button',{name:'チェックを開始',exact:true}).click();await expect(boxes(page)).toHaveCount(1);
  await page.getByRole('button',{name:'画面を止めて確認'}).click();await expect(page.getByText('PAUSED',{exact:true})).toBeVisible();expect(await allStopped(page)).toBe(true);
  const frozen=await page.locator('.live-frozen').getAttribute('src');expect(frozen).toMatch(/^data:image\/jpeg/);
  await page.evaluate(()=>{(window as unknown as {liveTest:{attached:boolean}}).liveTest.attached=false;});
  await expect(boxes(page)).toHaveCount(1);
  await page.getByRole('button',{name:'ライブ映像に戻る'}).click();await expect(page.getByText('LIVE',{exact:true})).toBeVisible();await expect(boxes(page)).toHaveCount(0);
  await expect(page.locator('.live-frozen')).toHaveCount(0);await page.getByRole('button',{name:'チェックを終了'}).click();expect(await allStopped(page)).toBe(true);
});

test('Safari-compatible frame callback fallback clears stale boxes and releases backgrounded camera',async({page})=>{
  await videoPixels(page,true);await page.goto('/');await page.getByRole('button',{name:'チェックを開始',exact:true}).click();await expect(boxes(page)).toHaveCount(1);
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.pause());
  await expect(page.getByRole('status')).toContainText('映像の更新を待っています',{timeout:2000});await expect(boxes(page)).toHaveCount(0);
  await page.locator('video').evaluate((v:HTMLVideoElement)=>v.play());await expect(boxes(page)).toHaveCount(1);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{get:()=>true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
  expect(await allStopped(page)).toBe(true);await expect(boxes(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'カメラを再起動',exact:true})).toBeVisible();
});

test('live permission errors provide retry and never show stale detections',async({page})=>{
  await page.addInitScript(()=>Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{throw new DOMException('denied','NotAllowedError');}}));
  await page.goto('/');await page.getByRole('button',{name:'チェックを開始',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Safariの設定');await expect(boxes(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'カメラを再起動',exact:true})).toBeVisible();
});

test('live detector performance and real photograph patch positions are measured with production pixels',async({page})=>{
  await page.goto('/');const {readFile,mkdir,writeFile}=await import('node:fs/promises');
  const report=await page.evaluate(async encoded=>{
    // @ts-expect-error Actual Vite module imported in browser.
    const {LiveDetector}=await import('/src/vision/live-detector.ts');
    const c=document.createElement('canvas');c.width=320;c.height=426;const ctx=c.getContext('2d')!;
    ctx.fillStyle='#ddd';ctx.fillRect(0,0,320,426);ctx.fillStyle='#191919';ctx.fillRect(100,110,120,230);ctx.fillStyle='#fafafa';ctx.fillRect(140,200,10,11);
    const pixels=ctx.getImageData(0,0,320,426),d=new LiveDetector(),times=[];
    for(let i=0;i<20;i++)d.analyze(pixels);
    for(let i=0;i<200;i++){const t=performance.now();const r=d.analyze(pixels);if(r.boxes.length!==1)throw new Error('Missing benchmark sticker');times.push(performance.now()-t);}
    times.sort((a,b)=>a-b);
    const photo=new Image();photo.src='data:image/jpeg;base64,'+encoded;await photo.decode();
    const outcomes=[];
    for(const count of [0,1,2]){
      ctx.drawImage(photo,330,195,340,350,0,0,320,426);
      const expected=[{x:157,y:233,width:8,height:8},{x:153,y:292,width:8,height:8}];ctx.fillStyle='#fafafa';for(let i=0;i<count;i++){const b=expected[i];ctx.fillRect(b.x,b.y,b.width,b.height);}
      const r=d.analyze(ctx.getImageData(0,0,320,426),undefined,undefined,true);
      outcomes.push({patches:count,boxes:r.boxes,darkCoverage:r.darkCoverage,candidates:r.candidates});
    }
    return {kind:'browser pixel benchmark and one real photo with digital white patches; not iPhone accuracy',iterations:times.length,medianMs:times[100],p95Ms:times[190],maxMs:times[199],outcomes};
  },(await readFile('private-fixtures/reference-pose.jpg')).toString('base64'));
  await mkdir('validation-results',{recursive:true});await writeFile('validation-results/live-performance.json',JSON.stringify(report,null,2));
  expect(report.p95Ms).toBeLessThan(100);
  for(const r of report.outcomes){if(r.patches>=1)expect(r.boxes.some((b:{x:number;y:number})=>Math.abs(b.x-157)<=1&&Math.abs(b.y-233)<=1)).toBe(true);if(r.patches>=2)expect(r.boxes.some((b:{x:number;y:number})=>Math.abs(b.x-153)<=1&&Math.abs(b.y-292)<=1)).toBe(true);}
});
