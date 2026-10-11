import { useEffect, useRef, useState } from 'react';
import { DIRECTIONS, type Direction } from './config';
import { openCamera, stopCamera } from './services/camera';
import { captureSequence, type Progress, type Shot } from './services/capture';
import { VoiceGuide } from './services/speech';
import { canSendOff, inspectShot, type CheckResult } from './vision/frames';
import { createInspector, type Inspector } from './vision/subject';
import { AnnotatedImage } from './components/AnnotatedImage';

type Screen = 'camera' | 'capture' | 'analyze' | 'findings' | 'incomplete' | 'sendoff';
const directionName = (direction: Direction) => direction === 'back' ? '背中' : DIRECTIONS.find(d => d.id === direction)!.label;
const dispose = (shots: Shot[]) => shots.forEach(s => { s.frames.forEach(c => { c.width = c.height = 0; }); s.frames = []; });

export function App() {
  const [screen, setScreen] = useState<Screen>('camera');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<Progress>();
  const [results, setResults] = useState<CheckResult[]>([]), [selected, setSelected] = useState(0);
  const video = useRef<HTMLVideoElement>(null), liveStream = useRef<MediaStream | null>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  const voice = useRef(new VoiceGuide()), screenRef = useRef(screen);
  const gesture = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);
  screenRef.current = screen;

  function releaseCamera() {
    const old = liveStream.current; liveStream.current = null;
    stopCamera(old);
    if (video.current) video.current.srcObject = null;
    setStream(null); setReady(false);
  }
  function cancelWork() { generation.current++; controller.current?.abort(); voice.current.cancel(); }
  async function startCamera() {
    if (document.hidden) return;
    cancelWork(); releaseCamera(); setLoading(true); setMessage('');
    setResults([]); setSelected(0); setProgress(undefined); setScreen('camera');
    const token = generation.current;
    try {
      const s = await openCamera();
      if (token !== generation.current || document.hidden) { stopCamera(s); return; }
      liveStream.current = s; setStream(s);
      s.getVideoTracks().forEach(track => { track.onended = () => {
        if (liveStream.current !== s) return;
        cancelWork(); releaseCamera(); setLoading(false); setScreen('camera');
        setMessage('カメラが止まりました。もう一度');
      }; });
    } catch (e) {
      if (token === generation.current) setMessage(e instanceof Error ? e.message : 'カメラを起動できませんでした');
    } finally { if (token === generation.current) setLoading(false); }
  }
  useEffect(() => {
    document.title = 'CAMERA';
    const initial = setTimeout(() => { void startCamera(); }, 0);
    const suspend = (event: Event) => {
      if (!document.hidden && event.type !== 'pagehide') return;
      cancelWork(); releaseCamera(); setLoading(false); setResults([]);
      setProgress(undefined); setScreen('camera'); setMessage('中断しました。もう一度');
    };
    document.addEventListener('visibilitychange', suspend); window.addEventListener('pagehide', suspend);
    return () => {
      clearTimeout(initial); generation.current++; controller.current?.abort();
      voice.current.cancel(); stopCamera(liveStream.current); liveStream.current = null;
      document.removeEventListener('visibilitychange', suspend); window.removeEventListener('pagehide', suspend);
    };
  }, []);
  useEffect(() => {
    const element = video.current;
    if (!element || !stream) return;
    element.srcObject = stream;
    void element.play().catch(() => { if (liveStream.current !== stream) return; releaseCamera(); setMessage('カメラを再開してください'); });
  }, [stream]);
  useEffect(() => {
    if (screen !== 'sendoff') return;
    const timer = setTimeout(() => { void startCamera(); }, 4500);
    return () => clearTimeout(timer);
  }, [screen]);
  function interrupt() {
    cancelWork(); releaseCamera(); setProgress(undefined); setResults([]); setLoading(false);
    setScreen('camera'); setMessage('中断しました。もう一度');
  }
  async function record() {
    if (!video.current || !liveStream.current || !ready || screenRef.current !== 'camera') return;
    voice.current.unlock();
    const abort = new AbortController(); controller.current = abort;
    const token = ++generation.current;
    setResults([]); setMessage(''); setProgress(undefined); setScreen('capture');
    const shots: Shot[] = [];
    let inspector: Inspector | undefined;
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await captureSequence(video.current, voice.current, abort.signal, setProgress, shot => shots.push(shot));
      if (token !== generation.current) return;
      releaseCamera(); setScreen('analyze'); voice.current.cancel();
      analysisTimer = setTimeout(() => {
        if (token !== generation.current) return;
        cancelWork(); setResults([]); setScreen('incomplete'); setMessage('解析できませんでした。もう一度');
      }, 45000);
      inspector = await createInspector();
      const checked: CheckResult[] = [];
      for (const shot of shots) {
        if (token !== generation.current) return;
        checked.push(await inspectShot(shot, inspector, abort.signal));
        dispose([shot]);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (token !== generation.current) return;
      setSelected(0);
      const incomplete = checked.find(r => r.analysis.status !== 'ok' || !r.facingVerified);
      setMessage(incomplete ? incomplete.analysis.reason ?? `${directionName(incomplete.direction)}を確認できませんでした` : '');
      if (checked.some(r => r.findings?.length)) { setResults(checked); setScreen('findings'); }
      else if (canSendOff(checked)) { setResults([]); setScreen('sendoff'); }
      else { setResults([]); setScreen('incomplete'); }
    } catch {
      if (token === generation.current && !abort.signal.aborted) {
        releaseCamera(); setResults([]); setScreen('incomplete'); setMessage('解析できませんでした。もう一度');
      }
    } finally {
      clearTimeout(analysisTimer); dispose(shots);
      await inspector?.close().catch(() => {});
    }
  }
  const findings = results.flatMap(r => (r.findings ?? []).map(f => ({ ...f, direction: r.direction })));
  const active = findings[selected];
  const move = (delta: number) => setSelected(i => Math.max(0, Math.min(findings.length - 1, i + delta)));
  const cameraScreen = screen === 'camera' || screen === 'capture';
  return <main className={`camera-app screen-${screen}`}>
    {cameraScreen && <>
      <video ref={video} className="viewfinder" autoPlay muted playsInline aria-label="フロントカメラのプレビュー"
        onPlaying={() => setReady(!!liveStream.current && video.current?.srcObject === liveStream.current)}
        onLoadedData={() => setReady(!!liveStream.current && !!video.current && video.current.srcObject === liveStream.current && video.current.readyState >= 2 && !video.current.paused)} />
      {screen === 'camera' && (message || loading) && <div className="camera-message" role={message ? 'alert' : 'status'}>
        <p>{message || 'カメラを許可してください'}</p>
        {message && <button className="quiet-button" onClick={() => void startCamera()}>カメラを再開</button>}
      </div>}
      {screen === 'capture' && <div className="capture-cue" role="status" aria-live="polite">
        <p>{progress?.preparing ? '少し離れて、全身を画面に' : progress?.instruction ?? '撮影を始めます'}</p>
        <span role="timer" aria-label={progress?.countdown ? `あと${progress.countdown}秒` : 'ゆっくり回ってください'}>{progress?.countdown ?? '\u00a0'}</span>
      </div>}
      <div className="camera-controls"><button className={`record-button ${screen === 'capture' ? 'recording' : ''}`}
        aria-label={screen === 'capture' ? '撮影を中止' : '録画開始'} disabled={screen === 'camera' && (!ready || loading)}
        onClick={screen === 'capture' ? interrupt : () => void record()}><span /></button></div>
    </>}
    {screen === 'analyze' && <div className="analysis-screen" role="status"><span className="activity-line"/><p>確認しています</p><button className="quiet-button" onClick={interrupt}>中止</button></div>}
    {screen === 'sendoff' && <div className="sendoff" role="status"><p>いってらっしゃい</p></div>}
    {screen === 'incomplete' && <div className="incomplete"><p role="alert">{message || '全身が映る位置で、もう一度'}</p><button className="quiet-button" onClick={() => void startCamera()}>もう一度撮影</button></div>}
    {screen === 'findings' && active && <section className="findings-screen" aria-label="確認する箇所">
      <div className="finding-photo" onClickCapture={e => { if (swiped.current) { e.preventDefault(); e.stopPropagation(); swiped.current = false; } }}
        onPointerDown={e => { swiped.current = false; gesture.current = { x: e.clientX, y: e.clientY }; }}
        onPointerCancel={() => { gesture.current = null; }} onPointerUp={e => {
          const start = gesture.current; gesture.current = null;
          if (start && Math.abs(e.clientX - start.x) > 45 && Math.abs(e.clientY - start.y) < 60) { swiped.current = true; move(e.clientX < start.x ? 1 : -1); }
        }} onKeyDown={e => { if (e.key === 'ArrowRight') move(1); if (e.key === 'ArrowLeft') move(-1); }}>
        <AnnotatedImage key={`${active.direction}-${selected}`} result={{ direction: active.direction, image: active.image, width: active.width, height: active.height,
          analysis: { status: 'ok', boxes: [active.box], region: active.box, darkCoverage: 0, sharpness: 0 } }} />
      </div>
      <div className="finding-caption" aria-live="polite"><p>{directionName(active.direction)}の付着物候補</p>
        {findings.length > 1 && <nav className="photo-navigation" aria-label="静止画の切り替え"><button disabled={selected === 0} aria-label="前の箇所" onClick={() => move(-1)}>‹</button><span>{selected + 1} / {findings.length}</span><button disabled={selected === findings.length - 1} aria-label="次の箇所" onClick={() => move(1)}>›</button></nav>}
      </div>
      <div className="result-controls">{message && <p className="partial-message" role="status">{message}</p>}<button className="quiet-button" onClick={() => void startCamera()}>もう一度撮影</button></div>
    </section>}
  </main>;
}
