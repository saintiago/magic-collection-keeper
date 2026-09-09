// Pure visual gate: OCR names never determine whether a physical transition occurred.
export function visualDifference(a, b) {
  if (!a || !b) return Infinity;
  let mean = 0;
  for (let i = 0; i < a.length; i += 4) mean += b[i] - a[i];
  mean /= a.length / 4;
  let total = 0;
  for (let i = 0; i < a.length; i += 4) total += Math.abs(b[i] - a[i] - mean);
  return total / (a.length / 4);
}
export function hasDetail(frame) {
  let sum = 0,
    square = 0;
  for (let i = 0; i < frame.length; i += 4) {
    sum += frame[i];
    square += frame[i] ** 2;
  }
  const n = frame.length / 4;
  return Math.sqrt(Math.max(0, square / n - (sum / n) ** 2)) > 12;
}
export function createTransitionGate({
  settleMs = 720,
  departureMs = 200,
} = {}) {
  let anchor,
    candidate,
    stableSince,
    departureSince,
    armed = true;
  return {
    observe(frame, now, presence = "single") {
      if (presence !== "single") {
        candidate = undefined;
        stableSince = undefined;
        // An overlap cannot rearm capture. An observed empty guide can establish
        // physical departure, preserving consecutive identical-copy scanning.
        if (
          presence === "none" &&
          !armed &&
          visualDifference(anchor, frame) > 16
        ) {
          departureSince ??= now;
          if (now - departureSince >= departureMs) armed = true;
        } else departureSince = undefined;
        return false;
      }
      if (!armed) {
        if (visualDifference(anchor, frame) > 16) {
          departureSince ??= now;
          if (now - departureSince >= departureMs) {
            armed = true;
            candidate = undefined;
            stableSince = undefined;
          }
        } else departureSince = undefined;
      }
      if (!armed) return false;
      if (!candidate || visualDifference(candidate, frame) > 5) {
        candidate = frame;
        stableSince = now;
        return false;
      }
      if (now - stableSince < settleMs || !hasDetail(frame)) return false;
      anchor = frame;
      armed = false;
      departureSince = undefined;
      return true;
    },
  };
}
