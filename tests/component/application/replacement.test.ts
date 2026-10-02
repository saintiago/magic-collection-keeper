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
  createQueriesSpy,
  createUserCardsSpy,
  createSourceImportsSpy,
  signedInStorage,
  testAccount,
  testConfiguration,
  testIdentityVerifier,
  testPrompt,
  testRevision,
} from './harness.js';

function replacement() {
  const catalog = createCatalogSpy();
  const queries = createQueriesSpy();
  const userCards = createUserCardsSpy();
  const sourceImports = createSourceImportsSpy();
  const synchronize = vi.fn(async () => testRevision);
  const configuration = { ...testConfiguration(), resources: undefined };
  const application = createApplication({
    configuration,
    identity: testIdentityVerifier(),
    components: {
      catalog: catalog.contract,
      userCardsQueries: queries.contract,
      userCards: userCards.contract,
      sourceImports: sourceImports.contract,
      synchronizer: { synchronize },
    },
  });
  return { application, catalog, queries, userCards, synchronize };
}

describe('component replacement at Application', () => {
  it('serves supplied components without database clients or resource coordinates', async () => {
    const { application, catalog, queries, synchronize } = replacement();
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
    const responsePage = await application.handle({
      method: 'POST',
      path: '/api/collection/query',
      body: JSON.stringify({ scope: { kind: 'collection' }, resultLevel: 'card' }),
      authentication: { claims: claimsFor(testAccount) },
    });
    expect(responsePage.status).toBe(200);
    expect(queries.query).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: testAccount }),
      { scope: { kind: 'collection' }, resultLevel: 'card' },
    );
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

  it('supplies a replacement recognition implementation to Capture without starting default engines', async () => {
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
      storage: signedInStorage(),
      fetch,
      createRecognition: () => recognition,
      // The replacement is supplied behind the Capture capability the UserInterface receives:
      // a session Application composes over it prepares through the replacement, not the engines.
      createUserInterface: (capabilities) =>
        capabilities.capture.create({
          accountId: capabilities.identity.current()!.accountId,
          importId: capabilities.capture.createImportId(),
          device: {
            openCamera: () =>
              Promise.resolve({
                preview: { stream: {} as MediaStream },
                sample: () => null,
                read: () => null,
                close: () => {},
              }),
            release: () => {},
          },
        }),
    });
    const session = application.userInterface as { start(): Promise<void>; stop(): void };
    await session.start();
    expect(recognition.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ engines: ['browser-onnx'] }),
    );
    session.stop();
    expect(dispose).toHaveBeenCalledWith({ sessionId: expect.any(String) });
    application.createRecognition().dispose({ sessionId: 'scan' });
    expect(dispose).toHaveBeenCalledWith({ sessionId: 'scan' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
