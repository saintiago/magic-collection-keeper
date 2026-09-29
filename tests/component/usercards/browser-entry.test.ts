/**
 * Component scope: UserCards' browser entry point
 * (docs/user-cards.md#browser-operation-lifecycle, docs/architecture.md). The cases bundle the
 * entry with the repository's browser bundling settings and instantiate the facade from that
 * bundle, so a transitive backend or Node-only import fails here instead of in the browser
 * composition that consumes the capability.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  createUserCardsOperations,
  usercardsConstraints,
  type UserCardsBrowserClient,
  type UserCardsChange,
} from '../../../src/usercards/browser.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const browserEntry = path.join(repoRoot, 'src', 'usercards', 'browser.ts');

/** The bundled browser entry point, loaded as the browser composition loads its capabilities. */
type BrowserEntry = {
  readonly createUserCardsOperations?: typeof createUserCardsOperations;
  readonly usercardsConstraints?: typeof usercardsConstraints;
};

/** Bundles one consumer of UserCards' browser entry point, as the browser deployment bundles it. */
async function bundleBrowserEntry(): Promise<BrowserEntry> {
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(browserEntry)};`,
      resolveDir: repoRoot,
      sourcefile: 'usercards-browser-consumer.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  });
  const [output] = result.outputFiles ?? [];
  if (output === undefined) {
    throw new Error('esbuild produced no UserCards browser bundle.');
  }
  const url = `data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`;
  return (await import(url)) as BrowserEntry;
}

describe('usercards browser entry point', () => {
  it('bundles the operation facade and constraints without backend modules', async () => {
    const bundle = await bundleBrowserEntry();

    expect(typeof bundle.createUserCardsOperations).toBe('function');
    expect(bundle.usercardsConstraints?.batch.confirmEntries).toBe(50);
  });

  it('retains and recovers an operation from the bundled facade', async () => {
    const bundle = await bundleBrowserEntry();
    const create = bundle.createUserCardsOperations;
    if (create === undefined) {
      throw new Error('The bundled entry published no operation facade.');
    }
    const changes: UserCardsChange[] = [];
    const client: UserCardsBrowserClient = {
      ...unusedBundleClient(),
      confirmImport: () => Promise.reject(new Error('The response was lost.')),
      recoverImportOperation: async (operationId) => ({
        outcome: 'recorded',
        receipt: {
          operationId,
          sessionId: 'import-1',
          sourceKind: 'manual',
          sourceId: 'manual',
          destination: { kind: 'ownership' },
          publicationPosition: '4',
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
        },
      }),
    };
    const account = create({ client, storage: null }).account('account-42');
    account.subscribe((change) => changes.push(change));

    const confirmation = account.confirmImport({
      sessionId: 'import-1',
      destination: { kind: 'ownership' },
      entries: [{ entryId: 'entry-1', expectedRevision: 1 }],
    });

    await expect.poll(() => confirmation.outcome().state).toBe('committed');
    expect(changes).toEqual([
      {
        scope: 'copies',
        records: [{ kind: 'copy', copyId: 'copy-1' }],
        imports: ['import-1'],
        position: '4',
      },
    ]);
    expect(account.retained()).toEqual([]);
  });
});

/** The private client of the bundle case; every operation it does not script rejects. */
function unusedBundleClient(): UserCardsBrowserClient {
  const unused = () => Promise.reject(new Error('The bundle case scripts no such operation.'));
  return {
    readCopies: unused,
    correctCopy: unused,
    listTags: unused,
    readTags: unused,
    createTag: unused,
    renameTag: unused,
    listAssociations: unused,
    readAssociations: unused,
    createAssociation: unused,
    changeAssociation: unused,
    removeAssociation: unused,
    setCopyLocation: unused,
    listImportSessions: unused,
    listImportEntries: unused,
    stageImportEntries: unused,
    stageSourceImport: unused,
    stageCaptureObservation: unused,
    reviewImportEntry: unused,
    attachImportCandidates: unused,
    discardImportEntry: unused,
    discardImportSession: unused,
    confirmImport: unused,
    recoverImportOperation: unused,
  };
}
