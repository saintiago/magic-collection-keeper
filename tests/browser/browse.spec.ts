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
  UiBrowseStart,
} from './browse.harness.js';
import type { PrintingRecord } from '../../src/catalog/index.js';
import {
  encodeSearchContinuation,
  normalizeSearchRequest,
  type SearchPage,
  type SearchEntry,
} from '../../src/search/index.js';

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
          'globalThis.keeperBrowseControl = installBrowseHarness(',
          "  document.getElementById('ui-root'), globalThis.keeperBrowseStart,",
          ');',
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
async function openBrowse(page: Page, hash: string, start: UiBrowseStart = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-browse.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: browsePageHtml }),
  );
  await page.goto(`http://keeper-browse.test/${hash}`);
  await page.evaluate((flags) => {
    (globalThis as unknown as Record<string, unknown>).keeperBrowseStart = flags;
  }, start);
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

/** Rejects the sign-out the shell awaits, as an authentication outage would. */
async function failSignOut(page: Page, message: string): Promise<void> {
  await page.evaluate((text) => {
    (
      globalThis as unknown as { keeperBrowseControl: UiBrowseControl }
    ).keeperBrowseControl.failSignOut(text);
  }, message);
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

test('signing in again after a sign-out never reads the previous activity', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog');
  const request = await searchRequest(page);
  await settleSearch(
    page,
    request.id,
    searchPage([
      cardEntry('card-bolt', {
        name: 'Lightning Bolt',
        quantity: { copies: 2, intended: 4 },
      }),
    ]),
  );
  await page.getByRole('link', { name: /Lightning Bolt/ }).click();
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('[data-ui-entry="card:card-bolt"] [data-ui-copies]')).toHaveText(
    ' Copies: 2',
  );
  // Card details is presented again, so the transitions below happen away from browsing pages.
  await page.goBack();
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');

  // Sign-out ends the activity although the presented page is a card, not a browsing page.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // The same account signing in again never reads the activity of its previous session.
  await signInAs(page, 'alice');
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recent cards' })).toBeVisible();
  await expect(page.locator('[data-ui-entry="card:card-bolt"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an account change on a card ends the activity of the account it leaves', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog');
  const request = await searchRequest(page);
  await settleSearch(
    page,
    request.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );
  await page.getByRole('link', { name: /Lightning Bolt/ }).click();
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');

  // Both transitions happen on card details, so no browsing page is mounted to clean up.
  await signInAs(page, 'bob');
  await signInAs(page, 'alice');

  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recent cards' })).toBeVisible();
  await expect(page.locator('[data-ui-entry="card:card-bolt"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a failed sign-out keeps the live page and its recent activity', async ({ page }) => {
  const errors = await openBrowse(page, '#/catalog', { deferredSignOut: true });
  const request = await searchRequest(page);
  await settleSearch(
    page,
    request.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );
  await page.getByRole('link', { name: /Lightning Bolt/ }).click();
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('main')).toBeHidden();
  await failSignOut(page, 'Authentication unavailable');

  // The session never ended, so the page stays live and its activity stays with the account.
  await expect(page.locator('#card-level')).toHaveText('card-bolt/-/-');
  await expect(page.locator('#ui-root > p[role="status"]')).toHaveText(
    'Authentication unavailable',
  );
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Recent cards' })).toBeVisible();
  await expect(page.locator('[data-ui-entry="card:card-bolt"]')).toContainText('Lightning Bolt');
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
  const firstLink = page.locator('[data-ui-entry="card:card-1"] [data-ui-open]');
  await firstLink.focus();
  await settleSearch(page, next.id, searchPage([cardEntry('card-2', { name: 'Bolt Two' })]));
  await expect(firstLink).toBeFocused();

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

test('Back and Forward restore the result window, its scroll and the focused result', async ({
  page,
}) => {
  const errors = await openBrowse(page, '#/');
  await page.getByRole('link', { name: 'Catalog', exact: true }).click();

  const entries = Array.from({ length: 50 }, (_, index) =>
    cardEntry(`card-${index}`, { name: `Bolt ${index}` }),
  );
  const opening = await searchRequest(page);
  await settleSearch(page, opening.id, searchPage(entries));

  const last = page.locator('[data-ui-entry="card:card-49"] [data-ui-open]');
  await last.focus();
  const scrollY = await page.evaluate(() => {
    window.scrollTo(0, 4000);
    return window.scrollY;
  });
  expect(scrollY).toBeGreaterThan(0);

  // The browser's Back leaves the catalog and Forward returns to the same history entry.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Recent cards' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Catalog and search' })).toBeVisible();

  // The restored entry evaluates its query again; the window, the scroll offset and the focused
  // result come back once the entries it held are available.
  const restored = await searchRequest(page, 1);
  await settleSearch(page, restored.id, searchPage(entries));

  await expect(last).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollY);
  expect(errors).toEqual([]);
});

test('returning to a paged result reloads the window that held its entry', async ({ page }) => {
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
  const second = await searchRequest(page, 1);
  expect(second.request.continuation).toBe('cursor-1');
  await settleSearch(page, second.id, searchPage([cardEntry('card-2', { name: 'Bolt Two' })]));

  const opened = page.locator('[data-ui-entry="card:card-2"] [data-ui-open]');
  await opened.focus();
  await opened.click();
  await expect(page.locator('#card-level')).toHaveText('card-2/-/-');

  // Back reloads the window the entry had loaded, so the page the opened entry belonged to returns
  // instead of only the first page of the result.
  await page.goBack();
  const reloaded = await searchRequest(page, 2);
  expect(reloaded.request).toEqual({ resultLevel: 'card', query: 'bolt', pageSize: 50 });
  await settleSearch(
    page,
    reloaded.id,
    searchPage([cardEntry('card-1', { name: 'Bolt One' })], {
      totalCount: 2,
      continuation: 'cursor-1',
    }),
  );
  const reloadedNext = await searchRequest(page, 3);
  expect(reloadedNext.request.continuation).toBe('cursor-1');
  await settleSearch(
    page,
    reloadedNext.id,
    searchPage([cardEntry('card-2', { name: 'Bolt Two' })]),
  );

  await expect(page.locator('[data-ui-entry="card:card-2"]')).toContainText('Bolt Two');
  await expect(opened).toBeFocused();
  expect(errors).toEqual([]);
});

test('a delayed restoration never reaches the page presented next', async ({ page }) => {
  const errors = await openBrowse(page, '#/');
  await page.getByRole('link', { name: 'Catalog', exact: true }).click();
  const opening = await searchRequest(page);
  await settleSearch(
    page,
    opening.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Recent cards' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Catalog and search' })).toBeVisible();

  // Leave the restored view before its entries arrive, then settle the withdrawn search.
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  const restored = await searchRequest(page, 1);
  expect(restored.aborted).toBe(true);
  await settleSearch(
    page,
    restored.id,
    searchPage([cardEntry('card-bolt', { name: 'Lightning Bolt' })]),
  );

  await expect(page.getByRole('heading', { name: 'Home' })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('[data-ui-entry]')).toHaveCount(0);
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

for (const total of [550, 525]) {
  test(`Back restores the actual 500-entry window after browsing ${total} results`, async ({
    page,
  }) => {
    const errors = await openBrowse(page, '#/catalog');
    const cursor = (offset: number): string =>
      encodeSearchContinuation({
        query: normalizeSearchRequest({ resultLevel: 'card', pageSize: 50 }),
        context: { accountId: 'alice' },
        revisions: { catalogRevision: '\\'.repeat(200), privateRevision: null },
        offset,
      });
    expect(cursor(50).length).toBeGreaterThan(500);
    const resultPage = (offset: number): SearchPage =>
      searchPage(
        Array.from({ length: Math.min(50, total - offset) }, (_, index) =>
          cardEntry(`card-${offset + index}`, { name: `Card ${offset + index}` }),
        ),
        { totalCount: total, continuation: offset + 50 < total ? cursor(offset + 50) : null },
      );
    for (let offset = 0; offset < total; offset += 50) {
      if (offset > 0) await page.getByRole('button', { name: 'Load more' }).click();
      const request = await searchRequest(page, offset / 50);
      await settleSearch(page, request.id, resultPage(offset));
    }
    await expect(page.locator('[data-ui-entry]')).toHaveCount(500);
    const last = page.locator(`[data-ui-entry="card:card-${total - 1}"] [data-ui-open]`);
    await last.click();
    await expect(page.locator('#card-level')).toHaveText(`card-${total - 1}/-/-`);
    await page.goBack();
    const start = total === 550 ? 50 : 0;
    for (let offset = start, index = 11; offset < total; offset += 50, index += 1) {
      const request = await searchRequest(page, index);
      expect(request.request.continuation).toBe(offset === 0 ? undefined : cursor(offset));
      await settleSearch(page, request.id, resultPage(offset));
    }
    await expect(page.locator('[data-ui-entry]')).toHaveCount(500);
    await expect(page.locator('[data-ui-entry]').first()).toHaveAttribute(
      'data-ui-entry',
      `card:card-${total - 500}`,
    );
    await expect(last).toBeFocused();
    expect(errors).toEqual([]);

    if (total === 550) {
      // The source remains authoritative: a changed revision rejects a retained cursor, and
      // Refresh starts at the beginning instead of retrying an obsolete window indefinitely.
      await last.click();
      await page.goBack();
      const stale = await searchRequest(page, 21);
      expect(stale.request.continuation).toBe(cursor(50));
      await failSearch(page, stale.id, {
        code: 'stale-continuation',
        message: 'Results changed; refresh.',
      });
      await expect(page.locator('[data-ui-status]')).toHaveText('Results changed; refresh.');
      await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
      const fresh = await searchRequest(page, 22);
      expect(fresh.request.continuation).toBeUndefined();
      await settleSearch(page, fresh.id, resultPage(0));
      await expect(page.locator('[data-ui-entry]').first()).toHaveAttribute(
        'data-ui-entry',
        'card:card-0',
      );
    }
  });
}

for (const view of ['catalog', 'home'] as const) {
  test(`history restores the focused result checkbox on ${view}`, async ({ page }) => {
    const errors = await openBrowse(page, '#/');
    await page.getByRole('link', { name: 'Catalog', exact: true }).click();
    const entries = [cardEntry('card-bolt', { name: 'Lightning Bolt' })];
    await settleSearch(page, (await searchRequest(page)).id, searchPage(entries));
    if (view === 'home') {
      await page.locator('[data-ui-open]').click();
      await page.getByRole('link', { name: 'Home', exact: true }).click();
    }
    const checkbox = page.getByLabel('Select Lightning Bolt');
    await checkbox.check();
    await checkbox.focus();
    await page.goBack();
    await page.goForward();
    if (view === 'catalog') {
      await settleSearch(page, (await searchRequest(page, 1)).id, searchPage(entries));
    }
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const action of ['restore', 'input', 'account', 'navigate'] as const) {
  test(`delayed printing image layout respects history position and ${action}`, async ({
    page,
  }) => {
    const errors = await openBrowse(page, '#/catalog?level=printing');
    const imageGate = Promise.withResolvers<void>();
    let delayedImages = 0;
    await page.route('https://cards.test/**', async (route) => {
      if (route.request().url().includes('return')) {
        delayedImages += 1;
        await imageGate.promise;
      }
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="223" height="310"><rect width="223" height="310" fill="gray"/></svg>',
      });
    });
    const entries = Array.from({ length: 10 }, (_, index) =>
      printingEntry(`printing-${index}`, `card-${index}`, `Card ${index}`),
    );
    const printings = entries.map((entry, index): PrintingRecord => ({
      ...printing(entry.card.cardId),
      printingId: `printing-${index}`,
      images: {
        small: null,
        normal: `https://cards.test/${index}.svg`,
        large: null,
        artCrop: null,
      },
    }));
    await settleSearch(page, (await searchRequest(page)).id, searchPage(entries));
    await settleCatalog(page, (await catalogRequest(page)).id, printings);
    await expect
      .poll(() =>
        page
          .locator('img')
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalHeight === 310,
            ),
          ),
      )
      .toBe(true);
    const last = page.locator('[data-ui-entry="printing:printing-9"] [data-ui-open]');
    await last.focus();
    await last.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().top - 120));
    const departedTop = await last.evaluate((element) => element.getBoundingClientRect().top);
    await last.click();
    await page.goBack();
    await settleSearch(page, (await searchRequest(page, 1)).id, searchPage(entries));
    await expect(last).toBeFocused();
    await settleCatalog(
      page,
      (await catalogRequest(page, 1)).id,
      printings.map((value) => ({
        ...value,
        images: { ...value.images, normal: `${value.images.normal}?return` },
      })),
    );
    await expect.poll(() => delayedImages).toBe(10);
    if (action === 'input') {
      await page.getByLabel('Search cards').focus();
      await page.getByLabel('Search cards').press('Home');
      await page.evaluate(() => window.scrollTo(0, 0));
    } else if (action === 'account') {
      await signInAs(page, 'bob');
    } else if (action === 'navigate') {
      await page.getByRole('link', { name: 'Home', exact: true }).click();
    }
    imageGate.resolve();
    if (action === 'restore' || action === 'input') {
      await expect
        .poll(() =>
          page
            .locator('img')
            .evaluateAll((images) =>
              images.every(
                (image) =>
                  image instanceof HTMLImageElement &&
                  image.complete &&
                  image.naturalHeight === 310,
              ),
            ),
        )
        .toBe(true);
      if (action === 'restore') {
        await expect
          .poll(async () =>
            Math.abs(
              (await last.evaluate((element) => element.getBoundingClientRect().top)) - departedTop,
            ),
          )
          .toBeLessThan(2);
        await expect(last).toBeFocused();
      } else {
        await expect(page.getByLabel('Search cards')).toBeFocused();
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      }
    } else {
      await expect(page.locator('h1')).toBeFocused();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.locator('[data-ui-entry]')).toHaveCount(action === 'navigate' ? 1 : 0);
    }
    expect(errors).toEqual([]);
  });
}

for (const level of ['card', 'printing'] as const) {
  for (const attempted of [100, 101]) {
    test(`Back preserves browsing state after ${attempted} ${level} selection attempts`, async ({
      page,
    }) => {
      const errors = await openBrowse(page, `#/catalog?level=${level}`);
      const resultPage = (offset: number): SearchPage =>
        searchPage(
          Array.from({ length: 50 }, (_, index) => {
            const id = offset + index;
            return level === 'card'
              ? cardEntry(`card-${id}`, { name: `Card ${id}` })
              : printingEntry(`printing-${id}`, `card-${id}`, `Card ${id}`);
          }),
          { totalCount: 150, continuation: offset < 100 ? `cursor-${offset + 50}` : null },
        );
      for (let index = 0; index < 3; index += 1) {
        if (index > 0) await page.getByRole('button', { name: 'Load more' }).click();
        const request = await searchRequest(page, index);
        await settleSearch(page, request.id, resultPage(index * 50));
      }
      await expect(page.locator('[data-ui-entry]')).toHaveCount(150);
      // Native clicks exercise the checkbox behavior, including disabled controls at the bound.
      await page.locator('[data-ui-select]').evaluateAll((inputs, count) => {
        for (const input of inputs.slice(0, count)) (input as HTMLInputElement).click();
      }, attempted);
      await page.getByLabel('Search cards').fill('unsaved query');
      await page.getByLabel('Owned only').check();
      await page.getByLabel('Finish').selectOption('foil');
      const opened = page.locator('[data-ui-open]').last();
      await opened.click();
      await expect(page.locator('#card-level')).toContainText('card-149/');
      await page.goBack();
      await expect(page.getByLabel('Search cards')).toHaveValue('unsaved query');
      await expect(page.getByLabel('Owned only')).toBeChecked();
      await expect(page.getByLabel('Finish')).toHaveValue('foil');
      for (let index = 0; index < 3; index += 1) {
        const request = await searchRequest(page, 3 + index);
        await settleSearch(page, request.id, resultPage(index * 50));
      }
      await expect(page.locator('[data-ui-entry]')).toHaveCount(150);
      await expect(page.locator('[data-ui-select]:checked')).toHaveCount(100);
      await expect(opened).toBeFocused();
      await expect(opened).toBeInViewport();
      await expect(page.locator('[data-ui-select]').nth(100)).toBeDisabled();
      await page.locator('[data-ui-select]').first().uncheck();
      await page.locator('[data-ui-select]').nth(100).check();
      await expect(page.locator('[data-ui-select]:checked')).toHaveCount(100);
      expect(errors).toEqual([]);
    });
  }
}

for (const level of ['card', 'printing'] as const) {
  test(`repeated returns retain an evicted ${level} selection until explicitly cleared`, async ({
    page,
  }) => {
    const errors = await openBrowse(page, `#/catalog?level=${level}`);
    const resultPage = (offset: number): SearchPage =>
      searchPage(
        Array.from({ length: 50 }, (_, index) => {
          const id = offset + index;
          return level === 'card'
            ? cardEntry(`card-${id}`, { name: `Card ${id}` })
            : printingEntry(`printing-${id}`, `card-${id}`, `Card ${id}`);
        }),
        { totalCount: 550, continuation: offset < 500 ? `cursor-${offset + 50}` : null },
      );
    let requestIndex = 0;
    for (let offset = 0; offset < 550; offset += 50) {
      if (offset > 0) await page.getByRole('button', { name: 'Load more' }).click();
      await settleSearch(page, (await searchRequest(page, requestIndex++)).id, resultPage(offset));
      if (offset === 0)
        await page.getByRole('checkbox', { name: /^Select Card 0(?: \(|$)/ }).check();
    }
    const count = page.locator('[data-ui-selection-count]');
    await expect(page.getByRole('checkbox', { name: /^Select Card 0(?: \(|$)/ })).toHaveCount(0);
    for (let visit = 0; visit < 2; visit += 1) {
      await page.locator('[data-ui-open]').last().click();
      await page.goBack();
      for (let offset = 50; offset < 550; offset += 50) {
        const request = await searchRequest(page, requestIndex++);
        expect(request.request.continuation).toBe(`cursor-${offset}`);
        await settleSearch(page, request.id, resultPage(offset));
      }
      await expect(count).toHaveText('1 of 100 selected');
    }
    // Reload the selected row to prove the retained identity still drives its checkbox.
    await page.getByRole('button', { name: 'Refresh results', exact: true }).click();
    await settleSearch(page, (await searchRequest(page, requestIndex++)).id, resultPage(0));
    await expect(page.getByRole('checkbox', { name: /^Select Card 0(?: \(|$)/ })).toBeChecked();
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await page.locator('[data-ui-open]').first().click();
    await page.goBack();
    await settleSearch(page, (await searchRequest(page, requestIndex)).id, resultPage(0));
    await expect(page.getByRole('checkbox', { name: /^Select Card 0(?: \(|$)/ })).not.toBeChecked();
    await expect(count).toHaveText('0 of 100 selected');
    expect(errors).toEqual([]);
  });

  test(`leaving pending ${level} restoration retains selection and respects later deselection`, async ({
    page,
  }) => {
    const errors = await openBrowse(page, `#/catalog?level=${level}`);
    const entries = [
      level === 'card'
        ? cardEntry('card-bolt', { name: 'Lightning Bolt' })
        : printingEntry('printing-bolt', 'card-bolt', 'Lightning Bolt'),
    ];
    await settleSearch(page, (await searchRequest(page)).id, searchPage(entries));
    const checkbox = page.getByLabel('Select Lightning Bolt');
    await checkbox.check();
    await page.locator('[data-ui-open]').click();
    await page.goBack();
    const pending = await searchRequest(page, 1);
    await page.goForward();
    await expect(page.locator('#card-level')).toContainText('card-bolt/');
    await page.goBack();
    await settleSearch(page, (await searchRequest(page, 2)).id, searchPage(entries));
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await page.goForward();
    await page.goBack();
    await settleSearch(page, (await searchRequest(page, 3)).id, searchPage(entries));
    // Even a late response to the abandoned restoration cannot resurrect deselected state.
    await settleSearch(page, pending.id, searchPage(entries));
    await expect(checkbox).not.toBeChecked();
    await expect(page.locator('[data-ui-selection-count]')).toHaveText('0 of 100 selected');
    expect(errors).toEqual([]);
  });
}
