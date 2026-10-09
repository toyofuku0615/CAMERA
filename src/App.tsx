import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowLeft, Check, Camera, ScanLine, ShieldCheck, Volume2, VolumeX, RotateCw, X, AlertCircle, LockKeyhole } from 'lucide-react';
import { APP, DIRECTIONS, GUIDE, type Direction } from './config';
import { openCamera, stopCamera } from './services/camera';
import { captureSequence, type Progress, type Shot } from './services/capture';
import { VoiceGuide } from './services/speech';
import { processShot, type CheckResult } from './vision/frames';
import { loadPersonModel, disposePersonModel, ModelLoadError } from './vision/model';
import { AnnotatedImage } from './components/AnnotatedImage';

type Screen = 'home' | 'prepare' | 'capture' | 'analyze' | 'results';
const errorMessage = (e: unknown) => e instanceof Error ? e.message : '処理を続けられませんでした。再試行してください。';
function SweaterArt() {
  return <svg className="sweater-art" viewBox="0 0 420 410" role="img" aria-label="黒いセーターの背中を確認するイメージ図">
    <defs><linearGradient id="cloth" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#4a4c48"/><stop offset="1" stopColor="#242723"/></linearGradient><pattern id="knit" width="4" height="5" patternUnits="userSpaceOnUse"><path d="M1 0v3m2-1v3" stroke="#ffffff" strokeOpacity=".045"/></pattern><filter id="shadow"><feDropShadow dx="0" dy="12" stdDeviation="14" floodOpacity=".12"/></filter></defs>
    <circle cx="211" cy="211" r="151" fill="#e9e9e2"/><circle cx="211" cy="211" r="173" fill="none" stroke="#deded5" strokeDasharray="3 8"/>
    <g filter="url(#shadow)"><path d="M173 93q38 27 76 0l43 23 64 120-45 24-35-66 5 138q-69 16-140 0l5-138-35 66-45-24 64-120z" fill="url(#cloth)"/><path d="M173 93q38 27 76 0l43 23 64 120-45 24-35-66 5 138q-69 16-140 0l5-138-35 66-45-24 64-120z" fill="url(#knit)"/><path d="M173 93q38 36 76 0m-102 223q66 13 133 0" fill="none" stroke="#161a16" strokeWidth="7" strokeOpacity=".5"/></g>
    <rect x="238" y="159" width="18" height="20" rx="1" fill="#f7f6ef" transform="rotate(8 247 169)"/>
    <path d="M225 149h-6v7m50-7h7v7m0 30v7h-7m-50-7v7h6" stroke="#bf7047" strokeWidth="2" fill="none"/>
    <path d="M280 173h37" stroke="#bf7047" strokeWidth="1"/><circle cx="322" cy="173" r="3" fill="#bf7047"/>
    <rect x="292" y="287" width="105" height="42" rx="9" fill="#fdfcf8" stroke="#e3e2d9"/><circle cx="310" cy="308" r="4" fill="#bf7047"/><text x="322" y="312" fill="#55594f" fontSize="11" fontFamily="sans-serif">見えない場所も。</text>
  </svg>;
}
export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [voiceOn, setVoiceOn] = useState(true), [ratio, setRatio] = useState('3 / 4');
  const [modelState, setModelState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [modelError, setModelError] = useState('');
  const [progress, setProgress] = useState<Progress>();
  const [results, setResults] = useState<CheckResult[]>([]), [selected, setSelected] = useState<Direction>('back');
  const [resultView, setResultView] = useState(0);
  const [retryDirections, setRetryDirections] = useState<Direction[]>();
  const video = useRef<HTMLVideoElement>(null), currentStream = useRef<MediaStream | null>(null);
  const voice = useRef<VoiceGuide | null>(null), controller = useRef<AbortController | null>(null), generation = useRef(0);
  const screenRef = useRef(screen); screenRef.current = screen;
  if (!voice.current) voice.current = new VoiceGuide();
  function releaseCamera() { stopCamera(currentStream.current); currentStream.current = null; setStream(null); setReady(false); }
  function cancelWork() { generation.current++; controller.current?.abort(); voice.current?.cancel(); }
  useEffect(() => {
    document.title = `${APP.name} — 服装チェック`;
    const suspend = () => {
      if (document.hidden || screenRef.current === 'capture') {
        generation.current++; controller.current?.abort(); voice.current?.cancel(); disposePersonModel(); stopCamera(currentStream.current); currentStream.current = null;
        setStream(null); setReady(false); setLoading(false); setResults([]); setRetryDirections(undefined);
        if (screenRef.current !== 'home') { setScreen('prepare'); setError('撮影を中断しました。カメラを再起動してください。'); }
      }
    };
    document.addEventListener('visibilitychange', suspend); window.addEventListener('pagehide', suspend);
    return () => { generation.current++; controller.current?.abort(); voice.current?.cancel(); disposePersonModel(); stopCamera(currentStream.current); document.removeEventListener('visibilitychange', suspend); window.removeEventListener('pagehide', suspend); };
  }, []);
  useEffect(() => {
    if (!video.current || !stream) return;
    const element = video.current; element.srcObject = stream;
    void element.play().catch(() => { setError('カメラ映像を再生できませんでした。カメラを再起動してください。'); setReady(false); });
  }, [stream]);
  async function prepare(directions?: Direction[]) {
    cancelWork(); releaseCamera(); setError(''); setResults(previous => directions ? previous : []); setRetryDirections(directions); setProgress(undefined); setScreen('prepare');
    await startCamera();
  }
  async function initializeModel() {
    const token = generation.current; setModelState('loading'); setModelError('');
    try { await loadPersonModel(); if (token === generation.current) setModelState('ready'); }
    catch (e) { if (token === generation.current) { setModelState('error'); setModelError(errorMessage(e)); } }
  }
  async function startCamera() {
    cancelWork(); releaseCamera(); setReady(false); setError(''); setLoading(true);
    const token = generation.current;
    void initializeModel();
    try {
      const s = await openCamera();
      if (token !== generation.current) { stopCamera(s); return; }
      currentStream.current = s; setStream(s);
      s.getVideoTracks().forEach(track => { track.onended = () => {
        if (currentStream.current !== s) return;
        cancelWork(); releaseCamera(); setLoading(false); setScreen('prepare'); setError('カメラとの接続が切れました。再起動してください。');
      }; });
    } catch (e) { if (token === generation.current) setError(errorMessage(e)); }
    finally { if (token === generation.current) setLoading(false); }
  }
  async function startCapture() {
    if (!video.current || !ready || modelState !== 'ready' || screenRef.current !== 'prepare') return;
    voice.current!.enabled = voiceOn; voice.current!.unlock();
    const abort = new AbortController(); controller.current = abort;
    const token = ++generation.current;
    setScreen('capture'); setError('');
    const shots: Shot[] = [];
    try {
      await captureSequence(video.current, voice.current!, abort.signal, setProgress, s => shots.push(s), retryDirections);
      if (token !== generation.current) return;
      releaseCamera(); setScreen('analyze');
      const analyzed: CheckResult[] = [];
      for (const shot of shots) {
        await new Promise(resolve => setTimeout(resolve, 40));
        if (token !== generation.current) return;
        try { analyzed.push(await processShot(shot, { signal: abort.signal })); }
        catch (e) { if (e instanceof ModelLoadError || abort.signal.aborted) throw e; analyzed.push(await processShot({ direction: shot.direction, frames: [], error: errorMessage(e) })); }
        finally { shot.frames.forEach(c => { c.width = 0; c.height = 0; }); shot.frames = []; }
      }
      if (token !== generation.current) return;
      const combined = retryDirections ? [...results.filter(r => !retryDirections.includes(r.direction)), ...analyzed] : analyzed;
      setResults(DIRECTIONS.map(d => combined.find(r => r.direction === d.id)).filter((r): r is CheckResult => !!r));
      setSelected(analyzed.find(r => r.analysis.boxes.length)?.direction ?? analyzed.find(r => r.direction === 'back')?.direction ?? analyzed[0].direction);
      setResultView(0); setScreen('results'); setRetryDirections(undefined);
    } catch (e) {
      if (!abort.signal.aborted && token === generation.current) { releaseCamera(); if (e instanceof ModelLoadError) { setModelState('error'); setModelError(errorMessage(e)); setError(''); } else setError(errorMessage(e)); setScreen('prepare'); }
    } finally { shots.forEach(s => s.frames.forEach(c => { c.width = 0; c.height = 0; })); }
  }
  function home() { cancelWork(); disposePersonModel(); releaseCamera(); setResults([]); setProgress(undefined); setLoading(false); setScreen('home'); setError(''); }
  function cancelCapture() { cancelWork(); releaseCamera(); setLoading(false); setProgress(undefined); setScreen('prepare'); setError('撮影を中止しました。再開するにはカメラを起動してください。'); }
  const total = results.reduce((n, r) => n + r.analysis.boxes.length + (r.additionalViews ?? []).reduce((sum, v) => sum + v.analysis.boxes.length, 0), 0);
  const failed = results.filter(r => r.analysis.status === 'uncertain').map(r => r.direction);
  const activeResult = results.find(r => r.direction === selected);
  const resultViews = activeResult ? [activeResult, ...(activeResult.additionalViews ?? [])] : [];
  const active = resultViews[resultView] ?? activeResult;
  const cameraScreen = screen === 'prepare' || screen === 'capture';
  return <div className={`app screen-${screen}`}>
    <header className="header"><button className="brand" onClick={home} aria-label="ホームに戻る"><span className="brand-symbol">b.</span>{APP.name}</button><span className="header-note">PRIVATE OUTFIT CHECK</span>{screen !== 'home' && <button className="close-button" onClick={home} aria-label="チェックを終了"><X size={20}/></button>}</header>
    {screen === 'home' && <main className="home"><div className="home-copy"><div className="eyebrow"><span className="tiny-line"/> BEFORE YOU STEP OUT</div><h1>服装を<br/>チェック<span className="title-dot">。</span></h1><p className="home-description">自分では見えないところまで、<br/>身だしなみを確認。</p><p className="home-subtitle">大切な予定の前に、あなたのための30秒。</p><div className="home-cta"><button className="primary" onClick={() => void prepare()}>チェックを開始<ArrowRight size={20}/></button><p><Camera size={14}/> 次の画面でカメラの使用を許可します</p></div></div>
      <div className="home-visual"><span className="visual-label">A QUIET CONFIDENCE.</span><SweaterArt/><div className="visual-caption"><span>01 — 04</span><p>正面から、見えない背中まで。</p><ScanLine size={19}/></div></div>
      <div className="home-bottom"><div className="steps"><div><span>01</span><p>スマホを置く</p></div><div><span>02</span><p>ゆっくり一回転</p></div><div><span>03</span><p>気になる箇所を確認</p></div></div><div className="privacy-note"><ShieldCheck size={19}/><p>画像は端末内で解析。<br/><span>保存・送信・登録は不要です。</span></p></div></div>
      <p className="scope-note">黒い無地のセーターに付いた白いシール・テープを対象にしています。</p>
    </main>}
    {cameraScreen && <main className="camera-layout"><section className="camera-copy"><span className="eyebrow">{screen === 'prepare' ? 'SET UP / 撮影準備' : `CAPTURE / ${progress?.preparing ? '準備' : `${(progress?.index ?? 0) + 1} OF ${progress?.total ?? 4}`}`}</span><h1>{screen === 'prepare' ? '大切な時間の、\nその前に。' : progress?.preparing ? '撮影位置へ。' : `${DIRECTIONS.find(d => d.id === progress?.direction)?.label ?? '正面'}の撮影`}</h1>
      {screen === 'prepare' ? <><p className="lead">スマートフォンを安定した場所に設置してください。</p><ol className="setup-list"><li><span>01</span><p>胸の高さにスマホを固定<small>明るい室内で、強い逆光を避けて。</small></p></li><li><span>02</span><p>約1.5〜2m離れて立つ<small>上半身全体が画面に収まる位置に立ってください。</small></p></li><li><span>03</span><p>右へ90度ずつ回転<small>撮影中は音声案内に従ってください。各方向で静止します。</small></p></li></ol><button className="voice-toggle" aria-pressed={voiceOn} onClick={() => setVoiceOn(v => !v)}>{voiceOn ? <Volume2 size={19}/> : <VolumeX size={19}/>}音声案内<span>{voiceOn ? 'オン' : 'オフ'}</span><i className={voiceOn ? 'switch on' : 'switch'}/></button><p className="muted small">音声が聞こえない場合も、画面の数字で撮影が進みます。</p></> : <><p className="capture-instruction" aria-live="polite">{progress?.instruction ?? '撮影を開始します'}</p><p className="muted">数字が消えるまで、その場で静止してください。</p><div className="capture-progress">{(retryDirections ?? DIRECTIONS.map(d => d.id)).map((id, i) => <div key={id} className={i < (progress?.index ?? 0) ? 'done' : i === progress?.index ? 'current' : ''}><span>{i < (progress?.index ?? 0) ? <Check size={14}/> : i + 1}</span><p>{DIRECTIONS.find(d => d.id === id)?.label}</p></div>)}</div></>}
      {modelError && <div className="error" role="alert"><AlertCircle size={20}/><p>{modelError}</p></div>}
      {error && <div className="error" role="alert"><AlertCircle size={20}/><p>{error}</p></div>}
      <div className="camera-actions">{screen === 'prepare' ? <>{!stream && !loading ? <button className="primary" onClick={() => void startCamera()}>カメラを{error ? '再起動' : '起動'}<Camera size={20}/></button> : <button className="primary" disabled={!ready || loading || modelState !== 'ready'} onClick={() => void startCapture()}>{loading || !ready ? 'カメラを準備しています' : modelState !== 'ready' ? '人物認識モデルを準備しています' : retryDirections ? '選択した方向を撮影' : '撮影を開始'}<ArrowRight size={20}/></button>}{modelState === 'error' && <button className="secondary" onClick={() => void initializeModel()}>人物認識モデルを再試行</button>}{stream && !ready && !loading && <button className="text-button" onClick={() => void startCamera()}>カメラを再起動</button>}<button className="text-button" onClick={home}><ArrowLeft size={15}/> ホームに戻る</button></> : <button className="secondary" onClick={cancelCapture}><X size={17}/> 撮影を中止</button>}</div>
    </section><section className="camera-panel"><div className="camera-stage" style={{ aspectRatio: ratio }}><video ref={video} autoPlay muted playsInline aria-label="フロントカメラのプレビュー" onLoadedData={() => { if (video.current) { setRatio(`${video.current.videoWidth} / ${video.current.videoHeight}`); setReady(!video.current.paused && video.current.readyState >= 2); } }} onPlaying={() => setReady(true)}/>{!ready && <div className="camera-placeholder"><Camera size={34}/><p>{loading ? 'カメラへのアクセスを待っています' : 'カメラプレビュー'}</p></div>}<div className="head-guide"/><div className="torso-guide" style={{ left: `${GUIDE.x * 100}%`, top: `${GUIDE.y * 100}%`, width: `${GUIDE.width * 100}%`, height: `${GUIDE.height * 100}%` }}><i/><i/><i/><i/></div>{screen === 'prepare' && <span className="guide-label">黒いセーターを枠の中に</span>}{screen === 'capture' && <div className="countdown" role="timer" aria-label={progress?.countdown ? `あと${progress.countdown}秒` : '向きを変えてください'}>{progress?.countdown ?? <RotateCw size={52}/>}</div>}<div className="camera-status"><span className={ready ? 'status-dot live' : 'status-dot'}/>{ready ? 'カメラ接続中' : 'カメラ待機中'}<span>FRONT CAMERA</span></div></div><p className="camera-footnote"><LockKeyhole size={13}/> 撮影画像は外部に送信されません</p></section></main>}
    {screen === 'analyze' && <main className="analyzing"><div className="scan-animation"><ScanLine size={46}/></div><span className="eyebrow">ONE MOMENT</span><h1>服の状態を<br/>確認しています</h1><p className="muted">撮影した画像を、端末内で確認しています。</p><button className="text-button" onClick={home}>チェックを終了</button></main>}
    {screen === 'results' && <main className="results"><div className="result-heading"><span className="eyebrow">YOUR CHECK / チェック完了</span><h1>チェック結果</h1><div className={`summary ${total ? 'has-detection' : ''}`}>{total ? <ScanLine size={23}/> : failed.length ? <AlertCircle size={23}/> : <Check size={23}/>}<p>{total ? `確認が必要な箇所が${total}件あります` : failed.length ? '一部の範囲を十分に確認できませんでした' : '確認できた範囲では、目立つ付着物は検出されませんでした'}</p></div>{total > 0 && failed.length > 0 && <p className="partial-notice">一部の範囲を十分に確認できませんでした。</p>}<p className="muted small">見つかった箇所を画像でご確認ください。検出には見落としや誤検出が生じることがあります。</p></div>
      <div className="result-grid"><section><div className="direction-tabs" role="tablist" aria-label="撮影方向">{DIRECTIONS.map(d => { const r = results.find(r => r.direction === d.id); return <button key={d.id} role="tab" id={`tab-${d.id}`} aria-controls="photo-panel" aria-selected={selected === d.id} tabIndex={selected === d.id ? 0 : -1} onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const index = DIRECTIONS.findIndex(d => d.id === selected); const next = DIRECTIONS[(index + (e.key === 'ArrowRight' ? 1 : 3)) % 4].id; setResultView(0); setSelected(next); document.getElementById(`tab-${next}`)?.focus(); } }} onClick={() => { setResultView(0); setSelected(d.id); }}>{d.label}{(r && (r.analysis.boxes.length > 0 || r.additionalViews?.length)) ? <i className="tab-dot"/> : r?.analysis.status === 'uncertain' ? <span className="tab-uncertain">!</span> : null}</button>; })}</div><div id="photo-panel" role="tabpanel" aria-labelledby={`tab-${selected}`}>{active && <AnnotatedImage key={active.image ?? active.direction} result={active}/>}</div><p className="image-caption">左右は表示画像を基準にしています。<span>画像をタップして拡大</span></p></section>
      <section className="result-detail">{resultViews.length > 1 && <div className="frame-view-switch" aria-label="候補を確認した撮影画像">{resultViews.map((_, i) => <button className="secondary" key={i} aria-pressed={resultView === i} onClick={() => setResultView(i)}>撮影画像 {i + 1} の候補</button>)}</div>}<span className="eyebrow">TAKE A CLOSER LOOK</span><h2>{DIRECTIONS.find(d => d.id === selected)?.label}の確認</h2>{active?.analysis.warnings.map((warning, i) => <p className="partial-notice" key={i}>{warning}</p>)}{active?.analysis.status === 'uncertain' && <div className="error" role="status"><AlertCircle size={19}/><p>{active.analysis.reason}</p></div>}{active?.analysis.boxes.map((b, i) => <div className="finding" key={i}><span>{String(i + 1).padStart(2, '0')}</span><div><h3>{DIRECTIONS.find(d => d.id === selected)?.label}・画像{b.x + b.width / 2 < active.width * .42 ? '左' : b.x + b.width / 2 > active.width * .58 ? '右' : '中央'}{b.y + b.height / 2 < active.height * .48 ? '上部' : '下部'}</h3><p>白い付着物の候補です。<br/>画像の枠内をご確認ください。{b.confidence === 'single-frame' && <small className="low-confidence">1枚の画像で確認した候補です。</small>}</p></div></div>)}{active?.analysis.status === 'ok' && !active.analysis.boxes.length && <div className="clear-note"><Check size={20}/><p>この方向では、目立つ付着物は<br/>検出されませんでした。</p></div>}<div className="result-actions"><button className="primary" onClick={() => void prepare()}>もう一度チェック<RotateCw size={18}/></button>{failed.length > 0 && <button className="secondary" onClick={() => void prepare(failed)}>未確認の方向だけ撮り直す</button>}<button className="text-button" onClick={home}>終了して画像を破棄</button></div><p className="muted small"><ShieldCheck size={14}/> 画像はこの画面を終了すると破棄されます。</p></section></div>
    </main>}
    <footer><span>{APP.tagline}</span><span>あなたの、その一歩のために。</span></footer>
  </div>;
}
