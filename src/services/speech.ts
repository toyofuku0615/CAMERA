export class VoiceGuide {
  enabled = true;
  private available = typeof window !== 'undefined' && 'speechSynthesis' in window;
  unlock(text = '撮影の準備をします') {
    if (!this.enabled || !this.available) return;
    // Called synchronously from the user's Start tap (Safari's gesture requirement).
    this.say(text);
  }
  say(text: string, maxDuration = 2200) {
    if (!this.enabled || !this.available) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'ja-JP'; utterance.rate = 1.05;
      const voice = window.speechSynthesis.getVoices().find(v => v.lang.startsWith('ja'));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
      // Speech must never delay capture or overlap the next visual countdown.
      clearTimeout(this.timer); this.timer = setTimeout(() => window.speechSynthesis.cancel(), maxDuration);
    } catch { this.available = false; }
  }
  private timer?: ReturnType<typeof setTimeout>;
  cancel() { clearTimeout(this.timer); if (this.available) window.speechSynthesis.cancel(); }
}
