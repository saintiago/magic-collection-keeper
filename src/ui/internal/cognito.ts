/**
 * Browser authentication of one deployment (docs/application.md#configuration-and-lifecycle).
 *
 * The deployment signs in against the app client of this environment's retained user pool with the
 * password and refresh flows that client enables, keeps the returned tokens in the browsing
 * session and reports the verified account the UserInterface presents. The app client identity and
 * the region come from the public settings only; no secret reaches the browser, and the decoded
 * token is presentation state — every backend invocation still carries the token and the backend
 * re-checks the issuer, the audience and the expiry before a private operation runs.
 */

import { z } from 'zod';

import type { PublicApplicationSettings } from '../../application/index.js';

import type { UiAccount, UiIdentity } from './identity.js';

/** One credential prompt of the browser: the sign-in form, or the new-password step. */
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
export interface CognitoSessionStore {
  read(): string | null;
  write(value: string | null): void;
}

export interface CognitoAuthenticationOptions {
  readonly settings: Pick<PublicApplicationSettings, 'authentication'>;
  /** Sign-in interaction of this deployment; the shell asks for it when the visitor signs in. */
  readonly prompt: BrowserCredentialPrompt;
  readonly fetch?: typeof globalThis.fetch;
  readonly storage?: CognitoSessionStore;
  /** Current time in milliseconds; tests control refresh without changing the system clock. */
  readonly now?: () => number;
}

export interface CognitoAuthentication {
  /** Verified-account capability the UserInterface presents. */
  readonly identity: UiIdentity;
  /** Current ID token of the session, refreshed when it is about to expire; null while signed out. */
  token(): Promise<string | null>;
}

/** Keeps the session in the browsing session of this tab, never in shared or durable storage. */
export function createBrowserSessionStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  key = 'keeper-session',
): CognitoSessionStore {
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
 * Builds the browser authentication of one environment. Only the public app client identity and
 * region are used; the tokens belong to the browsing session and are dropped when the visitor
 * signs out or the refresh token stops working.
 */
export function createCognitoAuthentication(
  options: CognitoAuthenticationOptions,
): CognitoAuthentication {
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
  const storage = options.storage ?? createBrowserSessionStore(globalThis.sessionStorage);
  const now = options.now ?? Date.now;
  const state = {
    session: readStoredSession(storage),
    refreshing: null as Promise<string | null> | null,
  };
  const listeners = new Set<(account: UiAccount | null) => void>();

  function report(): void {
    const account = state.session === null ? null : accountOf(state.session);
    for (const listener of [...listeners]) {
      listener(account);
    }
  }

  function remember(session: StoredSession): void {
    state.session = session;
    storage.write(JSON.stringify(session));
    report();
  }

  function forget(): void {
    state.session = null;
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
      throw new CognitoRefusal(readCognitoMessage(payload));
    }
    return payload;
  }

  async function refresh(): Promise<string | null> {
    const current = state.session;
    if (current === null) {
      return null;
    }
    let payload: Readonly<Record<string, unknown>>;
    try {
      payload = await cognito('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: settings.appClientId,
        AuthParameters: { REFRESH_TOKEN: current.refreshToken },
      });
    } catch (cause) {
      // A refusal ends the session; a service that could not be reached keeps it, so the next
      // invocation can try the refresh again.
      if (cause instanceof CognitoRefusal) {
        forget();
        report();
      }
      return null;
    }
    const result = readRecord(payload.AuthenticationResult);
    const idToken = readString(result?.IdToken);
    const accessToken = readString(result?.AccessToken) ?? current.accessToken;
    if (idToken === null) {
      forget();
      report();
      return null;
    }
    const decoded = decodeAccount(idToken);
    if (decoded === null) {
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
        const signIn = await prompt.request('sign-in', null);
        const username = signIn.username.trim();
        if (username.length === 0 || signIn.password.length === 0) {
          throw new Error('Enter the username and password of your account.');
        }
        let payload = await cognito('InitiateAuth', {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: settings.appClientId,
          AuthParameters: { USERNAME: username, PASSWORD: signIn.password },
        });
        if (payload.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
          const session = readString(payload.Session);
          if (session === null) {
            throw new Error('This sign-in challenge is not supported.');
          }
          const challenge = readRecord(payload.ChallengeParameters);
          const next = await prompt.request('new-password', username);
          payload = await cognito('RespondToAuthChallenge', {
            ClientId: settings.appClientId,
            ChallengeName: 'NEW_PASSWORD_REQUIRED',
            Session: session,
            ChallengeResponses: {
              USERNAME: readString(challenge?.USER_ID_FOR_SRP) ?? username,
              NEW_PASSWORD: next.password,
            },
          });
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
        remember({
          idToken,
          accessToken,
          refreshToken,
          expiresAt: now() + readExpiresIn(result?.ExpiresIn),
          accountId: decoded.accountId,
          displayName: decoded.displayName,
        });
      },
      async signOut() {
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
      state.refreshing ??= refresh().finally(() => {
        state.refreshing = null;
      });
      return state.refreshing;
    },
  };
}

function accountOf(session: StoredSession): UiAccount {
  return { accountId: session.accountId, displayName: session.displayName };
}

function readStoredSession(storage: CognitoSessionStore): StoredSession | null {
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

function readCognitoMessage(payload: Readonly<Record<string, unknown>>): string {
  const message = readString(payload['message']);
  return message ?? 'Sign-in failed. Please retry.';
}

function readExpiresIn(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value * 1000
    : 3_600_000;
}

/** The account one ID token reports; presentation state only, never an authorization decision. */
function decodeAccount(idToken: string): UiAccount | null {
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
