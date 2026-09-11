import { visualDifference, hasDetail } from "./scan-transition.js";

// Brief stability and geometry establish a usable frame, never card identity.
// SCAN-10 removes artwork/departure latches after a capture.
export function createScanAdmission({ settleMs = 600 } = {}) {
  let candidate, latest, latestAt, stableSince;
  let checkedAt = -Infinity,
    admittedAt = -Infinity;
  function matches(frame, capturedAt) {
    return (
      capturedAt >= stableSince &&
      latestAt - capturedAt <= 12000 &&
      visualDifference(latest, frame) <= 5
    );
  }
  return {
    track(frame, now) {
      latest = frame;
      if (
        !candidate ||
        now - latestAt > 500 ||
        visualDifference(candidate, frame) > 5
      ) {
        candidate = frame;
        stableSince = now;
      }
      latestAt = now;
    },
    matches,
    validate(frame, capturedAt, presence) {
      if (capturedAt < checkedAt) return false;
      checkedAt = capturedAt;
      if (!matches(frame, capturedAt)) return false;
      if (presence !== "single") {
        stableSince = capturedAt;
        return false;
      }
      if (
        capturedAt <= admittedAt ||
        latestAt - stableSince < settleMs ||
        !hasDetail(frame)
      )
        return false;
      admittedAt = capturedAt;
      return true;
    },
  };
}
