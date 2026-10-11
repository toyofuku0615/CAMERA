import { useEffect, useState } from 'react';
import { DETECTION, type DetectionSettings } from '../config';
import { analyzeCanvas, type CheckResult } from '../vision/frames';
import { AnnotatedImage } from './AnnotatedImage';
export function Developer() {
  const [canvas, setCanvas] = useState<HTMLCanvasElement>();
  const [settings, setSettings] = useState({ ...DETECTION });
  const [result, setResult] = useState<CheckResult>();
  const [error, setError] = useState('');
  useEffect(() => { if (canvas) { try { setResult({ direction: 'back', image: canvas.toDataURL('image/jpeg', .9), width: canvas.width, height: canvas.height, analysis: analyzeCanvas(canvas, settings) }); } catch (e) { setError(String(e)); } } }, [canvas, settings]);
  const controls: { key: keyof DetectionSettings; label: string; min: number; max: number; step: number }[] = [
    { key: 'brightnessThreshold', label: '明度閾値', min: 100, max: 250, step: 1 },
    { key: 'contrastThreshold', label: '周囲との明暗差', min: 20, max: 180, step: 1 },
    { key: 'darkThreshold', label: '黒い生地の上限明度', min: 30, max: 150, step: 1 },
    { key: 'minArea', label: '最小面積（解析画素）', min: 2, max: 150, step: 1 },
    { key: 'maxArea', label: '最大面積（解析画素）', min: 200, max: 8000, step: 50 },
    { key: 'regionMargin', label: 'ガイド内の余白', min: 0, max: .1, step: .005 },
    { key: 'minSurroundingDark', label: '周囲の生地の割合', min: .5, max: .95, step: .01 },
    { key: 'minSharpness', label: '鮮明度の下限', min: 0, max: 100, step: 1 },
  ];
  async function load(file?: File) {
    if (!file) return;
    setError('');
    if (!file.type.startsWith('image/')) { setError('画像ファイルを選択してください。'); return; }
    const url = URL.createObjectURL(file), image = new Image();
    try {
      image.src = url; await image.decode();
      const c = document.createElement('canvas'), scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      c.width = Math.round(image.width * scale); c.height = Math.round(image.height * scale);
      c.getContext('2d')!.drawImage(image, 0, 0, c.width, c.height); setCanvas(c);
    } catch { setError('画像を読み込めませんでした。JPEGまたはPNGを選択してください。'); }
    finally { URL.revokeObjectURL(url); }
  }
  return <main className="developer"><span className="eyebrow">CAMERA / DEVELOPMENT ONLY</span><h1>画素検出の調整</h1><p>この開発用画面はガイド内の画素検出だけを調整します。人物・向きの判定や正常判定は行いません。青：解析範囲、黄：暗い領域。本番のカメラ画面は人物モデルと組み合わせて解析します。</p><label className="upload">静止画像を選択<input type="file" accept="image/*" onChange={e => void load(e.target.files?.[0])}/></label>{error && <p role="alert">{error}</p>}
    <div className="dev-grid"><section>{controls.map(c => <label className="slider" key={c.key} htmlFor={`setting-${c.key}`}>{c.label}<output>{settings[c.key]}</output><input id={`setting-${c.key}`} aria-label={c.label} type="range" min={c.min} max={c.max} step={c.step} value={settings[c.key]} onChange={e => setSettings(s => ({ ...s, [c.key]: Number(e.target.value) }))}/></label>)}<button className="secondary" onClick={() => setSettings({ ...DETECTION })}>設定を戻す</button><p>変更はこの画面だけに反映されます。採用する値は src/config.ts に設定してください。</p><pre>{JSON.stringify(settings, null, 2)}</pre></section>
    <section>{result && <><p role="status">{result.analysis.status === 'ok' ? `候補 ${result.analysis.boxes.length}件` : result.analysis.reason}</p><p>生地割合 {(result.analysis.darkCoverage * 100).toFixed(1)}% / 鮮明度 {result.analysis.sharpness.toFixed(1)}</p><AnnotatedImage result={result} debug/><pre>{JSON.stringify(result.analysis.boxes, null, 2)}</pre></>}</section></div>
  </main>;
}
