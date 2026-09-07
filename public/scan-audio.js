export function createScanAudio({
  makeContext = () => new (window.AudioContext || window.webkitAudioContext)(),
} = {}) {
  let context,
    muted = false;
  const heard = new Set();
  return {
    async activate() {
      try {
        context ||= makeContext();
        await context.resume();
        return context.state === "running";
      } catch {
        return false;
      }
    },
    setMuted(value) {
      muted = value;
    },
    cue(kind, attempt) {
      if (heard.has(attempt)) return;
      heard.add(attempt);
      if (muted || context?.state !== "running") return;
      const notes = kind === "success" ? [660, 880] : [230, 170];
      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator(),
          gain = context.createGain();
        const at = context.currentTime + index * 0.11;
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.09, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.1);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
        oscillator.start(at);
        oscillator.stop(at + 0.11);
      });
    },
    close() {
      const old = context;
      context = undefined;
      heard.clear();
      return old?.close().catch(() => {});
    },
  };
}
