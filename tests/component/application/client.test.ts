/**
 * Component scope: the browser transports (docs/application.md#interface,
 * docs/application.md#configuration-and-lifecycle). The authenticated request attaches the
 * caller's current identity, routes each entry point, maps the transport failure envelope and
 * rejects a response of a session that ended. The browser application composes the public
 * settings, the Catalog client and the Recognition contract handed to UserInterface.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ApplicationError,
  ConfigurationError,
  createAuthenticatedRequest,
  createBrowserApplication,
  createCatalogClient,
  createSearchClient,
  createUserCardsClient,
  inspectCanvasFrame,
  type PublicApplicationSettings,
  type UserInterfaceCapabilities,
} from '../../../src/application/index.js';
import {
  readPublicSettings,
  resolveApplicationConfiguration,
} from '../../../src/application/index.js';

import { testConfiguration } from './harness.js';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function jsonFetch(
  payload: unknown,
  options: { readonly status?: number } = {},
): { readonly fetch: typeof globalThis.fetch; readonly calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function publicSettings(overrides: Partial<PublicApplicationSettings> = {}): unknown {
  return {
    ...readPublicSettings(resolveApplicationConfiguration(testConfiguration())),
    ...overrides,
  };
}

describe('authenticated request', () => {
  it('attaches the current identity to one entry-point call', async () => {
    const { fetch, calls } = jsonFetch({ ok: true });
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example/',
      token: () => 'id-token-value',
      fetch,
    });

    const payload = await request('/api/catalog/resolve', {
      method: 'POST',
      body: JSON.stringify({ references: [] }),
    });

    expect(payload).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test.keeper.example/api/catalog/resolve');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"references":[]}');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer id-token-value',
    );
  });

  it('defaults to a GET without a body', async () => {
    const { fetch, calls } = jsonFetch({ cards: [] });
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: async () => 'id-token-value',
      fetch,
    });

    await request('/api/card?printing=printing-1');

    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it('maps a transport failure envelope to its code', async () => {
    const { fetch } = jsonFetch(
      { error: { code: 'busy', message: 'Retry this card.' } },
      { status: 429 },
    );
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    await expect(request('/api/recognize', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'busy',
      message: 'Retry this card.',
    });
  });

  it('reports an unreadable or unreachable response as unavailable', async () => {
    const unreadable = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch: (async () => new Response('<html>', { status: 200 })) as typeof globalThis.fetch,
    });
    await expect(unreadable('/api/search', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'unavailable',
    });

    const unreachable = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch: (async () => {
        throw new Error('network down');
      }) as typeof globalThis.fetch,
    });
    await expect(unreachable('/api/search', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('never sends a request without an identity and never reports the credential', async () => {
    const { fetch, calls } = jsonFetch({ ok: true });
    const signedOut = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => null,
      fetch,
    });

    await expect(signedOut('/api/search')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toEqual([]);

    const failing = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => {
        throw new Error('refresh failed with token super-secret-credential');
      },
      fetch,
    });
    const error = await failing('/api/search').then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApplicationError);
    expect(String((error as Error).message)).not.toContain('super-secret-credential');
    expect(calls).toEqual([]);
  });

  it('reports a withdrawn invocation as cancelled', async () => {
    const controller = new AbortController();
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      })) as typeof globalThis.fetch;
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const pending = request('/api/search', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports a cancellation during response consumption instead of an outage', async () => {
    const controller = new AbortController();
    let readBody: (() => void) | undefined;
    const bodyStarted = new Promise<void>((resolve) => {
      readBody = resolve;
    });
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          stream = streamController;
          streamController.enqueue(new TextEncoder().encode('{"cards":'));
        },
        pull() {
          // The body is being consumed: the response headers have long arrived.
          readBody?.();
        },
      });
      init?.signal?.addEventListener('abort', () => {
        stream?.error(new DOMException('Aborted', 'AbortError'));
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const pending = request('/api/search', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    await bodyStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects a response that arrives after the session ended', async () => {
    let release: (() => void) | undefined;
    const fetch = (async () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      })) as typeof globalThis.fetch;
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const pending = request('/api/search', { method: 'POST', body: '{}' });
    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function');
    });
    request.endSession();
    release?.();

    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('requires an absolute base URL and a fetch implementation', () => {
    expect(() =>
      createAuthenticatedRequest({ baseUrl: 'keeper.example', token: () => 'token' }),
    ).toThrow(TypeError);
    expect(() =>
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'token',
        fetch: undefined as unknown as typeof globalThis.fetch,
      }),
    ).not.toThrow();
  });
});

describe('catalog client', () => {
  it('hydrates a resolution into the Catalog contract', async () => {
    const revision = {
      revisionId: 'revision-1',
      sourceName: 'scryfall',
      sourceVersion: '1',
      publishedAt: '2026-09-01T00:00:00.000Z',
    };
    const card = { cardId: 'oracle-lightning-bolt', name: 'Lightning Bolt' };
    const printing = { printingId: 'printing-m11-149-en', cardId: card.cardId };
    const { fetch, calls } = jsonFetch({
      revision,
      cards: [card],
      printings: [printing],
      missing: [{ kind: 'printing', printingId: 'printing-missing' }],
    });
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const resolution = await createCatalogClient(request).resolve([
      { kind: 'card', cardId: card.cardId },
    ]);

    expect(calls[0]?.url).toBe('https://api.test.keeper.example/api/catalog/resolve');
    expect(resolution.revision).toEqual(revision);
    expect(resolution.cards.get(card.cardId)).toEqual(card);
    expect(resolution.printings.get(printing.printingId)).toEqual(printing);
    expect(resolution.missing).toEqual([{ kind: 'printing', printingId: 'printing-missing' }]);
  });

  it('reads a printing page through the catalog route', async () => {
    const { fetch, calls } = jsonFetch({
      cardId: 'oracle/item',
      cardExists: true,
      revision: { revisionId: 'revision-1' },
      printings: [{ printingId: 'printing-1' }],
      continuation: 'next',
    });
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const page = await createCatalogClient(request).listCardPrintings('oracle/item', {
      pageSize: 25,
    });

    expect(calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/catalog/cards/oracle%2Fitem/printings?pageSize=25',
    );
    expect(page.printings).toEqual([{ printingId: 'printing-1' }]);
    expect(page.continuation).toBe('next');
  });

  it('reports an unreadable catalog response as unavailable', async () => {
    const { fetch } = jsonFetch({ cards: 'not-an-array' });
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    await expect(createCatalogClient(request).resolve([])).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('search client', () => {
  it('sends one query to the search route and keeps the page it read', async () => {
    const payload = {
      entries: [
        {
          entryKey: 'printing:printing-1',
          target: { kind: 'printing', printingId: 'printing-1' },
          card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: 'Blitzschlag' },
          printing: {
            printingId: 'printing-1',
            edition: 'M11',
            collectorNumber: '149',
            language: 'en',
          },
          quantity: { copies: 2, intended: null },
        },
      ],
      totalCount: 1,
      continuation: 'cursor-1',
      revisions: { catalogRevision: 'revision-1', privateRevision: null },
    };
    const { fetch, calls } = jsonFetch(payload);
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const page = await createSearchClient(request).execute({
      resultLevel: 'printing',
      query: 'bolt',
      pageSize: 25,
    });

    expect(calls[0]?.url).toBe('https://api.test.keeper.example/api/search');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"resultLevel":"printing","query":"bolt","pageSize":25}');
    expect(page).toEqual(payload);
  });

  it('reports a response outside the declared page as unavailable', async () => {
    const request = (payload: unknown) =>
      createSearchClient(
        createAuthenticatedRequest({
          baseUrl: 'https://api.test.keeper.example',
          token: () => 'id-token-value',
          fetch: jsonFetch(payload).fetch,
        }),
      );

    for (const payload of [
      { entries: 'not-an-array' },
      { entries: [], totalCount: 0, continuation: null, revisions: null },
      {
        entries: [
          {
            entryKey: 'card:card-1',
            target: { kind: 'card', cardId: 'card-1' },
            card: { cardId: 'card-1', name: 'Lightning Bolt', matchedName: null },
            printing: null,
            quantity: { copies: 'two', intended: null },
          },
        ],
        totalCount: 1,
        continuation: null,
        revisions: { catalogRevision: 'revision-1', privateRevision: null },
      },
    ]) {
      await expect(request(payload).execute({ resultLevel: 'card' })).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
  });
});

describe('user cards client', () => {
  it('reads explicit copies through the private route and keeps the authorized records', async () => {
    const payload = {
      privateRevision: 'private-1',
      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-1',
          finish: 'foil',
          condition: null,
          revision: 2,
        },
      ],
      missing: ['copy-2'],
    };
    const { fetch, calls } = jsonFetch(payload);
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const result = await createUserCardsClient(request).readCopies(['copy-1', 'copy-2']);

    expect(calls[0]?.url).toBe('https://api.test.keeper.example/api/collection/copies/read');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"copyIds":["copy-1","copy-2"]}');
    expect(result.privateRevision).toBe('private-1');
    expect(result.missing).toEqual(['copy-2']);
    expect(result.copies.get('copy-1')).toEqual({
      copyId: 'copy-1',
      printingId: 'printing-1',
      finish: 'foil',
      condition: null,
      revision: 2,
    });
  });

  it('corrects one copy under the revision it read and keeps the committed record', async () => {
    const payload = {
      privateRevision: 'private-2',
      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-2',
          finish: 'etched',
          condition: 'LP',
          revision: 3,
        },
      ],
    };
    const { fetch, calls } = jsonFetch(payload);
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });

    const result = await createUserCardsClient(request).correctCopy({
      copyId: 'copy/1',
      expectedRevision: 2,
      printingId: 'printing-2',
      finish: 'etched',
      condition: 'LP',
    });

    expect(calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/copies/copy%2F1/corrections',
    );
    expect(calls[0]?.init.body).toBe(
      '{"expectedRevision":2,"printingId":"printing-2","finish":"etched","condition":"LP"}',
    );
    expect(result).toEqual(payload);
  });

  it('reports a response outside the declared copy shape as unavailable', async () => {
    const request = (payload: unknown) =>
      createUserCardsClient(
        createAuthenticatedRequest({
          baseUrl: 'https://api.test.keeper.example',
          token: () => 'id-token-value',
          fetch: jsonFetch(payload).fetch,
        }),
      );

    for (const payload of [
      { privateRevision: 'private-1', copies: 'not-an-array', missing: [] },
      { privateRevision: 'private-1', copies: [], missing: [42] },
      {
        privateRevision: 'private-1',
        copies: [{ copyId: 'copy-1', printingId: 'printing-1', finish: 'foil', condition: null }],
        missing: [],
      },
    ]) {
      await expect(request(payload).readCopies(['copy-1'])).rejects.toMatchObject({
        code: 'unavailable',
      });
    }
  });
});

describe('browser application', () => {
  it('rejects private settings beside the public ones', () => {
    expect(() =>
      createBrowserApplication({
        settings: {
          ...(publicSettings() as Record<string, unknown>),
          resources: { catalogDatabase: { secretArn: 'arn:aws:secretsmanager:secret' } },
        },
        token: () => 'id-token-value',
      }),
    ).toThrow(ConfigurationError);
  });

  it('supplies UserInterface with the settings, transport and Recognition contract', () => {
    const settings = publicSettings();
    const { fetch } = jsonFetch({ ok: true });
    const received: UserInterfaceCapabilities[] = [];
    const createUserInterface = vi.fn((capabilities: UserInterfaceCapabilities) => {
      received.push(capabilities);
      return { constructed: true };
    });

    const application = createBrowserApplication({
      settings,
      token: () => 'id-token-value',
      fetch,
      createUserInterface,
    });

    expect(application.settings).toEqual(settings);
    expect(createUserInterface).toHaveBeenCalledTimes(1);
    const capabilities = received[0];
    expect(capabilities?.settings).toEqual(settings);
    expect(capabilities?.request).toBeTypeOf('function');
    expect(capabilities?.catalog.resolve).toBeTypeOf('function');
    expect(capabilities?.search.execute).toBeTypeOf('function');
    expect(capabilities?.userCards.readCopies).toBeTypeOf('function');
    expect(capabilities?.userCards.correctCopy).toBeTypeOf('function');
    expect(Object.keys(capabilities?.createRecognition() ?? {}).sort()).toEqual([
      'dispose',
      'prepare',
      'recognize',
    ]);
    expect(application.userInterface).toEqual({ constructed: true });
  });

  it('reads Search through the entry point UserInterface received', async () => {
    const { fetch, calls } = jsonFetch({
      entries: [],
      totalCount: 0,
      continuation: null,
      revisions: { catalogRevision: 'revision-1', privateRevision: null },
    });
    const received: UserInterfaceCapabilities[] = [];
    createBrowserApplication({
      settings: publicSettings(),
      token: () => 'id-token-value',
      fetch,
      createUserInterface: (capabilities) => {
        received.push(capabilities);
        return null;
      },
    });

    const page = await received[0]?.search.execute({ resultLevel: 'card', pageSize: 25 });

    expect(page?.totalCount).toBe(0);
    expect(calls[0]?.url).toBe('https://api.test.keeper.example/api/search');
    expect(calls[0]?.init.body).toBe('{"resultLevel":"card","pageSize":25}');
  });

  it('routes inference to the compute entry point and catalog reads to the API', async () => {
    const settings = publicSettings({
      recognition: {
        cloudEnabled: true,
        computeBaseUrl: 'https://compute.test.keeper.example',
      },
    }) as Record<string, unknown>;
    const { fetch, calls } = jsonFetch({ ok: true });
    const application = createBrowserApplication({
      settings,
      token: () => 'id-token-value',
      fetch,
    });

    await application.request('/api/recognize', { method: 'POST', body: '{}' });
    await application.request('/api/catalog/resolve', { method: 'POST', body: '{}' });

    expect(calls.map((call) => call.url)).toEqual([
      'https://compute.test.keeper.example/api/recognize',
      'https://api.test.keeper.example/api/catalog/resolve',
    ]);
  });

  it('keeps the preserved compute failures distinct on both inference paths', async () => {
    const settings = publicSettings({
      recognition: {
        cloudEnabled: true,
        computeBaseUrl: 'https://compute.test.keeper.example',
      },
    });
    const providerFailures = [
      { status: 401, error: 'Sign in to scan', code: 'unauthorized' },
      { status: 429, error: 'Scanner busy. Retry this card', code: 'busy' },
      { status: 503, error: 'Recognition unavailable. Retry this card', code: 'unavailable' },
      { status: 400, error: 'Invalid image', code: 'invalid-request' },
    ];

    for (const path of ['/api/recognize', '/api/recognize-independent']) {
      for (const providerFailure of providerFailures) {
        const { fetch } = jsonFetch(
          { error: providerFailure.error },
          { status: providerFailure.status },
        );
        const application = createBrowserApplication({
          settings,
          token: () => 'id-token-value',
          fetch,
        });

        await expect(
          application.request(path, { method: 'POST', body: '{}' }),
        ).rejects.toMatchObject({ code: providerFailure.code, message: providerFailure.error });
      }
    }
  });

  it('reports an inference call as unavailable when cloud engines are disabled', async () => {
    const { fetch, calls } = jsonFetch({ ok: true });
    const application = createBrowserApplication({
      settings: publicSettings(),
      token: () => 'id-token-value',
      fetch,
    });

    await expect(
      application.request('/api/recognize', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(calls).toEqual([]);
  });

  it('invalidates outstanding responses of the session it ends', async () => {
    let release: (() => void) | undefined;
    const fetch = (async () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      })) as typeof globalThis.fetch;
    const application = createBrowserApplication({
      settings: publicSettings(),
      token: () => 'id-token-value',
      fetch,
    });

    const pending = application.request('/api/search', { method: 'POST', body: '{}' });
    await vi.waitFor(() => {
      expect(release).toBeTypeOf('function');
    });
    application.endSession();
    release?.();

    await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('reads the bounded facts of one captured frame', () => {
    expect(inspectCanvasFrame({ width: 200, height: 300 } as HTMLCanvasElement)).toEqual({
      width: 200,
      height: 300,
      format: 'jpeg',
      encodedBytes: null,
    });
    expect(inspectCanvasFrame({ width: 0, height: 300 } as HTMLCanvasElement)).toEqual({
      width: 0,
      height: 300,
      format: 'jpeg',
      encodedBytes: null,
    });
    expect(inspectCanvasFrame(null as unknown as HTMLCanvasElement)).toBeNull();
  });
});
