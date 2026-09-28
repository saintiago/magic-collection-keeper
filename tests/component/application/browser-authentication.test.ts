/**
 * Component scope: the browser authentication Application supplies to the UserInterface
 * (docs/application.md#interface, docs/application.md#configuration-and-lifecycle).
 *
 * The sign-in against this environment's app client, the token it hands the authenticated
 * transport, the session transitions and the classification of the service's refusals are
 * exercised with a controlled sign-in service and session store; the sign-in page itself is
 * covered by the packaged browser journey.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserAuthentication,
  createBrowserSessionStore,
  type BrowserCredentialPrompt,
  type BrowserSessionStore,
} from '../../../src/application/index.js';

const settings = {
  environment: 'test',
  apiBaseUrl: 'https://api.test.keeper.example',
  authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
  recognition: { cloudEnabled: false, computeBaseUrl: null },
  capabilities: { sourceImports: true },
} as const;

const endpoint = 'https://cognito-idp.us-east-1.amazonaws.com/';

function memoryStorage(): {
  readonly store: BrowserSessionStore;
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    store: createBrowserSessionStore({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    }),
  };
}

function idToken(claims: Readonly<Record<string, unknown>>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

function session(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    idToken: idToken({ sub: 'cognito-alice', name: 'Alice' }),
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Date.now() + 3_600_000,
    accountId: 'cognito-alice',
    displayName: 'Alice',
    ...overrides,
  });
}

/** One credential prompt that answers with fixed values and records the steps it was asked for. */
function promptFor(
  ...answers: readonly { readonly username: string; readonly password: string }[]
) {
  const modes: string[] = [];
  const prompt: BrowserCredentialPrompt = {
    request: vi.fn(async (mode) => {
      modes.push(mode);
      const answer = answers[modes.length - 1] ?? answers[0];
      if (answer === undefined) {
        throw new Error('The journey supplied no credentials.');
      }
      return answer;
    }),
  };
  return { prompt, modes };
}

function cognitoAnswer(payload: Readonly<Record<string, unknown>>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/x-amz-json-1.1' },
  });
}

function cognitoService(
  answer: (
    target: string,
    body: Readonly<Record<string, unknown>>,
  ) => { readonly status?: number; readonly payload: Readonly<Record<string, unknown>> },
) {
  const calls: { readonly target: string; readonly body: Readonly<Record<string, unknown>> }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe(endpoint);
    const headers = new Headers(init?.headers);
    const target = headers.get('x-amz-target') ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Readonly<Record<string, unknown>>;
    calls.push({ target, body });
    const response = answer(target, body);
    return new Response(JSON.stringify(response.payload), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/x-amz-json-1.1' },
    });
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

/** A completion the case resolves later, so an answer of the service arrives when it chooses. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('browser authentication', () => {
  it('signs in with the environment’s app client and reports the verified account', async () => {
    const { store, values } = memoryStorage();
    const { prompt, modes } = promptFor({
      username: 'alice@example.test',
      password: 'correct horse battery staple',
    });
    const { calls, fetchImpl } = cognitoService(() => ({
      payload: {
        AuthenticationResult: {
          IdToken: idToken({ sub: 'cognito-alice', name: 'Alice' }),
          AccessToken: 'access-token',
          RefreshToken: 'refresh-token',
          ExpiresIn: 3600,
        },
      },
    }));
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });
    const reported: (string | null)[] = [];
    authentication.identity.subscribe((account) => reported.push(account?.accountId ?? null));

    expect(authentication.identity.current()).toBeNull();
    await authentication.identity.signIn();

    expect(modes).toEqual(['sign-in']);
    expect(calls).toEqual([
      {
        target: 'AWSCognitoIdentityProviderService.InitiateAuth',
        body: {
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: 'keeper-test-client',
          AuthParameters: {
            USERNAME: 'alice@example.test',
            PASSWORD: 'correct horse battery staple',
          },
        },
      },
    ]);
    expect(authentication.identity.current()).toEqual({
      accountId: 'cognito-alice',
      displayName: 'Alice',
    });
    expect(reported).toEqual(['cognito-alice']);
    await expect(authentication.token()).resolves.toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(values.get('keeper-session')).toContain('refresh-token');
  });

  it('completes the invitation challenge before it starts the session', async () => {
    const { store } = memoryStorage();
    const { prompt, modes } = promptFor(
      { username: 'alice@example.test', password: 'temporary-password' },
      { username: 'alice@example.test', password: 'chosen-password-1' },
    );
    const { calls, fetchImpl } = cognitoService((target) =>
      target.endsWith('InitiateAuth')
        ? {
            payload: {
              ChallengeName: 'NEW_PASSWORD_REQUIRED',
              Session: 'challenge-session',
              ChallengeParameters: { USER_ID_FOR_SRP: 'cognito-alice' },
            },
          }
        : {
            payload: {
              AuthenticationResult: {
                IdToken: idToken({ sub: 'cognito-alice', 'cognito:username': 'alice' }),
                AccessToken: 'access-token',
                RefreshToken: 'refresh-token',
                ExpiresIn: 3600,
              },
            },
          },
    );
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });

    await authentication.identity.signIn();

    expect(modes).toEqual(['sign-in', 'new-password']);
    expect(calls[1]).toEqual({
      target: 'AWSCognitoIdentityProviderService.RespondToAuthChallenge',
      body: {
        ClientId: 'keeper-test-client',
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        Session: 'challenge-session',
        ChallengeResponses: {
          USERNAME: 'cognito-alice',
          NEW_PASSWORD: 'chosen-password-1',
        },
      },
    });
    expect(authentication.identity.current()?.accountId).toBe('cognito-alice');
  });

  it('reports the service’s own message when the credentials are refused', async () => {
    const { store } = memoryStorage();
    const { prompt } = promptFor({ username: 'alice', password: 'wrong' });
    const { fetchImpl } = cognitoService(() => ({
      status: 400,
      payload: { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' },
    }));
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });

    await expect(authentication.identity.signIn()).rejects.toThrow(
      'Incorrect username or password.',
    );
    expect(authentication.identity.current()).toBeNull();
  });

  it('refreshes an expiring token before an invocation', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() + 30_000 }));
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const refreshed = idToken({ sub: 'cognito-alice', name: 'Alice' });
    const { calls, fetchImpl } = cognitoService(() => ({
      payload: {
        AuthenticationResult: { IdToken: refreshed, AccessToken: 'new-access', ExpiresIn: 3600 },
      },
    }));
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });

    await expect(authentication.token()).resolves.toBe(refreshed);
    expect(calls).toEqual([
      {
        target: 'AWSCognitoIdentityProviderService.InitiateAuth',
        body: {
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          ClientId: 'keeper-test-client',
          AuthParameters: { REFRESH_TOKEN: 'refresh-token' },
        },
      },
    ]);
    expect(JSON.parse(values.get('keeper-session') ?? '{}')).toMatchObject({
      refreshToken: 'refresh-token',
      accountId: 'cognito-alice',
    });
  });

  it('drops a session whose refresh token stopped working and reports the sign-out', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() - 1 }));
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const { fetchImpl } = cognitoService(() => ({
      status: 400,
      payload: { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' },
    }));
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });
    const reported: (string | null)[] = [];
    authentication.identity.subscribe((account) => reported.push(account?.accountId ?? null));

    await expect(authentication.token()).resolves.toBeNull();
    expect(authentication.identity.current()).toBeNull();
    // The ended session is reported to the shell, so it presents the signed-out view.
    expect(reported).toEqual([null]);
    expect(values.has('keeper-session')).toBe(false);
  });

  it('signs out by dropping the session and reporting the account change', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session());
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: cognitoService(() => ({ payload: {} })).fetchImpl,
      storage: store,
    });

    await authentication.identity.signOut();

    expect(authentication.identity.current()).toBeNull();
    expect(values.has('keeper-session')).toBe(false);
    await expect(authentication.token()).resolves.toBeNull();
  });

  it('keeps the session when the sign-in service cannot be reached', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() - 1 }));
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof globalThis.fetch,
      storage: store,
    });

    await expect(authentication.token()).resolves.toBeNull();
    expect(authentication.identity.current()?.accountId).toBe('cognito-alice');
    expect(values.has('keeper-session')).toBe(true);
  });

  it('drops a stored session that is not readable instead of presenting a partial account', () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', '{not json');
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: cognitoService(() => ({ payload: {} })).fetchImpl,
      storage: store,
    });

    expect(authentication.identity.current()).toBeNull();
    expect(values.has('keeper-session')).toBe(false);
  });

  it('keeps a session through a provider failure and refreshes it on the next invocation', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() - 1 }));
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const refreshed = idToken({ sub: 'cognito-alice', name: 'Alice' });
    let calls = 0;
    const { fetchImpl } = cognitoService(() => {
      calls += 1;
      return calls === 1
        ? {
            status: 500,
            payload: { __type: 'InternalErrorException', message: 'Internal server error' },
          }
        : {
            payload: {
              AuthenticationResult: { IdToken: refreshed, AccessToken: 'access', ExpiresIn: 3600 },
            },
          };
    });
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });
    const reported: (string | null)[] = [];
    authentication.identity.subscribe((account) => reported.push(account?.accountId ?? null));

    await expect(authentication.token()).resolves.toBeNull();
    expect(authentication.identity.current()?.accountId).toBe('cognito-alice');
    expect(values.has('keeper-session')).toBe(true);
    // The provider outage reported no identity change, and the session stayed usable.
    expect(reported).toEqual([]);
    await expect(authentication.token()).resolves.toBe(refreshed);
  });

  it('keeps a session through throttling instead of signing the visitor out', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() - 1 }));
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const { fetchImpl } = cognitoService(() => ({
      status: 400,
      payload: { __type: 'TooManyRequestsException', message: 'Slow down.' },
    }));
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });

    await expect(authentication.token()).resolves.toBeNull();
    expect(authentication.identity.current()?.accountId).toBe('cognito-alice');
    expect(values.has('keeper-session')).toBe(true);
  });

  it('does not restore a session a refresh answered after the visitor signed out', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() - 1 }));
    const { prompt } = promptFor({ username: 'unused', password: 'unused' });
    const service = deferred<Response>();
    let started = false;
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: (() => {
        started = true;
        return service.promise;
      }) as typeof globalThis.fetch,
      storage: store,
    });
    const reported: (string | null)[] = [];
    authentication.identity.subscribe((account) => reported.push(account?.accountId ?? null));

    const refreshing = authentication.token();
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    await authentication.identity.signOut();
    service.resolve(
      cognitoAnswer({
        AuthenticationResult: {
          IdToken: idToken({ sub: 'cognito-alice', name: 'Alice' }),
          AccessToken: 'access',
          ExpiresIn: 3600,
        },
      }),
    );
    await expect(refreshing).resolves.toBeNull();

    // The ended session stays ended: its late refresh stored nothing and reported nothing.
    expect(authentication.identity.current()).toBeNull();
    expect(values.has('keeper-session')).toBe(false);
    expect(reported).toEqual([null]);
  });

  it('does not let a refusal of an old session clear the session that replaced it', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() - 1 }));
    const { prompt } = promptFor({ username: 'bob@example.test', password: 'bob-password' });
    const stale = deferred<Response>();
    let calls = 0;
    const bobToken = idToken({ sub: 'cognito-bob', name: 'Bob' });
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return stale.promise;
      }
      return cognitoAnswer({
        AuthenticationResult: {
          IdToken: bobToken,
          AccessToken: 'access',
          RefreshToken: 'bob-refresh',
          ExpiresIn: 3600,
        },
      });
    }) as typeof globalThis.fetch;
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });

    const refreshing = authentication.token();
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });
    await authentication.identity.signOut();
    await authentication.identity.signIn();
    stale.resolve(
      cognitoAnswer(
        { __type: 'NotAuthorizedException', message: 'Refresh Token has expired' },
        400,
      ),
    );
    await expect(refreshing).resolves.toBeNull();

    // Bob keeps the session the stale refusal belonged to nobody.
    expect(authentication.identity.current()?.accountId).toBe('cognito-bob');
    expect(JSON.parse(values.get('keeper-session') ?? '{}')).toMatchObject({
      accountId: 'cognito-bob',
      refreshToken: 'bob-refresh',
    });
  });

  it('refreshes the session that replaced one whose refresh is still in flight', async () => {
    const { store, values } = memoryStorage();
    values.set('keeper-session', session({ expiresAt: Date.now() - 1 }));
    const { prompt } = promptFor({ username: 'bob@example.test', password: 'bob-password' });
    const stale = deferred<Response>();
    const bobToken = idToken({ sub: 'cognito-bob', name: 'Bob' });
    const bobRefreshed = idToken({ sub: 'cognito-bob', name: 'Bob', issued: 2 });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return stale.promise;
      }
      if (calls === 2) {
        // Bob's stored session starts out already close enough to expiry to need a refresh.
        return cognitoAnswer({
          AuthenticationResult: {
            IdToken: bobToken,
            AccessToken: 'access',
            RefreshToken: 'bob-refresh',
            ExpiresIn: 30,
          },
        });
      }
      return cognitoAnswer({
        AuthenticationResult: {
          IdToken: bobRefreshed,
          AccessToken: 'access',
          ExpiresIn: 3600,
        },
      });
    }) as typeof globalThis.fetch;
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: fetchImpl,
      storage: store,
    });

    const refreshing = authentication.token();
    await vi.waitFor(() => {
      expect(calls).toBe(1);
    });
    await authentication.identity.signOut();
    await authentication.identity.signIn();

    // The stale refresh is still in flight and must not hold back the new session's refresh.
    await expect(authentication.token()).resolves.toBe(bobRefreshed);
    stale.resolve(
      cognitoAnswer({
        AuthenticationResult: {
          IdToken: idToken({ sub: 'cognito-alice', name: 'Alice' }),
          AccessToken: 'access',
          ExpiresIn: 3600,
        },
      }),
    );
    await expect(refreshing).resolves.toBeNull();
    expect(authentication.identity.current()?.accountId).toBe('cognito-bob');
  });

  it('does not start a session a sign-in answered after the visitor signed out', async () => {
    const { store, values } = memoryStorage();
    const { prompt } = promptFor({ username: 'alice@example.test', password: 'password' });
    const service = deferred<Response>();
    let started = false;
    const authentication = createBrowserAuthentication({
      settings,
      prompt,
      fetch: (() => {
        started = true;
        return service.promise;
      }) as typeof globalThis.fetch,
      storage: store,
    });

    const signingIn = authentication.identity.signIn();
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    await authentication.identity.signOut();
    service.resolve(
      cognitoAnswer({
        AuthenticationResult: {
          IdToken: idToken({ sub: 'cognito-alice', name: 'Alice' }),
          AccessToken: 'access',
          RefreshToken: 'refresh',
          ExpiresIn: 3600,
        },
      }),
    );
    await signingIn;

    expect(authentication.identity.current()).toBeNull();
    expect(values.has('keeper-session')).toBe(false);
  });
});
