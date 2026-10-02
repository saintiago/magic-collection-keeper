/**
 * Application diagnostics (docs/application.md#configuration-and-lifecycle).
 *
 * One record identifies the operation and its outcome; it never carries request bodies, image
 * data, credentials, account identifiers or collection contents. The sink is supplied by the
 * running environment; the default keeps Application testable without one.
 */

import { isApplicationFailureCode, type ApplicationFailureCode } from './failures.js';

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
  /** Safe finite-job phase; never derived from an exception message. */
  readonly stage?: string;
  /** Sanitized provider classification, when an underlying provider supplied one. */
  readonly providerErrorClassification?: string;
  /** Sanitized provider request/correlation identity, when one was supplied. */
  readonly providerCorrelationId?: string;
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

/** Safe failure context for background-job diagnostics; messages and request values are ignored. */
export function backgroundFailureDiagnostic(
  stage: string,
  cause: unknown,
): Pick<DiagnosticEvent, 'stage' | 'providerErrorClassification' | 'providerCorrelationId'> {
  let current: unknown = cause;
  let classification: string | undefined;
  let correlationId: string | undefined;
  for (let depth = 0; depth < 8 && isRecord(current); depth += 1) {
    const name = safeDiagnosticValue(current['name']);
    const code = safeDiagnosticValue(current['code']);
    if (classification === undefined) {
      if (name !== undefined && !internalErrorNames.has(name)) {
        classification = name;
      } else if (code !== undefined && !isApplicationFailureCode(code)) {
        classification = code;
      }
    }
    const metadata = isRecord(current['$metadata']) ? current['$metadata'] : null;
    correlationId ??=
      safeDiagnosticValue(current['requestId']) ??
      safeDiagnosticValue(current['correlationId']) ??
      safeDiagnosticValue(metadata?.['requestId']);
    current = current['cause'];
  }
  return {
    stage,
    ...(classification === undefined ? {} : { providerErrorClassification: classification }),
    ...(correlationId === undefined ? {} : { providerCorrelationId: correlationId }),
  };
}

const internalErrorNames = new Set(['Error', 'ApplicationError', 'CatalogError', 'UserCardsError']);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function safeDiagnosticValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(value)
    ? value
    : undefined;
}
