import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '../../../src/application/backend.js';
import {
  createBrowserApplication,
  readPublicSettings,
  resolveApplicationConfiguration,
} from '../../../src/application/index.js';
import { CatalogError } from '../../../src/catalog/index.js';
import type { Recognition } from '../../../src/recognition/index.js';
import {
  claimsFor,
  createCatalogSpy,
  createSearchSpy,
  createUserCardsSpy,
  createSourceImportsSpy,
  testAccount,
  testConfiguration,
  testIdentityVerifier,
  testPrompt,
  testRevision,
} from './harness.js';

function replacement() {
  const catalog = createCatalogSpy();
  const search = createSearchSpy();
  const userCards = createUserCardsSpy();
  const sourceImports = createSourceImportsSpy();
  const synchronize = vi.fn(async () => testRevision);
  const configuration = { ...testConfiguration(), resources: undefined };
  const application = createApplication({
    configuration,
    identity: testIdentityVerifier(),
    components: {
      catalog: catalog.contract,
      search: search.contract,
      userCards: userCards.contract,
      sourceImports: sourceImports.contract,
      synchronizer: { synchronize },
      indexer: null,
    },
  });
  return { application, catalog, search, userCards, synchronize };
}

describe('component replacement at Application', () => {
  it('serves supplied components without database clients or resource coordinates', async () => {
    const { application, catalog, search, synchronize } = replacement();
    const response = await application.handle({
      method: 'POST',
      path: '/api/catalog/resolve',
      body: JSON.stringify({ references: [{ kind: 'card', cardId: 'bolt' }] }),
    });
    expect(response.status).toBe(200);
    expect(catalog.resolve).toHaveBeenCalledWith([{ kind: 'card', cardId: 'bolt' }]);
    expect(JSON.parse(response.body)).toMatchObject({
      revision: testRevision,
      cards: [],
      printings: [],
    });
    expect(
      (
        await application.handle({
          method: 'POST',
          path: '/api/search',
          body: JSON.stringify({ resultLevel: 'card' }),
        })
      ).status,
    ).toBe(200);
    expect(search.execute).toHaveBeenCalledOnce();
    const counts = await application.handle({
      method: 'POST',
      path: '/api/search/counts',
      body: JSON.stringify({ references: [{ kind: 'card', cardId: 'bolt' }] }),
      authentication: { claims: claimsFor(testAccount) },
    });
    expect(counts.status).toBe(200);
    expect(search.counts).toHaveBeenCalledWith(
      { references: [{ kind: 'card', cardId: 'bolt' }] },
      expect.objectContaining({ accountId: testAccount }),
    );
    expect(JSON.parse(counts.body)).toEqual({
      privateRevision: 'private-revision-1',
      counts: [],
    });
    const progress = await application.handle({
      method: 'POST',
      path: '/api/search/progress',
      body: JSON.stringify({ positions: ['7'], timeoutMs: 0 }),
      authentication: { claims: claimsFor(testAccount) },
    });
    expect(progress.status).toBe(200);
    expect(search.observe).toHaveBeenCalledWith(
      { positions: ['7'], catalogRevision: null },
      expect.objectContaining({ accountId: testAccount }),
      expect.objectContaining({ timeoutMs: 0 }),
    );
    expect(JSON.parse(progress.body)).toMatchObject({ state: 'incorporated' });
    await expect(application.synchronizeCatalog({ dataset: 'default_cards' })).resolves.toEqual(
      testRevision,
    );
    expect(synchronize).toHaveBeenCalledOnce();
    application.dispose();
    await expect(application.handle({ method: 'GET', path: '/api/search' })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(
      application.synchronizeCatalog({ dataset: 'default_cards' }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('enforces authentication before a replacement private provider and passes only trusted identity', async () => {
    const { application, userCards } = replacement();
    const request = {
      method: 'POST',
      path: '/api/collection/copies/read',
      body: JSON.stringify({ copyIds: ['copy-1'], accountId: 'attacker' }),
    };
    expect((await application.handle(request)).status).toBe(401);
    expect(userCards.readCopies).not.toHaveBeenCalled();
    expect(
      (await application.handle({ ...request, authentication: { claims: claimsFor(testAccount) } }))
        .status,
    ).toBe(200);
    expect(userCards.readCopies).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: testAccount }),
      ['copy-1'],
    );
  });

  it('preserves a replacement provider failure instead of reporting an empty result', async () => {
    const { application, catalog } = replacement();
    catalog.resolve.mockRejectedValue(new CatalogError('unavailable', 'Offline'));
    const response = await application.handle({
      method: 'POST',
      path: '/api/catalog/resolve',
      body: JSON.stringify({ references: [] }),
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('supplies a replacement recognition implementation to the UI without starting default engines', () => {
    const dispose = vi.fn();
    const recognition: Recognition<HTMLCanvasElement> = {
      prepare: vi.fn(),
      recognize: vi.fn(),
      dispose,
    };
    const fetch = vi.fn();
    const application = createBrowserApplication({
      settings: readPublicSettings(resolveApplicationConfiguration(testConfiguration())),
      prompt: testPrompt(),
      fetch,
      createRecognition: () => recognition,
      createUserInterface: (capabilities) => capabilities.createRecognition(),
    });
    expect(application.userInterface).toBe(recognition);
    application.createRecognition().dispose({ sessionId: 'scan' });
    expect(dispose).toHaveBeenCalledWith({ sessionId: 'scan' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
