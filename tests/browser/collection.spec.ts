/**
 * Browser journeys: the collection and card-details pages (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations,
 * docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real shell with the real collection and card-details pages and the
 * controlled component access of collection.harness.ts and drive them in Chromium: the collection
 * evaluates the owned records of the level its URL names, its entries show physical copies and
 * intended quantities distinctly and open the details of the level they name, a copy presents its
 * stored attributes and corrects printing, finish and condition, a conflict and a lost response
 * keep and recover the unsaved change, a failed read of one copy stays reported until a read
 * establishes its state again, and bulk changes act on the explicit selected copy identities
 * without reporting partial work as saved.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type { ApplicationFailureCode } from '../../src/application/index.js';
import type { CardRecord, PrintingRecord } from '../../src/catalog/index.js';
import type { SearchEntry, SearchPage } from '../../src/search/index.js';
import type { PhysicalCopy } from '../../src/usercards/index.js';
import { organizationContinuationFailures } from '../support/organization-pagination.js';
import type {
  UiCollectionControl,
  UiCollectionCorrection,
  UiCollectionCopyRead,
  UiCollectionSearchRequest,
} from './collection.harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = path.join(repoRoot, 'tests', 'browser', 'collection.harness.ts');
const collectionPageHtml = '<!doctype html><html><body><div id="ui-root"></div></body></html>';

const replacementPath = path.join(repoRoot, 'tests', 'browser', 'replacement-modules.ts');

let bundle: Promise<string> | null = null;
let replacementBundle: Promise<string> | null = null;

/** Bundles the collection pages with the journey harness, as a deployment bundles the UI. */
function collectionBundle(): Promise<string> {
  bundle ??= bundleOf([
    `import { installCollectionHarness } from ${JSON.stringify(harnessPath)};`,
    "globalThis.keeperCollectionControl = installCollectionHarness(document.getElementById('ui-root'));",
  ]);
  return bundle;
}

/** The same pages over a replacement CardViews module (docs/ui/architecture.md#replacement-check). */
function replacementCollectionBundle(): Promise<string> {
  replacementBundle ??= bundleOf([
    `import { installCollectionHarness } from ${JSON.stringify(harnessPath)};`,
    `import { replacementModules } from ${JSON.stringify(replacementPath)};`,
    "globalThis.keeperCollectionControl = installCollectionHarness(document.getElementById('ui-root'), replacementModules());",
  ]);
  return replacementBundle;
}

/** Bundles one journey entry as a deployment bundles the UI. */
async function bundleOf(lines: readonly string[]): Promise<string> {
  const result = await build({
    stdin: {
      contents: lines.join('\n'),
      resolveDir: repoRoot,
      sourcefile: 'collection-consumer.ts',
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
}

/** Serves a fresh document for the collection pages, enters it at `hash` and loads the UI. */
async function openCollection(page: Page, hash: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-collection.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: collectionPageHtml }),
  );
  await page.goto(`http://keeper-collection.test/${hash}`);
  await page.addScriptTag({ content: await collectionBundle(), type: 'module' });
  await page.waitForFunction(() => Reflect.has(globalThis, 'keeperCollectionControl'));
  return errors;
}

/** Serves a fresh document for the collection pages over a replacement module. */
async function openReplacementCollection(page: Page, hash: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-collection.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: collectionPageHtml }),
  );
  await page.goto(`http://keeper-collection.test/${hash}`);
  await page.addScriptTag({ content: await replacementCollectionBundle(), type: 'module' });
  await page.waitForFunction(() => Reflect.has(globalThis, 'keeperCollectionControl'));
  return errors;
}

async function searchRequests(page: Page): Promise<readonly UiCollectionSearchRequest[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.searchRequests(),
  );
}

async function searchRequest(page: Page, index = 0): Promise<UiCollectionSearchRequest> {
  await expect.poll(async () => (await searchRequests(page)).length).toBeGreaterThan(index);
  const request = (await searchRequests(page))[index];
  if (request === undefined) {
    throw new Error(`The page did not issue search request ${index}.`);
  }
  return request;
}

async function settleSearch(page: Page, id: number, value: SearchPage): Promise<void> {
  await page.evaluate(
    ({ id: requestId, page: value }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.settleSearch(requestId, value);
    },
    { id, page: value },
  );
}

async function copyReads(page: Page): Promise<readonly UiCollectionCopyRead[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.copyReads(),
  );
}

async function copyRead(page: Page, index = 0): Promise<UiCollectionCopyRead> {
  await expect.poll(async () => (await copyReads(page)).length).toBeGreaterThan(index);
  const read = (await copyReads(page))[index];
  if (read === undefined) {
    throw new Error(`The page did not issue copy read ${index}.`);
  }
  return read;
}

async function settleCopyRead(
  page: Page,
  id: number,
  copies: readonly PhysicalCopy[],
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, values }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.settleCopyRead(requestId, { copies: values });
    },
    { id, values: copies },
  );
}

async function corrections(page: Page): Promise<readonly UiCollectionCorrection[]> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.corrections(),
  );
}

async function correction(page: Page, index = 0): Promise<UiCollectionCorrection> {
  await expect.poll(async () => (await corrections(page)).length).toBeGreaterThan(index);
  const recorded = (await corrections(page))[index];
  if (recorded === undefined) {
    throw new Error(`The page did not issue correction ${index}.`);
  }
  return recorded;
}

/** The printing-list read at `index`, waiting until the page issued it. */
async function printingsRequest(page: Page, index = 0) {
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
          ).keeperCollectionControl.printingsRequests().length,
      ),
    )
    .toBeGreaterThan(index);
  return page.evaluate(
    (position) =>
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.printingsRequests()[position],
    index,
  );
}

async function settlePrintings(
  page: Page,
  id: number,
  printings: readonly PrintingRecord[],
  continuation: string | null,
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, values, next }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.settlePrintings(requestId, {
        cardId: values[0]?.cardId ?? 'card-1',
        cardExists: true,
        revision: {
          revisionId: 'revision-1',
          sourceName: 'fixture',
          sourceVersion: '1',
          publishedAt: '2026-09-01T00:00:00.000Z',
        },
        printings: values,
        continuation: next,
      });
    },
    { id, values: printings, next: continuation },
  );
}

async function failPrintings(
  page: Page,
  id: number,
  failure: { readonly code: ApplicationFailureCode; readonly message: string },
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, value }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.failPrintings(requestId, value);
    },
    { id, value: failure },
  );
}

async function failCopyRead(
  page: Page,
  id: number,
  failure: { readonly code: string; readonly message: string },
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, value }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.failCopyRead(requestId, value as never);
    },
    { id, value: failure },
  );
}

async function settleCorrection(
  page: Page,
  id: number,
  copies: readonly PhysicalCopy[],
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, values }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.settleCorrection(requestId, values);
    },
    { id, values: copies },
  );
}

async function failCorrection(
  page: Page,
  id: number,
  failure: { readonly code: string; readonly message: string },
): Promise<void> {
  await page.evaluate(
    ({ id: requestId, value }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.failCorrection(requestId, value as never);
    },
    { id, value: failure },
  );
}

/** Resolves the waiting catalog read that asks for the named printing. */
async function settlePrinting(
  page: Page,
  printingId: string,
  records: {
    readonly cards?: readonly CardRecord[];
    readonly printings?: readonly PrintingRecord[];
  },
): Promise<void> {
  await page.evaluate(
    ({ id, value }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.settleCatalogFor({ kind: 'printing', printingId: id }, value);
    },
    { id: printingId, value: records },
  );
}

/** Resolves the waiting catalog read that asks for the named card. */
async function settleCard(
  page: Page,
  cardId: string,
  records: {
    readonly cards?: readonly CardRecord[];
    readonly printings?: readonly PrintingRecord[];
  },
): Promise<void> {
  await page.evaluate(
    ({ id, value }) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.settleCatalogFor({ kind: 'card', cardId: id }, value);
    },
    { id: cardId, value: records },
  );
}

/** Chooses one printing through the copy form's picker: select the entry and choose it. */
async function choosePrinting(page: Page, printingId: string): Promise<void> {
  await page.locator(`#copy-printing-picker [data-ui-select="printing:${printingId}"]`).check();
  await page.locator('#copy-printing-picker [data-ui-tool="choose-printing"]').click();
}

/** One owned card entry of the collection result, with its evaluated counts. */
function cardEntry(
  cardId: string,
  name: string,
  quantity: { readonly copies: number; readonly intended: number | null },
): SearchEntry {
  return {
    entryKey: `card:${cardId}`,
    target: { kind: 'card', cardId },
    card: { cardId, name, matchedName: null },
    printing: null,
    quantity,
  };
}

/** One owned physical-copy entry of the collection result. */
function copyEntry(copyId: string, printingId: string, cardId = 'card-1'): SearchEntry {
  return {
    entryKey: `copy:${copyId}`,
    target: { kind: 'copy', copyId },
    card: { cardId, name: 'Lightning Bolt', matchedName: null },
    printing: {
      printingId,
      edition: 'M11',
      collectorNumber: '149',
      language: 'en',
    },
    quantity: { copies: 1, intended: null },
  };
}

function searchPage(entries: readonly SearchEntry[]): SearchPage {
  return {
    status: 'ready',
    entries,
    totalCount: entries.length,
    continuation: null,
    revisions: {
      generation: 'generation-1',
      catalogRevision: 'revision-1',
      catalogPosition: '1',
      privateRevision: 'private-1',
    },
  };
}

function cardRecord(cardId = 'card-1', name = 'Lightning Bolt'): CardRecord {
  return {
    cardId,
    name,
    names: [],
    rulesText: 'Lightning Bolt deals 3 damage to any target.',
    typeLine: 'Instant',
    colors: ['R'],
    colorIdentity: ['R'],
    manaValue: 1,
  };
}

function printingRecord(printingId = 'printing-1', cardId = 'card-1'): PrintingRecord {
  return {
    printingId,
    cardId,
    edition: 'M11',
    collectorNumber: '149',
    language: 'en',
    finishes: ['nonfoil', 'foil'],
    physical: true,
    images: {
      small: 'https://cards.test/small.jpg',
      normal: 'https://cards.test/normal.jpg',
      large: null,
      artCrop: null,
    },
  };
}

/** One bounded page of a card's published printings, as the Catalog contract returns it. */
function printingBatch(pageIndex: number): readonly PrintingRecord[] {
  return Array.from({ length: 100 }, (_, index) =>
    printingRecord(`printing-${(pageIndex - 1) * 100 + index + 2}`),
  );
}

function storedCopy(overrides: Partial<PhysicalCopy> = {}): PhysicalCopy {
  return {
    copyId: 'copy-1',
    printingId: 'printing-1',
    finish: 'nonfoil',
    condition: 'NM',
    revision: 4,
    ...overrides,
  };
}

test('the collection presents owned entries with their counts and opens the level they name', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/collection');
  const request = await searchRequest(page);
  expect(request.request).toEqual({
    resultLevel: 'card',
    criteria: [{ kind: 'owned' }],
    pageSize: expect.any(Number),
  });
  await settleSearch(
    page,
    request.id,
    searchPage([
      cardEntry('card-1', 'Lightning Bolt', { copies: 3, intended: 2 }),
      cardEntry('card-2', 'Counterspell', { copies: 1, intended: null }),
    ]),
  );

  // Physical copies and intended quantities are presented distinctly, never conflated.
  const bolt = page.locator('[data-ui-entry="card:card-1"]');
  await expect(bolt.locator('[data-ui-copies]')).toHaveText(' Copies: 3');
  await expect(bolt.locator('[data-ui-intended]')).toHaveText(' Intended: 2');
  const counterspell = page.locator('[data-ui-entry="card:card-2"]');
  await expect(counterspell.locator('[data-ui-copies]')).toHaveText(' Copies: 1');
  await expect(counterspell.locator('[data-ui-intended]')).toHaveCount(0);

  // The entry opens the card level its identity names.
  await bolt.locator('[data-ui-open]').click();
  await expect(page).toHaveURL(/#\/cards\/card-1$/);
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#card-name')).toHaveText('Lightning Bolt');
  await expect(page.locator('#card-type')).toHaveText('Instant');
  expect(errors).toEqual([]);
});

test('the collection level and expression build the query its URL carries', async ({ page }) => {
  const errors = await openCollection(page, '#/collection');
  await settleSearch(page, (await searchRequest(page)).id, searchPage([]));

  await page.getByLabel('Search collection').fill('bolt');
  await page.getByLabel('Level').selectOption('copy');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page).toHaveURL(/#\/collection\?query=bolt&level=copy$/);
  const presented = await searchRequest(page, 1);
  expect(presented.request).toEqual({
    resultLevel: 'copy',
    query: 'bolt',
    criteria: [{ kind: 'owned' }],
    pageSize: expect.any(Number),
  });
  await settleSearch(page, presented.id, searchPage([copyEntry('copy-1', 'printing-1')]));
  await expect(page.locator('[data-ui-entry="copy:copy-1"]')).toBeVisible();

  // A direct entry with the same URL presents the same result.
  await openCollection(page, '#/collection?query=bolt&level=copy');
  const reloaded = await searchRequest(page);
  expect(reloaded.request).toEqual(presented.request);
  expect(errors).toEqual([]);
});

test('the card level lists published printings and opens one printing level', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1');
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#card-name')).toHaveText('Lightning Bolt');
  await expect(page.locator('#card-text')).toContainText('deals 3 damage');

  // One bounded page of printings loads first; the next page is offered until the list ends.
  const first = await printingsRequest(page);
  expect(first?.cardId).toBe('card-1');
  await settlePrintings(page, first!.id, [printingRecord('printing-1')], 'cursor-2');
  await expect(page.locator('#card-printings a')).toHaveCount(1);
  await page.locator('#card-printings [data-ui-more]').click();
  const second = await printingsRequest(page, 1);
  expect(second?.options.continuation).toBe('cursor-2');
  await settlePrintings(page, second!.id, [printingRecord('printing-2')], null);
  await expect(page.locator('#card-printings a')).toHaveCount(2);
  await expect(page.locator('#card-printings [data-ui-more]')).toBeHidden();

  await page.locator('[id="card-printing-printing%3Aprinting-2"]').click();
  await expect(page).toHaveURL(/#\/cards\/card-1\/printing-2$/);
  await settlePrinting(page, 'printing-2', { printings: [printingRecord('printing-2')] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#printing-name')).toHaveText('Lightning Bolt');
  await expect(page.locator('#printing-line')).toHaveText('M11 149 · en');
  await expect(page.locator('#printing-card-link')).toHaveAttribute('href', '#/cards/card-1');
  expect(errors).toEqual([]);
});

test('returning to a card level re-presents the printing window it held', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1');
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const first = await printingsRequest(page);
  await settlePrintings(page, first!.id, [printingRecord('printing-1')], 'cursor-2');
  await page.locator('#card-printings [data-ui-more]').click();
  const second = await printingsRequest(page, 1);
  await settlePrintings(page, second!.id, [printingRecord('printing-2')], null);
  await expect(page.locator('#card-printings a')).toHaveCount(2);

  // A printing of the second page is opened; Back returns to the window it was opened from.
  await page.locator('[id="card-printing-printing%3Aprinting-2"]').click();
  await expect(page).toHaveURL(/#\/cards\/card-1\/printing-2$/);
  await settlePrinting(page, 'printing-2', { printings: [printingRecord('printing-2')] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#printing-name')).toHaveText('Lightning Bolt');

  await page.goBack();
  // The retained window is re-acquired from its own position, so the second page loads again.
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const restoredFirst = await printingsRequest(page, 2);
  expect(restoredFirst?.options.continuation).toBeUndefined();
  await settlePrintings(page, restoredFirst!.id, [printingRecord('printing-1')], 'cursor-2');
  const restoredSecond = await printingsRequest(page, 3);
  expect(restoredSecond?.options.continuation).toBe('cursor-2');
  await settlePrintings(page, restoredSecond!.id, [printingRecord('printing-2')], null);
  await expect(page.locator('#card-printings a')).toHaveCount(2);
  await expect(page.locator('[id="card-printing-printing%3Aprinting-2"]')).toBeFocused();
  expect(errors).toEqual([]);
});

test('leaving the card level releases the printing list that observed input', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1');
  // The window input and document focus observers the printing list installs are invisible to the
  // page; the DevTools protocol counts them, so a list retained by a closed page is observable.
  const client = await page.context().newCDPSession(page);
  const observers = async (): Promise<number> => {
    const counted = await client.send('Runtime.evaluate', {
      expression: [
        "['wheel', 'touchstart', 'pointerdown', 'keydown']",
        '.reduce((total, type) => total + (getEventListeners(window)[type]?.length ?? 0), 0)',
        "+ (getEventListeners(document)['focusin']?.length ?? 0)",
      ].join(''),
      includeCommandLineAPI: true,
      returnByValue: true,
    });
    return counted.result.value as number;
  };
  const before = await observers();
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const first = await printingsRequest(page);
  await settlePrintings(page, first!.id, [printingRecord('printing-1')], null);
  await expect(page.locator('#card-printings a')).toHaveCount(1);
  // The presented card level's printing list observes explicit input beside the browser's own.
  expect(await observers()).toBeGreaterThan(before);

  // The card details page is left for a shell page without a list: the departed page's printing
  // list releases its rendered DOM and the observers it installed with that page's signal, so
  // nothing of the closed view keeps observing the browser.
  await page.evaluate(() => {
    window.location.hash = '#/not-a-page';
  });
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect.poll(observers).toBe(before);
  expect(errors).toEqual([]);
});

test('an initial printing-list failure is reported and retried from the card level', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1');
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const failed = await printingsRequest(page);
  await failPrintings(page, failed!.id, {
    code: 'unavailable',
    message: 'The catalog is unavailable.',
  });

  // A failure is not the end of the list: it stays presented beside its retry.
  await expect(page.locator('#card-printings [data-ui-status]')).toHaveText(
    'The catalog is unavailable.',
  );
  await expect(page.locator('#card-printings [data-ui-retry]')).toBeVisible();
  await expect(page.locator('#card-printings [data-ui-more]')).toBeHidden();

  await page.locator('#card-printings [data-ui-retry]').click();
  const retried = await printingsRequest(page, 1);
  await settlePrintings(page, retried!.id, [printingRecord('printing-1')], null);
  await expect(page.locator('#card-printings a')).toHaveCount(1);
  await expect(page.locator('#card-printings [data-ui-status]')).toHaveText('');
  expect(errors).toEqual([]);
});

test('an invalidated printing continuation restarts the card printing list', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1');
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const first = await printingsRequest(page);
  await settlePrintings(page, first!.id, [printingRecord('printing-1')], 'cursor-2');

  await page.locator('#card-printings [data-ui-more]').click();
  const stale = await printingsRequest(page, 1);
  expect(stale?.options.continuation).toBe('cursor-2');
  await failPrintings(page, stale!.id, {
    code: 'stale-continuation',
    message: 'The catalog changed during printing lookup.',
  });

  // The list restarts the card's printings from its first page instead of repeating the cursor the
  // catalog keeps refusing, and the presented printing stays until the fresh page arrives.
  const restart = await printingsRequest(page, 2);
  expect(restart?.options.continuation).toBeUndefined();
  await expect(page.locator('#card-printings a')).toHaveCount(1);
  await settlePrintings(page, restart!.id, [printingRecord('printing-3')], null);
  await expect(page.locator('[id="card-printing-printing%3Aprinting-3"]')).toBeVisible();
  await expect(page.locator('#card-printings a')).toHaveCount(1);
  await expect(page.locator('#card-printings [data-ui-more]')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a failed card-level restore keeps the printing window it was holding', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1');
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(
    page,
    (await printingsRequest(page))!.id,
    [printingRecord('printing-1')],
    'cursor-2',
  );
  await page.locator('#card-printings [data-ui-more]').click();
  await settlePrintings(
    page,
    (await printingsRequest(page, 1))!.id,
    [printingRecord('printing-2')],
    null,
  );
  await page.locator('[id="card-printing-printing%3Aprinting-2"]').click();
  await settlePrinting(page, 'printing-2', { printings: [printingRecord('printing-2')] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#printing-name')).toHaveText('Lightning Bolt');

  // The entry that held the window comes back while the catalog is unavailable.
  await page.goBack();
  const catalogReads = await page.evaluate(() =>
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.catalogRequests(),
  );
  await page.evaluate(
    (id) => {
      (
        globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
      ).keeperCollectionControl.failCatalog(id, 'The catalog is unavailable.');
    },
    catalogReads[catalogReads.length - 1]!.id,
  );
  await expect(page.locator('#card-details-failure')).toHaveText('The catalog is unavailable.');

  // Leaving the failed view keeps the retained window; returning presents it again.
  await page.getByRole('link', { name: 'Home' }).click();
  await page.goBack();
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const restoredFirst = await printingsRequest(page, 2);
  await settlePrintings(page, restoredFirst!.id, [printingRecord('printing-1')], 'cursor-2');
  const restoredSecond = await printingsRequest(page, 3);
  await settlePrintings(page, restoredSecond!.id, [printingRecord('printing-2')], null);
  await expect(page.locator('#card-printings a')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('a detail read that fails is reported with a retry', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1');
  const request = await page.evaluate(() =>
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.catalogRequests(),
  );
  await page.evaluate((id) => {
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.failCatalog(id, 'The catalog is unavailable.');
  }, request[0]!.id);
  await expect(page.locator('#card-details-failure')).toHaveText('The catalog is unavailable.');
  // The page keeps the retry beside the failed level; the floating notice keeps the service
  // failure visible after the view is left (docs/ui/navigation.md#error-notices).
  const notice = page.locator('[data-ui-notice="navigation:page:alice:card-details"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice).toContainText('The catalog is unavailable.');
  await expect(notice.locator('.ui-notice-mark')).toHaveText('Error:');
  await expect(notice.locator('.ui-notice-spinner')).toBeHidden();

  await page.getByRole('button', { name: 'Retry' }).click();
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#card-name')).toHaveText('Lightning Bolt');
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a copy presents its stored attributes and corrects them as one change', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  const read = await copyRead(page);
  expect(read.copyIds).toEqual(['copy-1']);
  await settleCopyRead(page, read.id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });

  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · near mint');
  await expect(page.locator('#copy-finish-choice')).toHaveValue('nonfoil');
  await expect(page.locator('#copy-condition-choice')).toHaveValue('NM');

  // A change names the revision the page read and corrects printing, finish and condition at once.
  await page.locator('#copy-condition-choice').selectOption('LP');
  await page.locator('#copy-finish-choice').selectOption('foil');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const saved = await correction(page);
  expect(saved.input).toEqual({
    copyId: 'copy-1',
    expectedRevision: 4,
    printingId: 'printing-1',
    finish: 'foil',
    condition: 'LP',
  });
  await settleCorrection(page, saved.id, [
    storedCopy({ finish: 'foil', condition: 'LP', revision: 5 }),
  ]);
  await expect(page.locator('#copy-status')).toHaveText('Saved.');
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · foil · lightly played');
  expect(errors).toEqual([]);
});

test('a conflict keeps the unsaved change for review and a retry saves it', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });

  await page.locator('#copy-condition-choice').selectOption('DMG');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const conflicted = await correction(page);
  await failCorrection(page, conflicted.id, {
    code: 'conflict',
    message: 'The copy changed after this revision; reload it before correcting it.',
  });

  // The unsaved change stays presented while the stored attributes refresh for the retry.
  await expect(page.locator('#copy-status')).toContainText('changed since you read it');
  await expect(page.locator('#copy-condition-choice')).toHaveValue('DMG');
  const refresh = await copyRead(page, 1);
  await settleCopyRead(page, refresh.id, [storedCopy({ condition: 'HP', revision: 6 })]);
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · heavily played');
  await expect(page.locator('#copy-condition-choice')).toHaveValue('DMG');

  await page.getByRole('button', { name: 'Save changes' }).click();
  const retried = await correction(page, 1);
  expect(retried.input).toEqual({
    copyId: 'copy-1',
    expectedRevision: 6,
    printingId: 'printing-1',
    finish: 'nonfoil',
    condition: 'DMG',
  });
  await settleCorrection(page, retried.id, [storedCopy({ condition: 'DMG', revision: 7 })]);
  await expect(page.locator('#copy-status')).toHaveText('Saved.');
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · damaged');
  expect(errors).toEqual([]);
});

test('a lost response stays unknown while current attributes and a guarded retry remain available', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });

  await page.locator('#copy-finish-choice').selectOption('foil');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const lost = await correction(page);
  await failCorrection(page, lost.id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });

  const recovered = await copyRead(page, 1);
  await settleCopyRead(page, recovered.id, [storedCopy({ finish: 'foil', revision: 5 })]);
  await expect(page.locator('#copy-status')).toHaveText(
    'The outcome is unknown. Reload the copy before retrying.',
  );
  // The form keeps the draft and the message; the floating notice keeps the uncertain correction
  // visible with the recovery read the form offers (docs/ui/navigation.md#error-notices).
  const notice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice).toContainText('The outcome is unknown. Reload the copy before retrying.');
  await expect(notice.getByRole('button', { name: 'Reload the copy' })).toBeVisible();
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · foil · near mint');
  await expect(page.locator('#copy-finish-choice')).toHaveValue('foil');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();

  await page.getByRole('button', { name: 'Reload copy' }).click();
  await settleCopyRead(page, (await copyRead(page, 2)).id, [storedCopy({ revision: 6 })]);
  await expect(page.locator('#copy-status')).toHaveText('Reloaded the copy.');
  await expect(page.locator('#copy-finish-choice')).toHaveValue('foil');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const retry = await correction(page, 1);
  expect(retry.input.expectedRevision).toBe(6);
  expect(retry.input.finish).toBe('foil');
  await settleCorrection(page, retry.id, [storedCopy({ finish: 'foil', revision: 7 })]);
  await expect(page.locator('#copy-status')).toHaveText('Saved.');
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('bulk changes act on the explicit selected copy identities', async ({ page }) => {
  const errors = await openCollection(page, '#/collection?level=copy');
  const request = await searchRequest(page);
  expect(request.request.resultLevel).toBe('copy');
  await settleSearch(
    page,
    request.id,
    searchPage([copyEntry('copy-1', 'printing-1'), copyEntry('copy-2', 'printing-1')]),
  );

  // Equivalent copies group, and every copy stays individually selectable inside the group.
  const group = page.locator('[data-ui-group]');
  await expect(group).toHaveCount(1);
  await expect(group.locator('[data-ui-group-count]')).toHaveText('2 equivalent copies');
  await page.getByLabel('Select Lightning Bolt (M11 149)').nth(1).check();
  await expect(page.locator('[data-ui-selection-count]')).toHaveText('1 selected');

  await page.getByLabel('Select Lightning Bolt (M11 149)').first().check();
  await expect(page.locator('[data-ui-selection-count]')).toHaveText('2 selected');
  await settleCopyRead(page, (await copyRead(page)).id, [
    storedCopy({ copyId: 'copy-1' }),
    storedCopy({ copyId: 'copy-2' }),
  ]);
  await page.getByLabel('Finish to apply').selectOption('foil');
  await page.getByRole('button', { name: 'Apply finish' }).click();

  // The change reads the revision of exactly the selected copies.
  const revisionRead = await copyRead(page, 1);
  expect(revisionRead.copyIds).toEqual(['copy-1', 'copy-2']);
  await settleCopyRead(page, revisionRead.id, [
    storedCopy({ copyId: 'copy-1', revision: 2 }),
    storedCopy({ copyId: 'copy-2', revision: 7 }),
  ]);
  const first = await correction(page);
  expect(first.input).toEqual({
    copyId: 'copy-1',
    expectedRevision: 2,
    printingId: 'printing-1',
    finish: 'foil',
    condition: 'NM',
  });
  await settleCorrection(page, first.id, [storedCopy({ copyId: 'copy-1', finish: 'foil' })]);
  const second = await correction(page, 1);
  expect(second.input).toEqual({
    copyId: 'copy-2',
    expectedRevision: 7,
    printingId: 'printing-1',
    finish: 'foil',
    condition: 'NM',
  });
  await settleCorrection(page, second.id, [storedCopy({ copyId: 'copy-2', finish: 'foil' })]);
  await expect(page.locator('[data-ui-outcome]')).toHaveText('Saved 2 copies.');
  await expect(page.locator('[data-ui-outcome]')).toHaveAttribute(
    'data-ui-outcome-status',
    'committed',
  );
  expect(errors).toEqual([]);
});

for (const failure of ['conflict', 'unavailable'] as const) {
  test(`a bulk change with a ${failure} response is never reported as saved`, async ({ page }) => {
    const errors = await openCollection(page, '#/collection?level=copy');
    const request = await searchRequest(page);
    await settleSearch(
      page,
      request.id,
      searchPage([copyEntry('copy-1', 'printing-1'), copyEntry('copy-2', 'printing-1')]),
    );
    await page.locator('[data-ui-group-select]').check();
    await settleCopyRead(page, (await copyRead(page)).id, [
      storedCopy({ copyId: 'copy-1' }),
      storedCopy({ copyId: 'copy-2' }),
    ]);
    await page.getByLabel('Condition to apply').selectOption('DMG');
    await page.getByRole('button', { name: 'Apply condition' }).click();

    const revisionRead = await copyRead(page, 1);
    await settleCopyRead(page, revisionRead.id, [
      storedCopy({ copyId: 'copy-1', revision: 2 }),
      storedCopy({ copyId: 'copy-2', revision: 7 }),
    ]);
    const first = await correction(page);
    await settleCorrection(page, first.id, [storedCopy({ copyId: 'copy-1', condition: 'DMG' })]);
    const second = await correction(page, 1);
    await failCorrection(page, second.id, {
      code: failure,
      message: failure === 'conflict' ? 'The copy changed.' : 'The response was lost.',
    });

    const outcome = page.locator('[data-ui-outcome]');
    if (failure === 'unavailable') {
      await settleCopyRead(page, (await copyRead(page, 2)).id, [
        storedCopy({ copyId: 'copy-2', condition: 'DMG', revision: 8 }),
      ]);
      await expect(outcome).toHaveAttribute('data-ui-outcome-status', 'unknown');
      await expect(outcome).toHaveText(
        '1 of 2 copies have an unknown outcome. Reload them before retrying.',
      );
    } else {
      await expect(outcome).toHaveAttribute('data-ui-outcome-status', 'conflict');
      await expect(outcome).toHaveText(
        '1 of 2 copies changed since they were read. Reload and review the change.',
      );
    }
    // A bulk change that did not commit stays visible as the floating error notice, with the
    // selection the list still holds for the retry (docs/ui/navigation.md#error-notices).
    const outcomeText = (await outcome.textContent()) ?? '';
    const notice = page.locator('[data-ui-notice="navigation:page:alice:copy-bulk"]');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
    await expect(notice).toContainText(outcomeText);
    await expect(page.locator('[data-ui-group-select]')).toBeChecked();
    expect(errors).toEqual([]);
  });
}

test('leaving and returning keeps the collection selection and the unsaved copy draft', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/collection?level=copy');
  const request = await searchRequest(page);
  await settleSearch(page, request.id, searchPage([copyEntry('copy-1', 'printing-1')]));
  await page.getByLabel('Select Lightning Bolt (M11 149)').check();
  await page.locator('[data-ui-entry="copy:copy-1"] [data-ui-open]').click();

  const read = await copyRead(page, 1);
  await settleCopyRead(page, read.id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await page.locator('#copy-condition-choice').selectOption('MP');

  // The card level is reachable from the copy level, and Back leaves the draft intact.
  await page.locator('#copy-card-link').click();
  await expect(page).toHaveURL(/#\/cards\/card-1$/);
  await page.goBack();
  const restoredRead = await copyRead(page, 2);
  await settleCopyRead(page, restoredRead.id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#copy-condition-choice')).toHaveValue('MP');

  await page.goBack();
  const restored = await searchRequest(page, 1);
  expect(restored.request.resultLevel).toBe('copy');
  await settleSearch(page, restored.id, searchPage([copyEntry('copy-1', 'printing-1')]));
  await expect(page.getByLabel('Select Lightning Bolt (M11 149)')).toBeChecked();
  await expect(page.locator('[data-ui-selection-count]')).toHaveText('1 selected');
  expect(errors).toEqual([]);
});

test('a returned copy keeps the printing and finish its draft intends', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], 'cursor-2');

  // A second page offers a foil-only printing of another language.
  const foilOnly = { ...printingRecord('printing-2'), language: 'es', finishes: ['foil'] as const };
  await page.locator('#copy-printing-picker [data-ui-more]').click();
  await settlePrintings(page, (await printingsRequest(page, 1))!.id, [foilOnly], null);
  await choosePrinting(page, 'printing-2');
  // The form reads the chosen printing's record, so the finish control follows its finishes.
  await settlePrinting(page, 'printing-2', { printings: [foilOnly] });
  await page.locator('#copy-finish-choice').selectOption('foil');

  // Leaving for the card level and returning keeps the draft while its data loads again.
  await page.locator('#copy-card-link').click();
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(
    page,
    (await printingsRequest(page, 2))!.id,
    [printingRecord()],
    'cursor-2',
  );
  await page.goBack();
  await settleCopyRead(page, (await copyRead(page, 1)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(
    page,
    (await printingsRequest(page, 3))!.id,
    [printingRecord()],
    'cursor-2',
  );

  // The loaded first page does not carry the intended printing: the draft stays, named by its own
  // identity until the record that describes it arrives.
  await expect(page.locator('#copy-printing-line')).toHaveText('Printing printing-2');
  await expect(page.locator('#copy-finish-choice')).toHaveValue('foil');
  await expect(page.locator('#copy-condition-choice')).toHaveValue('NM');

  // Once its record loads the intended printing is presented by its published data.
  await settlePrinting(page, 'printing-2', { printings: [foilOnly] });
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · es');
  await expect(page.locator('#copy-finish-choice')).toHaveValue('foil');
  expect(errors).toEqual([]);
});

test('an initial printing-list failure is reported and retried from the copy level', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const failed = await printingsRequest(page);
  await failPrintings(page, failed!.id, {
    code: 'unavailable',
    message: 'The printings could not be loaded.',
  });

  // The failure stays presented beside its retry, and the copy's own printing stays correctable.
  await expect(page.locator('#copy-printing-picker [data-ui-status]')).toHaveText(
    'The printings could not be loaded.',
  );
  await expect(page.locator('#copy-printing-picker [data-ui-retry]')).toBeVisible();
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · en');

  await page.locator('#copy-printing-picker [data-ui-retry]').click();
  const retried = await printingsRequest(page, 1);
  await settlePrintings(page, retried!.id, [printingRecord('printing-2')], null);
  await expect(page.locator('#copy-printing-picker [data-ui-status]')).toHaveText('');
  await expect(page.locator('#copy-printing-picker [data-ui-retry]')).toBeHidden();
  await expect(page.locator('#copy-printing-picker [data-ui-entry]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the copy printing window stays bounded while the user pages through it', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, printingBatch(1), 'cursor-1');

  // Six bounded catalog pages are offered one after another through the list's own window.
  for (let pageIndex = 2; pageIndex <= 6; pageIndex += 1) {
    await page.locator('#copy-printing-picker [data-ui-more]').click();
    const request = await printingsRequest(page, pageIndex - 1);
    expect(request?.options.continuation).toBe(`cursor-${pageIndex - 1}`);
    const next = pageIndex === 6 ? null : `cursor-${pageIndex}`;
    await settlePrintings(page, request!.id, printingBatch(pageIndex), next);
  }

  // The window retires the oldest printings beyond its own bound.
  await expect(page.locator('#copy-printing-picker [data-ui-entry]')).toHaveCount(500);
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · en');
  expect(errors).toEqual([]);
});

test('an expired catalog page restarts the copy printing offer from its first page', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], 'cursor-2');
  await page.locator('#copy-condition-choice').selectOption('MP');

  // The catalog published a revision since that page was read, so the cursor is unusable.
  await page.locator('#copy-printing-picker [data-ui-more]').click();
  const expired = await printingsRequest(page, 1);
  expect(expired?.options.continuation).toBe('cursor-2');
  await failPrintings(page, expired!.id, (await organizationContinuationFailures()).printings);

  // The offer reads the printing list again from its first page instead of repeating the cursor,
  // and the copy's own printing together with the unsaved draft stay in the form.
  const restarted = await printingsRequest(page, 2);
  expect(restarted?.cardId).toBe('card-1');
  expect(restarted?.options.continuation).toBeUndefined();
  await settlePrintings(page, restarted!.id, [printingRecord()], 'cursor-3');
  await expect(page.locator('#copy-printing-picker [data-ui-status]')).toHaveText('');
  await expect(page.locator('#copy-printing-picker [data-ui-more]')).toBeVisible();
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · en');
  await expect(page.locator('#copy-condition-choice')).toHaveValue('MP');

  // The restarted page's continuation is the one further pages are read with.
  await page.locator('#copy-printing-picker [data-ui-more]').click();
  const next = await printingsRequest(page, 3);
  expect(next?.options.continuation).toBe('cursor-3');
  await settlePrintings(page, next!.id, [printingRecord('printing-2')], null);
  await expect(page.locator('#copy-printing-picker [data-ui-entry]')).toHaveCount(2);
  await expect(page.locator('#copy-printing-picker [data-ui-more]')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a failed restart of the copy printing offer keeps its retry on the first page', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], 'cursor-2');

  await page.locator('#copy-printing-picker [data-ui-more]').click();
  const expired = await printingsRequest(page, 1);
  await failPrintings(page, expired!.id, (await organizationContinuationFailures()).printings);
  const restarted = await printingsRequest(page, 2);
  await failPrintings(page, restarted!.id, {
    code: 'unavailable',
    message: 'The printings could not be loaded.',
  });

  // The unusable cursor is not retained: the retry the failure leaves behind starts the list again.
  await expect(page.locator('#copy-printing-picker [data-ui-status]')).toHaveText(
    'The printings could not be loaded.',
  );
  await page.locator('#copy-printing-picker [data-ui-retry]').click();
  const retried = await printingsRequest(page, 3);
  expect(retried?.options.continuation).toBeUndefined();
  await settlePrintings(page, retried!.id, [printingRecord('printing-2')], null);
  await expect(page.locator('#copy-printing-picker [data-ui-status]')).toHaveText('');
  await expect(page.locator('#copy-printing-picker [data-ui-retry]')).toBeHidden();
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · en');
  expect(errors).toEqual([]);
});

test('choosing a printing reports the selection without claiming a committed change', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  await choosePrinting(page, 'printing-1');

  // The picker reports the explicit selection the owner made and presents no outcome of its own:
  // a selection is not a provider-committed change, so nothing claims that one was saved
  // (docs/ui/cardviews.md#interface, docs/ui/editors.md#interface).
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · en');
  await expect(page.locator('#copy-printing-picker [data-ui-outcome]')).toHaveCount(0);
  await expect(page.locator('#copy-printing-picker')).not.toContainText('Saved');
  await expect(page.locator('#copy-status')).toHaveText('');
  expect(errors).toEqual([]);
});

test('presents details, lists and printing choices through the supplied CardViews module', async ({
  page,
}) => {
  const errors = await openReplacementCollection(page, '#/cards/card-1/printing-1');
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });

  // The printing level renders through the supplied module: the page composes its routes and
  // layout around the detail view it receives (docs/ui/cardviews.md#interface).
  await expect(page.locator('#card-details-content [data-ui-replacement-detail]')).toHaveText(
    'REPLACEMENT DETAIL',
  );
  await expect(page.locator('#printing-name')).toHaveText('Lightning Bolt');
  await expect(page.locator('#printing-line')).toHaveText('M11 149 · en');

  // The card level composes its printing list beside the supplied detail as well.
  await page.locator('#printing-card-link').click();
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);
  await expect(page.locator('#card-details-content [data-ui-replacement-detail]')).toHaveText(
    'REPLACEMENT DETAIL',
  );
  await expect(page.locator('#card-printings [data-ui-entry]')).toHaveCount(1);

  // The copy level requests its printing choices through the supplied picker.
  await page.evaluate(() =>
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.navigate({
      page: 'card',
      cardId: 'card-1',
      printingId: 'printing-1',
      copyId: 'copy-1',
    }),
  );
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page, 1))!.id, [printingRecord()], null);
  await expect(page.locator('#copy-printing-picker [data-ui-replacement-picker]')).toHaveText(
    'REPLACEMENT PICKER',
  );
  await choosePrinting(page, 'printing-1');
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · en');
  expect(errors).toEqual([]);
});

test('a failed reload is reported as a failure, not as a missing copy', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  await page.locator('#copy-reload').click();
  await failCopyRead(page, (await copyRead(page, 1)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });

  // An unavailable read does not establish that the account lost the copy.
  await expect(page.locator('#copy-status')).toHaveText('The service could not be reached.');
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · near mint');
  expect(errors).toEqual([]);
});

test('a failed copy read clears when leaving and reopening presents the copy again', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  await page.locator('#copy-reload').click();
  await failCopyRead(page, (await copyRead(page, 1)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });

  // The failed read is reported beside the form and as the shell's notice of this copy's read.
  const notice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
  await expect(page.locator('#copy-status')).toHaveText('The service could not be reached.');
  await expect(notice).toContainText('The service could not be reached.');

  // Leaving the copy keeps the failure visible; its recovery belonged to the form that is gone.
  await page.getByRole('link', { name: 'Collection', exact: true }).click();
  await settleSearch(page, (await searchRequest(page)).id, searchPage([]));
  await expect(page).toHaveURL(/#\/collection$/);
  await expect(notice).toContainText('The service could not be reached.');

  // Back opens the copy again: the read that establishes its recorded state reconciles the failure
  // of the read the replaced editor presented (docs/ui/navigation.md#error-notices).
  await page.goBack();
  await settleCopyRead(page, (await copyRead(page, 2)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · near mint');
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a failed opening read of the copy level clears when a retry presents the copy', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await failCopyRead(page, (await copyRead(page)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });

  // The level reports the failure it can retry, and the notice keeps it visible after leaving.
  const notice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
  await expect(page.locator('#card-details-failure')).toHaveText(
    'The service could not be reached.',
  );
  await expect(notice).toContainText('The service could not be reached.');

  await page.getByRole('button', { name: 'Retry' }).click();
  await settleCopyRead(page, (await copyRead(page, 1)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · near mint');
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an obsolete opening read never replaces the copy a newer retry presented', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await failCopyRead(page, (await copyRead(page)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });
  const notice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
  await expect(page.locator('#card-details-failure')).toHaveText(
    'The service could not be reached.',
  );

  // The page's Retry starts one read of the level, and the failure notice's own recovery a second
  // one while the first is still pending: two overlapping loads, neither settled yet.
  await page.getByRole('button', { name: 'Retry' }).click();
  const retry = await copyRead(page, 1);
  await notice.getByRole('button', { name: 'Load the copy again' }).click();
  const recovered = await copyRead(page, 2);

  // The newer load presents the copy its retry read and ends the notice the failure reported.
  await settleCopyRead(page, recovered.id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · near mint');
  await expect(notice).toHaveCount(0);
  await page.locator('#copy-finish-choice').selectOption('foil');

  // The superseded load answers: its failure neither replaces the presented editor nor the draft
  // it holds, nor reports a read the newer load established
  // (docs/ui/architecture.md#asynchronous-presentation).
  await failCopyRead(page, retry.id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });
  await expect(page.locator('#card-details-failure')).toHaveCount(0);
  await expect(page.locator('#copy-form')).toBeVisible();
  await expect(page.locator('#copy-finish-choice')).toHaveValue('foil');
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · near mint');
  await expect(page.locator('[data-ui-notice]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a read that establishes the copy is absent reconciles its read failure', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  await page.locator('#copy-reload').click();
  await failCopyRead(page, (await copyRead(page, 1)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });
  const notice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
  await expect(notice).toContainText('The service could not be reached.');

  // The next read answers: the account no longer holds the copy, so the service failure is
  // reconciled by the absence that read established (docs/ui/navigation.md#error-notices).
  await page.locator('#copy-reload').click();
  await settleCopyRead(page, (await copyRead(page, 2)).id, []);
  await expect(page.locator('#copy-status')).toHaveText(
    'This copy is no longer in the collection.',
  );
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a successful copy read reconciles its read failure without resolving an uncertain change', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  // A lost response leaves the change unresolved: the recovery read presents the copy for review
  // while the change keeps its own notice.
  await page.locator('#copy-finish-choice').selectOption('foil');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await failCorrection(page, (await correction(page)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });
  await settleCopyRead(page, (await copyRead(page, 1)).id, [
    storedCopy({ finish: 'foil', revision: 5 }),
  ]);
  const change = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1"]');
  await expect(change).toContainText('The outcome is unknown.');

  await page.locator('#copy-reload').click();
  await failCopyRead(page, (await copyRead(page, 2)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });
  const read = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
  await expect(read).toContainText('The service could not be reached.');

  // The next reload reads the copy: its notice ends while the unresolved change stays reported.
  await page.locator('#copy-reload').click();
  await settleCopyRead(page, (await copyRead(page, 3)).id, [
    storedCopy({ finish: 'foil', revision: 6 }),
  ]);
  await expect(page.locator('#copy-status')).toHaveText('Reloaded the copy.');
  await expect(read).toHaveCount(0);
  await expect(change).toContainText('The outcome is unknown.');
  expect(errors).toEqual([]);
});

test('a correction recovery that establishes absence reconciles the read failure', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  await page.locator('#copy-reload').click();
  await failCopyRead(page, (await copyRead(page, 1)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });
  const read = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
  await expect(read).toContainText('The service could not be reached.');

  // The change's response is lost: its recovery read answers that the account no longer holds the
  // copy. The absence that read established ends the copy's read failure while the unresolved
  // change stays reported under its own identity (docs/ui/navigation.md#error-notices).
  await page.locator('#copy-finish-choice').selectOption('foil');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await failCorrection(page, (await correction(page)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });
  await settleCopyRead(page, (await copyRead(page, 2)).id, []);
  await expect(page.locator('#copy-status')).toHaveText(
    'The outcome is unknown. This copy is no longer in the collection.',
  );
  await expect(read).toHaveCount(0);
  const change = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1"]');
  await expect(change).toContainText(
    'The outcome is unknown. This copy is no longer in the collection.',
  );
  expect(errors).toEqual([]);
});

test('the copy-read notice presents its failure, dismissal and account lifetime', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  await page.locator('#copy-reload').click();
  await failCopyRead(page, (await copyRead(page, 1)).id, {
    code: 'unavailable',
    message: 'The service could not be reached.',
  });

  // The failure presents as a red notice with a textual indicator and the recovery the form owns.
  const notice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice).toContainText('Error:');
  await expect(notice).toContainText('The service could not be reached.');
  await expect(notice.getByRole('button', { name: 'Reload the copy' })).toBeVisible();

  // Its explicit dismiss control removes it, and a later failure is reported under the same
  // identity instead of leaving two notices (docs/ui/navigation.md#error-notices).
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  await page.locator('#copy-reload').click();
  await failCopyRead(page, (await copyRead(page, 2)).id, {
    code: 'unavailable',
    message: 'The copy service is unavailable.',
  });
  await expect(notice).toContainText('The copy service is unavailable.');

  // Leaving the copy keeps the failure visible while its recovery belonged to the gone form.
  await page.getByRole('link', { name: 'Collection', exact: true }).click();
  await settleSearch(page, (await searchRequest(page)).id, searchPage([]));
  await expect(notice).toContainText('The copy service is unavailable.');
  await expect(notice.getByRole('button', { name: 'Reload the copy' })).toBeHidden();

  // The notice belongs to the account that presented it: another account ends it.
  await page.evaluate(() =>
    (
      globalThis as unknown as { keeperCollectionControl: UiCollectionControl }
    ).keeperCollectionControl.signInAs('bob'),
  );
  await settleSearch(page, (await searchRequest(page, 1)).id, searchPage([]));
  await expect(page.locator('[data-ui-notice]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const reloadTiming of ['before', 'after'] as const) {
  test(`a reload failure ${reloadTiming} correction completion cannot leave a stale read notice`, async ({
    page,
  }) => {
    const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
    await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
    await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
    await settleCard(page, 'card-1', { cards: [cardRecord()] });

    await page.locator('#copy-condition-choice').selectOption('LP');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const saved = await correction(page);
    await page.locator('#copy-reload').click();
    const reload = await copyRead(page, 1);
    const readNotice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
    const failReload = () =>
      failCopyRead(page, reload.id, {
        code: 'unavailable',
        message: 'The service could not be reached.',
      });
    if (reloadTiming === 'before') {
      await failReload();
      await expect(readNotice).toContainText('The service could not be reached.');
    }
    // Later typing stays a draft, independent of the submitted change and overlapping read.
    await page.locator('#copy-condition-choice').selectOption('DMG');
    await settleCorrection(page, saved.id, [storedCopy({ condition: 'LP', revision: 5 })]);
    await expect(page.locator('#copy-saved')).toContainText('lightly played');
    if (reloadTiming === 'after') {
      await failReload();
    }
    await expect(readNotice).toHaveCount(0);
    await expect(page.locator('#copy-status')).toHaveText('Saved.');
    await expect(page.locator('#copy-condition-choice')).toHaveValue('DMG');
    expect(errors).toEqual([]);
  });

  test(`a successful reload ${reloadTiming} correction recovery cannot hide an unknown write`, async ({
    page,
  }) => {
    const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
    await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
    await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
    await settleCard(page, 'card-1', { cards: [cardRecord()] });

    await page.locator('#copy-finish-choice').selectOption('foil');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const saved = await correction(page);
    await page.locator('#copy-reload').click();
    const reload = await copyRead(page, 1);
    if (reloadTiming === 'before') {
      await settleCopyRead(page, reload.id, [storedCopy()]);
      await expect(page.locator('#copy-status')).toHaveText('Reloaded the copy.');
    }
    await failCorrection(page, saved.id, {
      code: 'unavailable',
      message: 'The service could not be reached.',
    });
    await settleCopyRead(page, (await copyRead(page, 2)).id, [
      storedCopy({ finish: 'foil', revision: 5 }),
    ]);
    await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · foil · near mint');
    if (reloadTiming === 'after') {
      await settleCopyRead(page, reload.id, [storedCopy()]);
    }
    const changeNotice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1"]');
    await expect(changeNotice).toContainText('The outcome is unknown.');
    await expect(page.locator('#copy-status')).toHaveText(
      'The outcome is unknown. Reload the copy before retrying.',
    );
    await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · foil · near mint');
    await expect(page.locator('#copy-finish-choice')).toHaveValue('foil');
    expect(errors).toEqual([]);
  });
}

for (const readOutcome of ['record', 'absence', 'failure'] as const) {
  for (const reloadTiming of ['before', 'after'] as const) {
    test(`an earlier reload establishing ${readOutcome} ${reloadTiming} correction rejection reconciles its own notice`, async ({
      page,
    }) => {
      const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
      await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
      await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
      await settleCard(page, 'card-1', { cards: [cardRecord()] });

      await page.locator('#copy-reload').click();
      await failCopyRead(page, (await copyRead(page, 1)).id, {
        code: 'unavailable',
        message: 'The service could not be reached.',
      });
      const readNotice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
      await expect(readNotice).toContainText('The service could not be reached.');
      await page.locator('#copy-reload').click();
      const reload = await copyRead(page, 2);
      await page.locator('#copy-condition-choice').selectOption('DMG');
      await page.getByRole('button', { name: 'Save changes' }).click();
      const saved = await correction(page);
      const completeReload = async () => {
        if (readOutcome === 'failure') {
          await failCopyRead(page, reload.id, {
            code: 'unavailable',
            message: 'The copy service is still unavailable.',
          });
          await expect(readNotice).toContainText('The copy service is still unavailable.');
        } else {
          await settleCopyRead(
            page,
            reload.id,
            readOutcome === 'record' ? [storedCopy({ condition: 'LP', revision: 5 })] : [],
          );
          await expect(readNotice).toHaveCount(0);
        }
      };
      if (reloadTiming === 'before') {
        await completeReload();
        await expect(page.locator('#copy-status')).toHaveText('Saving…');
      }
      await failCorrection(page, saved.id, {
        code: 'invalid-request',
        message: 'This correction is not valid.',
      });
      if (reloadTiming === 'after') {
        await completeReload();
      }
      await expect(page.locator('#copy-status')).toHaveText('This correction is not valid.');
      await expect(
        page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1"]'),
      ).toContainText('This correction is not valid.');
      if (readOutcome === 'record') {
        await expect(page.locator('#copy-saved')).toContainText('lightly played');
      }
      await expect(page.locator('#copy-condition-choice')).toHaveValue('DMG');
      expect(errors).toEqual([]);
    });
  }
}

for (const newestOutcome of ['success', 'failure'] as const) {
  test(`an obsolete reload cannot change the read notice after a newer ${newestOutcome}`, async ({
    page,
  }) => {
    const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
    await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
    await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
    await settleCard(page, 'card-1', { cards: [cardRecord()] });

    await page.locator('#copy-reload').click();
    const older = await copyRead(page, 1);
    await page.locator('#copy-reload').click();
    const newer = await copyRead(page, 2);
    const readNotice = page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1:read"]');
    const failure = { code: 'unavailable', message: 'The service could not be reached.' };
    if (newestOutcome === 'success') {
      await settleCopyRead(page, newer.id, [storedCopy({ revision: 5 })]);
      await failCopyRead(page, older.id, failure);
      await expect(readNotice).toHaveCount(0);
      await expect(page.locator('#copy-status')).toHaveText('Reloaded the copy.');
    } else {
      await failCopyRead(page, newer.id, failure);
      await expect(readNotice).toContainText(failure.message);
      await settleCopyRead(page, older.id, [storedCopy()]);
      await expect(readNotice).toContainText(failure.message);
      await expect(page.locator('#copy-status')).toHaveText(failure.message);
    }
    expect(errors).toEqual([]);
  });
}

for (const failure of [
  { code: 'conflict', message: 'The copy changed since you read it.' },
  { code: 'invalid-request', message: 'This correction is not valid.' },
] as const) {
  test(`an overlapping reload does not hide the ${failure.code} correction outcome`, async ({
    page,
  }) => {
    const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
    await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
    await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
    await settleCard(page, 'card-1', { cards: [cardRecord()] });

    await page.locator('#copy-condition-choice').selectOption('DMG');
    await page.getByRole('button', { name: 'Save changes' }).click();
    const saved = await correction(page);
    await page.locator('#copy-reload').click();
    await settleCopyRead(page, (await copyRead(page, 1)).id, [storedCopy({ revision: 5 })]);
    await expect(page.locator('#copy-status')).toHaveText('Reloaded the copy.');
    await failCorrection(page, saved.id, failure);
    if (failure.code === 'conflict') {
      await settleCopyRead(page, (await copyRead(page, 2)).id, [storedCopy({ revision: 6 })]);
    }
    await expect(
      page.locator('[data-ui-notice="navigation:page:alice:copy:copy-1"]'),
    ).toContainText(failure.message);
    await expect(page.locator('#copy-status')).toContainText(failure.message);
    await expect(page.locator('#copy-condition-choice')).toHaveValue('DMG');
    expect(errors).toEqual([]);
  });
}

test('an older reload never replaces the state a save committed', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  // A reload is started first and answers with the state a later save superseded.
  await page.locator('#copy-condition-choice').selectOption('LP');
  await page.locator('#copy-reload').click();
  const reload = await copyRead(page, 1);
  await page.getByRole('button', { name: 'Save changes' }).click();
  const saved = await correction(page);
  await settleCorrection(page, saved.id, [storedCopy({ condition: 'LP', revision: 5 })]);
  await expect(page.locator('#copy-status')).toHaveText('Saved.');
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · lightly played');

  // The earlier reload arrives after the save: it presents neither older state nor its feedback.
  await settleCopyRead(page, reload.id, [storedCopy({ condition: 'NM', revision: 4 })]);
  await expect(page.locator('#copy-status')).toHaveText('Saved.');
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · lightly played');
  await expect(page.locator('#copy-condition-choice')).toHaveValue('LP');
  expect(errors).toEqual([]);
});

test('overlapping reloads present the newest recorded state', async ({ page }) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord()], null);

  await page.locator('#copy-reload').click();
  const first = await copyRead(page, 1);
  await page.locator('#copy-reload').click();
  const second = await copyRead(page, 2);
  await settleCopyRead(page, second.id, [storedCopy({ condition: 'LP', revision: 5 })]);
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · lightly played');

  // The older response answers after the newer one: the presented state and feedback survive.
  await settleCopyRead(page, first.id, [storedCopy({ condition: 'NM', revision: 4 })]);
  await expect(page.locator('#copy-saved')).toHaveText('M11 149 · en · nonfoil · lightly played');
  await expect(page.locator('#copy-status')).toHaveText('Reloaded the copy.');
  expect(errors).toEqual([]);
});

test('rejects ambiguous copy printing choices after choosing another printing', async ({
  page,
}) => {
  const errors = await openCollection(page, '#/cards/card-1/printing-1/copy-1');
  await settleCopyRead(page, (await copyRead(page)).id, [storedCopy()]);
  await settlePrinting(page, 'printing-1', { printings: [printingRecord()] });
  await settleCard(page, 'card-1', { cards: [cardRecord()] });
  const other = { ...printingRecord('printing-2'), edition: 'M10', collectorNumber: '146' };
  await settlePrintings(page, (await printingsRequest(page))!.id, [printingRecord(), other], null);
  await choosePrinting(page, 'printing-1');
  await choosePrinting(page, 'printing-2');
  await expect(page.locator('#copy-status')).toHaveText(
    'Select exactly one printing, then choose it.',
  );
  await expect(page.locator('#copy-printing-line')).toHaveText('M11 149 · en');
  await page.locator('#copy-printing-picker [data-ui-select="printing:printing-1"]').uncheck();
  await page.locator('#copy-printing-picker [data-ui-tool="choose-printing"]').click();
  await settlePrinting(page, 'printing-2', { printings: [other] });
  await expect(page.locator('#copy-printing-line')).toHaveText('M10 146 · en');
  await expect(page.locator('#copy-status')).toBeEmpty();
  expect(errors).toEqual([]);
});
