import { expect, test, type Page } from '@playwright/test';
// Synthetic live video source. The app still reads video pixels, captures bursts,
// runs the production detector, and draws calculated boxes; no results are stubbed.
async function syntheticCamera(page: Page) {
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
  await page.goto('/dev');
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 480; c.height = 640; const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 480, 640); ctx.fillStyle = '#222'; ctx.fillRect(150, 165, 180, 345); ctx.fillStyle = '#eee'; ctx.fillRect(210, 300, 14, 16); return c.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic-shirt.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect(page.locator('p[role=status]')).toHaveText('候補 1件'); await expect(page.locator('.debug-region')).toBeVisible();
  await page.getByRole('slider', { name: /明度閾値/ }).press('End'); await expect(page.locator('p[role=status]')).toHaveText('候補 0件');
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
    await expect(page.getByText('確認が必要な箇所が4件あります')).toBeVisible({ timeout: 40000 });
    await expect(page.locator('.detection-box')).toHaveCount(1);
  } finally { await browser.close(); }
});
