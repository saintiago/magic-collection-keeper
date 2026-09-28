/**
 * Browser authentication of one deployment (docs/application.md#interface,
 * docs/application.md#configuration-and-lifecycle).
 *
 * Application owns this environment's sign-in: the password and refresh flows of the retained user
 * pool's app client, the tokens the browsing session keeps and the verified account it reports.
 * UserInterface supplies the credential interaction it presents and receives the identity
 * capability it presents, so replacing the provider or the session policy stays with Application
 * and changes no page. The app client identity and the region come from the public settings only;
 * no secret reaches the browser, and the decoded token is presentation state — every backend
 * invocation still carries the token and the backend re-checks the issuer, the audience and the
 * expiry before a private operation runs.
 *
 * Pending authentication work owns the session it started from: a transition (a sign-in, a
 * sign-out or an ended session) invalidates every older refresh and sign-in, so a late answer can
 * never restore an account the visitor left, clear a newer session or report a stale identity.
 * A refusal of the credentials or of the refresh token ends the session; a service failure or
 * throttling keeps it, so the next invocation can retry against the same session.
 */

import { z } from 'zod';

import type { PublicApplicationSettings } from './configuration.js';
import { ApplicationError } from './failures.js';

/** One verified account Application reports to the UserInterface. */
export interface BrowserAccount {
  /** Verified account identity, stable across sign-ins of the same account. */
  readonly accountId: string;
  /** Name to present for the account, or null when the token reports none. */
  readonly displayName: string | null;
}

/** Identity capability Application supplies to the UserInterface. */
export interface BrowserIdentity {
  /** Current verified account, or null while the visitor is signed out. */
  current(): BrowserAccount | null;
  /** Starts this environment's sign-in interaction. */
  signIn(): void | Promise<void>;
  /** Ends the session in Application's authentication. */
  signOut(): void | Promise<void>;
  /** Reports verified-account changes, including sign-out; returns the unsubscribe function. */
  subscribe(listener: (account: BrowserAccount | null) => void): () => void;
}

/** One credential prompt the UserInterface presents; the sign-in form, or the new-password step. */
export interface BrowserCredentialPrompt {
  /**
   * Asks the visitor for credentials. `new-password` is the invitation step of a first sign-in:
   * the named account has to choose its own password before the session starts.
   */
  request(
    mode: 'sign-in' | 'new-password',
    account: string | null,
  ): Promise<{ readonly username: string; readonly password: string }>;
}

/** Where one browsing session keeps its tokens; a reload of the page keeps the session. */
export interface BrowserSessionStore {
  read(): string | null;
  write(value: string | null): void;
}

export interface BrowserAuthenticationOptions {
  readonly settings: Pick<PublicApplicationSettings, 'authentication'>;
  /** Sign-in interaction of this deployment; the shell asks for it when the visitor signs in. */
  readonly prompt: BrowserCredentialPrompt;
  readonly fetch?: typeof globalThis.fetch;
  readonly storage?: BrowserSessionStore;
  /** Current time in milliseconds; tests control refresh without changing the system clock. */
  readonly now?: () => number;
}

export interface BrowserAuthentication {
  /** Verified-account capability the UserInterface presents. */
  readonly identity: BrowserIdentity;
  /**
   * Current ID token, refreshed before expiry; null while signed out or after terminal rejection.
   * A retryable provider failure throws `unavailable` and keeps the session for another attempt.
   */
  token(): Promise<string | null>;
}

/** Keeps the session in the browsing session of this tab, never in shared or durable storage. */
export function createBrowserSessionStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key = 'keeper-session',
): BrowserSessionStore {
  return {
    read: () => storage.getItem(key),
    write(value) {
      if (value === null) {
        storage.removeItem(key);
        return;
      }
      storage.setItem(key, value);
    },
  };
}

/** Refreshes this long before the token expires, so a request never races the expiry. */
const refreshMarginMs = 60_000;

const sessionSchema = z.object({
  idToken: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().int(),
  accountId: z.string().min(1).max(128),
  displayName: z.string().min(1).nullable(),
});

type StoredSession = z.infer<typeof sessionSchema>;

/**
 * The sign-in service refused the request (unknown account, wrong password, expired refresh
 * token). It is distinct from the service being unreachable: only a refusal ends the session.
 */
class CognitoRefusal extends Error {}

/**
 * Cognito error codes that report the service rather than the credentials, so an invocation may
 * retry them against the same session. Every other refused response is a terminal rejection.
 */
const cognitoServiceFailures = new Set([
  'InternalErrorException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'RequestLimitExceeded',
  'LimitExceededException',
]);

/**
 * Builds the browser authentication of one environment. Only the public app client identity and
 * region are used; the tokens belong to the browsing session and are dropped when the visitor
 * signs out or the service refuses the refresh token.
 */
export function createBrowserAuthentication(
  options: BrowserAuthenticationOptions,
): BrowserAuthentication {
  const settings = options?.settings?.authentication;
  if (typeof settings?.appClientId !== 'string' || typeof settings?.region !== 'string') {
    throw new TypeError('Browser authentication requires the public app client settings.');
  }
  const prompt = options.prompt;
  if (typeof prompt?.request !== 'function') {
    throw new TypeError('Browser authentication requires its credential prompt.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Browser authentication requires a fetch implementation.');
  }
  const storage = options.storage ?? browserSessionStore();
  const now = options.now ?? Date.now;
  const state = {
    session: readStoredSession(storage),
    refreshing: null as Promise<string | null> | null,
    /**
     * Counts the session transitions. Each pending authentication operation took the generation it
     * started from; when the session moved on since, its answer no longer owns the session and is
     * dropped instead of storing tokens, clearing state or reporting an identity.
     */
    generation: 0,
  };
  const listeners = new Set<(account: BrowserAccount | null) => void>();

  function report(): void {
    const account = state.session === null ? null : accountOf(state.session);
    for (const listener of [...listeners]) {
      listener(account);
    }
  }

  /** Begins one session transition and returns the generation the caller now owns. */
  function beginTransition(): number {
    state.generation += 1;
    return state.generation;
  }

  function owns(generation: number): boolean {
    return state.generation === generation;
  }

  function remember(session: StoredSession): void {
    beginTransition();
    state.session = session;
    // A refresh of the previous session is obsolete; the new session refreshes on its own.
    state.refreshing = null;
    storage.write(JSON.stringify(session));
    report();
  }

  function forget(): void {
    beginTransition();
    state.session = null;
    state.refreshing = null;
    storage.write(null);
  }

  async function cognito(
    action: string,
    body: unknown,
  ): Promise<Readonly<Record<string, unknown>>> {
    let response: Response;
    try {
      response = await fetchImpl(`https://cognito-idp.${settings.region}.amazonaws.com/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': `AWSCognitoIdentityProviderService.${action}`,
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new Error('The sign-in service could not be reached.', { cause });
    }
    const payload = await readPayload(response);
    if (!response.ok) {
      throw readCognitoFailure(response.status, payload);
    }
    return payload;
  }

  async function refresh(): Promise<string | null> {
    const current = state.session;
    if (current === null) {
      return null;
    }
    const generation = state.generation;
    let payload: Readonly<Record<string, unknown>>;
    try {
      payload = await cognito('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: settings.appClientId,
        AuthParameters: { REFRESH_TOKEN: current.refreshToken },
      });
    } catch (cause) {
      if (!owns(generation)) {
        // The session this refresh belonged to already ended; its answer changes nothing.
        return null;
      }
      // A refusal ends the session; a service that could not be reached keeps it, so the next
      // invocation can try the refresh again.
      if (cause instanceof CognitoRefusal) {
        forget();
        report();
        return null;
      }
      throw new ApplicationError('unavailable', 'The sign-in service could not be reached.', {
        cause,
      });
    }
    if (!owns(generation)) {
      return null;
    }
    const result = readRecord(payload.AuthenticationResult);
    const idToken = readString(result?.IdToken);
    const accessToken = readString(result?.AccessToken) ?? current.accessToken;
    const decoded = idToken === null ? null : decodeAccount(idToken);
    if (idToken === null || decoded === null) {
      forget();
      report();
      return null;
    }
    remember({
      idToken,
      accessToken,
      refreshToken: current.refreshToken,
      expiresAt: now() + readExpiresIn(result?.ExpiresIn),
      accountId: decoded.accountId,
      displayName: decoded.displayName,
    });
    return idToken;
  }

  return {
    identity: {
      current: () => (state.session === null ? null : accountOf(state.session)),
      async signIn() {
        // The sign-in becomes the only work that may touch the session from here on.
        const generation = beginTransition();
        const signIn = await prompt.request('sign-in', null);
        if (!owns(generation)) {
          return;
        }
        const username = signIn.username.trim();
        if (username.length === 0 || signIn.password.length === 0) {
          throw new Error('Enter the username and password of your account.');
        }
        let payload = await cognito('InitiateAuth', {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: settings.appClientId,
          AuthParameters: { USERNAME: username, PASSWORD: signIn.password },
        });
        if (!owns(generation)) {
          return;
        }
        if (payload.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
          const session = readString(payload.Session);
          if (session === null) {
            throw new Error('This sign-in challenge is not supported.');
          }
          const challenge = readRecord(payload.ChallengeParameters);
          const next = await prompt.request('new-password', username);
          if (!owns(generation)) {
            return;
          }
          payload = await cognito('RespondToAuthChallenge', {
            ClientId: settings.appClientId,
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: session,
            ChallengeResponses: {
              USERNAME: readString(challenge?.USER_ID_FOR_SRP) ?? username,
              NEW_PASSWORD: next.password,
            },
          });
          if (!owns(generation)) {
            return;
          }
        }
        const result = readRecord(payload.AuthenticationResult);
        const idToken = readString(result?.IdToken);
        const refreshToken = readString(result?.RefreshToken);
        const accessToken = readString(result?.AccessToken);
        if (idToken === null || refreshToken === null || accessToken === null) {
          throw new Error('This sign-in challenge is not supported.');
        }
        const decoded = decodeAccount(idToken);
        if (decoded === null) {
          throw new Error('The signed-in account could not be read.');
        }
        if (!owns(generation)) {
          return;
        }
        remember({
          idToken,
          accessToken,
          refreshToken,
          expiresAt: now() + readExpiresIn(result?.ExpiresIn),
          accountId: decoded.accountId,
          displayName: decoded.displayName,
        });
      },
      signOut() {
        forget();
        report();
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    async token() {
      const current = state.session;
      if (current === null) {
        return null;
      }
      if (now() < current.expiresAt - refreshMarginMs) {
        return current.idToken;
      }
      if (state.refreshing === null) {
        const refreshing = refresh();
        state.refreshing = refreshing;
        // Only the refresh that still owns the state clears it: a transition in between may already
        // have started the refresh of the session that replaced this one. The caller of token()
        // receives the refresh's own outcome; this chain only clears the slot.
        void refreshing
          .catch(() => undefined)
          .then(() => {
            if (state.refreshing === refreshing) {
              state.refreshing = null;
            }
          });
      }
      return state.refreshing;
    },
  };
}

/**
 * The browsing session of this page. A browsing context that grants no session storage (an opaque
 * origin, for example) keeps the session only for the life of the page instead of failing.
 */
function browserSessionStore(): BrowserSessionStore {
  try {
    const storage = globalThis.sessionStorage;
    return storage === undefined ? transientStore() : createBrowserSessionStore(storage);
  } catch {
    return transientStore();
  }
}

/** A store that keeps nothing beside the session the authentication already holds in memory. */
function transientStore(): BrowserSessionStore {
  return {
    read: () => null,
    write() {
      // Nothing outlives the page in this browsing context.
    },
  };
}

function accountOf(session: StoredSession): BrowserAccount {
  return { accountId: session.accountId, displayName: session.displayName };
}

function readStoredSession(storage: BrowserSessionStore): StoredSession | null {
  let raw: string | null;
  try {
    raw = storage.read();
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    storage.write(null);
    return null;
  }
  const session = sessionSchema.safeParse(decoded);
  if (!session.success) {
    storage.write(null);
    return null;
  }
  return session.data;
}

async function readPayload(response: Response): Promise<Readonly<Record<string, unknown>>> {
  try {
    return readRecord(await response.json()) ?? {};
  } catch {
    return {};
  }
}

/**
 * One refused response of the sign-in service, classified by what the caller may do about it. A
 * terminal rejection (unknown account, wrong password, expired refresh token) ends the session; a
 * service failure or throttling keeps it, so the next invocation retries the same session.
 */
function readCognitoFailure(status: number, payload: Readonly<Record<string, unknown>>): Error {
  const message = readString(payload['message']) ?? 'Sign-in failed. Please retry.';
  const reported = readString(payload['__type']) ?? '';
  const name = reported.includes('#') ? reported.slice(reported.lastIndexOf('#') + 1) : reported;
  return status >= 500 || status === 429 || cognitoServiceFailures.has(name)
    ? new Error(message)
    : new CognitoRefusal(message);
}

function readExpiresIn(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value * 1000
    : 3_600_000;
}

/** The account one ID token reports; presentation state only, never an authorization decision. */
function decodeAccount(idToken: string): BrowserAccount | null {
  const segments = idToken.split('.');
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) {
    return null;
  }
  let claims: Readonly<Record<string, unknown>> | null;
  try {
    claims = readRecord(JSON.parse(decodeBase64Url(payload)));
  } catch {
    return null;
  }
  const accountId = readString(claims?.['sub']);
  if (accountId === null || accountId.length > 128) {
    return null;
  }
  return {
    accountId,
    displayName:
      readString(claims?.['name']) ??
      readString(claims?.['preferred_username']) ??
      readString(claims?.['cognito:username']),
  };
}

function decodeBase64Url(value: string): string {
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
