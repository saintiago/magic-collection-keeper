// SPDX-License-Identifier: AGPL-3.0-only
import { raceReadings } from "./recognition-race.js";
// Session preparation is demand-driven. There is no timer that keeps a service warm.
function abortable(promise, signal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () =>
      reject(signal.reason || new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
}

export function createHybridRecognition({
  local,
  cloud,
  onState = () => {},
  prepareDelayMs = 750,
  readyTimeoutMs = 12000,
  hedgeDelayMs = 0,
}) {
  let current,
    active = false;
  async function waitForReadiness(ready, signal) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(
              new Error(
                "Scanner is still preparing. Try this card again shortly.",
              ),
              { code: "SCANNER_PREPARING" },
            ),
          ),
        readyTimeoutMs,
      );
    });
    try {
      return await abortable(Promise.race([ready, timeout]), signal);
    } finally {
      clearTimeout(timer);
    }
  }
  function state(scope, value) {
    if (current === scope) onState(value);
  }
  function cloudReady(scope) {
    if (!scope.cloudTask)
      scope.cloudTask = Promise.resolve()
        .then(() => cloud.prepare({ signal: scope.controller.signal }))
        .then(
          () => {
            scope.controller.signal.throwIfAborted();
            scope.cloudReady = true;
            state(scope, scope.localReady ? "local-ready" : "cloud-ready");
            return cloud;
          },
          (error) => {
            scope.cloudTask = null;
            throw error;
          },
        );
    return scope.cloudTask;
  }
  function start() {
    if (current) return current;
    const scope = { controller: new AbortController(), localReady: false };
    current = scope;
    state(scope, "preparing");
    scope.localTask = Promise.resolve()
      .then(() => local.prepare())
      .then(() => {
        scope.controller.signal.throwIfAborted();
        scope.localReady = true;
        state(scope, "local-ready");
        return local;
      });
    const delayedCloud = new Promise((resolve) => {
      scope.timer = setTimeout(resolve, prepareDelayMs);
      scope.wake = resolve;
    }).then(() => {
      scope.controller.signal.throwIfAborted();
      if (!cloud) return scope.localTask;
      return scope.localReady ? local : cloudReady(scope);
    });
    scope.ready = Promise.any([scope.localTask, delayedCloud]);
    scope.ready.catch(() => state(scope, "unavailable"));
    return scope;
  }
  async function readWithFallback(scope, first, canvas, options) {
    const alternatives = [...new Set([first, first === local ? cloud : local])];
    const failedProviders = [];
    let lastError;
    for (const port of alternatives) {
      if (!port || (port === local && port !== first && !scope.localReady))
        continue;
      options.signal?.throwIfAborted();
      scope.controller.signal.throwIfAborted();
      try {
        if (port === cloud) await abortable(cloudReady(scope), options.signal);
        let result = await port.recognize(canvas, options);
        if (
          port === local &&
          cloud &&
          result.status === "unknown" &&
          result.measurement?.evidence?.topScore >= 0.55 &&
          result.measurement?.evidence?.differentIdentityMargin >= 0.08
        ) {
          // One bounded title corroboration attempt. The service independently
          // reads the title; a weak visual score alone never selects a card.
          try {
            await abortable(cloudReady(scope), options.signal);
            const corroborated = await cloud.recognize(canvas, options);
            result = {
              ...corroborated,
              measurement: {
                ...corroborated.measurement,
                titleFallback: true,
                originalVisual: result.measurement?.evidence,
              },
            };
            return { result, port: cloud, failedProviders };
          } catch (error) {
            options.signal?.throwIfAborted();
            scope.controller.signal.throwIfAborted();
            failedProviders.push({
              provider: cloud.kind,
              name: error.name,
              status: error.status || null,
            });
          }
        }
        return { result, port, failedProviders };
      } catch (error) {
        options.signal?.throwIfAborted();
        scope.controller.signal.throwIfAborted();
        if (port === local) scope.localReady = false;
        failedProviders.push({
          provider: port.kind,
          name: error.name,
          status: error.status || null,
        });
        lastError = error;
      }
    }
    throw lastError || new Error("Recognition unavailable. Please retry.");
  }
  return {
    kind: "hybrid",
    prepare() {
      return start().ready;
    },
    dispose() {
      const scope = current;
      current = null;
      if (scope) {
        scope.controller.abort();
        clearTimeout(scope.timer);
        scope.wake();
      }
      local.dispose?.();
      cloud?.dispose?.();
    },
    async recognize(canvas, { signal, attempt, onUpdate, onStage }) {
      signal?.throwIfAborted();
      if (active) throw new Error("Scanner busy. Retry this card.");
      active = true;
      const scope = start(),
        started = performance.now();
      try {
        if (scope.localReadTask)
          await abortable(
            scope.localReadTask.catch(() => {}),
            signal,
          );
        let first;
        try {
          first = scope.localReady
            ? local
            : scope.cloudReady
              ? cloud
              : await waitForReadiness(scope.ready, signal);
        } catch (error) {
          signal?.throwIfAborted();
          scope.controller.signal.throwIfAborted();
          if (!cloud || !(error instanceof AggregateError)) throw error;
          // A user retry may recover a transient preparation failure.
          first = await abortable(cloudReady(scope), signal);
        }
        if (onUpdate && cloud && first === local && !scope.verificationTask) {
          const combined = AbortSignal.any([
            scope.controller.signal,
            ...(signal ? [signal] : []),
          ]);
          return await raceReadings({
            local: () => {
              const task = local.recognize(canvas, {
                signal: combined,
                attempt,
                onStage,
              });
              scope.localReadTask = task;
              task
                .finally(() => {
                  if (scope.localReadTask === task) scope.localReadTask = null;
                })
                .catch(() => {});
              return task;
            },
            remote: () => {
              const task = (async () => {
                await abortable(cloudReady(scope), combined);
                combined.throwIfAborted();
                return cloud.recognize(canvas, {
                  signal: combined,
                  attempt,
                  onStage,
                });
              })();
              scope.verificationTask = task;
              task
                .finally(() => {
                  if (scope.verificationTask === task)
                    scope.verificationTask = null;
                })
                .catch(() => {});
              return task;
            },
            delayMs: hedgeDelayMs,
            signal: combined,
            onUpdate: (result) => {
              if (current === scope && !combined.aborted) onUpdate(result);
            },
          });
        }
        if (onUpdate && scope.verificationTask && first === local)
          return await local.recognize(canvas, { signal, attempt, onStage });
        const { result, port, failedProviders } = await readWithFallback(
          scope,
          first,
          canvas,
          { signal, attempt, onStage },
        );
        signal?.throwIfAborted();
        scope.controller.signal.throwIfAborted();
        return {
          ...result,
          selected:
            result.status === "possible" &&
            result.suggested === true &&
            result.candidates?.some((c) => c.id === result.selected?.id)
              ? result.selected
              : null,
          measurement: {
            ...result.measurement,
            provider: port.kind,
            failedProviders,
            hybridMs: performance.now() - started,
          },
        };
      } finally {
        active = false;
      }
    },
  };
}
