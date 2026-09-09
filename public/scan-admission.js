import { visualDifference, hasDetail } from "./scan-transition.js";

// Cheap visual tracking runs continuously. Geometry validates a timestamped
// captured frame; its processing time never starts another stability interval.
export function createScanAdmission({
  settleMs = 600,
  departureMs = 200,
} = {}) {
  let candidate,
    latest,
    latestAt,
    stableSince,
    anchor,
    emptySince,
    checkedAt = -Infinity;
  function matches(frame, capturedAt) {
    return (
      capturedAt >= stableSince &&
      latestAt - capturedAt <= 450 &&
      visualDifference(latest, frame) <= 5
    );
  }
  return {
    track(frame, now) {
      latest = frame;
      latestAt = now;
      if (!candidate || visualDifference(candidate, frame) > 5) {
        candidate = frame;
        stableSince = now;
        emptySince = undefined;
      }
    },
    matches,
    validate(frame, capturedAt, presence) {
      if (capturedAt < checkedAt) return false;
      checkedAt = capturedAt;
      if (!matches(frame, capturedAt)) return false;
      if (presence !== "single") {
        if (
          presence === "none" &&
          anchor &&
          visualDifference(anchor, frame) > 16
        ) {
          emptySince ??= capturedAt;
          if (capturedAt - emptySince >= departureMs) anchor = undefined;
        } else emptySince = undefined;
        // Measured overlap/ambiguity requires fresh stable evidence afterward.
        stableSince = capturedAt;
        return false;
      }
      emptySince = undefined;
      if (latestAt - stableSince < settleMs || !hasDetail(frame)) return false;
      if (anchor && visualDifference(anchor, frame) <= 16) return false;
      anchor = frame;
      return true;
    },
  };
}
