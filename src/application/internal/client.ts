/**
 * The browser side of the transports (docs/application.md#interface,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The authenticated request attaches the caller's current identity to every backend call, routes
 * the preserved recognition calls to the compute entry point and everything else to the interactive
 * entry point, and rejects a response that belongs to a session that already ended. The catalog
 * and search clients and the browser application compose the component contracts the UserInterface
 * receives; only public settings cross into the browser. Application's own failure envelope keeps
 * its code and message; the preserved compute runtime reports a plain message beside the HTTP
 * status, so that status decides the failure instead of collapsing into an invalid request.
 */

// A type-only import of the Catalog public entry keeps the provider barrel out of a browser
// bundle: the inline `type` form would stay behind as an evaluated empty import (docs/application.md#interface).
import type {
  CardRecord,
  CardPrintingsPage,
  Catalog,
  CatalogReference,
  CatalogResolution,
  CatalogRevision,
  ListCardPrintingsOptions,
  PrintingRecord,
} from '../../catalog/index.js';
import {
  createRecognition,
  createBrowserRecognitionPipeline,
  type Recognition,
  type RecognitionFrameFacts,
} from '../../recognition/index.js';
// Search stays a type-only import here for the same reason: the browser reaches its contract
// through the request it already carries (docs/application.md#interface).
import type {
  SearchEntry,
  SearchEntryTarget,
  SearchPage,
  SearchRequestInput,
} from '../../search/index.js';

import {
  isApplicationFailureCode,
  ApplicationError,
  type ApplicationFailureCode,
} from './failures.js';
import { resolvePublicSettings, type PublicApplicationSettings } from './configuration.js';
import { applicationRoutes } from './paths.js';
import { applicationPath } from './transport.js';

/** The preserved engines' inference paths reach the recognition compute entry point. */
const computePaths: readonly string[] = [
  applicationRoutes.recognition,
  applicationRoutes.recognitionIndependent,
];

export interface AuthenticatedRequestInit {
  readonly method?: string;
  readonly body?: string;
  readonly signal?: AbortSignal | null;
}

/** The callable part of a transport: everything a consumer needs to reach one entry point. */
export type RequestTransport = (path: string, init?: AuthenticatedRequestInit) => Promise<unknown>;

/**
 * One authenticated request to a backend entry point. A caller that has no current identity, or
 * whose session ended while the response was on its way, receives an `unauthorized` failure instead
 * of another session's data.
 */
export interface AuthenticatedRequest extends RequestTransport {
  /** Ends the current session; a response of it is rejected instead of delivered. */
  endSession(): void;
}

export interface AuthenticatedRequestOptions {
  /** Base URL of the entry point; the request path is appended. */
  readonly baseUrl: string;
  /** Supplies the current Cognito ID token, or null when the caller is signed out. */
  readonly token: () => string | null | Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}

/** Builds the authenticated transport one entry point is reached through. */
export function createAuthenticatedRequest(
  options: AuthenticatedRequestOptions,
): AuthenticatedRequest {
  const baseUrl = readBaseUrl(options?.baseUrl);
  const token = options?.token;
  if (typeof token !== 'function') {
    throw new TypeError('createAuthenticatedRequest requires a token provider.');
  }
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createAuthenticatedRequest requires a fetch implementation.');
  }
  let session = 0;

  const request = (async (path: string, init: AuthenticatedRequestInit = {}) => {
    if (typeof path !== 'string' || path.length === 0) {
      throw new TypeError('An authenticated request names its path.');
    }
    const opened = session;
    const credential = await readCredential(token);
    if (opened !== session) {
      throw new ApplicationError('unauthorized', 'The session ended before the request was sent.');
    }
    if (isAborted(init.signal)) {
      throw new ApplicationError('cancelled', 'The invocation was cancelled.');
    }
    let response: Response;
    try {
      response = await fetchImpl(joinBaseUrl(baseUrl, path), {
        method: init.method ?? 'GET',
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: init.signal ?? undefined,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${credential}`,
        },
      });
    } catch (cause) {
      if (isAborted(init.signal)) {
        throw new ApplicationError('cancelled', 'The invocation was cancelled.', { cause });
      }
      throw new ApplicationError('unavailable', 'The service could not be reached.', { cause });
    }
    const payload = await readPayload(response, init.signal);
    if (opened !== session) {
      throw new ApplicationError('unauthorized', 'The session ended before the response arrived.');
    }
    if (!response.ok) {
      throw readFailure(response.status, payload);
    }
    return payload;
  }) as AuthenticatedRequest;

  request.endSession = () => {
    session += 1;
  };
  return request;
}

/**
 * A Catalog contract over the interactive entry point. The preserved recognition resolution and the
 * UserInterface read the published catalog through it instead of reaching the provider directly.
 */
export function createCatalogClient(request: RequestTransport): Catalog {
  if (typeof request !== 'function') {
    throw new TypeError('createCatalogClient requires the authenticated request contract.');
  }
  return {
    async resolve(references: readonly CatalogReference[]): Promise<CatalogResolution> {
      const payload = await request(applicationRoutes.catalogResolve, {
        method: 'POST',
        body: JSON.stringify({ references }),
      });
      return readCatalogResolution(payload);
    },

    async listCardPrintings(
      cardId: string,
      options: ListCardPrintingsOptions = {},
    ): Promise<CardPrintingsPage> {
      const path = withQuery(applicationPath(applicationRoutes.catalogCardPrintings, { cardId }), {
        pageSize: options.pageSize,
        continuation: options.continuation,
      });
      return readPrintingsPage(cardId, await request(path));
    },
  };
}

/**
 * The Search contract over the interactive entry point. The caller sends its request; the
 * transport derives the trusted account from the verified identity, so no account crosses into the
 * browser and a private query is authorized at the backend boundary. A page keeps the provider's
 * result unchanged: stable entry keys, typed targets, basic information, quantity context and the
 * opaque continuation of the query.
 */
export interface SearchClient {
  /** Evaluates one request; an aborted signal withdraws the invocation. */
  execute(request: SearchRequestInput, signal?: AbortSignal): Promise<SearchPage>;
}

/** Builds the Search contract the UserInterface queries through the interactive entry point. */
export function createSearchClient(request: RequestTransport): SearchClient {
  if (typeof request !== 'function') {
    throw new TypeError('createSearchClient requires the authenticated request contract.');
  }
  return {
    async execute(input: SearchRequestInput, signal?: AbortSignal): Promise<SearchPage> {
      const payload = await request(applicationRoutes.search, {
        method: 'POST',
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      return readSearchPage(payload);
    },
  };
}

/** Component access and public configuration the UserInterface receives (docs/user-interface.md#interface). */
export interface UserInterfaceCapabilities {
  readonly settings: PublicApplicationSettings;
  /** Authenticated transport to the interactive backend entry point. */
  readonly request: AuthenticatedRequest;
  /** Public Catalog reads: card and printing information of the presented entries. */
  readonly catalog: Catalog;
  /** Combined Catalog and UserCards queries with their ordering and continuation. */
  readonly search: SearchClient;
  /** Builds the Recognition contract over the browser's preserved engines. */
  readonly createRecognition: () => Recognition<HTMLCanvasElement>;
}

export interface BrowserApplicationOptions {
  /** Raw public settings as the deployment published them; private settings are rejected. */
  readonly settings: unknown;
  readonly token: () => string | null | Promise<string | null>;
  readonly fetch?: typeof globalThis.fetch;
  /** Selects a replacement Recognition implementation; defaults to the preserved engines. */
  readonly createRecognition?: (capabilities: {
    readonly settings: PublicApplicationSettings;
    readonly request: AuthenticatedRequest;
  }) => Recognition<HTMLCanvasElement>;
  /** Builds the UserInterface from the capabilities Application supplies. */
  readonly createUserInterface?: (capabilities: UserInterfaceCapabilities) => unknown;
}

export interface BrowserApplication {
  readonly settings: PublicApplicationSettings;
  /** Authenticated transport to every backend entry point of this environment. */
  readonly request: AuthenticatedRequest;
  readonly createRecognition: () => Recognition<HTMLCanvasElement>;
  /** The constructed UserInterface, when the environment supplied its factory. */
  readonly userInterface: unknown;
  /** Ends the session: outstanding responses are rejected and no further call is sent without one. */
  endSession(): void;
}

/**
 * Assembles the browser runtime: the authenticated transports, the Catalog and Search contracts
 * and the Recognition contract over the preserved browser engines, and hands the UserInterface its
 * capabilities and public configuration.
 */
export function createBrowserApplication(options: BrowserApplicationOptions): BrowserApplication {
  const settings = resolvePublicSettings(options?.settings);
  const api = createAuthenticatedRequest({
    baseUrl: settings.apiBaseUrl,
    token: options.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const compute =
    settings.recognition.computeBaseUrl === null
      ? null
      : createAuthenticatedRequest({
          baseUrl: settings.recognition.computeBaseUrl,
          token: options.token,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
  const request = createEntryPointRequest(api, compute);
  const catalog = createCatalogClient(request);
  const search = createSearchClient(request);
  const createRecognitionContract = () =>
    options.createRecognition !== undefined
      ? options.createRecognition({ settings, request })
      : createRecognition<HTMLCanvasElement>({
          createEnginePipeline: () =>
            createBrowserRecognitionPipeline({
              request,
              cloudEnabled: settings.recognition.cloudEnabled,
            }),
          catalog,
          inspectFrame: inspectCanvasFrame,
        });
  const userInterface =
    typeof options.createUserInterface === 'function'
      ? options.createUserInterface({
          settings,
          request,
          catalog,
          search,
          createRecognition: createRecognitionContract,
        })
      : null;
  return {
    settings,
    request,
    createRecognition: createRecognitionContract,
    userInterface,
    endSession() {
      request.endSession();
    },
  };
}

/**
 * Routes one preserved request to its entry point: inference goes to the compute runtime, catalog
 * hydration and interactive operations go to the interactive API.
 */
function createEntryPointRequest(
  api: AuthenticatedRequest,
  compute: AuthenticatedRequest | null,
): AuthenticatedRequest {
  const request = (async (path: string, init: AuthenticatedRequestInit = {}) => {
    if (isComputePath(path)) {
      if (compute === null) {
        throw new ApplicationError(
          'unavailable',
          'The recognition compute entry point is not enabled in this environment.',
        );
      }
      return compute(path, init);
    }
    return api(path, init);
  }) as AuthenticatedRequest;
  request.endSession = () => {
    api.endSession();
    compute?.endSession();
  };
  return request;
}

/** True for the preserved inference paths, which the compute runtime serves. */
function isComputePath(path: string): boolean {
  const withoutQuery = path.split('?')[0] ?? '';
  return computePaths.includes(withoutQuery);
}

/** Reads the bounded facts of one captured browser frame before any inference starts. */
export function inspectCanvasFrame(frame: HTMLCanvasElement): RecognitionFrameFacts | null {
  if (typeof frame !== 'object' || frame === null) {
    return null;
  }
  const width = frame.width;
  const height = frame.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return null;
  }
  // The preserved browser engines encode a capture as JPEG and learn the encoded size while
  // encoding, so the inspector reports no encoded size.
  return { width, height, format: 'jpeg', encodedBytes: null };
}

async function readCredential(
  token: () => string | null | Promise<string | null>,
): Promise<string> {
  let credential: string | null;
  try {
    credential = await token();
  } catch (cause) {
    throw new ApplicationError('unauthorized', 'Sign in to use the collection.', { cause });
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new ApplicationError('unauthorized', 'Sign in to use the collection.');
  }
  return credential;
}

/**
 * Reads one response body. A withdrawn invocation keeps reporting cancellation while the body is
 * consumed; only a response that fails without a cancellation is an outage.
 */
async function readPayload(
  response: Response,
  signal: AbortSignal | null | undefined,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    if (isAborted(signal)) {
      throw new ApplicationError('cancelled', 'The invocation was cancelled.', { cause });
    }
    throw new ApplicationError('unavailable', 'The service returned an unreadable response.', {
      cause,
    });
  }
}

/**
 * The failure one non-ok response reports. Application's own envelope carries the failure code and
 * message; the preserved compute runtime reports a plain message beside its HTTP status, which the
 * status maps into the same failure vocabulary.
 */
function readFailure(status: number, payload: unknown): ApplicationError {
  const envelope = readObject(payload);
  const error = readObject(envelope?.error);
  const code = error?.code;
  const message = error?.message;
  if (isApplicationFailureCode(code) && typeof message === 'string' && message.length > 0) {
    return new ApplicationError(code, message);
  }
  const providerMessage = typeof envelope?.error === 'string' ? envelope.error.trim() : '';
  return new ApplicationError(
    failureCodeForStatus(status),
    providerMessage === '' ? 'The service rejected the request.' : providerMessage,
  );
}

/** The failure one provider status reports when its body carries no Application failure code. */
function failureCodeForStatus(status: number): ApplicationFailureCode {
  switch (status) {
    case 400:
      return 'invalid-request';
    case 401:
    case 403:
      return 'unauthorized';
    case 404:
      return 'not-found';
    case 405:
      return 'method-not-allowed';
    case 409:
      return 'conflict';
    case 429:
      return 'busy';
    default:
      return status >= 500 ? 'unavailable' : 'invalid-request';
  }
}

function readCatalogResolution(payload: unknown): CatalogResolution {
  const record = readObject(payload);
  const cards = readRecords(record?.cards, 'cardId');
  const printings = readRecords(record?.printings, 'printingId');
  const revision = readObject(record?.revision);
  if (
    record === null ||
    cards === null ||
    printings === null ||
    revision === null ||
    !Array.isArray(record.missing)
  ) {
    throw unreadableCatalog();
  }
  return {
    revision: revision as unknown as CatalogRevision,
    cards: new Map(cards.map((card) => [String(card.cardId), card as unknown as CardRecord])),
    printings: new Map(
      printings.map((printing) => [
        String(printing.printingId),
        printing as unknown as PrintingRecord,
      ]),
    ),
    missing: record.missing as readonly CatalogReference[],
  };
}

function readPrintingsPage(cardId: string, payload: unknown): CardPrintingsPage {
  const record = readObject(payload);
  const printings = readRecords(record?.printings, 'printingId');
  const revision = readObject(record?.revision);
  const continuation = record?.continuation;
  if (
    record === null ||
    printings === null ||
    revision === null ||
    typeof record.cardExists !== 'boolean' ||
    (continuation !== null && typeof continuation !== 'string')
  ) {
    throw unreadableCatalog();
  }
  return {
    cardId,
    cardExists: record.cardExists,
    revision: revision as unknown as CatalogRevision,
    printings: printings as unknown as readonly PrintingRecord[],
    continuation,
  };
}

function unreadableCatalog(): ApplicationError {
  return new ApplicationError('unavailable', 'The catalog response could not be read.');
}

/**
 * Reads one search page. A response outside the declared shape is an unavailable evaluation
 * rather than an empty page or a different outcome (docs/search.md#request-and-result).
 */
function readSearchPage(payload: unknown): SearchPage {
  const record = readObject(payload);
  const entries = record?.entries;
  if (record === null || !Array.isArray(entries)) {
    throw unreadableSearch();
  }
  const read: SearchEntry[] = [];
  for (const candidate of entries) {
    const entry = readSearchEntry(candidate);
    if (entry === null) {
      throw unreadableSearch();
    }
    read.push(entry);
  }
  const totalCount = record.totalCount ?? null;
  const continuation = record.continuation ?? null;
  const revisions = readObject(record.revisions);
  const catalogRevision = revisions?.catalogRevision ?? null;
  const privateRevision = revisions?.privateRevision ?? null;
  if (
    !isSearchCountOrNull(totalCount) ||
    (continuation !== null && typeof continuation !== 'string') ||
    !isSearchIdentifier(catalogRevision) ||
    !isSearchIdentifierOrNull(privateRevision)
  ) {
    throw unreadableSearch();
  }
  return {
    entries: read,
    totalCount,
    continuation,
    revisions: { catalogRevision, privateRevision },
  };
}

/** One entry of a search page, or null when the response does not carry the declared shape. */
function readSearchEntry(value: unknown): SearchEntry | null {
  const entry = readObject(value);
  const entryKey = entry?.entryKey;
  const target = readSearchTarget(entry?.target);
  const card = readObject(entry?.card);
  const cardId = card?.cardId;
  const name = card?.name;
  const matchedName = card?.matchedName ?? null;
  if (
    entry === null ||
    target === null ||
    !isSearchIdentifier(entryKey) ||
    card === null ||
    !isSearchIdentifier(cardId) ||
    !isSearchIdentifier(name) ||
    (matchedName !== null && typeof matchedName !== 'string')
  ) {
    return null;
  }
  const printing = readSearchPrinting(entry.printing);
  if (printing === null && entry.printing !== null) {
    return null;
  }
  const quantity = readSearchQuantity(entry.quantity);
  if (quantity === null && entry.quantity !== null) {
    return null;
  }
  return {
    entryKey,
    target,
    card: { cardId, name, matchedName: matchedName === null ? null : String(matchedName) },
    printing,
    quantity,
  };
}

/** Typed target of one entry, at the level the query requested. */
function readSearchTarget(value: unknown): SearchEntryTarget | null {
  const target = readObject(value);
  const kind = target?.kind;
  const cardId = target?.cardId;
  const printingId = target?.printingId;
  const copyId = target?.copyId;
  if (kind === 'card' && isSearchIdentifier(cardId)) {
    return { kind, cardId };
  }
  if (kind === 'printing' && isSearchIdentifier(printingId)) {
    return { kind, printingId };
  }
  if (kind === 'copy' && isSearchIdentifier(copyId)) {
    return { kind, copyId };
  }
  return null;
}

/** Printing information of one entry; null at card level. */
function readSearchPrinting(value: unknown): SearchEntry['printing'] {
  if (value === null) {
    return null;
  }
  const printing = readObject(value);
  const printingId = printing?.printingId;
  const edition = printing?.edition;
  const collectorNumber = printing?.collectorNumber;
  const language = printing?.language;
  if (
    printing === null ||
    !isSearchIdentifier(printingId) ||
    !isSearchIdentifier(edition) ||
    !isSearchIdentifier(collectorNumber) ||
    !isSearchIdentifier(language)
  ) {
    return null;
  }
  return { printingId, edition, collectorNumber, language };
}

/** Quantity context of one entry: both counts exact, or null when the query evaluated none. */
function readSearchQuantity(value: unknown): SearchEntry['quantity'] {
  if (value === null) {
    return null;
  }
  const quantity = readObject(value);
  if (quantity === null) {
    return null;
  }
  const copies = quantity.copies;
  const intended = quantity.intended;
  if (!isSearchCountOrNull(copies) || !isSearchCountOrNull(intended)) {
    return null;
  }
  return { copies, intended };
}

function isSearchCountOrNull(value: unknown): value is number | null {
  return value === null || isSearchCount(value);
}

function isSearchIdentifierOrNull(value: unknown): value is string | null {
  return value === null || isSearchIdentifier(value);
}

function isSearchCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSearchIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function unreadableSearch(): ApplicationError {
  return new ApplicationError('unavailable', 'The search response could not be read.');
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readRecords(
  value: unknown,
  identityKey: string,
): readonly Readonly<Record<string, unknown>>[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const records: Readonly<Record<string, unknown>>[] = [];
  for (const entry of value) {
    const record = readObject(entry);
    if (record === null || typeof record[identityKey] !== 'string') {
      return null;
    }
    records.push(record);
  }
  return records;
}

function readBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('An authenticated transport requires its base URL.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new TypeError('The authenticated transport requires an absolute base URL.', { cause });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('The authenticated transport requires an http or https base URL.');
  }
  return value;
}

function isAborted(signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true;
}

function joinBaseUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

function withQuery(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      query.set(name, String(value));
    }
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}
