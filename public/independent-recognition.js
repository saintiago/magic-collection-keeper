import { mergeReadings, validReading } from "./recognition-race.js";

// One additional request per stable capture, at most one in flight and fifty in
// a scanner session. Cancellation cannot guarantee cancellation of model billing.
export function createIndependentRecognition({
  primary,
  independent,
  maximumCalls = 50,
}) {
  let epoch = 0,
    calls = 0,
    active = null,
    controller = new AbortController();
  return {
    kind: "hybrid",
    prepare: () => primary.prepare(),
    dispose() {
      epoch++;
      calls = 0;
      active = null;
      controller.abort();
      controller = new AbortController();
      primary.dispose();
      independent.dispose?.();
    },
    async recognize(canvas, options) {
      options.signal?.throwIfAborted();
      const current = epoch;
      if (active || calls >= maximumCalls)
        return primary.recognize(canvas, options);
      const signal = AbortSignal.any([
        controller.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
      signal.throwIfAborted();
      calls++;
      let first,
        second,
        primaryError,
        independentError,
        finished = 0,
        delivered = false,
        resolveFirst,
        rejectFirst;
      const promise = new Promise((resolve, reject) => {
        resolveFirst = resolve;
        rejectFirst = reject;
      });
      const abort = () => rejectFirst(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      function publish() {
        if (current !== epoch || signal.aborted) return;
        const readings = [];
        if (first)
          readings.push({
            result: first,
            provider: first.measurement?.provider || "lambda",
          });
        if (second)
          readings.push({ result: second, provider: "bedrock-independent" });
        const merged = mergeReadings(readings);
        if (merged) {
          const value = { ...merged, provisional: finished < 2 };
          if (!delivered) {
            delivered = true;
            resolveFirst(value);
          } else options.onUpdate?.(value);
        } else if (finished === 2 && !delivered) {
          if (first || second) resolveFirst(first || second);
          else
            rejectFirst(
              primaryError ||
                independentError ||
                Error("Recognition unavailable"),
            );
        }
        if (finished === 2) signal.removeEventListener("abort", abort);
      }
      const primaryTask = primary.recognize(canvas, {
        ...options,
        signal,
        onUpdate: (result) => {
          first = result;
          publish();
        },
      });
      primaryTask.then(
        (result) => {
          if (!first || !validReading(first)) first = result;
          finished++;
          publish();
        },
        (error) => {
          primaryError = error;
          finished++;
          publish();
        },
      );
      const independentTask = independent.recognize(canvas, {
        ...options,
        signal,
      });
      active = independentTask;
      independentTask
        .then(
          (result) => {
            second = result;
            finished++;
            publish();
          },
          (error) => {
            independentError = error;
            finished++;
            publish();
          },
        )
        .finally(() => {
          if (active === independentTask) active = null;
        });
      return promise;
    },
  };
}
