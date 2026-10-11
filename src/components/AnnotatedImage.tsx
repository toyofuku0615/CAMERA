import { useEffect, useRef, useState } from 'react';
import type { CheckResult } from '../vision/frames';

export function AnnotatedImage({ result, debug = false }: { result: CheckResult; debug?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const trigger = useRef<HTMLButtonElement>(null), close = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const initialPinch = useRef(0), initialZoom = useRef(1);
  useEffect(() => {
    if (!expanded) return;
    pointers.current.clear();
    close.current?.focus();
    const frame = requestAnimationFrame(() => {
      const box = result.analysis.boxes[0], element = viewport.current;
      if (!box || !element) return;
      element.scrollLeft = (box.x + box.width / 2) / result.width * element.scrollWidth - element.clientWidth / 2;
      element.scrollTop = (box.y + box.height / 2) / result.height * element.scrollHeight - element.clientHeight / 2;
    });
    return () => { cancelAnimationFrame(frame); trigger.current?.focus(); };
  }, [expanded]);
  const picture = <div className="annotated" style={{ aspectRatio: `${result.width}/${result.height}` }}>
    <img src={result.image} alt="撮影した静止画。細いリングの箇所を確認してください。" draggable={false}/>
    <svg viewBox={`0 0 ${result.width} ${result.height}`} aria-label={`${result.analysis.boxes.length}件の検出リング`}>
      {debug && <><rect className="debug-region" {...result.analysis.region}/><rect className="debug-cloth" {...result.analysis.clothBounds}/></>}
      {result.analysis.boxes.map((b, i) => <ellipse className="detection-ring" key={i} cx={b.x + b.width / 2} cy={b.y + b.height / 2}
        rx={Math.max(b.width / 2 + 7, 12)} ry={Math.max(b.height / 2 + 7, 12)}/>)}
    </svg>
  </div>;
  if (!result.image) return <p className="missing-image">撮影できませんでした</p>;
  return <>
    <button ref={trigger} className="image-button" aria-label="問題箇所を拡大" onClick={e => { if (e.detail > 1) return; setZoom(2); setExpanded(true); }}>{picture}</button>
    {expanded && <div className="lightbox" role="dialog" aria-modal="true" aria-label="問題箇所の拡大"
      onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()} onKeyDown={e => {
        if (e.key === 'Escape') setExpanded(false);
        if (e.key === 'Tab') {
          e.preventDefault();
          const target = document.activeElement === close.current ? e.currentTarget.querySelector<HTMLButtonElement>('.zoom-control') : close.current;
          target?.focus();
        }
      }}>
      <button ref={close} className="lightbox-close" onClick={() => setExpanded(false)} aria-label="拡大を閉じる">×</button>
      <div ref={viewport} className="zoom-viewport"><div className="zoom-picture" style={{ width: `${zoom * 100}%` }}
        onPointerDown={e => {
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          e.currentTarget.setPointerCapture(e.pointerId);
          if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; initialPinch.current = Math.hypot(a.x - b.x, a.y - b.y); initialZoom.current = zoom; }
        }} onPointerMove={e => {
          if (!pointers.current.has(e.pointerId)) return;
          const previous = pointers.current.get(e.pointerId)!;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 1 && viewport.current) { viewport.current.scrollLeft -= e.clientX - previous.x; viewport.current.scrollTop -= e.clientY - previous.y; }
          if (pointers.current.size === 2 && initialPinch.current) { const [a, b] = [...pointers.current.values()]; setZoom(Math.max(1, Math.min(4, initialZoom.current * Math.hypot(a.x - b.x, a.y - b.y) / initialPinch.current))); }
        }} onPointerUp={e => { pointers.current.delete(e.pointerId); }} onPointerCancel={e => { pointers.current.delete(e.pointerId); }}>
        {picture}
      </div></div>
      <button className="quiet-button zoom-control" onClick={() => setZoom(z => z >= 3 ? 1 : z + 1)}>{zoom >= 3 ? '全体を見る' : '拡大する'}</button>
    </div>}
  </>;
}
