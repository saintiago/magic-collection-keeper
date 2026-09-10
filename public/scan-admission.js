import { visualDifference, hasDetail } from "./scan-transition.js";

// Cheap visual tracking runs continuously. Geometry validates a timestamped
// captured frame; its processing time never starts another stability interval.
export function createScanAdmission({
  settleMs = 600,
  departureMs = 600,
} = {}) {
  let candidate,
    latest,
    latestAt,
    stableSince,
    anchor,
    emptySince,
    emptyAt,
    emptyChecks = 0,
    checkedAt = -Infinity;
  function resetDeparture() {
    emptySince = emptyAt = undefined;
    emptyChecks = 0;
  }
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
        resetDeparture();
      }
      latestAt = now;
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
          if (emptyAt === undefined || capturedAt > emptyAt) {
            emptyAt = capturedAt;
            emptyChecks++;
          }
          if (emptyChecks >= 3 && capturedAt - emptySince >= departureMs)
            anchor = undefined;
        } else resetDeparture();
        // Measured overlap/ambiguity requires fresh stable evidence afterward.
        stableSince = capturedAt;
        return false;
      }
      resetDeparture();
      if (latestAt - stableSince < settleMs || !hasDetail(frame)) return false;
      // A stable different-looking surface is still the same physical attempt
      // until sustained checked absence. Glare/contrast/name changes cannot
      // release this latch, nor can repeated use of one geometry result.
      if (anchor) return false;
      anchor = frame;
      return true;
    },
  };
}
