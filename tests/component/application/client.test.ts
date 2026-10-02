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
  createUserCardsClient,
  inspectCanvasFrame,
  type PublicApplicationSettings,
  type UserInterfaceCapabilities,
} from '../../../src/application/index.js';
import {
  readPublicSettings,
  resolveApplicationConfiguration,
} from '../../../src/application/index.js';
import type { CaptureSnapshot } from '../../../src/capture/index.js';
import type { RecognitionPrepareRequest } from '../../../src/recognition/index.js';

import { signedInStorage, testConfiguration, testPrompt } from './harness.js';

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

  it('reads one bounded page of tags and one tag’s associations', async () => {
    const tags = {
      privateRevision: 'private-1',
      tags: [{ tagId: 'tag-1', kind: 'wishlist', label: 'Wanted', system: false, revision: 2 }],
      continuation: 'next-tags',
    };
    const { fetch, calls } = jsonFetch(tags);
    const request = createAuthenticatedRequest({
      baseUrl: 'https://api.test.keeper.example',
      token: () => 'id-token-value',
      fetch,
    });
    const client = createUserCardsClient(request);

    const page = await client.listTags({ pageSize: 1, continuation: 'page-1' });

    expect(calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/tags?pageSize=1&continuation=page-1',
    );
    expect(page.tags).toEqual(tags.tags);
    expect(page.continuation).toBe('next-tags');

    const associations = {
      privateRevision: 'private-1',
      associations: [
        {
          associationId: 'association-1',
          tagId: 'tag-1',
          targetLevel: 'printing',
          targetId: 'printing-1',
          quantity: 4,
          revision: 3,
        },
      ],
      continuation: null,
    };
    const listed = jsonFetch(associations);
    const associationClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: listed.fetch,
      }),
    );

    const associationPage = await associationClient.listAssociations('tag/1', { pageSize: 50 });

    expect(listed.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/tags/tag%2F1/associations?pageSize=50',
    );
    expect(associationPage.associations).toEqual(associations.associations);
    expect(associationPage.continuation).toBeNull();
  });

  it('renames a tag, changes an association and moves a copy’s location', async () => {
    const renamed = {
      privateRevision: 'private-2',

      tag: { tagId: 'tag/1', kind: 'deck', label: 'Burn deck', system: false, revision: 2 },
    };
    const rename = jsonFetch(renamed);
    const renameClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: rename.fetch,
      }),
    );

    const result = await renameClient.renameTag({
      tagId: 'tag/1',
      expectedRevision: 1,
      label: 'Burn deck',
    });

    expect(rename.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/tags/tag%2F1/rename',
    );
    expect(rename.calls[0]?.init.body).toBe('{"expectedRevision":1,"label":"Burn deck"}');
    expect(result.tag.label).toBe('Burn deck');

    const changed = {
      privateRevision: 'private-3',

      association: {
        associationId: 'association-1',
        tagId: 'tag-1',
        targetLevel: 'card',
        targetId: 'card-bolt',
        quantity: 4,
        revision: 4,
      },
    };
    const association = jsonFetch(changed);
    const associationClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: association.fetch,
      }),
    );

    await associationClient.changeAssociation({
      associationId: 'association/1',
      expectedRevision: 3,
      targetLevel: 'card',
      targetId: 'card-bolt',
      quantity: 4,
    });

    expect(association.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/associations/association%2F1/changes',
    );
    expect(association.calls[0]?.init.body).toBe(
      '{"expectedRevision":3,"targetLevel":"card","targetId":"card-bolt","quantity":4}',
    );

    const moved = {
      privateRevision: 'private-4',

      copy: {
        copyId: 'copy-1',
        printingId: 'printing-1',
        finish: 'nonfoil',
        condition: null,
        revision: 6,
      },
      location: null,
    };
    const location = jsonFetch(moved);
    const locationClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: location.fetch,
      }),
    );

    const movedResult = await locationClient.setCopyLocation({
      copyId: 'copy-1',
      locationTagId: null,
      expectedRevision: 5,
    });

    expect(location.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/copies/copy-1/location',
    );
    expect(location.calls[0]?.init.body).toBe('{"expectedRevision":5,"locationTagId":null}');
    expect(movedResult.location).toBeNull();
    expect(movedResult.copy.revision).toBe(6);
  });

  it('reads, stages, reviews and confirms pending imports through their routes', async () => {
    const session = {
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      sourceReference: null,
      state: 'pending',
      pendingEntries: 1,
      confirmedEntries: 0,
      discardedEntries: 0,
      revision: 2,
    };
    const storedEntry = {
      entryId: 'entry-1',
      sessionId: 'manual',
      position: 1,
      state: 'pending',
      cardId: null,
      printingId: 'printing-1',
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
      candidates: [],
      sourceLine: null,
      revision: 3,
    };
    const { fetch, calls } = jsonFetch({
      privateRevision: 'private-1',
      session,
      entries: [storedEntry],
      continuation: null,
    });
    const client = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch,
      }),
    );

    const page = await client.listImportEntries({
      sessionId: 'manual',
      pageSize: 50,
      continuation: 'pending-1',
    });

    expect(calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/imports/manual/entries?pageSize=50&continuation=pending-1',
    );
    expect(calls[0]?.init.method).toBe('GET');
    expect(page.session.sourceKind).toBe('manual');
    expect(page.entries).toEqual([storedEntry]);

    const stage = jsonFetch({
      privateRevision: 'private-2',
      session,
      entries: [{ ...storedEntry, printingId: 'printing-2' }],
      staged: 1,
      replayed: false,
    });
    const stageClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: stage.fetch,
      }),
    );

    const staged = await stageClient.stageImportEntries({
      sessionId: 'manual',
      source: { kind: 'manual', id: 'manual' },
      entries: [{ entryId: 'entry-2', printingId: 'printing-2', quantity: 2 }],
    });

    expect(stage.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/imports/manual/entries',
    );
    expect(stage.calls[0]?.init.body).toBe(
      '{"source":{"kind":"manual","id":"manual"},"entries":[{"entryId":"entry-2","printingId":"printing-2","quantity":2}]}',
    );
    expect(staged.staged).toBe(1);

    const review = jsonFetch({
      privateRevision: 'private-3',
      session,
      entry: { ...storedEntry, quantity: 2, revision: 4 },
    });
    const reviewClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: review.fetch,
      }),
    );

    const reviewed = await reviewClient.reviewImportEntry({
      entryId: 'entry/1',
      expectedRevision: 3,
      cardId: null,
      printingId: 'printing-1',
      finish: 'foil',
      condition: null,
      quantity: 2,
    });

    expect(review.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/imports/entries/entry%2F1/review',
    );
    expect(review.calls[0]?.init.body).toBe(
      '{"expectedRevision":3,"cardId":null,"printingId":"printing-1","finish":"foil",' +
        '"condition":null,"quantity":2}',
    );
    expect(reviewed.entry.revision).toBe(4);

    const confirmation = jsonFetch({
      operationId: 'operation-1',
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      destination: { kind: 'ownership' },
      copies: [
        {
          copyId: 'copy-1',
          printingId: 'printing-1',
          finish: 'nonfoil',
          condition: null,
          revision: 1,
        },
      ],
      associations: [],
      replayed: true,
      privateRevision: 'private-4',
    });
    const confirmationClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: confirmation.fetch,
      }),
    );

    const confirmed = await confirmationClient.confirmImport({
      operationId: 'operation-1',
      sessionId: 'manual',
      destination: { kind: 'ownership' },
      entries: [{ entryId: 'entry-1', expectedRevision: 4 }],
    });

    expect(confirmation.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/imports/manual/confirmation',
    );
    expect(confirmation.calls[0]?.init.body).toBe(
      '{"operationId":"operation-1","destination":{"kind":"ownership"},' +
        '"entries":[{"entryId":"entry-1","expectedRevision":4}]}',
    );
    expect(confirmed.replayed).toBe(true);
    expect(confirmed.copies.map((copy) => copy.copyId)).toEqual(['copy-1']);
  });

  it('stages a capture observation and attaches its late alternatives', async () => {
    const session = {
      sessionId: 'ui-capture-1',
      sourceKind: 'capture',
      sourceId: 'ui-capture-1',
      sourceReference: null,
      state: 'pending',
      pendingEntries: 1,
      confirmedEntries: 0,
      discardedEntries: 0,
      revision: 2,
    };
    const storedEntry = {
      entryId: 'capture-1',
      sessionId: 'ui-capture-1',
      position: 1,
      state: 'pending',
      printingId: 'printing-1',
      finish: 'nonfoil',
      condition: null,
      quantity: 1,
      candidates: [
        { printingId: 'printing-1', provider: 'recognition', evidence: 'engine-ranking' },
      ],
      sourceLine: null,
      revision: 3,
    };
    const observation = jsonFetch({
      privateRevision: 'private-2',
      outcome: 'admitted',
      replayed: false,
      session,
      entry: storedEntry,
    });
    const observationClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: observation.fetch,
      }),
    );

    const admitted = await observationClient.stageCaptureObservation({
      sessionId: 'ui-capture-1',
      captureId: 'capture-1',
      printingId: 'printing-1',
      candidates: [
        { printingId: 'printing-1', provider: 'recognition', evidence: 'engine-ranking' },
      ],
    });

    expect(observation.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/imports/ui-capture-1/captures',
    );
    expect(observation.calls[0]?.init.method).toBe('POST');
    expect(observation.calls[0]?.init.body).toBe(
      '{"captureId":"capture-1","printingId":"printing-1","finish":null,"candidates":[{"printingId":"printing-1","provider":"recognition","evidence":"engine-ranking"}]}',
    );
    expect(admitted.outcome).toBe('admitted');
    expect(admitted.entry?.entryId).toBe('capture-1');

    const attached = jsonFetch({
      privateRevision: 'private-3',
      session: { ...session, revision: 3 },
      entry: {
        ...storedEntry,
        candidates: [
          ...storedEntry.candidates,
          { printingId: 'printing-2', provider: 'recognition', evidence: 'title-evidence' },
        ],
      },
    });
    const attachmentClient = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch: attached.fetch,
      }),
    );

    const entry = await attachmentClient.attachImportCandidates({
      entryId: 'entry/1',
      candidates: [
        { printingId: 'printing-2', provider: 'recognition', evidence: 'title-evidence' },
      ],
    });

    expect(attached.calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/imports/entries/entry%2F1/candidates',
    );
    expect(attached.calls[0]?.init.body).toBe(
      '{"candidates":[{"printingId":"printing-2","provider":"recognition","evidence":"title-evidence"}]}',
    );
    expect(entry.entry.candidates).toHaveLength(2);
  });

  it('reads the recorded outcome of one confirmation operation', async () => {
    const { fetch, calls } = jsonFetch({ outcome: 'absent' });
    const client = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch,
      }),
    );

    await expect(client.recoverImportOperation('operation/1')).resolves.toEqual({
      outcome: 'absent',
    });
    expect(calls[0]?.url).toBe(
      'https://api.test.keeper.example/api/collection/imports/operations/operation%2F1',
    );
  });

  it('parses one supported source through its route and reads every row', async () => {
    const session = {
      sessionId: 'pasted-list:1',
      sourceKind: 'pasted-list',
      sourceId: 'pasted-list:1',
      sourceReference: null,
      state: 'pending',
      pendingEntries: 1,
      confirmedEntries: 0,
      discardedEntries: 0,
      revision: 2,
    };
    const { fetch, calls } = jsonFetch({
      privateRevision: 'private-1',
      session,
      rows: [
        {
          position: 1,
          line: {
            name: 'Lightning Bolt',
            section: null,
            set: 'M11',
            collectorNumber: '149',
            language: null,
            finish: null,
            declaredQuantity: 1,
            problem: 'The source named no printing; choose one during review.',
          },
          outcome: 'staged',
          problem: 'The source named no printing; choose one during review.',
          entryId: 'entry-1',
          sessionId: 'pasted-list:1',
        },
        {
          position: 2,
          line: null,
          outcome: 'invalid',
          problem: 'Use “quantity card name”, optionally followed by “(SET) number”.',
          entryId: null,
          sessionId: null,
        },
      ],
      staged: 1,
    });
    const client = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch,
      }),
    );

    const result = await client.stageSourceImport({
      format: 'pasted-list',
      sessionId: 'paste-import-1',
      text: '1 Lightning Bolt',
    });

    expect(calls[0]?.url).toBe('https://api.test.keeper.example/api/collection/imports/sources');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(
      '{"format":"pasted-list","sessionId":"paste-import-1","text":"1 Lightning Bolt"}',
    );
    expect(result.session.sourceId).toBe('pasted-list:1');
    expect(result.rows.map((row) => row.outcome)).toEqual(['staged', 'invalid']);
    expect(result.rows[0]?.line?.name).toBe('Lightning Bolt');
    expect(result.staged).toBe(1);
  });

  it('rejects a source-import response outside the declared shape', async () => {
    const { fetch } = jsonFetch({
      privateRevision: 'private-1',
      session: {
        sessionId: 'pasted-list:1',
        sourceKind: 'pasted-list',
        sourceId: 'pasted-list:1',
        sourceReference: null,
        state: 'pending',
        pendingEntries: 1,
        confirmedEntries: 0,
        discardedEntries: 0,
        revision: 2,
      },
      // A row that reports a line cannot be an unreadable row.
      rows: [
        {
          position: 1,
          line: { name: 'Lightning Bolt', declaredQuantity: 1 },
          outcome: 'invalid',
          problem: null,
          entryId: null,
          sessionId: null,
        },
      ],
      staged: 0,
    });
    const client = createUserCardsClient(
      createAuthenticatedRequest({
        baseUrl: 'https://api.test.keeper.example',
        token: () => 'id-token-value',
        fetch,
      }),
    );

    await expect(
      client.stageSourceImport({
        format: 'moxfield',
        sessionId: 'deck-import-1',
        url: 'https://x.test',
      }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The import response could not be read.',
    });
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
        prompt: testPrompt(),
        storage: signedInStorage(),
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
      prompt: testPrompt(),
      storage: signedInStorage(),
      fetch,
      createUserInterface,
    });

    expect(application.settings).toEqual(settings);
    expect(createUserInterface).toHaveBeenCalledTimes(1);
    const capabilities = received[0];
    expect(capabilities?.settings).toEqual(settings);
    expect(capabilities?.request).toBeTypeOf('function');
    expect(capabilities?.catalog.resolve).toBeTypeOf('function');
    expect(capabilities?.catalog.query).toBeTypeOf('function');
    expect(capabilities?.userCards.account).toBeTypeOf('function');
    const accountId = application.identity.current()!.accountId;
    expect(capabilities?.userCards.account(accountId).readCopies).toBeTypeOf('function');
    expect(capabilities?.userCards.account(accountId).correctCopy).toBeTypeOf('function');
    // Application selects the CardList implementation and supplies its provider bindings and the
    // account lifecycle; the UserInterface never names the component's own factory
    // (docs/architecture.md#composition-and-replacement).
    expect(capabilities?.cardList.create).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).catalogQuery).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).collectionQuery).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).pickerQuery).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).changes).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).recent().source.load).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).printingImages).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).pendingEntries).toBeTypeOf('function');
    expect(capabilities?.cardList.account(accountId).tagAssociations).toBeTypeOf('function');
    // Application selects the Capture implementation and supplies its composed factory; the
    // UserInterface names neither the component's wiring nor the Recognition contract behind it
    // (docs/architecture.md#composition-and-replacement).
    expect(capabilities?.capture.create).toBeTypeOf('function');
    expect(capabilities?.capture.createImportId()).toBeTypeOf('string');
  });

  it('ends the UserCards scope of the account it leaves', async () => {
    const { fetch } = jsonFetch({ error: 'The service is unavailable.' }, { status: 503 });
    const received: UserInterfaceCapabilities[] = [];
    const application = createBrowserApplication({
      settings: publicSettings(),
      prompt: testPrompt(),
      storage: signedInStorage(),
      attemptStorage: null,
      fetch,
      createUserInterface: (capabilities) => {
        received.push(capabilities);
        return null;
      },
    });
    const userCards = received[0]?.userCards;
    const alice = userCards?.account('cognito-alice');
    const lost = alice?.beginSourceImport({ format: 'pasted-list', text: '1 Lightning Bolt' });
    expect(await lost?.observe()).toMatchObject({ state: 'unknown' });
    expect(alice?.retained()).toHaveLength(1);

    application.endSession();

    // Leaving the account ends the scope Application composed: its retained attempt is gone, its
    // reads refuse, and nothing of it reaches the transport another account will serve.
    expect(alice?.retained()).toEqual([]);
    await expect(alice?.readCopies(['copy-1'])).rejects.toThrow(/has ended/);
    expect(() => alice?.subscribe(() => {})).toThrow(/has ended/);

    expect(() => userCards?.account('cognito-alice')).toThrow(/authenticated account/);
  });

  it.each(['sign-out', 'replacement', 'end-session'] as const)(
    'rejects retained capture creation after %s and permits a fresh sign-in',
    async (transition) => {
      const received: UserInterfaceCapabilities[] = [];
      let signingInAs = 'cognito-bob';
      const fetch = vi.fn<typeof globalThis.fetch>(
        async () =>
          new Response(
            JSON.stringify({
              AuthenticationResult: {
                IdToken: `header.${Buffer.from(JSON.stringify({ sub: signingInAs })).toString('base64url')}.signature`,
                AccessToken: 'access',
                RefreshToken: 'refresh',
                ExpiresIn: 3600,
              },
            }),
          ),
      );
      const prepare = vi.fn(async (request: RecognitionPrepareRequest) => ({
        sessionId: request.sessionId,
        engines: [...request.engines],
        versions: {},
        timings: {},
      }));
      const recognize = vi.fn(() => {
        throw new Error('No frames are supplied in this lifecycle case.');
      });
      const createRecognition = vi.fn(() => ({ prepare, recognize, dispose: vi.fn() }));
      const application = createBrowserApplication({
        settings: publicSettings(),
        prompt: testPrompt(),
        storage: signedInStorage(),
        attemptStorage: null,
        fetch,
        createRecognition,
        createUserInterface: (value) => received.push(value),
      });
      const { capture, userCards, cardList } = received[0]!;
      const alice = userCards.account('cognito-alice');
      const close = vi.fn();
      const device = {
        openCamera: vi.fn(async () => ({
          preview: { stream: {} as MediaStream },
          sample: () => null,
          read: () => null,
          close,
        })),
        release: vi.fn(),
      };
      const create = (accountId: string) =>
        capture.create({
          accountId,
          importId: capture.createImportId(),
          device,
        });
      // Even before departure, a caller cannot bind another account to the active transport.
      expect(() => create('cognito-bob')).toThrow(/authenticated account/);

      if (transition === 'sign-out') await application.identity.signOut();
      else if (transition === 'replacement') await application.identity.signIn();
      else application.endSession();

      const sent = fetch.mock.calls.length;
      expect(() => create('cognito-alice')).toThrow(/authenticated account/);
      // The same account lookup also serves direct operations and CardList's private bindings.
      expect(() => userCards.account('cognito-alice')).toThrow(/authenticated account/);
      expect(() => cardList.account('cognito-alice').tagAssociations('deck')).toThrow(
        /authenticated account/,
      );
      expect(device.openCamera).not.toHaveBeenCalled();
      expect(createRecognition).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(recognize).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(sent);

      if (transition === 'replacement') {
        const bob = create('cognito-bob');
        await bob.start();
        expect(device.openCamera).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        await application.identity.signOut();
        expect(close).toHaveBeenCalledTimes(1);
        await bob.start();
        expect(device.openCamera).toHaveBeenCalledTimes(1);
      }

      signingInAs = 'cognito-alice';
      await application.identity.signIn();
      expect(application.identity.current()?.accountId).toBe('cognito-alice');
      expect(userCards.account('cognito-alice')).not.toBe(alice);
      const fresh = create('cognito-alice');
      await fresh.start();
      expect(device.openCamera).toHaveBeenCalledTimes(transition === 'replacement' ? 2 : 1);
      expect(prepare).toHaveBeenCalledTimes(transition === 'replacement' ? 2 : 1);
      application.endSession();
      expect(close).toHaveBeenCalledTimes(transition === 'replacement' ? 2 : 1);
    },
  );

  it('disposes the capture sessions of the account it leaves with no page presenting them', async () => {
    const received: UserInterfaceCapabilities[] = [];
    const releasedRecognition: string[] = [];
    const application = createBrowserApplication({
      settings: publicSettings(),
      prompt: testPrompt(),
      storage: signedInStorage(),
      attemptStorage: null,
      fetch: jsonFetch({ ok: true }).fetch,
      // The session is driven headlessly here, so the case owns the recognition lifecycle the
      // account teardown must reach instead of loading the preserved browser engines.
      createRecognition: () => ({
        prepare: (request) =>
          Promise.resolve({
            sessionId: request.sessionId,
            engines: [...request.engines],
            versions: {},
            timings: {},
          }),
        recognize: () => ({
          initial: Promise.reject(new Error('The case does not run inference.')),
          completion: Promise.resolve(),
        }),
        dispose: (request) => {
          releasedRecognition.push(request.sessionId);
        },
      }),
      createUserInterface: (capabilities) => {
        received.push(capabilities);
        return null;
      },
    });
    const capabilities = received[0]!;
    const accountId = application.identity.current()!.accountId;
    let closed = 0;
    let released = 0;
    let opened = 0;
    const session = capabilities.capture.create({
      accountId,
      importId: capabilities.capture.createImportId(),
      device: {
        openCamera: () => {
          opened += 1;
          return Promise.resolve({
            preview: { stream: {} as MediaStream },
            sample: () => null,
            read: () => null,
            close: () => {
              closed += 1;
            },
          });
        },
        release: () => {
          released += 1;
        },
      },
    });
    const states: CaptureSnapshot[] = [];
    session.observe((snapshot) => {
      states.push(snapshot);
    });
    await session.start();
    expect(states.at(-1)?.running).toBe(true);

    application.endSession();

    // The camera, the recognition session and the subscription end with the account even though no
    // page disposed the view that created the session
    // (docs/capture.md#admission-and-lifecycle, docs/architecture.md#runtime-boundaries).
    expect(closed).toBe(1);
    expect(released).toBe(1);
    expect(releasedRecognition).toHaveLength(1);
    const observed = states.length;
    await session.start();
    expect(opened).toBe(1);
    expect(states.length).toBe(observed);
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
      prompt: testPrompt(),
      storage: signedInStorage(),
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
          prompt: testPrompt(),
          storage: signedInStorage(),
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
      prompt: testPrompt(),
      storage: signedInStorage(),
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
      prompt: testPrompt(),
      storage: signedInStorage(),
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
