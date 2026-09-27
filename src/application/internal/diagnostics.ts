/**
 * Application diagnostics (docs/application.md#configuration-and-lifecycle).
 *
 * One record identifies the operation and its outcome; it never carries request bodies, image
 * data, credentials, account identifiers or collection contents. The sink is supplied by the
 * running environment; the default keeps Application testable without one.
 */

import type { ApplicationFailureCode } from './failures.js';

export interface DiagnosticEvent {
  /** Stable operation identity, for example `search.execute` or `catalog.synchronize`. */
  readonly operation: string;
  /** Transport request identity of the invocation, or null for a finite job. */
  readonly requestId: string | null;
  readonly outcome: 'ok' | 'failed';
  /** Failure code when the operation failed; never a message or a cause. */
  readonly failureCode: ApplicationFailureCode | null;
  /** Milliseconds the operation took, including validation and dispatch. */
  readonly durationMs: number;
}

export interface Diagnostics {
  record(event: DiagnosticEvent): void;
}

export const silentDiagnostics: Diagnostics = {
  record() {
    // Diagnostics are optional; without a sink the application reports nothing.
  },
};

/** Reports one event, and lets a faulty sink fail neither the operation nor its response. */
export function recordDiagnostic(diagnostics: Diagnostics, event: DiagnosticEvent): void {
  try {
    diagnostics.record(event);
  } catch {
    // A diagnostics failure is never a business failure.
  }
}
