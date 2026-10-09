import { useEffect, useRef, useState } from 'react';
import { APP, DETECTION, type DetectionSettings } from '../config';
import { analyzeWithObservation, maskOverlay, resizeForAnalysis, stableBoxes, type CheckResult, type FrameDiagnostic } from '../vision/frames';
import { inferPerson, disposePersonModel } from '../vision/model';
import type { PersonObservation } from '../vision/person';
import { AnnotatedImage } from './AnnotatedImage';
interface CachedFrame { canvas: HTMLCanvasElement; observation: PersonObservation | null; inferenceMs: number; name: string }
export function Developer() {
  const [frames, setFrames] = useState<CachedFrame[]>([]), [settings, setSettings] = useState({ ...DETECTION });
  const [diagnostics, setDiagnostics] = useState<FrameDiagnostic[]>([]), [selected, setSelected] = useState(0);
  const [error, setError] = useState(''), [loading, setLoading] = useState('');
  const [showMask, setShowMask] = useState(true), [showCandidates, setShowCandidates] = useState(true);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; disposePersonModel(); }, []);
  useEffect(() => {
    try {
      const inspected = frames.map((f, index) => {
        const { analysis, torso } = analyzeWithObservation(f.canvas, f.observation, settings, true);
        return { index, analysis, image: f.canvas.toDataURL('image/jpeg', .9), width: f.canvas.width, height: f.canvas.height, maskImage: maskOverlay(torso), inferenceMs: f.inferenceMs };
      });
      setDiagnostics(inspected.map(f => ({ ...f, analysis: { ...f.analysis, boxes: stableBoxes(f.analysis, inspected.map(i => i.analysis)).boxes } })));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [frames, settings]);
  const controls: { key: keyof DetectionSettings; label: string; min: number; max: number; step: number }[] = [
    { key: 'brightnessThreshold', label: '強い白の明度閾値', min: 100, max: 250, step: 1 },
    { key: 'minLocalBrightness', label: '局所候補の最低明度', min: 60, max: 250, step: 1 },
    { key: 'contrastThreshold', label: '周囲との明暗差', min: 20, max: 250, step: 1 },
    { key: 'darkThreshold', label: '黒い生地の上限明度', min: 30, max: 150, step: 1 },
    { key: 'minArea', label: '最小面積（解析画素）', min: 2, max: 150, step: 1 },
    { key: 'maxArea', label: '最大面積（解析画素）', min: 200, max: 8000, step: 50 },
    { key: 'regionMargin', label: '胴体領域の余白', min: 0, max: .15, step: .005 },
    { key: 'minSurroundingDark', label: '周囲の生地の割合', min: .5, max: .95, step: .01 },
    { key: 'minSharpness', label: '鮮明度の下限', min: 0, max: 100, step: 1 },
  ];
  async function load(files: FileList | null) {
    if (!files?.length) return;
    const token = ++generation.current; setError(''); setFrames([]); setDiagnostics([]); setSelected(0);
    const cached: CachedFrame[] = [];
    try {
      if (files.length > 8) throw new Error('同じ向きの連続画像を8枚以内で選択してください。');
      for (let i = 0; i < files.length; i++) {
        const file = files[i]; if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選択してください。');
        setLoading(`人物モデルで画像 ${i + 1} / ${files.length} を解析しています`);
        const url = URL.createObjectURL(file), image = new Image();
        try {
          image.src = url; await image.decode();
          if (token !== generation.current) return;
          const c = document.createElement('canvas'), scale = Math.min(1, 1600 / Math.max(image.width, image.height));
          c.width = Math.round(image.width * scale); c.height = Math.round(image.height * scale); c.getContext('2d')!.drawImage(image, 0, 0, c.width, c.height);
          const start = performance.now(), observation = await inferPerson(resizeForAnalysis(c));
          if (token !== generation.current) return;
          cached.push({ canvas: c, observation, inferenceMs: performance.now() - start, name: file.name });
        } finally { URL.revokeObjectURL(url); }
      }
      if (token === generation.current) setFrames(cached);
    } catch (e) { if (token === generation.current) setError(e instanceof Error ? e.message : '画像を読み込めませんでした。'); }
    finally { if (token === generation.current) setLoading(''); }
  }
  const frame = diagnostics[selected], result: CheckResult | undefined = frame && { direction: 'back', ...frame };
  return <main className="developer"><span className="eyebrow">{APP.name} / DEVELOPMENT ONLY</span><h1>画像検証</h1><p>画像は端末内で解析します。青：人物マスク、緑：解析に使う胴体領域、オレンジ：採用候補、赤：除外候補。同じ向きの連続画像を選ぶとフレーム間の一致も検証します。</p>
    <label className="upload">静止画像を選択（最大8枚）<input type="file" accept="image/*" multiple onChange={e => void load(e.target.files)}/></label>
    {loading && <p role="status">{loading}</p>}{error && <p role="alert">{error}</p>}
    <div className="dev-grid"><section>{controls.map(c => <label className="slider" key={c.key} htmlFor={`setting-${c.key}`}>{c.label}<output>{settings[c.key]}</output><input id={`setting-${c.key}`} aria-label={c.label} type="range" min={c.min} max={c.max} step={c.step} value={settings[c.key]} onChange={e => setSettings(s => ({ ...s, [c.key]: Number(e.target.value) }))}/></label>)}<button className="secondary" onClick={() => setSettings({ ...DETECTION })}>設定を戻す</button><p>モデル推論は画像読み込み時だけ実行し、閾値変更はキャッシュ済みマスクで即時再解析します。採用する値は src/config.ts に設定してください。</p><pre>{JSON.stringify(settings, null, 2)}</pre></section>
    <section>{result && <><div className="diagnostic-tabs">{diagnostics.map((f, i) => <button className="secondary" key={i} aria-pressed={selected === i} onClick={() => setSelected(i)}>画像 {i + 1}：候補 {f.analysis.boxes.length}件</button>)}</div><p>{frames[selected]?.name}</p><p role="status">{result.analysis.status === 'ok' ? `候補 ${result.analysis.boxes.length}件` : result.analysis.reason}</p><p>ROI：{result.analysis.roiSource} / 人物マスク一致 {(result.analysis.maskCoverage * 100).toFixed(1)}% / 黒い生地 {(result.analysis.darkCoverage * 100).toFixed(1)}% / 鮮明度 {result.analysis.sharpness.toFixed(1)} / 推論 {frame.inferenceMs.toFixed(0)}ms</p>
      <div className="diagnostic-controls"><label><input type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)}/> 人物・胴体マスク</label><label><input type="checkbox" checked={showCandidates} onChange={e => setShowCandidates(e.target.checked)}/> 採用前・除外候補</label></div>
      <AnnotatedImage result={result} debug maskImage={showMask ? frame.maskImage : undefined} showCandidates={showCandidates}/>
      <details><summary>元画像</summary><img className="diagnostic-original" src={result.image} alt="解析前の元画像"/></details>
      <table className="diagnostic-table"><thead><tr><th>候補座標</th><th>面積</th><th>明暗差</th><th>判定・理由</th></tr></thead><tbody>{result.analysis.candidates.map((c, i) => <tr key={i}><td>{c.box.x.toFixed(0)}, {c.box.y.toFixed(0)}</td><td>{c.box.area.toFixed(0)}</td><td>{c.contrast.toFixed(1)}</td><td>{c.accepted ? '採用' : '除外'}：{c.reason}</td></tr>)}</tbody></table>
      <pre>{JSON.stringify(result.analysis, null, 2)}</pre></>}</section></div>
  </main>;
}
