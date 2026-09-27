// Each port must already validate identity and hydrate canonical printings.
export function validReading(result) {
  return (
    result?.status === "possible" &&
    result.suggested === true &&
    result.selected &&
    result.candidates?.some((card) => card.id === result.selected.id)
  );
}
function titleEvidence(result) {
  const evidence = result.measurement?.evidence;
  if (evidence?.independentIdentity)
    return evidence.identityBasis === "visible_title"
      ? "independent-visible-title"
      : "independent-artwork";
  if (evidence?.identityTitleCorroborated || evidence?.titleAgrees)
    return evidence.titleEvidenceProvider === "vision_language"
      ? "visible-title-model"
      : "visible-title-ocr";
  return "visual";
}
export function mergeReadings(readings) {
  const valid = readings.filter(({ result }) => validReading(result));
  if (!valid.length) return null;
  // Whole-title corroboration outranks visual-only similarity. Model self-confidence
  // and similarities from different runtimes are deliberately never compared.
  const strength = ({ result }) =>
    ({
      visual: 0,
      "independent-artwork": 0,
      "independent-visible-title": 1,
      "visible-title-ocr": 2,
      "visible-title-model": 2,
    })[titleEvidence(result)];
  const ranked = [...valid].sort((a, b) => strength(b) - strength(a));
  const chosen = ranked[0];
  const candidates = [
    ...new Map(
      ranked
        .flatMap(({ result }) => [result.selected, ...result.candidates])
        .map((card) => [card.id, card]),
    ).values(),
  ];
  const identities = new Set(
    candidates.map((card) => card.oracle_id || card.id),
  );
  return {
    ...chosen.result,
    candidates,
    recognition: valid
      .flatMap(
        ({ result, provider }) =>
          result.recognition || [
            {
              printing_id: result.selected.id,
              provider,
              evidence: titleEvidence(result),
            },
          ],
      )
      .slice(0, 3),
    disagreement: identities.size > 1,
    provisional: false,
    measurement: {
      ...chosen.result.measurement,
      provider: chosen.provider,
      comparedProviders: valid.map(({ provider }) => provider),
      disagreement: identities.size > 1,
    },
  };
}

export async function raceReadings({
  local,
  remote,
  delayMs,
  signal,
  onUpdate = () => {},
}) {
  signal?.throwIfAborted();
  let startRemote,
    timer,
    firstDelivered = false,
    remoteStarted = false,
    finished = 0;
  const readings = [],
    errors = [];
  let resolveFirst, rejectFirst, finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const first = new Promise((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  const abort = () => {
    finish();
    clearTimeout(timer);
    rejectFirst(signal.reason || new DOMException("Cancelled", "AbortError"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  function settle(result, provider, error) {
    if (signal?.aborted) return;
    finished++;
    if (error) errors.push(error);
    else readings.push({ result, provider });
    const merged = mergeReadings(readings);
    if (merged && !firstDelivered) {
      firstDelivered = true;
      // A fast valid local read avoids the remote request entirely.
      if (!remoteStarted) {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        finish();
      }
      resolveFirst({
        ...merged,
        completion,
        provisional: remoteStarted && finished < 2,
      });
    } else if (merged && firstDelivered) onUpdate(merged);
    if (!merged && !remoteStarted) startRemote();
    if (finished === 2) {
      finish();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!firstDelivered) {
        if (readings.length) resolveFirst(readings[0].result);
        else rejectFirst(errors[0] || Error("Recognition unavailable"));
      }
    }
  }
  startRemote = () => {
    if (remoteStarted || signal?.aborted) return;
    remoteStarted = true;
    clearTimeout(timer);
    Promise.resolve()
      .then(remote)
      .then(
        (result) => settle(result, "lambda"),
        (error) => settle(null, "lambda", error),
      );
  };
  timer = setTimeout(startRemote, delayMs);
  Promise.resolve()
    .then(local)
    .then(
      (result) => settle(result, "browser-onnx"),
      (error) => settle(null, "browser-onnx", error),
    );
  return first;
}
