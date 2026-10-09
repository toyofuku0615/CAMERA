import { LIVE, type LiveSettings } from '../config';
import type { Box } from './detector';
export class LiveTracker {
  private previous: { box: Box; hits: number }[] = [];
  private lastTime = -Infinity;
  update(boxes: Box[], now: number, settings: LiveSettings = LIVE): Box[] {
    if (now - this.lastTime > settings.staleAfterMs) this.previous = [];
    const used = new Set<number>();
    const next = boxes.map(box => {
      let match = -1, distance = Infinity;
      this.previous.forEach((previous, i) => {
        if (used.has(i)) return;
        const b = previous.box, ratio = Math.max(b.area, box.area) / Math.max(1, Math.min(b.area, box.area));
        const d = Math.hypot(box.x + box.width / 2 - b.x - b.width / 2, box.y + box.height / 2 - b.y - b.height / 2);
        if (ratio <= 3 && d <= settings.matchDistance && d < distance) { distance = d; match = i; }
      });
      if (match >= 0) used.add(match);
      const hits = match >= 0 ? this.previous[match].hits + 1 : 1;
      return { box: { ...box, confidence: hits >= settings.confirmationFrames ? 'confirmed' as const : 'single-frame' as const, support: hits }, hits };
    });
    this.previous = next; this.lastTime = now;
    // Boxes always come from this frame. No fading or stale result retention.
    return next.map(n => n.box);
  }
  clear() { this.previous = []; this.lastTime = -Infinity; }
}
