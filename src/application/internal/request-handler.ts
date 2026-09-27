/**
 * One backend invocation (docs/application.md#construction-and-request-boundary).
 *
 * The handler resolves the route, verifies the caller's identity before any private operation runs,
 * derives the trusted context from that identity, validates the transport input, races the operation
 * against its deadline and reports one consistent response. Every piece of invocation state — the
 * deadline, the identity, the diagnostics record — belongs to that invocation alone; a timed-out or
 * cancelled write reports that its outcome is unknown instead of a failure.
 */

import { recordDiagnostic, type Diagnostics } from './diagnostics.js';
import { ApplicationError, translateFailure } from './errors.js';
import {
  hasAuthenticationEvidence,
  readAuthenticatedIdentity,
  trustedContextFor,
  type IdentityVerifier,
} from './identity.js';
import {
  CANCELLED_MESSAGE,
  INVALID_BODY_MESSAGE,
  TIMEOUT_MESSAGE,
  createRequestDeadline,
  failureResponse,
  jsonResponse,
  raceDeadline,
  readQueryValues,
  resolveRoute,
  type RequestDeadline,
  type Route,
  type RouteCall,
  type TransportRequest,
  type TransportResponse,
} from './transport.js';

export interface RequestHandlerDependencies {
  readonly routes: readonly Route[];
  readonly identity: IdentityVerifier;
  /** Deadline Application enforces on one invocation. */
  readonly requestTimeoutMs: number;
  readonly diagnostics: Diagnostics;
}

/** Builds the interactive entry point over one environment's routes and identity verification. */
export function createRequestHandler(
  dependencies: RequestHandlerDependencies,
): (request: TransportRequest) => Promise<TransportResponse> {
  const { routes, identity, requestTimeoutMs, diagnostics } = dependencies;

  return async function handle(request: TransportRequest): Promise<TransportResponse> {
    const startedAt = Date.now();
    let operation = 'application.request';
    let requestId: string | null = null;
    let matched: { readonly route: Route; readonly call: RouteCall } | null = null;
    let failure: ApplicationError | null = null;
    let response: TransportResponse;
    const deadline = createRequestDeadline(requestTimeoutMs, request?.signal ?? null);
    try {
      requestId = readRequestId(request?.requestId);
      const resolution = resolveRoute(routes, request?.method, request?.path);
      if (resolution.kind === 'route-not-found') {
        throw new ApplicationError('route-not-found', 'The requested operation does not exist.');
      }
      if (resolution.kind === 'method-not-allowed') {
        throw new ApplicationError(
          'method-not-allowed',
          'The requested operation does not accept this method.',
        );
      }
      const route = resolution.route;
      operation = route.operation;
      const evidence = request?.authentication ?? null;
      const authenticated = await raceDeadline(
        Promise.resolve(readAuthenticatedIdentity(identity, evidence)),
        deadline,
      );
      if (
        authenticated === null &&
        (route.access === 'authenticated' || hasAuthenticationEvidence(evidence))
      ) {
        throw new ApplicationError('unauthorized', 'Sign in to use the collection.');
      }
      const call: RouteCall = {
        body: readJsonBody(request?.body),
        params: resolution.params,
        query: readQueryValues(request?.query),
        context: trustedContextFor(authenticated),
        signal: deadline.signal,
        requestId,
      };
      matched = { route, call };
      response = jsonResponse(await raceDeadline(Promise.resolve(route.call(call)), deadline));
    } catch (cause) {
      failure = classifyFailure(cause, deadline);
      response = failureResponse(failure, readRecovery(matched));
    } finally {
      deadline.release();
      recordDiagnostic(diagnostics, {
        operation,
        requestId,
        outcome: failure === null ? 'ok' : 'failed',
        failureCode: failure?.code ?? null,
        durationMs: Date.now() - startedAt,
      });
    }
    return response;
  };
}

function readRequestId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null;
}

function readJsonBody(body: string | null | undefined): Readonly<Record<string, unknown>> {
  if (body === null || body === undefined || body === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new ApplicationError('invalid-request', INVALID_BODY_MESSAGE, { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApplicationError('invalid-request', INVALID_BODY_MESSAGE);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * The failure one invocation reports. A deadline or a caller cancellation wins over the operation's
 * own failure: neither establishes that a write failed.
 */
function classifyFailure(cause: unknown, deadline: RequestDeadline): ApplicationError {
  if (deadline.isExpired()) {
    return new ApplicationError('timeout', TIMEOUT_MESSAGE, { cause });
  }
  if (deadline.isCancelled()) {
    return new ApplicationError('cancelled', CANCELLED_MESSAGE, { cause });
  }
  return translateFailure(cause);
}

function readRecovery(
  matched: { readonly route: Route; readonly call: RouteCall } | null,
): Readonly<Record<string, string>> | null {
  if (matched === null || matched.route.replayOperationId === undefined) {
    return null;
  }
  let operationId: string | null;
  try {
    operationId = matched.route.replayOperationId(matched.call);
  } catch {
    operationId = null;
  }
  return operationId === null ? null : { operationId };
}
