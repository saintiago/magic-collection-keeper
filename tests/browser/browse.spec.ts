/**
 * Browser journeys: the browsing pages (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/search.md#scryfall-compatibility,
 * docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real shell with the real Home and catalog pages and the controlled
 * component access of browse.harness.ts and drive them in Chromium: Home's search opens the
 * catalog, the catalog presents basic information with quantities, the text expression and the
 * structured controls build one query, an unsupported expression is reported instead of an empty
 * result, printing images load and retry separately, further results carry the continuation of
 * their query, Back restores the query, the controls and the selection, recent activity belongs to
 * the account that opened the card, and a closed page withdraws its search and presents no late
 * result.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type {
  UiBrowseCatalogRequest,
  UiBrowseControl,
  UiBrowseSearchRequest,
} from './browse.harness.js';
import type { PrintingRecord } from '../../src/catalog/index.js';
import type { SearchPage, SearchEntry } from '../../src/search/index.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = path.join(repoRoot, 'tests', 'browser', 'browse.harness.ts');
const browsePageHtml = '<!doctype html><html><body><div id="ui-root"></div></body></html>';

let bundle: Promise<string> | null = null;

/** Bundles the browsing pages with the journey harness, as a deployment bundles the UI. */
function browseBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({
      stdin: {
        contents: [
          `import { installBrowseHarness } from ${JSON.stringify(harnessPath)};`,
          "globalThis.keeperBrowseControl = installBrowseHarness(document.getElementById('ui-root'));",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'browse-consumer.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
    });
    const [output] = result.outputFiles ?? [];
    if (output === undefined) {
      throw new Error('esbuild produced no browser bundle.');
    }
    return output.text;
  })();
  return bundle;
}

/** Serves a fresh document for the browsing pages, enters it at `hash` and loads the UI. */
async function openBrowse(page: Page, hash: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-browse.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: browsePageHtml }),
  );
  await page.goto(`http://keeper-browse.test/${hash}`);
  await page.addScriptTag({ content: await browseBundle(), type: 'module' });
  return errors;
}

/** Requested searches the harness recorded. */
async function searchRequests(page: Page): Promise<readonly UiBrowseSearchRequest[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
    ).keeperBrowseControl.searchRequests(),
  );
}

/** The search request at `index`, waiting until the page issued it. */
async function searchRequest(page: Page, index = 0): Promise<UiBrowseSearchRequest> {
  await expect.poll(async () => (await searchRequests(page)).length).toBeGreaterThan(index);
  const request = (await searchRequests(page))[index];
  if (request === undefined) {
    throw new Error(`The page did not issue search request ${index}.`);
  }
  return request;
}

async function settleSearch(page: Page, id: number, pageValue: SearchPage): Promise<void> {
  await page.evaluate(
    ({ id: requestId, value }) => {
      (
        globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
      ).keeperBrowseControl.settleSearch(requestId, value);
    },
    { id, value: pageValue },
  );
}

async function failSearch(
  page: Page,
  id: number,
  failure: { readonly code: string; readonly message: string },
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, value }) => {
      (
        globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
      ).keeperBrowseControl.failSearch(requestId, value as never);
    },
    { id, value: failure },
  );
}

/** Catalog resolves the harness recorded. */
async function catalogRequests(page: Page): Promise<readonly UiBrowseCatalogRequest[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
    ).keeperBrowseControl.catalogRequests(),
  );
}

/** The catalog resolve at `index`, waiting until the images fragment issued it. */
async function catalogRequest(page: Page, index = 0): Promise<UiBrowseCatalogRequest> {
  await expect.poll(async () => (await catalogRequests(page)).length).toBeGreaterThan(index);
  const request = (await catalogRequests(page))[index];
  if (request === undefined) {
    throw new Error(`The page did not issue catalog resolve ${index}.`);
  }
  return request;
}

async function settleCatalog(
  page: Page,
  id: number,
  printings: readonly PrintingRecord[],
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, value }) => {
      (
        globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
      ).keeperBrowseControl.settleCatalog(requestId, value);
    },
    { id, value: printings },
  );
}

async function failCatalog(page: Page, id: number, message: string): Promise<void> {
  await page.evaluate(
    ({ id: requestId, value }) => {
      (
        globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
      ).keeperBrowseControl.failCatalog(requestId, value);
    },
    { id, value: message },
  );
}

/** Reports a verified sign-in of another account inside the installed shell. */
async function signInAs(page: Page, accountId: string): Promise<void> {
  await page.evaluate((value) => {
    (
      globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
    ).keeperBrowseControl.signInAs(value);
  }, accountId);
}

/** One card-level search entry. */
function cardEntry(
  cardId: string,
  options: {
    readonly name?: string;
    readonly matchedName?: string | null;
    readonly quantity?: { readonly copies: number | null; readonly intended: number | null } | null;
  } = {},
): SearchEntry {
  return {
    entryKey: `card:${cardId}`,
    target: { kind: 'card', cardId },
    card: {
      cardId,
      name: options.name ?? `Card ${cardId}`,
      matchedName: options.matchedName ?? null,
    },
    printing: null,
    quantity: options.quantity ?? null,
  };
}

/** One printing-level search entry of a named card. */
function printingEntry(printingId: string, cardId: string, name: string): SearchEntry {
  return {
    entryKey: `printing:${printingId}`,
    target: { kind: 'printing', printingId },
    card: { cardId, name, matchedName: null },
    printing: { printingId, edition: 'BLB', collectorNumber: '1', language: 'en' },
    quantity: null,
  };
}

/** One page the Search contract returns. */
function searchPage(
  entries: readonly SearchEntry[],
  options: { readonly totalCount?: number; readonly continuation?: string | null } = {},
): SearchPage {
  return {
    entries,
    totalCount: options.totalCount ?? entries.length,
    continuation: options.continuation ?? null,
    revisions: { catalogRevision: 'browse-revision', privateRevision: null },
  };
}

/** One printing with the images a result row presents. */
function printing(cardId: string): PrintingRecord {
  return {
    printingId: 'printing-1',
    cardId,
    edition: 'BLB',
    collectorNumber: '1',
    language: 'en',
    finishes: ['nonfoil'],
    physical: true,
    images: {
      small: 'https://cards.test/blb-1-small.jpg',
      normal: 'https://cards.test/blb-1-normal.jpg',
      large: null,
      artCrop: null,
    },
  };
}

test('Home opens the catalog and the catalog presents its entries', async ({ page }) => {
  const errors = await openBrowse(page, '#/');

  await expect(page.getByRole('heading', { name: 'Recent cards' })).toBeVisible();
  await expect(page.locator('[data-ui-card-list] [data-ui-status]')).toHaveText('No entries');

  await page.getByLabel('Search cards').fill('lightning bolt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Catalog and search' })).toBeVisible();
  expect(page.url()).toContain('query=lightning');
  await expect(page.getByLabel('Search cards')).toHaveValue('lightning bolt');
  const request = await searchRequest(page);
  expect(request.request).toEqual({
    resultLevel: 'card',
    query: 'lightning bolt',
    pageSize: 50,
  });

  await settleSearch(
    page,
    request.id,
    searchPage([
      cardEntry('card-bolt', {
        name: 'Lightning Bolt',
        matchedName: 'Blitzschlag',
        quantity: { copies: 2, intended: 4 },
      }),
    ]),
  );

  const row = page.locator('[data-ui-entry="card:card-bolt"]');
  await expect(row).toContainText('Lightning Bolt');
  await expect(row.locator('[data-ui-matched-name]')).toHaveText(' (Blitzschlag)');
  await expect(row.locator('[data-ui-copies]')).toHaveText(' Copies: 2');
  await expect(row.locator('[data-ui-intended]')).toHaveText(' Intended: 4');
  await expect(row.locator('[data-ui-open]')).toHaveAttribute('href', '#/cards/card-bolt');

  // Opening the entry presents its details without selecting it, and Back presents it again.
  await expect(page.getByLabel('Select Lightning Bolt')).not.toBeChecked();
  await row.locator('[data-ui-open]').click();
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');
  await page.goBack();
  const restored = await searchRequest(page, 1);
  await settleSearch(
    page,
    restored.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );
  await expect(page.getByLabel('Select Lightning Bolt')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('opening a card records recent activity for its account only', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog');
  const request = await searchRequest(page);
  await settleSearch(
    page,
    request.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' }), cardEntry('card-elf')]),
  );

  await page.getByRole('link', { name: /Lightning Bolt/ }).click();
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('[data-ui-entry="card:card-bolt"]')).toContainText('Lightning Bolt');
  await expect(page.locator('[data-ui-entry="card:card-elf"]')).toHaveCount(0);

  // Another account never sees the activity, and it does not return with the first account.
  await signInAs(page, 'bob');
  await expect(page.locator('[data-ui-entry="card:card-bolt"]')).toHaveCount(0);
  await signInAs(page, 'alice');
  await expect(page.locator('[data-ui-entry="card:card-bolt"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an unsupported expression is reported instead of an empty result', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog?query=foo%3Abar');

  await expect(page.getByLabel('Search cards')).toHaveValue('foo:bar');
  const request = await searchRequest(page);
  expect(request.request).toEqual({ resultLevel: 'card', query: 'foo:bar', pageSize: 50 });

  await failSearch(page, request.id, {
    code: 'unsupported-query',
    message: 'The search expression "foo:bar" is not supported. Unknown keyword "foo".',
  });

  await expect(page.locator('[data-ui-card-list] [data-ui-status]')).toHaveText(
    'The search expression "foo:bar" is not supported. Unknown keyword "foo".',
  );
  await expect(page.locator('[data-ui-status]')).not.toHaveText('No entries');
  await expect(page.getByLabel('Search cards')).toHaveValue('foo:bar');
  expect(errors).toEqual([]);
});

test('printing results load images separately and retry a failed read', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog?level=printing&query=set%3Ablb');

  const request = await searchRequest(page);
  expect(request.request).toEqual({ resultLevel: 'printing', query: 'set:blb', pageSize: 50 });
  await settleSearch(
    page,
    request.id,
    searchPage([printingEntry('printing-1', 'card-bolt', 'Lightning Bolt')]),
  );

  await expect(page.locator('[data-ui-entry="printing:printing-1"]')).toContainText('BLB 1 · en');
  const images = await catalogRequest(page);
  expect(images.references).toEqual([{ kind: 'printing', printingId: 'printing-1' }]);

  await failCatalog(page, images.id, 'Catalog unavailable');
  await expect(page.locator('[data-ui-fragment="images"]')).toContainText(
    'images unavailable: Catalog unavailable',
  );

  await page.getByRole('button', { name: 'Retry images', exact: true }).click();
  const retry = await catalogRequest(page, 1);
  await settleCatalog(page, retry.id, [printing('card-bolt')]);

  await expect(page.locator('[data-ui-fragment="images"] img')).toHaveAttribute(
    'src',
    'https://cards.test/blb-1-normal.jpg',
  );
  await expect(page.locator('[data-ui-fragment="images"] img')).toHaveAttribute(
    'alt',
    'BLB 1 · en',
  );
  expect(errors).toEqual([]);
});

test('the structured controls build the query the URL and the search carry', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog');

  const opening = await searchRequest(page);
  expect(opening.request).toEqual({ resultLevel: 'card', pageSize: 50 });
  await settleSearch(page, opening.id, searchPage([]));
  // A successful evaluation with no matches is an empty result, not a failure.
  await expect(page.locator('[data-ui-status]')).toHaveText('No entries');

  await page.getByLabel('Search cards').fill('bolt');
  await page.getByLabel('Result level').selectOption('printing');
  await page.getByLabel('Owned only').check();
  await page.getByLabel('Finish').selectOption('foil');
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  expect(page.url()).toContain('query=bolt');
  expect(page.url()).toContain('level=printing');
  expect(page.url()).toContain('owned=1');
  expect(page.url()).toContain('finish=foil');
  await expect(page.getByLabel('Result level')).toHaveValue('printing');
  await expect(page.getByLabel('Owned only')).toBeChecked();
  await expect(page.getByLabel('Finish')).toHaveValue('foil');

  const request = await searchRequest(page, 1);
  expect(request.request).toEqual({
    resultLevel: 'printing',
    query: 'bolt',
    criteria: [{ kind: 'owned' }, { kind: 'finish', finish: 'foil' }],
    pageSize: 50,
  });
  await settleSearch(
    page,
    request.id,
    searchPage([printingEntry('printing-1', 'card-bolt', 'Lightning Bolt')]),
  );
  await expect(page.locator('[data-ui-entry="printing:printing-1"]')).toContainText(
    'Lightning Bolt',
  );
  expect(errors).toEqual([]);
});

test('further results load with the continuation of the same query', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog?query=bolt');

  const first = await searchRequest(page);
  await settleSearch(
    page,
    first.id,
    searchPage([cardEntry('card-1', { name: 'Bolt One' })], {
      totalCount: 2,
      continuation: 'cursor-1',
    }),
  );

  await page.getByRole('button', { name: 'Load more' }).click();
  const next = await searchRequest(page, 1);
  expect(next.request).toEqual({
    resultLevel: 'card',
    query: 'bolt',
    pageSize: 50,
    continuation: 'cursor-1',
  });
  await settleSearch(page, next.id, searchPage([cardEntry('card-2', { name: 'Bolt Two' })]));

  await expect(page.locator('[data-ui-entry]')).toHaveCount(2);
  await expect(page.locator('[data-ui-entry="card:card-2"]')).toContainText('Bolt Two');
  // The second entry carries no quantity context, and an unavailable count is not a zero.
  await expect(page.locator('[data-ui-entry="card:card-2"] [data-ui-copies]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a stale continuation is reported and refreshing restarts the result', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog?query=bolt');

  const first = await searchRequest(page);
  await settleSearch(
    page,
    first.id,
    searchPage([cardEntry('card-1', { name: 'Bolt One' })], {
      totalCount: 2,
      continuation: 'cursor-1',
    }),
  );
  await page.getByRole('button', { name: 'Load more' }).click();
  const stale = await searchRequest(page, 1);
  await failSearch(page, stale.id, {
    code: 'stale-continuation',
    message: 'The catalog changed since this page; start the search again.',
  });

  await expect(page.locator('[data-ui-status]')).toHaveText(
    'The catalog changed since this page; start the search again.',
  );
  await expect(page.locator('[data-ui-entry="card:card-1"]')).toContainText('Bolt One');

  await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
  const restart = await searchRequest(page, 2);
  expect(restart.request).toEqual({ resultLevel: 'card', query: 'bolt', pageSize: 50 });
  await settleSearch(page, restart.id, searchPage([cardEntry('card-2', { name: 'Bolt Two' })]));

  await expect(page.locator('[data-ui-entry="card:card-1"]')).toHaveCount(0);
  await expect(page.locator('[data-ui-entry="card:card-2"]')).toContainText('Bolt Two');
  expect(errors).toEqual([]);
});

test('Back and Forward restore the catalog query, its controls, focus and selection', async ({
  page,
}) => {
  const errors = await openBrowse(page, '#/');

  await page.getByRole('link', { name: 'Catalog', exact: true }).click();
  const first = await searchRequest(page);
  await settleSearch(
    page,
    first.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );
  await page.getByLabel('Select Lightning Bolt').check();
  await page.getByLabel('Search cards').fill('draft');
  await page.getByLabel('Owned only').check();
  await page.getByLabel('Finish').selectOption('foil');
  await page.getByLabel('Search cards').focus();

  // The browser's Back leaves the catalog, keeping the entry it left: query, controls and focus.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.goForward();

  await expect(page.getByRole('heading', { name: 'Catalog and search' })).toBeVisible();
  await expect(page.getByLabel('Search cards')).toHaveValue('draft');
  await expect(page.getByLabel('Search cards')).toBeFocused();
  await expect(page.getByLabel('Owned only')).toBeChecked();
  await expect(page.getByLabel('Finish')).toHaveValue('foil');

  // The restored page evaluates the query its URL names; the selection returns with its entries.
  const restored = await searchRequest(page, 1);
  expect(restored.request).toEqual({ resultLevel: 'card', pageSize: 50 });
  await settleSearch(
    page,
    restored.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );
  await expect(page.getByLabel('Select Lightning Bolt')).toBeChecked();
  expect(errors).toEqual([]);
});

test('a closed page withdraws its search and presents no late result', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog?query=bolt');

  const request = await searchRequest(page);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect
    .poll(async () => (await searchRequests(page)).map((entry) => entry.aborted))
    .toEqual([true]);

  await settleSearch(
    page,
    request.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('[data-ui-entry="card:card-bolt"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
