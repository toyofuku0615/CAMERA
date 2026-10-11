import { useEffect, useRef, useState } from 'react';
import { openCamera, stopCamera } from './services/camera';
import { captureSequence, type Progress, type Recording } from './services/capture';
import { VoiceGuide } from './services/speech';
import { canSendOff, inspectVideo, type Finding } from './vision/frames';
import { createInspector, type Inspector } from './vision/subject';
import { AnnotatedImage } from './components/AnnotatedImage';

type Screen = 'camera' | 'capture' | 'analyze' | 'findings' | 'incomplete' | 'sendoff';
const directionName = (direction: Finding['direction']) => direction === 'back' ? '背中' : direction === 'front' ? '正面' : '服';

export function App() {
  const [screen, setScreen] = useState<Screen>('camera');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [ready, setReady] = useState(false), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState<Progress>();
  const [findings, setFindings] = useState<Finding[]>([]), [selected, setSelected] = useState(0);
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
    setFindings([]); setSelected(0); setProgress(undefined); setScreen('camera');
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
      cancelWork(); releaseCamera(); setLoading(false); setFindings([]);
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
    cancelWork(); releaseCamera(); setProgress(undefined); setFindings([]); setLoading(false);
    setScreen('camera'); setMessage('中断しました。もう一度');
  }
  async function record() {
    if (!video.current || !liveStream.current || !ready || screenRef.current !== 'camera') return;
    voice.current.unlock();
    const abort = new AbortController(); controller.current = abort;
    const token = ++generation.current;
    setFindings([]); setMessage(''); setProgress(undefined); setScreen('capture');
    let recording: Recording | undefined;
    let inspector: Inspector | undefined;
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      recording = await captureSequence(video.current, voice.current, abort.signal, setProgress);
      if (token !== generation.current) return;
      releaseCamera(); setScreen('analyze'); voice.current.cancel();
      analysisTimer = setTimeout(() => {
        if (token !== generation.current) return;
        cancelWork(); setFindings([]); setScreen('incomplete'); setMessage('解析できませんでした。もう一度');
      }, 150000);
      inspector = await createInspector();
      const report = await inspectVideo(recording, inspector, abort.signal);
      if (token !== generation.current) return;
      setSelected(0); setMessage(report.reason ?? '');
      if (report.findings.length) { setFindings(report.findings); setScreen('findings'); }
      else if (report.complete && canSendOff(report.checks)) { setFindings([]); setScreen('sendoff'); }
      else { setFindings([]); setScreen('incomplete'); }
    } catch (error) {
      if (token === generation.current && !abort.signal.aborted) {
        releaseCamera(); setFindings([]); setScreen('incomplete');
        setMessage(!recording && error instanceof Error && error.message.length < 60 ? error.message : '解析できませんでした。もう一度');
      }
    } finally {
      clearTimeout(analysisTimer); recording = undefined;
      await inspector?.close().catch(() => {});
    }
  }
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
        <span role="timer" aria-label={progress?.countdown ? `あと${progress.countdown}秒` : progress?.instruction ?? '撮影中'}>{progress?.countdown ?? '\u00a0'}</span>
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
        <AnnotatedImage key={`${active.direction}-${selected}`} result={{ image: active.image, width: active.width, height: active.height,
          analysis: { status: 'ok', boxes: [active.box], region: active.box, darkCoverage: 0, sharpness: 0 } }} />
      </div>
      <div className="finding-caption" aria-live="polite"><p>{directionName(active.direction)}の付着物候補</p>
        {findings.length > 1 && <nav className="photo-navigation" aria-label="静止画の切り替え"><button disabled={selected === 0} aria-label="前の箇所" onClick={() => move(-1)}>‹</button><span>{selected + 1} / {findings.length}</span><button disabled={selected === findings.length - 1} aria-label="次の箇所" onClick={() => move(1)}>›</button></nav>}
      </div>
      <div className="result-controls">{message && <p className="partial-message" role="status">{message}</p>}<button className="quiet-button" onClick={() => void startCamera()}>もう一度撮影</button></div>
    </section>}
  </main>;
}
