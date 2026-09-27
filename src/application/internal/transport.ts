/**
 * The backend transport boundary (docs/application.md#interface,
 * docs/application.md#construction-and-request-boundary).
 *
 * A transport request carries the method and path, the transport input, the authentication
 * evidence, a request identity and the caller's cancellation signal; a transport response carries
 * one status, JSON body and no-store headers. The router is shared by every backend runtime so the
 * routes, their access level and their failures stay one contract.
 */

import type { TrustedUserContext } from '../../usercards/index.js';

import { ApplicationError, transportStatus } from './errors.js';
import type { TransportAuthentication } from './identity.js';

export interface TransportRequest {
  /** HTTP method of the invocation, for example `POST`. */
  readonly method: string;
  /** Request path, for example `/api/collection/copies`. */
  readonly path: string;
  /** Query values as the transport received them; repeated values keep their first occurrence. */
  readonly query?: Readonly<Record<string, string | readonly string[] | undefined>> | null;
  /** Authentication evidence presented by the caller. */
  readonly authentication?: TransportAuthentication | null;
  /** Raw JSON request body, or null when the operation takes none. */
  readonly body?: string | null;
  /** Transport request identity for diagnostics; never a credential or private content. */
  readonly requestId?: string | null;
  /** Cancellation signal of the caller. */
  readonly signal?: AbortSignal | null;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Access level of one route: public operations may run anonymously, private ones never do. */
export type RouteAccess = 'public' | 'authenticated';

export interface RouteCall {
  /** Parsed JSON body object; empty when the transport carried none. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | undefined>>;
  /** Verified context of an authenticated route; null while a public route runs anonymously. */
  readonly context: TrustedUserContext | null;
  /** Deadline and cancellation signal of this invocation. */
  readonly signal: AbortSignal;
  readonly requestId: string | null;
}

export interface Route {
  /** Stable operation identity reported to diagnostics. */
  readonly operation: string;
  readonly method: string;
  /** Path template; `:name` segments become call parameters. */
  readonly path: string;
  readonly access: RouteAccess;
  /**
   * Operation identity of a replayable action, read from the validated transport input. A timed-out
   * replayable invocation reports it so the caller can recover the recorded outcome.
   */
  readonly replayOperationId?: (call: RouteCall) => string | null;
  /** Runs the operation and returns the payload of a successful response. */
  readonly call: (call: RouteCall) => unknown | Promise<unknown>;
}

export type RouteResolution =
  | {
      readonly kind: 'matched';
      readonly route: Route;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'method-not-allowed' }
  | { readonly kind: 'route-not-found' };

/** Matches one request against the route table, keeping an unknown path distinct from a wrong method. */
export function resolveRoute(
  routes: readonly Route[],
  method: unknown,
  path: unknown,
): RouteResolution {
  if (
    typeof method !== 'string' ||
    method.length === 0 ||
    typeof path !== 'string' ||
    path.length === 0
  ) {
    throw new ApplicationError('invalid-request', 'A request carries an HTTP method and a path.');
  }
  const requested = method.toUpperCase();
  let pathMatched = false;
  for (const route of routes) {
    const params = matchPath(route.path, path);
    if (params === null) {
      continue;
    }
    pathMatched = true;
    if (route.method.toUpperCase() === requested) {
      return { kind: 'matched', route, params };
    }
  }
  return pathMatched ? { kind: 'method-not-allowed' } : { kind: 'route-not-found' };
}

/** Expands one route template into a request path, encoding every parameter. */
export function applicationPath(
  template: string,
  params: Readonly<Record<string, string>> = {},
): string {
  const path = template
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? encodeURIComponent(readParameterValue(params, segment.slice(1)))
        : segment,
    )
    .join('/');
  return path;
}

const transportHeaders: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function jsonResponse(payload: unknown, status = 200): TransportResponse {
  let body: string;
  try {
    body = JSON.stringify(payload ?? null);
  } catch (cause) {
    throw new ApplicationError('unavailable', 'The operation outcome could not be reported.', {
      cause,
    });
  }
  return { status, headers: transportHeaders, body };
}

/** One failure response; a replayable timeout also names the operation to recover. */
export function failureResponse(
  error: ApplicationError,
  recovery: Readonly<Record<string, string>> | null = null,
): TransportResponse {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(recovery === null ? {} : { recovery }),
      },
    },
    transportStatus(error.code),
  );
}

/** Normalizes the received query values into the first value of each parameter. */
export function readQueryValues(
  query: TransportRequest['query'],
): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  if (query === null || query === undefined) {
    return values;
  }
  for (const [name, value] of Object.entries(query)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && first !== null) {
      values[name] = first;
    }
  }
  return values;
}

export const TIMEOUT_MESSAGE =
  'The operation did not report an outcome before the transport deadline; its committed outcome is unknown.';
export const CANCELLED_MESSAGE = 'The caller withdrew the invocation.';
export const INVALID_BODY_MESSAGE = 'The request body must be a JSON object.';

export interface RequestDeadline {
  /** Deadline and cancellation signal the invocation runs under. */
  readonly signal: AbortSignal;
  /** True once the transport deadline elapsed before the operation reported an outcome. */
  isExpired(): boolean;
  /** True when the caller withdrew the invocation. */
  isCancelled(): boolean;
  /** Releases the deadline timer and the caller listener; safe to call more than once. */
  release(): void;
}

/**
 * One invocation's deadline and cancellation. The timer and the caller listener are temporary
 * resources of a single invocation and are released when it finishes.
 */
export function createRequestDeadline(
  timeoutMs: number,
  caller: AbortSignal | null | undefined,
): RequestDeadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort(new DOMException(TIMEOUT_MESSAGE, 'TimeoutError'));
  }, timeoutMs);
  timer.unref?.();
  const onCallerAbort = () => {
    controller.abort(caller?.reason ?? new DOMException(CANCELLED_MESSAGE, 'AbortError'));
  };
  if (caller !== null && caller !== undefined) {
    if (caller.aborted) {
      onCallerAbort();
    } else {
      caller.addEventListener('abort', onCallerAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    isExpired: () => expired,
    isCancelled: () => caller?.aborted === true,
    release() {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/**
 * Waits for one invocation's outcome, and stops waiting when its deadline or cancellation fires.
 * The operation itself is not interrupted: a timed-out write may still commit, so the caller
 * recovers the recorded outcome instead of retrying the action.
 */
export function raceDeadline<T>(work: Promise<T>, deadline: RequestDeadline): Promise<T> {
  const signal = deadline.signal;
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(cause);
      },
    );
  });
}

function matchPath(pattern: string, path: string): Readonly<Record<string, string>> | null {
  const patternSegments = splitPath(pattern);
  const pathSegments = splitPath(path);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index] ?? '';
    const pathSegment = pathSegments[index] ?? '';
    if (patternSegment.startsWith(':')) {
      if (pathSegment.length === 0) {
        return null;
      }
      params[patternSegment.slice(1)] = decodePathSegment(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

function splitPath(path: string): readonly string[] {
  const withoutQuery = path.split('?')[0]?.split('#')[0] ?? '';
  return withoutQuery.split('/').filter((segment) => segment.length > 0);
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (cause) {
    throw new ApplicationError('invalid-request', 'The request path is not valid.', { cause });
  }
}

function readParameterValue(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') {
    throw new TypeError(`The route path requires the ${name} parameter.`);
  }
  return value;
}
