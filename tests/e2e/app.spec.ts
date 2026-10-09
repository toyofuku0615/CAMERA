import { expect, test, type Page } from '@playwright/test';
// Only the garment segmentation service is replaced in synthetic workflow tests. Camera pixels,
// detection, fusion, drawing and all UI transitions remain production code.
async function syntheticPose(page: Page) {
  await page.route('**/src/vision/model.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    export class ModelLoadError extends Error {}
    export async function loadPersonModel() { return {}; }
    export function disposePersonModel() {}
    export async function inferPerson(canvas) {
      const width=canvas.width,height=canvas.height,data=new Float32Array(width*height);
      const pixels=canvas.getContext('2d').getImageData(0,0,width,height).data;
      let dark=0; for(let i=0;i<pixels.length;i+=4) if(pixels[i]<85) dark++;
      if(!dark) return null;
      for(let y=0;y<height;y++) for(let x=0;x<width;x++) if(x/width>=150/480 && x/width<330/480 && y/height>=165/640 && y/height<510/640) data[y*width+x]=.99;
      return {mask:{width,height,data},clothes:{width,height,data},skin:{width,height,data:new Float32Array(width*height)}};
    }
  ` }));
}
// Synthetic live video source. The app still reads video pixels, captures bursts,
// runs the production detector, and draws calculated boxes; no results are stubbed.
async function syntheticCamera(page: Page) {
  await syntheticPose(page);
  await page.addInitScript(() => {
    const state = window as typeof window & { testSticker: boolean; testInvalid: boolean; testStreams: MediaStream[] };
    state.testSticker = true; state.testInvalid = false; state.testStreams = [];
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const c = document.createElement('canvas'); c.width = 480; c.height = 640;
      const ctx = c.getContext('2d')!;
      const draw = () => {
        ctx.fillStyle = '#e2e2e2'; ctx.fillRect(0, 0, 480, 640);
        if (state.testInvalid) return;
        ctx.fillStyle = '#181a18'; ctx.fillRect(150, 165, 180, 345);
        ctx.fillStyle = '#222822'; for(let y=165;y<510;y+=3) ctx.fillRect(150,y,180,1);
        if (state.testSticker) { ctx.fillStyle = '#fafafa'; ctx.fillRect(210, 300, 14, 16); }
      };
      draw(); const interval = setInterval(draw, 50); const stream = c.captureStream(20);
      stream.getTracks()[0].addEventListener('ended', () => clearInterval(interval)); state.testStreams.push(stream); return stream;
    } });
  });
}
test('four-direction capture detects real synthetic pixels, then removal changes results', async ({ page }) => {
  await syntheticCamera(page); await page.goto('/');
  await expect(page.getByRole('heading', { name: /服装を.*チェック/  })).toBeVisible();
  await page.getByRole('button', { name: 'チェックを開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '撮影を開始', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: /音声案内/ }).click();
  await page.getByRole('button', { name: '撮影を開始', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'チェック結果' })).toBeVisible({ timeout: 40000 });
  await expect(page.getByText('確認が必要な箇所が4件あります')).toBeVisible();
  await expect(page.locator('.detection-box')).toHaveCount(1);
  const firstX = Number(await page.locator('.detection-box').getAttribute('x'));
  expect(firstX).toBe(252); // 480 - 210 - 14 - four-pixel drawing padding.
  for (const label of ['正面', '側面①', '背面', '側面②']) { await page.getByRole('tab', { name: label, exact: true }).click(); await expect(page.locator('.detection-box')).toHaveCount(1); }
  await expect(page.getByRole('button', { name: '未確認の方向だけ撮り直す' })).toHaveCount(0);
  await page.getByRole('button', { name: '撮影画像を拡大' }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button', { name: '拡大を閉じる' }).click();
  expect(await page.evaluate(() => (window as unknown as { testStreams: MediaStream[] }).testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  await page.screenshot({ path: 'test-results/result-mobile.png', fullPage: true });
  await page.evaluate(() => { (window as unknown as { testSticker: boolean }).testSticker = false; });
  await page.getByRole('button', { name: 'もう一度チェック' }).click();
  await expect(page.locator('.detection-box')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '撮影を開始', exact: true })).toBeEnabled(); await page.getByRole('button', { name: '撮影を開始', exact: true }).click();
  await expect(page.getByText('確認できた範囲では、目立つ付着物は検出されませんでした')).toBeVisible({ timeout: 40000 });
  await expect(page.locator('.detection-box')).toHaveCount(0);
  await page.getByRole('button', { name: '終了して画像を破棄' }).click();
  await expect(page.getByRole('button', { name: 'チェックを開始', exact: true })).toBeVisible(); await expect(page.locator('.annotated')).toHaveCount(0);
});
test('denied permission gives a retry action, not a clear result', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('denied', 'NotAllowedError'); } }));
  await page.goto('/'); await page.getByRole('button', { name: 'チェックを開始', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('カメラを使用できません。Safariの設定をご確認ください。');
  await expect(page.getByRole('button', { name: 'カメラを再起動', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'チェック結果' })).toHaveCount(0);
});
test('cancellation stops the camera and never advances to results', async ({ page }) => {
  await syntheticCamera(page); await page.goto('/'); await page.getByRole('button', { name: 'チェックを開始', exact: true }).click();
  await page.getByRole('button', { name: '撮影を開始', exact: true }).click(); await expect(page.getByRole('timer')).toBeVisible();
  await page.getByRole('button', { name: '撮影を中止' }).click();
  await expect(page.getByRole('alert')).toContainText('撮影を中止しました');
  expect(await page.evaluate(() => (window as unknown as { testStreams: MediaStream[] }).testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  await expect(page.getByRole('heading', { name: 'チェック結果' })).toHaveCount(0);
});
test('an unrecognizable torso stays uncertain and supports retry', async ({ page }) => {
  await syntheticCamera(page); await page.goto('/'); await page.evaluate(() => { (window as unknown as { testInvalid: boolean }).testInvalid = true; });
  await page.getByRole('button', { name: 'チェックを開始', exact: true }).click(); await page.getByRole('button', { name: '撮影を開始', exact: true }).click();
  await expect(page.getByText('一部の範囲を十分に確認できませんでした', { exact: true })).toBeVisible({ timeout: 40000 });
  await expect(page.getByText('確認できた範囲では、目立つ付着物は検出されませんでした')).toHaveCount(0);
  await page.getByRole('button', { name: '未確認の方向だけ撮り直す' }).click();
  await expect(page.getByRole('button', { name: '選択した方向を撮影' })).toBeEnabled();
});
test('dev tool uploads pixels and recomputes thresholds', async ({ page }) => {
  await syntheticPose(page); await page.goto('/dev');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 640; const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 480, 640); ctx.fillStyle = '#222'; ctx.fillRect(150, 165, 180, 345); ctx.fillStyle = '#eee'; ctx.fillRect(210, 300, 14, 16); return c.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-shirt.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('p[role=status]')).toHaveText('候補 1件'); await expect(page.locator('.debug-region')).toBeVisible();
  await page.getByRole('slider', { name: /周囲との明暗差/ }).press('End'); await expect(page.locator('p[role=status]')).toHaveText('候補 0件');
});
test('home fits mobile and desktop without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/home-${width}.png`, fullPage: true });
  }
});

test('native getUserMedia works with Chromium synthetic camera device', async ({ playwright }, testInfo) => {
  const { writeFile } = await import('node:fs/promises');
  const w = 480, h = 640, luminance = Buffer.alloc(w * h, 225), chroma = Buffer.alloc(w * h / 2, 128);
  for (let y = 165; y < 510; y++) for (let x = 150; x < 330; x++) luminance[y * w + x] = 30;
  for (let y = 300; y < 316; y++) for (let x = 210; x < 224; x++) luminance[y * w + x] = 235;
  const file = testInfo.outputPath('synthetic-camera.y4m');
  await writeFile(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), luminance, chroma]));
  const browser = await playwright.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${file}`] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); await page.goto('http://127.0.0.1:5173');
    await page.getByRole('button', { name: 'チェックを開始', exact: true }).click();
    await expect(page.getByRole('button', { name: '撮影を開始', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: /音声案内/ }).click(); await page.getByRole('button', { name: '撮影を開始', exact: true }).click();
    await expect(page.getByText('一部の範囲を十分に確認できませんでした', { exact: true })).toBeVisible({ timeout: 40000 });
    await expect(page.locator('.detection-box')).toHaveCount(0);
  } finally { await browser.close(); }
});

test('model loading failure is explicit and blocks capture until retry succeeds', async ({ page }) => {
  // Camera is synthetic, while this test exercises the real model loader.
  await syntheticCamera(page); await page.unroute('**/src/vision/model.ts*');
  await page.route('**/vision/manifest.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('/'); await page.getByRole('button', { name: 'チェックを開始', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('服認識モデルを読み込めませんでした');
  await expect(page.getByRole('button', { name: '服認識モデルを準備しています' })).toBeDisabled();
  await page.unroute('**/vision/manifest.json'); await page.getByRole('button', { name: '服認識モデルを再試行' }).click();
  await expect(page.getByRole('button', { name: '撮影を開始', exact: true })).toBeEnabled({ timeout: 60000 });
});

test('real person photograph uses real clothes segmentation; photocomposite backgrounds keep sticker coordinates', async ({ page }) => {
  await page.goto('/dev');
  const { readFile, mkdir, writeFile } = await import('node:fs/promises');
  const original = (await readFile('private-fixtures/reference-pose.jpg')).toString('base64');
  const report = await page.evaluate(async encoded => {
    // @ts-expect-error Browser dynamically imports the actual Vite source module.
    const { inferPerson } = await import('/src/vision/model.ts');
    // @ts-expect-error Browser dynamically imports the actual Vite source module.
    const { analyzeCanvas, resizeForAnalysis, maskOverlay, analyzeWithObservation } = await import('/src/vision/frames.ts');
    const image = new Image(); image.src = `data:image/jpeg;base64,${encoded}`; await image.decode();
    const full=document.createElement('canvas'); full.width=image.width; full.height=image.height; full.getContext('2d')!.drawImage(image,0,0);
    const sourceObservation=await inferPerson(resizeForAnalysis(full));
    if(!sourceObservation || !sourceObservation.clothes) throw new Error('Real reference person was not recognized');
    const originalAnalysis=await analyzeCanvas(full);
    const outcomes=[];
    for(const background of ['original','white','black','furniture','pattern','window']) for(const stickers of [0,1,2]) {
      const composed=document.createElement('canvas');composed.width=full.width;composed.height=full.height;const ctx=composed.getContext('2d')!;
      ctx.drawImage(full,0,0);const pixels=ctx.getImageData(0,0,composed.width,composed.height), mask=sourceObservation.mask;
      if(background!=='original') for(let y=0;y<composed.height;y++) for(let x=0;x<composed.width;x++) {
        const confidence=mask.data[Math.min(mask.height-1,Math.floor(y*mask.height/composed.height))*mask.width+Math.min(mask.width-1,Math.floor(x*mask.width/composed.width))];
        if(confidence>.5) continue;
        const color=background==='white'?220:background==='black'?24:background==='window'?Math.min(255,50+x*.2):background==='furniture'?(Math.floor(y/70)%2?45:150):(Math.floor(x/30)+Math.floor(y/30))%2?240:30;
        const i=(y*composed.width+x)*4;pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=color;
      }
      ctx.putImageData(pixels,0,0);
      const c=document.createElement('canvas');c.width=480;c.height=494;const crop=c.getContext('2d')!;crop.drawImage(composed,330,195,340,350,0,0,480,494);
      const boxes=[{x:235,y:270,width:10,height:10},{x:230,y:340,width:10,height:10}];
      crop.fillStyle='#fafafa';for(let n=0;n<stickers;n++){const b=boxes[n];crop.fillRect(b.x,b.y,b.width,b.height);}
      const start=performance.now(),analysis=await analyzeCanvas(c);
      outcomes.push({background,stickers,status:analysis.status,reason:analysis.reason,count:analysis.boxes.length,roiSource:analysis.roiSource,maskCoverage:analysis.maskCoverage,boxes:analysis.boxes,elapsedMs:performance.now()-start});
    }
    return {kind:'real photograph with digitally composited backgrounds and stickers, not physical acceptance trials', knownExistingObject:'white necklace/pendant visible on original shirt; thin low-fill components excluded by compact attachment filter',original:{status:originalAnalysis.status,roiSource:originalAnalysis.roiSource,maskCoverage:originalAnalysis.maskCoverage,boxes:originalAnalysis.boxes},outcomes};
  }, original);
  await mkdir('validation-results',{recursive:true});await writeFile('validation-results/reference-person.json',JSON.stringify(report,null,2));
  expect(report.original.roiSource).toBe('clothes');expect(report.original.maskCoverage).toBeGreaterThan(.3);
  for (const outcome of report.outcomes) {
    expect(outcome.status, `${outcome.background} / ${outcome.stickers}: ${outcome.reason}`).toBe('ok');
    expect(outcome.count, `${outcome.background} / ${outcome.stickers}; compact patches only`).toBe(outcome.stickers);
    if(outcome.stickers >= 1) expect(outcome.boxes.some((b: { x: number; y: number }) => Math.abs(b.x - 235) < 2 && Math.abs(b.y - 270) < 2)).toBe(true);
    if(outcome.stickers >= 2) expect(outcome.boxes.some((b: { x: number; y: number }) => Math.abs(b.x - 230) < 2 && Math.abs(b.y - 340) < 2)).toBe(true);
  }
});

test('single-frame and secondary-frame candidates keep actual image coordinates', async ({ page }) => {
  await syntheticPose(page); await page.goto('/dev');
  const fusion = await page.evaluate(async () => {
    // @ts-expect-error Runtime module served by the development server.
    const { processShot } = await import('/src/vision/frames.ts');
    const canvas = (x?: number, y = 300) => {
      const c=document.createElement('canvas');c.width=480;c.height=640;const ctx=c.getContext('2d')!;
      ctx.fillStyle='#ddd';ctx.fillRect(0,0,480,640);ctx.fillStyle='#181a18';ctx.fillRect(150,165,180,345);
      ctx.fillStyle='#222822';for(let row=165;row<510;row+=3)ctx.fillRect(150,row,180,1);
      if(x!==undefined){ctx.fillStyle='#fafafa';ctx.fillRect(x,y,14,16);}return c;
    };
    const one=await processShot({direction:'back',frames:[canvas(210),canvas()]},{diagnostics:true});
    const separate=await processShot({direction:'back',frames:[canvas(180,250),canvas(270,400)]},{diagnostics:true});
    return {one,separate};
  });
  expect(fusion.one.analysis.boxes).toHaveLength(1);expect(fusion.one.analysis.boxes[0].confidence).toBe('single-frame');
  expect(fusion.one.analysis.boxes[0].x).toBe(210);expect(fusion.one.analysis.warnings).not.toHaveLength(0);
  expect(fusion.separate.additionalViews).toHaveLength(1);
  const coordinates = [fusion.separate.analysis.boxes[0].x, fusion.separate.additionalViews![0].analysis.boxes[0].x].sort((a,b)=>a-b);
  expect(coordinates).toEqual([180,270]); expect(fusion.separate.image).not.toBe(fusion.separate.additionalViews![0].image);
});

test('real garment segmentation survives recolored plain clothing and light/dark/colored patches', async ({ page }) => {
  await page.goto('/dev');
  const { readFile, mkdir, writeFile } = await import('node:fs/promises');
  const report = await page.evaluate(async encoded => {
    // @ts-expect-error Actual Vite module loaded in browser.
    const { inferPerson } = await import('/src/vision/model.ts');
    // @ts-expect-error Actual Vite module loaded in browser.
    const { resizeForAnalysis, analyzeCanvas } = await import('/src/vision/frames.ts');
    const image=new Image();image.src='data:image/jpeg;base64,'+encoded;await image.decode();
    const original=document.createElement('canvas');original.width=480;original.height=494;original.getContext('2d')!.drawImage(image,330,195,340,350,0,0,480,494);
    const source=await inferPerson(resizeForAnalysis(original));if(!source)throw new Error('No reference garment');
    const outcomes=[];
    for(const variant of [{name:'white / black',fabric:[230,230,230],item:'#222'}, {name:'gray / red',fabric:[130,130,130],item:'#ed373c'}, {name:'navy / white',fabric:[25,35,80],item:'#fafafa'}])for(const attached of [false,true]) {
      const c=document.createElement('canvas');c.width=480;c.height=494;const ctx=c.getContext('2d')!;ctx.drawImage(original,0,0);
      const pixels=ctx.getImageData(0,0,480,494),m=source.clothes;
      for(let y=0;y<494;y++)for(let x=0;x<480;x++){
        const confidence=m.data[Math.min(m.height-1,Math.floor(y*m.height/494))*m.width+Math.min(m.width-1,Math.floor(x*m.width/480))];
        if(confidence<.65)continue;
        const p=(y*480+x)*4,lum=pixels.data[p]*.2126+pixels.data[p+1]*.7152+pixels.data[p+2]*.0722;
        for(let channel=0;channel<3;channel++)pixels.data[p+channel]=Math.max(0,Math.min(255,variant.fabric[channel]+(lum-70)*.18));
      }
      ctx.putImageData(pixels,0,0);if(attached){ctx.fillStyle=variant.item;ctx.fillRect(235,270,10,10);}
      const start=performance.now(),analysis=await analyzeCanvas(c);
      outcomes.push({variant:variant.name,attached,status:analysis.status,reason:analysis.reason,roiSource:analysis.roiSource,boxes:analysis.boxes,elapsedMs:performance.now()-start});
    }
    return {kind:'one real photograph with digitally recolored garments and composited patches; not physical accuracy',outcomes};
  },(await readFile('private-fixtures/reference-pose.jpg')).toString('base64'));
  await mkdir('validation-results',{recursive:true});await writeFile('validation-results/plain-clothing-reference.json',JSON.stringify(report,null,2));
  for(const result of report.outcomes){
    expect(result.roiSource,result.variant).toBe('clothes');expect(result.status,`${result.variant}: ${result.reason}`).toBe('ok');
    expect(result.boxes.length,`${result.variant} / ${result.attached}`).toBe(result.attached?1:0);
    if(result.attached)expect(result.boxes[0]).toMatchObject({x:235,y:270,width:10,height:10});
  }
});
