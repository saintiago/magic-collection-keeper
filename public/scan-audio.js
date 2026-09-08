export function createScanAudio({
  makeContext = () => new (window.AudioContext || window.webkitAudioContext)(),
  onState = () => {},
} = {}) {
  let context,
    muted = false,
    unavailable = false;
  const handled = new Set();
  const state = () =>
    muted
      ? "muted"
      : unavailable
        ? "unavailable"
        : context?.state || "inactive";
  const notify = () => onState(state());
  function play(notes) {
    if (muted || context?.state !== "running") return false;
    try {
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
      return true;
    } catch {
      unavailable = true;
      notify();
      return false;
    }
  }
  return {
    state,
    async activate({ test = false } = {}) {
      try {
        if (!context || context.state === "closed") {
          context = makeContext();
          context.onstatechange = notify;
        }
        unavailable = false;
        const active = context;
        notify();
        await active.resume();
        if (context !== active) return false;
        notify();
        if (test) play([440]);
        return state() === "running";
      } catch {
        unavailable = true;
        notify();
        return false;
      }
    },
    setMuted(value) {
      muted = value;
      notify();
    },
    cue(kind, attempt) {
      if (handled.has(attempt)) return false;
      // Expire skipped cues too: resuming must never announce an old card.
      handled.add(attempt);
      return play(kind === "success" ? [660, 880] : [230, 170]);
    },
    close() {
      const old = context;
      context = undefined;
      if (old) old.onstatechange = null;
      handled.clear();
      notify();
      return old?.close().catch(() => {});
    },
  };
}
