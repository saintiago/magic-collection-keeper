import { visualDifference, hasDetail } from "./scan-transition.js";

// Compare card artwork in four patches after geometry has located its bounds.
// Correlation ignores brightness/contrast; flat or partly obscured patches are
// inconclusive. Three independently changed patches are required for replacement.
function artworkPatchCorrelation(a, b, left, top, dx, dy) {
  let sa = 0,
    sb = 0,
    aa = 0,
    bb = 0,
    ab = 0,
    n = 0;
  for (let y = top; y < top + 8; y++)
    for (let x = left; x < left + 10; x++) {
      const i = (y * 24 + x) * 4,
        j = ((y + dy) * 24 + x + dx) * 4;
      const av = (a[i] + a[i + 1] + a[i + 2]) / 3;
      const bv = (b[j] + b[j + 1] + b[j + 2]) / 3;
      sa += av;
      sb += bv;
      aa += av * av;
      bb += bv * bv;
      ab += av * bv;
      n++;
    }
  const va = aa - (sa * sa) / n,
    vb = bb - (sb * sb) / n;
  if (va / n < 100 || vb / n < 100) return 1;
  return (ab - (sa * sb) / n) / Math.sqrt(va * vb);
}
export function differentCardArtwork(a, b) {
  if (!a || !b) return false;
  let changed = 0;
  for (const [left, top] of [
    [2, 4],
    [12, 4],
    [2, 12],
    [12, 12],
  ]) {
    let correlation = -1;
    // Tolerate a one-pixel crop/pose shift in the small normalized signature.
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        correlation = Math.max(
          correlation,
          artworkPatchCorrelation(a, b, left, top, dx, dy),
        );
    if (correlation < 0.4) changed++;
  }
  return changed >= 3;
}

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
    anchorArtwork,
    replacementSince,
    replacementAt,
    replacementArtwork,
    emptySince,
    emptyAt,
    emptyChecks = 0,
    checkedAt = -Infinity;
  function resetReplacement() {
    replacementSince = replacementAt = replacementArtwork = undefined;
  }
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
        resetReplacement();
      }
      latestAt = now;
    },
    matches,
    validate(frame, capturedAt, presence, artwork) {
      if (capturedAt < checkedAt) return false;
      checkedAt = capturedAt;
      if (!matches(frame, capturedAt)) return false;
      if (presence !== "single") {
        resetReplacement();
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
      if (anchor) {
        if (!differentCardArtwork(anchorArtwork, artwork)) {
          resetReplacement();
          return false;
        }
        if (differentCardArtwork(replacementArtwork, artwork))
          resetReplacement();
        replacementArtwork = artwork;
        replacementSince ??= capturedAt;
        if (replacementAt === undefined || capturedAt > replacementAt)
          replacementAt = capturedAt;
        // Reusing a slow worker result must never establish replacement.
        if (replacementAt - replacementSince < settleMs) return false;
      }
      resetReplacement();
      anchorArtwork = artwork;
      anchor = frame;
      return true;
    },
  };
}
