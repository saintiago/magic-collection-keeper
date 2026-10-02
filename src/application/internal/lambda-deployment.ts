/** HTTP API Lambda adapter shared by the independently packaged serving runtimes. */

import type { Diagnostics } from './diagnostics.js';
import { ApplicationError } from './failures.js';
import { failureResponse, type TransportRequest, type TransportResponse } from './transport.js';

export function createConsoleDiagnostics(
  write: (line: string) => void = (line) => console.info(line),
): Diagnostics {
  return {
    record(event) {
      write(JSON.stringify({ event: 'keeper-operation', ...event }));
    },
  };
}

export interface ApiGatewayHttpApiEvent {
  readonly rawPath?: unknown;
  readonly rawQueryString?: unknown;
  readonly queryStringParameters?: unknown;
  readonly headers?: unknown;
  readonly body?: unknown;
  readonly isBase64Encoded?: unknown;
  readonly requestContext?: unknown;
}

export interface LambdaHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export function createApiGatewayHandler(target: {
  handle(request: TransportRequest): Promise<TransportResponse>;
}): (event: unknown) => Promise<LambdaHttpResponse> {
  if (typeof target?.handle !== 'function') {
    throw new TypeError('createApiGatewayHandler requires the application request boundary.');
  }
  return async function handler(event: unknown): Promise<LambdaHttpResponse> {
    if (isPreflight(event)) return { statusCode: 204, headers: {}, body: '' };
    const response = await dispatch(target, event);
    return { statusCode: response.status, headers: response.headers, body: response.body };
  };
}

function isPreflight(event: unknown): boolean {
  const record = readRecord(event);
  const requestContext = readRecord(record?.requestContext);
  const http = readRecord(requestContext?.http);
  return readString(http?.method)?.toUpperCase() === 'OPTIONS';
}

async function dispatch(
  target: { handle(request: TransportRequest): Promise<TransportResponse> },
  event: unknown,
): Promise<TransportResponse> {
  let request: TransportRequest;
  try {
    request = readTransportRequest(event);
  } catch (cause) {
    return failureResponse(
      new ApplicationError('invalid-request', 'The invocation is not a readable HTTP request.', {
        cause,
      }),
    );
  }
  try {
    return await target.handle(request);
  } catch (cause) {
    return failureResponse(
      cause instanceof ApplicationError
        ? cause
        : new ApplicationError('unavailable', 'The operation could not be completed.', { cause }),
    );
  }
}

function readTransportRequest(event: unknown): TransportRequest {
  if (typeof event !== 'object' || event === null) {
    throw new TypeError('The invocation carries no event.');
  }
  const record = event as Readonly<Record<string, unknown>>;
  const requestContext = readRecord(record.requestContext);
  const http = readRecord(requestContext?.http);
  const method = readString(http?.method);
  const path = readString(record.rawPath) ?? readString(http?.path);
  if (method === null || path === null) {
    throw new TypeError('The invocation carries no method or path.');
  }
  const claims = readRecord(readRecord(requestContext?.authorizer)?.jwt)?.claims;
  return {
    method,
    path,
    query: readQuery(record.queryStringParameters),
    authentication: { claims: normalizeAuthorizerClaims(claims) },
    body: readBody(record),
    requestId: readString(requestContext?.requestId),
  };
}

function normalizeAuthorizerClaims(value: unknown): Readonly<Record<string, unknown>> | null {
  const claims = readRecord(value);
  if (claims === null) return null;
  const expiry = claims.exp;
  return typeof expiry === 'string' && /^\d+$/.test(expiry)
    ? { ...claims, exp: Number(expiry) }
    : claims;
}

function readBody(event: Readonly<Record<string, unknown>>): string | null {
  const body = event.body;
  if (body === null || body === undefined) return null;
  if (typeof body !== 'string') {
    throw new TypeError('The invocation carries a body that is not text.');
  }
  return event.isBase64Encoded === true ? Buffer.from(body, 'base64').toString('utf8') : body;
}

function readQuery(value: unknown): Readonly<Record<string, string>> | null {
  const query = readRecord(value);
  if (query === null) return null;
  const values: Record<string, string> = {};
  for (const [name, entry] of Object.entries(query)) {
    if (typeof entry === 'string') values[name] = entry;
  }
  return values;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
