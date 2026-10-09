import { useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import type { CheckResult } from '../vision/frames';
export function AnnotatedImage({ result, debug = false }: { result: CheckResult; debug?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const picture = <div className="annotated" style={{ aspectRatio: `${result.width}/${result.height}` }}>
    <img src={result.image} alt="撮影画像。オレンジの枠は確認が必要な箇所です。" />
    <svg viewBox={`0 0 ${result.width} ${result.height}`} aria-label={`${result.analysis.boxes.length}件の検出枠`}>
      {debug && <><rect className="debug-region" {...result.analysis.region} /><rect className="debug-cloth" {...result.analysis.clothBounds} /></>}
      {result.analysis.boxes.map((b, i) => <g key={i}><rect className="detection-box" x={b.x - 4} y={b.y - 4} width={b.width + 8} height={b.height + 8} /><rect x={b.x - 4} y={Math.max(0, b.y - 26)} width="25" height="22" rx="3" fill="#ce713d"/><text x={b.x + 8} y={Math.max(16, b.y - 10)} textAnchor="middle" fill="white" fontSize="16">{i + 1}</text></g>)}
    </svg>
  </div>;
  if (!result.image) return <div className="missing-image">画像を取得できませんでした</div>;
  return <><button className="image-button" aria-label="撮影画像を拡大" onClick={() => setExpanded(true)}>{picture}<span className="image-expand"><Maximize2 size={16}/> 拡大</span></button>
    {expanded && <div className="lightbox" role="dialog" aria-modal="true" aria-label="撮影画像の拡大" onKeyDown={e => { if (e.key === 'Escape') setExpanded(false); if (e.key === 'Tab') { e.preventDefault(); (e.currentTarget.querySelector('button') as HTMLButtonElement)?.focus(); } }}><button autoFocus className="lightbox-close" onClick={() => setExpanded(false)} aria-label="拡大を閉じる"><X/></button>{picture}<p>指で拡大して確認できます</p></div>}
  </>;
}
