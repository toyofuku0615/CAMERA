import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, LockKeyhole, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { LIVE, LIVE_GUIDE } from '../config';
import { openCamera, stopCamera } from '../services/camera';
import { startLiveAnalysis, type LiveSample } from '../services/live';
import type { VoiceGuide } from '../services/speech';

export function LiveCheck({ voice, onClose }: { voice: VoiceGuide; onClose: () => void }) {
  const [phase, setPhase] = useState<'starting' | 'live' | 'frozen' | 'stopped' | 'error'>('starting');
  const [sample, setSample] = useState<LiveSample>();
  const [frozen, setFrozen] = useState<string>(), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true), [ratio, setRatio] = useState('3 / 4');
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null);
  const stopLoop = useRef<(() => void) | null>(null), latest = useRef<LiveSample | undefined>(undefined);
  const generation = useRef(0), lastSpoken = useRef(-Infinity), previousCount = useRef(0);
  const debug = import.meta.env.DEV && new URLSearchParams(window.location.search).get('debug') === '1';
  function release() {
    generation.current++; stopLoop.current?.(); stopLoop.current = null;
    stopCamera(stream.current); stream.current = null;
    if (video.current) { video.current.pause(); video.current.srcObject = null; }
    latest.current = undefined; voice.cancel();
  }
  async function restart() {
    release(); const token = generation.current;
    setPhase('starting'); setError(''); setSample(undefined); setFrozen(undefined); setStale(false); previousCount.current = 0;
    try {
      const s = await openCamera();
      if (token !== generation.current) { stopCamera(s); return; }
      stream.current = s;
      const element = video.current; if (!element) { stopCamera(s); return; }
      element.srcObject = s; await element.play();
      if (token !== generation.current) return;
      setRatio(`${element.videoWidth} / ${element.videoHeight}`); setPhase('live');
      s.getVideoTracks().forEach(track => { track.onended = () => { if (stream.current !== s) return; release(); setSample(undefined); setPhase('error'); setError('カメラとの接続が切れました。再起動してください。'); }; });
      stopLoop.current = startLiveAnalysis(element, {
        onSample: next => {
          if (token !== generation.current) return;
          latest.current = next; setSample(next); setStale(false);
          const count = next.analysis.boxes.filter(b => b.confidence === 'confirmed').length;
          if (voice.enabled && count > 0 && count !== previousCount.current && performance.now() - lastSpoken.current >= LIVE.voiceCooldownMs) {
            voice.say('白いシールの候補があります'); lastSpoken.current = performance.now(); previousCount.current = count;
          }
          if (!count) previousCount.current = 0;
        },
        onStale: () => { if (token === generation.current) { latest.current = undefined; setSample(undefined); setStale(true); } },
        onError: e => { if (token === generation.current) { release(); setSample(undefined); setPhase('error'); setError(e.message); } },
      }, { debug });
    } catch (e) {
      if (token !== generation.current) return;
      release(); setPhase('error'); setError(e instanceof Error ? e.message : 'カメラを起動できませんでした。再試行してください。');
    }
  }
  useEffect(() => {
    void restart();
    const suspend = () => {
      if (document.hidden) { release(); setSample(undefined); setFrozen(undefined); setPhase('stopped'); setError('映像を停止しました。再開してください。'); }
    };
    const hide = () => { release(); setSample(undefined); setFrozen(undefined); setPhase('stopped'); };
    document.addEventListener('visibilitychange', suspend); window.addEventListener('pagehide', hide);
    return () => { release(); document.removeEventListener('visibilitychange', suspend); window.removeEventListener('pagehide', hide); };
  }, []);
  function freeze() {
    const current = latest.current; if (!current || stale) return;
    const image = current.canvas.toDataURL('image/jpeg', .92);
    release(); setFrozen(image); setSample(current); setPhase('frozen');
  }
  function toggleVoice() {
    const next = !voiceOn; setVoiceOn(next); voice.enabled = next;
    if (next) { previousCount.current = 0; lastSpoken.current = -Infinity; voice.unlock('音声案内を開始します'); } else voice.cancel();
  }
  const boxes = sample?.analysis.boxes ?? [];
  const message = phase === 'starting' ? 'カメラを準備しています' : phase === 'stopped' ? '映像を停止しています' : phase === 'error' ? 'チェックを再開してください' : stale ? '映像の更新を待っています' : boxes.length ? `白いシールの候補が${boxes.length}件あります` : sample?.analysis.reason ?? '白いシールの候補を探しています';
  return <main className="live-layout"><section className="live-copy">
    <span className="eyebrow">LIVE CHECK / 黒い服 × 白いシール</span><h1>その場で、確認。</h1>
    <p className="lead">黒い服を枠の中に収めてください。<br/>白いシールの候補を、映像に表示します。</p>
    <div className={`live-message ${boxes.length ? 'has-detection' : ''}`} role="status" aria-live="polite"><span className="status-dot live"/><p>{message}</p></div>
    <p className="live-instructions">明るい室内でスマホを固定し、ゆっくり背中を向けて一瞬静止してください。服が小さい場合は、枠に収まる範囲で近づいてください。</p>
    <p className="muted small">無地の黒い服と、約3cmの白いシール専用です。枠は候補を示します。検出されない場合も、服の状態を保証するものではありません。</p>
    {error && <div className="error" role="alert"><AlertCircle size={20}/><p>{error}</p></div>}
    <div className="live-actions">{phase === 'live' ? <button className="primary" disabled={!sample || stale} onClick={freeze}>画面を止めて確認<Pause size={19}/></button> : phase === 'frozen' ? <button className="primary" onClick={() => void restart()}>ライブ映像に戻る<Play size={19}/></button> : phase !== 'starting' ? <button className="primary" onClick={() => void restart()}>カメラを再起動<Camera size={19}/></button> : null}
      <button className="voice-toggle" aria-pressed={voiceOn} onClick={toggleVoice}>{voiceOn ? <Volume2 size={18}/> : <VolumeX size={18}/>}音声案内<span>{voiceOn ? 'オン' : 'オフ'}</span><i className={voiceOn ? 'switch on' : 'switch'}/></button>
      <button className="text-button" onClick={onClose}>終了して映像を破棄</button>
    </div>
    {debug && sample && <details className="live-diagnostics" open><summary>ライブ診断（開発時のみ）</summary><p>解析 {sample.processingMs.toFixed(1)}ms / 更新 {sample.frame} / 黒い領域 {(sample.analysis.darkCoverage * 100).toFixed(0)}% / {sample.analysis.width} × {sample.analysis.height}px</p><pre>{JSON.stringify(sample.analysis.candidates, null, 2)}</pre></details>}
  </section><section className="live-panel"><div className="camera-stage live-stage" style={{ aspectRatio: ratio }}>
    <video ref={video} autoPlay muted playsInline aria-label="ライブカメラ映像" onResize={() => { if (video.current?.videoWidth) setRatio(`${video.current.videoWidth} / ${video.current.videoHeight}`); }}/>
    {frozen && <img className="live-frozen" src={frozen} alt="一時停止した解析映像"/>}
    {(phase === 'starting' || phase === 'error' || phase === 'stopped') && <div className="camera-placeholder"><Camera size={34}/><p>{message}</p></div>}
    {(phase === 'live' || phase === 'frozen') && <><div className="torso-guide" style={{ left: `${LIVE_GUIDE.x * 100}%`, top: `${LIVE_GUIDE.y * 100}%`, width: `${LIVE_GUIDE.width * 100}%`, height: `${LIVE_GUIDE.height * 100}%` }}><i/><i/><i/><i/></div>
    {sample && <svg className="live-overlay" viewBox={`0 0 ${sample.analysis.width} ${sample.analysis.height}`} aria-label={`${boxes.length}件のライブ検出枠`}>{boxes.map((b, i) => <rect key={i} className={`detection-box live-detection ${b.confidence === 'single-frame' ? 'provisional' : ''}`} x={b.x - 2} y={b.y - 2} width={b.width + 4} height={b.height + 4}/>)}</svg>}
    <span className="live-badge">{phase === 'frozen' ? 'PAUSED' : 'LIVE'}</span><span className="guide-label">黒い服を枠の中に</span></>}
  </div><p className="camera-footnote"><LockKeyhole size={13}/> 映像は端末内で解析。保存・送信しません。</p></section></main>;
}
