/**
 * Component scope: Search's browser entry point (docs/search.md#freshness, docs/architecture.md).
 * The cases bundle the entry with the repository's browser bundling settings and instantiate the
 * capability from that bundle, so a transitive backend import or a Node-only dependency fails here
 * instead of in the browser composition that consumes the capability.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { createSearchProgress, type SearchProgress } from '../../../src/search/browser.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const browserEntry = path.join(repoRoot, 'src', 'search', 'browser.ts');

/** The bundled browser entry point, loaded as the browser composition loads its capabilities. */
type BrowserEntry = {
  readonly createSearchProgress?: typeof createSearchProgress;
  readonly SEARCH_PROGRESS_DEFAULT_WINDOW_MS?: number;
};

/** Bundles one consumer of Search's browser entry point, as the browser deployment bundles it. */
async function bundleBrowserEntry(): Promise<BrowserEntry> {
  const result = await build({
    stdin: {
      contents: `export * from ${JSON.stringify(browserEntry)};`,
      resolveDir: repoRoot,
      sourcefile: 'search-browser-consumer.ts',
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
    throw new Error('esbuild produced no Search browser bundle.');
  }
  const url = `data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`;
  return (await import(url)) as BrowserEntry;
}

describe('search browser entry point', () => {
  it('bundles the account progress capability without backend modules', async () => {
    const bundle = await bundleBrowserEntry();

    expect(typeof bundle.createSearchProgress).toBe('function');
    expect(bundle.SEARCH_PROGRESS_DEFAULT_WINDOW_MS).toBe(5_000);
  });

  it('instantiates the bundled tracker and reports incorporation', async () => {
    const bundle = await bundleBrowserEntry();
    const create = bundle.createSearchProgress;
    if (create === undefined) {
      throw new Error('The bundled entry published no progress capability.');
    }
    const progress = create({
      accountId: 'account-42',
      intervalMs: 10,
      windowMs: 50,
      read: async (): Promise<SearchProgress> => ({
        state: 'incorporated',
        revisions: {
          generation: 'generation-1',
          catalogRevision: 'revision-1',
          catalogPosition: '9',
          privateRevision: '7',
        },
      }),
    });

    progress.committed(['7']);

    await expect.poll(() => progress.status().state).toBe('incorporated');
    expect(progress.status().outstanding).toEqual([]);
  });
});
