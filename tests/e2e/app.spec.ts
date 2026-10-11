import { expect, test, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

// Synthetic LIVE pixels are encoded by the REAL MediaRecorder, decoded from
// the resulting video Blob, then inspected, deduplicated and drawn as JPEG/SVG. Only model
// evidence is mocked in the UI scenarios; the real models are tested separately.
async function syntheticCamera(page: Page, marked: boolean | 'brief' = true) {
  await page.addInitScript((marked) => {
    const state = window as typeof window & { testSticker: boolean | 'brief'; testInvalid: boolean; testWrongFacing: boolean; testModelFails: boolean; testStreams: MediaStream[] };
    state.testSticker = marked; state.testInvalid = false; state.testWrongFacing = false; state.testModelFails = false; state.testStreams = [];
    const Recorder = window.MediaRecorder;
    const observed = window as typeof window & { testRecorders: MediaRecorder[]; testBlobUrls: string[]; testRevokedUrls: string[]; testDropRecordingData: boolean };
    observed.testRecorders = []; observed.testBlobUrls = []; observed.testRevokedUrls = [];
    window.MediaRecorder = class extends Recorder {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) { super(stream, options); observed.testRecorders.push(this); if(observed.testDropRecordingData)this.addEventListener('dataavailable', e=>e.stopImmediatePropagation()); }
    };
    const originalCreate = URL.createObjectURL.bind(URL), originalRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = originalCreate(blob); if(blob instanceof Blob && blob.type.startsWith('video/')) observed.testBlobUrls.push(url); return url; };
    URL.revokeObjectURL = url => { observed.testRevokedUrls.push(url); originalRevoke(url); };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const c = document.createElement('canvas'); c.width = 480; c.height = 640;
      const ctx = c.getContext('2d')!;
      const opened = performance.now();
      const draw = () => {
        ctx.fillStyle = '#e2e2e2'; ctx.fillRect(0, 0, 480, 640);
        ctx.fillStyle = '#181a18'; ctx.fillRect(150, 165, 180, 345);
        // Real focus evidence in the garment itself; a flat rectangle alone must
        // not be certified using the sharp white wall in its background.
        ctx.fillStyle = '#212321'; for (let y = 168; y < 510; y += 4) ctx.fillRect(150, y, 180, 1);
        if (state.testSticker && (state.testSticker !== 'brief' || (performance.now()-opened > 4500 && performance.now()-opened < 6200))) { ctx.fillStyle = '#fafafa'; ctx.fillRect(210, 300, 14, 16); ctx.fillRect(270, 400, 12, 12); }
      };
      draw(); const interval = setInterval(draw, 50); const stream = c.captureStream(20);
      stream.getTracks()[0].addEventListener('ended', () => clearInterval(interval)); state.testStreams.push(stream); return stream;
    } });
  }, marked);
}
async function modelEvidence(page: Page) {
  await page.route('**/src/vision/subject.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    export async function createInspector() {
      let index = 0;
      return { async inspect(canvas) {
        if (window.testModelFails) throw new Error('synthetic model failure');
        if(window.testSlowModel)await new Promise(resolve=>setTimeout(resolve,2000));
        const mask = new Uint8Array(canvas.width * canvas.height);
        for(let y=165;y<510;y++)for(let x=150;x<330;x++)mask[y*canvas.width+x]=1;
        return { width:canvas.width, height:canvas.height, mask, landmarks:[], complete:!window.testInvalid,
          facing:window.testWrongFacing?'front':(index++ < 12 ? 'front' : index <= 24 ? 'profile' : 'back'),
          reason:window.testInvalid?'全身が映る位置で、もう一度':undefined };
      }, async close() {} };
    }` }));
}
async function record(page: Page) {
  await page.goto('/'); await expect(page.getByRole('button', { name: '録画開始', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '録画開始', exact: true }).click();
  await expect(page.getByRole('button', { name: '撮影を中止' })).toBeVisible();
}
async function streamsStopped(page: Page) {
  return page.evaluate(() => (window as unknown as { testStreams: MediaStream[] }).testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')));
}

test('launch opens only the live front preview and record control, no external requests', async ({ page }) => {
  await syntheticCamera(page);
  const external: string[] = []; const errors: string[] = [];
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith('http://127.0.0.1:5173')) external.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: '録画開始' })).toBeEnabled();
  await expect(page.locator('video')).toBeVisible(); await expect(page.locator('button')).toHaveCount(1);
  await expect(page.locator('header,h1,footer')).toHaveCount(0);
  await expect(page.getByText('カメラを許可してください')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/camera-mobile.png' });
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

test('records a real movie, extracts four deduplicated screenshots; mirrored ring, swipe, zoom, recapture', async ({ page }) => {
  await syntheticCamera(page); await modelEvidence(page); await record(page);
  await expect(page.getByText('正面の付着物候補')).toBeVisible({ timeout: 45000 });
  await expect(page.getByText('1 / 4', { exact: true })).toBeVisible();
  const ring = page.locator('.finding-photo .detection-ring');
  await expect(ring).toHaveCount(1); expect(Number(await ring.getAttribute('cx'))).toBeCloseTo(263, 0);
  expect(Number(await ring.getAttribute('cy'))).toBeCloseTo(308, 0);
  expect(await streamsStopped(page)).toBe(true);
  const movie = await page.evaluate(() => {
    const w=window as typeof window & { testRecorders: MediaRecorder[]; testBlobUrls:string[];testRevokedUrls:string[] };
    return {recorders:w.testRecorders.length, state:w.testRecorders[0].state, mime:w.testRecorders[0].mimeType, urls:w.testBlobUrls.length, revoked:w.testRevokedUrls};
  });
  expect(movie).toMatchObject({recorders:1,state:'inactive',urls:1}); expect(movie.mime).toMatch(/^video\//);expect(movie.revoked).toHaveLength(1);
  const img = page.locator('.finding-photo img'); expect(await img.getAttribute('src')).toMatch(/^data:image\/jpeg/);
  // Both image and SVG use contain with the same origin, dimensions and viewBox.
  const aligned = await page.evaluate(() => {
    const image = document.querySelector('.finding-photo img')!;
    const svg = document.querySelector('.finding-photo svg')!;
    const a = image.getBoundingClientRect(), b = svg.getBoundingClientRect();
    return Math.abs(a.x-b.x)+Math.abs(a.y-b.y)+Math.abs(a.width-b.width)+Math.abs(a.height-b.height) < 1 && getComputedStyle(image).objectFit === 'contain';
  }); expect(aligned).toBe(true);
  await page.screenshot({ path: 'test-results/finding-mobile.png', fullPage: true });
  const bounds = await page.locator('.finding-photo').boundingBox();
  await page.mouse.move(bounds!.x + bounds!.width * .8, bounds!.y + bounds!.height * .5); await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * .2, bounds!.y + bounds!.height * .5, { steps: 10 }); await page.mouse.up();
  await expect(page.getByText('2 / 4', { exact: true })).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '次の箇所' }).click(); await expect(page.getByText('背中の付着物候補')).toBeVisible();
  await page.getByRole('button', { name: '問題箇所を拡大' }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '拡大する' }).click(); await expect(page.getByRole('button', { name: '全体を見る' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'もう一度撮影' }).click(); await expect(page.getByRole('button', { name: '録画開始' })).toBeEnabled();
  await expect(page.locator('.detection-ring,img')).toHaveCount(0);
});

test('verified clean front and back without side shots show only the sendoff, then automatically return', async ({ page }) => {
  await syntheticCamera(page, false); await modelEvidence(page); await record(page);
  await expect(page.getByText('いってらっしゃい', { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(page.locator('main')).toHaveText('いってらっしゃい'); await expect(page.locator('button,video,img')).toHaveCount(0);
  await page.locator('.sendoff').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  expect(await streamsStopped(page)).toBe(true); await page.screenshot({ path: 'test-results/sendoff-mobile.png' });
  await expect(page.getByRole('button', { name: '録画開始' })).toBeEnabled({ timeout: 7000 });
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0);
});

test('incomplete full-body evidence never shows a sendoff', async ({ page }) => {
  await syntheticCamera(page, false); await modelEvidence(page);
  await page.goto('/'); await page.evaluate(() => { (window as unknown as { testInvalid: boolean }).testInvalid = true; });
  await page.getByRole('button', { name: '録画開始' }).click();
  await expect(page.getByRole('alert')).toContainText('全身が映る位置で、もう一度', { timeout: 45000 });
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0); expect(await streamsStopped(page)).toBe(true);
});

test('elapsed time facing front does not verify back', async ({ page }) => {
  await syntheticCamera(page, false); await modelEvidence(page); await page.goto('/');
  await page.evaluate(() => { (window as unknown as { testWrongFacing: boolean }).testWrongFacing = true; });
  await page.getByRole('button', { name: '録画開始' }).click();
  await expect(page.getByRole('alert')).toContainText('確認できませんでした', { timeout: 45000 });
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0);
});

test('model failures remain failures and release camera streams', async ({ page }) => {
  await syntheticCamera(page, false); await modelEvidence(page); await page.goto('/');
  await page.evaluate(() => { (window as unknown as { testModelFails: boolean }).testModelFails = true; });
  await page.getByRole('button', { name: '録画開始' }).click();
  await expect(page.getByRole('alert')).toContainText('解析できませんでした', { timeout: 45000 });
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0); expect(await streamsStopped(page)).toBe(true);
});

test('denied camera permission provides a short recovery action', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('denied', 'NotAllowedError'); } }));
  await page.goto('/'); await expect(page.getByRole('alert')).toContainText('カメラを許可してください');
  await expect(page.getByRole('button', { name: 'カメラを再開' })).toBeVisible(); await expect(page.getByRole('button', { name: '録画開始' })).toBeDisabled();
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0);
});

test('stop and pagehide cancel capture, stop streams and discard frames', async ({ page }) => {
  await syntheticCamera(page); await record(page);
  await page.waitForFunction(()=> (window as unknown as {testRecorders:MediaRecorder[]}).testRecorders[0]?.state === 'recording');
  await page.getByRole('button', { name: '撮影を中止' }).click();
  await expect(page.getByRole('alert')).toContainText('中断'); expect(await streamsStopped(page)).toBe(true);
  expect(await page.evaluate(()=>(window as unknown as {testRecorders:MediaRecorder[]}).testRecorders[0].state)).toBe('inactive');
  await page.getByRole('button', { name: 'カメラを再開' }).click(); await page.getByRole('button', { name: '録画開始' }).click();
  await page.waitForFunction(()=> (window as unknown as {testRecorders:MediaRecorder[]}).testRecorders[1]?.state === 'recording');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByRole('alert')).toContainText('中断'); expect(await streamsStopped(page)).toBe(true);
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0);
});

test('portrait, landscape, desktop and reduced motion keep the control in view', async ({ page }) => {
  await syntheticCamera(page); await page.goto('/'); await expect(page.getByRole('button', { name: '録画開始' })).toBeEnabled();
  for (const [width, height] of [[375, 667], [390, 844], [430, 932], [844, 390], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    const bounds = await page.getByRole('button', { name: '録画開始' }).boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.record-button').evaluate(e => getComputedStyle(e).transitionDuration)).toBe('0s');
});

test('real local pose and face models run on an actual photograph with zero external requests', async ({ page }) => {
  const external: string[] = [], failed: string[] = [];
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith('http://127.0.0.1:5173')) external.push(r.url()); });
  page.on('requestfailed', r => failed.push(r.url())); await page.goto('/dev');
  const photograph = (await readFile('tests/fixtures/pose.jpg')).toString('base64');
  const result = await page.evaluate(async photograph => {
    const path = '/src/vision/subject.ts'; const { createInspector } = await import(/* @vite-ignore */ path);
    const image = new Image(); image.src = `data:image/jpeg;base64,${photograph}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
    const ctx = canvas.getContext('2d')!; ctx.translate(480, 0); ctx.scale(-1, 1); ctx.drawImage(image, 0, 0, 480, 320);
    const engine = await createInspector();
    try {
      const subject = await engine.inspect(canvas);
      const empty = document.createElement('canvas'); empty.width = 480; empty.height = 640; empty.getContext('2d')!.fillRect(0, 0, 480, 640);
      const noPerson = await engine.inspect(empty);
      return { count: subject.landmarks.length, pixels: subject.mask.reduce((n: number, p: number) => n+p, 0), complete: subject.complete, emptyComplete: noPerson.complete, emptyFacing: noPerson.facing };
    } finally { await engine.close(); }
  }, photograph);
  expect(result.count).toBe(33); expect(result.pixels).toBeGreaterThan(1000); expect(result.pixels).toBeLessThan(480 * 320 * .6);
  expect(result.complete).toBe(true); expect(result.emptyComplete).toBe(false); expect(result.emptyFacing).toBe('unknown');
  expect(external).toEqual([]); expect(failed).toEqual([]);
});

test('developer pixel harness still recomputes thresholds on an uploaded image', async ({ page }) => {
  await page.goto('/dev');
  const png = await page.evaluate(() => {
    const c=document.createElement('canvas');c.width=480;c.height=640;const ctx=c.getContext('2d')!;
    ctx.fillStyle='#ddd';ctx.fillRect(0,0,480,640);ctx.fillStyle='#222';ctx.fillRect(150,165,180,345);ctx.fillStyle='#eee';ctx.fillRect(210,300,14,16);return c.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({name:'synthetic-shirt.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(page.locator('p[role=status]')).toHaveText('候補 1件');
  await page.getByRole('slider', {name:/明度閾値/}).press('End'); await expect(page.locator('p[role=status]')).toHaveText('候補 0件');
});

test('native getUserMedia feeds the real models; a non-person video cannot receive a sendoff', async ({ playwright }, testInfo) => {
  const width = 480, height = 640, luminance = Buffer.alloc(width * height, 225), chroma = Buffer.alloc(width * height / 2, 128);
  for (let y = 165; y < 510; y++) for (let x = 150; x < 330; x++) luminance[y * width + x] = 25;
  for (let y = 300; y < 316; y++) for (let x = 210; x < 224; x++) luminance[y * width + x] = 235;
  const file = testInfo.outputPath('not-a-person.y4m');
  await writeFile(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W480 H640 F30:1 Ip A1:1 C420jpeg\nFRAME\n`), luminance, chroma]));
  const browser = await playwright.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ['--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${file}`] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('console', message => { if (message.type() === 'error') console.log('Native camera browser:', message.text()); });
    page.on('pageerror', error => console.log('Native camera page:', error.message));
    page.on('requestfailed', request => console.log('Native camera request failed:', request.url()));
    await page.addInitScript(() => {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const state = window as unknown as { nativeStreams: MediaStream[] }; state.nativeStreams = [];
      navigator.mediaDevices.getUserMedia = async constraints => { const stream = await original(constraints); state.nativeStreams.push(stream); return stream; };
    });
    await record(page); await expect(page.getByRole('alert')).toContainText('全身が映る位置で、もう一度', { timeout: 60000 });
    await expect(page.getByText('いってらっしゃい')).toHaveCount(0); await expect(page.locator('.detection-ring')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { nativeStreams: MediaStream[] }).nativeStreams.every(s => s.getTracks().every(t => t.readyState === 'ended')))).toBe(true);
  } finally { await browser.close(); }
});

test('deployment CSP permits the actual local model runtime', async ({ page }) => {
  const configuration = JSON.parse(await readFile('vercel.json', 'utf8'));
  const csp = configuration.headers[0].headers.find((h: { key: string }) => h.key === 'Content-Security-Policy').value;
  const external: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:5173/')) external.push(request.url()); });
  // Serve an empty harness under the REAL deployment policy. This avoids Vite's
  // development-only inline React preamble, which isn't part of production.
  await page.route('http://127.0.0.1:5173/', route => route.fulfill({ contentType: 'text/html',
    headers: { 'Content-Security-Policy': csp }, body: '<!doctype html><html><head><title>Model CSP harness</title></head><body></body></html>' }));
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective));
    const path = '/src/vision/subject.ts'; const { createInspector } = await import(/* @vite-ignore */ path);
    const engine = await createInspector();
    try {
      const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 640;
      const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#e2e2e2'; ctx.fillRect(0, 0, 480, 640); ctx.fillStyle = '#181a18'; ctx.fillRect(150, 165, 180, 345);
      const subject = await engine.inspect(canvas);
      return { complete: subject.complete, facing: subject.facing, violations };
    } finally { await engine.close(); }
  });
  expect(result.complete).toBe(false); expect(result.facing).toBe('unknown');
  expect(result.violations).toEqual([]); expect(external).toEqual([]);
});


test('a brief sticker appearing between the old shot times is extracted from the movie', async ({ page }) => {
  await syntheticCamera(page, 'brief');await modelEvidence(page);await record(page);
  await expect(page.getByText('正面の付着物候補')).toBeVisible({timeout:45000});
  await expect(page.getByText('1 / 2', {exact:true})).toBeVisible();
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0);
  expect(await page.locator('.finding-photo img').getAttribute('src')).toMatch(/^data:image\/jpeg/);
});

test('empty recording data is a recording failure, never a sendoff', async ({ page }) => {
  await syntheticCamera(page,false);await modelEvidence(page);
  await page.addInitScript(()=>{ (window as unknown as {testDropRecordingData:boolean}).testDropRecordingData=true; });
  await record(page);
  await expect(page.getByRole('alert')).toContainText('撮影が止まりました',{timeout:45000});
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0);expect(await streamsStopped(page)).toBe(true);
});

test('cancelling video analysis releases the Blob URL and hidden decoder', async ({ page }) => {
  await syntheticCamera(page,false);await modelEvidence(page);
  await page.addInitScript(()=>{ (window as unknown as {testSlowModel:boolean}).testSlowModel=true; });
  await record(page);
  await page.waitForFunction(()=> (window as unknown as {testBlobUrls:string[]}).testBlobUrls.length===1);
  await page.getByRole('button',{name:'中止',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('中断');
  await expect.poll(()=>page.evaluate(()=> (window as unknown as {testRevokedUrls:string[]}).testRevokedUrls.length)).toBe(1);
  await expect(page.locator('body > video')).toHaveCount(0);
  await expect(page.getByText('いってらっしゃい')).toHaveCount(0);
});
