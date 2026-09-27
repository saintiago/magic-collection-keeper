/**
 * Browser journeys: the tags page and the tag view (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations,
 * docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real shell with the real organization pages and the controlled component
 * access of tags.harness.ts and drive them in Chromium: the tags page lists, creates and renames
 * tags while keeping an unsaved label after a conflict, a tag view presents a wishlist's intended
 * quantities and refines a card association to one exact printing, a location view moves a copy's
 * single physical location, and the add search distinguishes owned and intended counts while
 * adding a card to the wishlist with the quantity the owner chose.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type { CardRecord, PrintingRecord } from '../../src/catalog/index.js';
import type { Association, PhysicalCopy, Tag } from '../../src/usercards/index.js';
import type {
  UiTagsAssociationListRequest,
  UiTagsControl,
  UiTagsListRequest,
  UiTagsRequest,
} from './tags.harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = path.join(repoRoot, 'tests', 'browser', 'tags.harness.ts');
const tagsPageHtml = '<!doctype html><html><body><div id="ui-root"></div></body></html>';

let bundle: Promise<string> | null = null;

/** Bundles the organization pages with the journey harness, as a deployment bundles the UI. */
function tagsBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({
      stdin: {
        contents: [
          `import { installTagsHarness } from ${JSON.stringify(harnessPath)};`,
          "globalThis.keeperTagsControl = installTagsHarness(document.getElementById('ui-root'));",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'tags-consumer.ts',
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

/** Serves a fresh document for the organization pages, enters it at `hash` and loads the UI. */
async function openTags(page: Page, hash: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-tags.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: tagsPageHtml }),
  );
  await page.goto(`http://keeper-tags.test/${hash}`);
  await page.addScriptTag({ content: await tagsBundle(), type: 'module' });
  await page.waitForFunction(() => Reflect.has(globalThis, 'keeperTagsControl'));
  return errors;
}

/** Calls one operation of the installed harness with the supplied arguments. */
async function control<Value>(
  page: Page,
  method: keyof UiTagsControl,
  ...args: readonly unknown[]
): Promise<Value> {
  return page.evaluate(
    ({ name, values }) => {
      const target = (
        globalThis as unknown as {
          keeperTagsControl: Record<string, (...parameters: readonly unknown[]) => unknown>;
        }
      ).keeperTagsControl;
      return target[name as string]?.(...values) as unknown;
    },
    { name: method, values: args },
  ) as Promise<Value>;
}

/** Requests one operation recorded so far, waiting for it. */
async function requested<Arguments>(
  page: Page,
  method: keyof UiTagsControl,
  index = 0,
): Promise<UiTagsRequest<Arguments>> {
  await expect
    .poll(async () => (await control<readonly unknown[]>(page, method)).length)
    .toBeGreaterThan(index);
  const requests = await control<readonly UiTagsRequest<Arguments>[]>(page, method);
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`The pages did not issue ${String(method)} request ${index}.`);
  }
  return request;
}

async function settle<Value>(
  page: Page,
  method: keyof UiTagsControl,
  id: number,
  value: Value,
): Promise<void> {
  await control(page, method, id, value);
}

function tag(overrides: Partial<Tag> = {}): Tag {
  return {
    tagId: 'tag-burn',
    kind: 'deck',
    label: 'Burn',
    system: false,
    revision: 1,
    ...overrides,
  };
}

function association(overrides: Partial<Association> = {}): Association {
  return {
    associationId: 'association-1',
    tagId: 'tag-wish',
    targetLevel: 'printing',
    targetId: 'printing-1',
    quantity: 2,
    revision: 1,
    ...overrides,
  };
}

const boltPrinting: PrintingRecord = {
  printingId: 'printing-1',
  cardId: 'card-bolt',
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

const boltCard: CardRecord = {
  cardId: 'card-bolt',
  name: 'Lightning Bolt',
  names: [],
  rulesText: 'Lightning Bolt deals 3 damage to any target.',
  typeLine: 'Instant',
  colors: ['R'],
  colorIdentity: ['R'],
  manaValue: 1,
};

/** Answers the catalog resolves one association page issues for its card and printing references. */
async function settleCatalog(
  page: Page,
  index: number,
  records: Parameters<UiTagsControl['settleCatalog']>[1],
): Promise<void> {
  const request = await requested(page, 'catalogRequests', index);
  await settle(page, 'settleCatalog', request.id, records);
}

test('lists the account’s tags and keeps an unsaved rename after a conflict', async ({ page }) => {
  const errors = await openTags(page, '#/tags');
  const listing = await requested<UiTagsListRequest>(page, 'listTags');
  expect(listing.arguments).toEqual({ pageSize: 50, continuation: null });
  await settle(page, 'settleListTags', listing.id, {
    tags: [tag(), { tagId: 'tag-owned', kind: 'owned', label: 'Owned', system: true, revision: 1 }],
    continuation: null,
  });

  const row = page.locator('#tags-list [data-ui-tag="tag-burn"]');
  await expect(row.locator('a')).toHaveText('Burn');
  await expect(row.locator('[data-ui-tag-kind]')).toHaveText('Deck');
  // The account's system tag is managed by its own lifecycle, not by the tag controls.
  await expect(page.locator('#tags-list [data-ui-tag="tag-owned"]')).toHaveCount(0);

  await page.fill('#tag-label-tag-burn', 'Burn deck');
  await page.click('#tag-rename-tag-burn');
  const rename = await requested<{ readonly tagId: string }>(page, 'renameTag');
  expect(rename.arguments).toEqual({
    tagId: 'tag-burn',
    expectedRevision: 1,
    label: 'Burn deck',
  });
  await settle(page, 'fail', rename.id, {
    code: 'conflict',
    message: 'The tag changed after this revision; reload it before renaming it.',
  });

  // The unsaved label stays in the row and the saved state is read again for review.
  await expect(page.locator('#tag-label-tag-burn')).toHaveValue('Burn deck');
  await expect(page.locator('#tag-row-status-tag-burn')).toHaveText(
    'The tag changed after this revision; reload it before renaming it.',
  );
  const reread = await requested<readonly string[]>(page, 'readTags');
  expect(reread.arguments).toEqual(['tag-burn']);
  await settle(page, 'settleReadTags', reread.id, [tag()]);

  await page.click('#tag-rename-tag-burn');
  const retry = await requested<{ readonly label: string }>(page, 'renameTag', 1);
  expect(retry.arguments).toEqual({
    tagId: 'tag-burn',
    expectedRevision: 1,
    label: 'Burn deck',
  });
  await settle(page, 'settleRenameTag', retry.id, tag({ label: 'Burn deck', revision: 2 }));
  await expect(page.locator('#tag-row-status-tag-burn')).toHaveText('Renamed the tag.');
  await expect(page.locator('#tags-list [data-ui-tag="tag-burn"] a')).toHaveText('Burn deck');
  expect(errors).toEqual([]);
});

test('does not present a system tag as an editable grouping', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-owned');
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    { tagId: 'tag-owned', kind: 'owned', label: 'Owned', system: true, revision: 1 },
  ]);

  await expect(page.locator('#tag-kind')).toHaveText(
    'System tags are managed through their own lifecycle operations.',
  );
  await expect(page.locator('#tag-rename')).toHaveCount(0);
  await expect(page.locator('#tag-associations')).toHaveCount(0);
  expect(await control<readonly unknown[]>(page, 'listAssociations')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('creates a tag and keeps the unsaved label when the create fails', async ({ page }) => {
  const errors = await openTags(page, '#/tags');
  const listing = await requested<UiTagsListRequest>(page, 'listTags');
  await settle(page, 'settleListTags', listing.id, { tags: [], continuation: null });

  await page.selectOption('#tag-create-kind', 'wishlist');
  await page.fill('#tag-create-label', 'To buy');
  await page.click('#tag-create-submit');
  const create = await requested<{ readonly kind: string; readonly label: string }>(
    page,
    'createTag',
  );
  expect(create.arguments).toEqual({ kind: 'wishlist', label: 'To buy' });
  await settle(page, 'fail', create.id, {
    code: 'unavailable',
    message: 'The service is down.',
  });
  await expect(page.locator('#tag-create-label')).toHaveValue('To buy');
  await expect(page.locator('#tag-create-status')).toHaveText(
    'The outcome is unknown. Check whether the tag appears in the list before retrying.',
  );
  // The lost response is recovered by reading the list again, not by guessing the outcome.
  const recovery = await requested<UiTagsListRequest>(page, 'listTags', 1);
  await settle(page, 'settleListTags', recovery.id, { tags: [], continuation: null });

  await page.click('#tag-create-submit');
  const retry = await requested<{ readonly label: string }>(page, 'createTag', 1);
  await settle(
    page,
    'settleCreateTag',
    retry.id,
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'To buy', revision: 1 }),
  );
  await expect(page.locator('#tag-create-status')).toHaveText('Created “To buy”.');
  await expect(page.locator('#tag-create-label')).toHaveValue('');
  await expect(page.locator('#tags-list [data-ui-tag="tag-wish"] a')).toHaveText('To buy');
  expect(errors).toEqual([]);
});

test('presents a wishlist association’s intended quantity and saves a new one', async ({
  page,
}) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  const read = await requested<readonly string[]>(page, 'readTags');
  expect(read.arguments).toEqual(['tag-wish']);
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const page1 = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  expect(page1.arguments).toEqual({ tagId: 'tag-wish', pageSize: 50, continuation: null });
  await settle(page, 'settleListAssociations', page1.id, { associations: [association()] });
  await settleCatalog(page, 0, { printings: [boltPrinting] });
  await settleCatalog(page, 1, { cards: [boltCard] });

  const row = page.locator('#tag-associations [data-ui-entry="association:association-1"]');
  await expect(row).toContainText('Lightning Bolt');
  await expect(row).toContainText('M11 149 · en');
  await expect(row).toContainText('Printing');
  await expect(row.locator('[data-ui-intended]')).toHaveText(' Intended: 2');

  await page.fill('#tag-quantity-association-1', '4');
  await page.click('#tag-quantity-save-association-1');
  const change = await requested<Record<string, unknown>>(page, 'changeAssociation');
  expect(change.arguments).toEqual({
    associationId: 'association-1',
    expectedRevision: 1,
    targetLevel: 'printing',
    targetId: 'printing-1',
    quantity: 4,
  });
  await settle(
    page,
    'settleChangeAssociation',
    change.id,
    association({ quantity: 4, revision: 2 }),
  );

  // The committed change makes the association list read the tag's associations again.
  const refresh = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', refresh.id, {
    associations: [association({ quantity: 4, revision: 2 })],
  });
  await settleCatalog(page, 2, { printings: [boltPrinting] });
  await settleCatalog(page, 3, { cards: [boltCard] });
  await expect(
    page.locator(
      '#tag-associations [data-ui-entry="association:association-1"] [data-ui-intended]',
    ),
  ).toHaveText(' Intended: 4');
  expect(errors).toEqual([]);
});

test('keeps a typed intended quantity when the change fails', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, { associations: [association()] });
  await settleCatalog(page, 0, { printings: [boltPrinting] });
  await settleCatalog(page, 1, { cards: [boltCard] });

  await page.fill('#tag-quantity-association-1', '9');
  await page.click('#tag-quantity-save-association-1');
  const change = await requested<Record<string, unknown>>(page, 'changeAssociation');
  await settle(page, 'fail', change.id, {
    code: 'invalid-request',
    message: 'A card or printing association needs its intended quantity.',
  });

  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');
  await expect(page.locator('#tag-association-status-association-1')).toHaveText(
    'A card or printing association needs its intended quantity.',
  );
  // A failed change never reloads the associations: the unsaved input is what the owner reviews.
  expect(await control<readonly unknown[]>(page, 'listAssociations')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('refines a card association to one exact printing', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association({ targetLevel: 'card', targetId: 'card-bolt', quantity: 1 })],
  });
  await settleCatalog(page, 0, { cards: [boltCard] });

  // The printings are read when the owner refines the association, not for every presented card.
  expect(await control<readonly unknown[]>(page, 'printingsRequests')).toHaveLength(0);
  await page.click('#tag-refine-choose-association-1');
  const printings = await requested<{ readonly cardId: string }>(page, 'printingsRequests');
  expect(printings.arguments.cardId).toBe('card-bolt');
  await settle(page, 'settlePrintings', printings.id, {
    cardId: 'card-bolt',
    cardExists: true,
    revision: {
      revisionId: 'tags-revision',
      sourceName: 'fixture',
      sourceVersion: '1',
      publishedAt: '2026-09-01T00:00:00.000Z',
    },
    printings: [boltPrinting],
    continuation: null,
  });

  await page.selectOption('#tag-refine-association-1', 'printing-1');
  await page.click('#tag-refine-save-association-1');
  const change = await requested<Record<string, unknown>>(page, 'changeAssociation');
  expect(change.arguments).toEqual({
    associationId: 'association-1',
    expectedRevision: 1,
    targetLevel: 'printing',
    targetId: 'printing-1',
    quantity: 1,
  });
  await settle(
    page,
    'settleChangeAssociation',
    change.id,
    association({ targetLevel: 'printing', quantity: 1, revision: 2 }),
  );
  const refresh = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', refresh.id, {
    associations: [association({ targetLevel: 'printing', quantity: 1, revision: 2 })],
  });
  await settleCatalog(page, 1, { printings: [boltPrinting] });
  await settleCatalog(page, 2, { cards: [boltCard] });
  await expect(
    page.locator(
      '#tag-associations [data-ui-entry="association:association-1"] [data-ui-association-level]',
    ),
  ).toHaveText('Printing');
  expect(errors).toEqual([]);
});

test('moves a copy out of a location and shows the remaining associations', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-binder');
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-binder', kind: 'location', label: 'Binder' }),
  ]);
  // The location view offers the account's locations beside the copies it holds.
  const locations = await requested<UiTagsListRequest>(page, 'listTags');
  await settle(page, 'settleListTags', locations.id, {
    tags: [
      tag({ tagId: 'tag-binder', kind: 'location', label: 'Binder' }),
      tag({ tagId: 'tag-box', kind: 'location', label: 'Box' }),
    ],
    continuation: null,
  });
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association({ targetLevel: 'copy', targetId: 'copy-1', quantity: null })],
  });
  const copies = await requested<readonly string[]>(page, 'readCopies');
  expect(copies.arguments).toEqual(['copy-1']);
  const stored: PhysicalCopy = {
    copyId: 'copy-1',
    printingId: 'printing-1',
    finish: 'nonfoil',
    condition: 'NM',
    revision: 5,
  };
  await settle(page, 'settleReadCopies', copies.id, [stored]);
  await settleCatalog(page, 0, { printings: [boltPrinting] });
  await settleCatalog(page, 1, { cards: [boltCard] });

  const row = page.locator('#tag-associations [data-ui-entry="association:association-1"]');
  await expect(row.locator('[data-ui-association-level]')).toHaveText('Physical copy');
  await expect(row.locator('#tag-quantity-association-1')).toHaveCount(0);
  await expect(page.locator('#tag-move-association-1 option')).toHaveText([
    'No location',
    'Binder',
    'Box',
  ]);

  await page.selectOption('#tag-move-association-1', '');
  await page.click('#tag-move-save-association-1');
  // The move quotes the revision a fresh private read observes, never the page's older one.
  const reread = await requested<readonly string[]>(page, 'readCopies', 1);
  expect(reread.arguments).toEqual(['copy-1']);
  await settle(page, 'settleReadCopies', reread.id, [stored]);
  const move = await requested<Record<string, unknown>>(page, 'setCopyLocation');
  expect(move.arguments).toEqual({
    copyId: 'copy-1',
    locationTagId: null,
    expectedRevision: 5,
  });
  await settle(page, 'settleSetCopyLocation', move.id, { copy: stored, location: null });

  const refresh = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', refresh.id, { associations: [] });
  await expect(page.locator('#tag-associations [data-ui-status]')).toHaveText('No entries');
  expect(errors).toEqual([]);
});

test('searches the catalog and adds a card to the wishlist with its intended quantity', async ({
  page,
}) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  expect(listing.arguments).toEqual({ tagId: 'tag-wish', pageSize: 50, continuation: null });
  await settle(page, 'settleListAssociations', listing.id, { associations: [] });
  await expect(page.locator('#tag-associations [data-ui-status]')).toHaveText('No entries');

  await page.fill('#tag-add-query', 'bolt');
  await page.selectOption('#tag-add-level', 'card');
  await page.fill('#tag-add-quantity', '4');
  await page.click('#tag-add-submit');
  const search = await requested<{ readonly request: Record<string, unknown> }>(page, 'searches');
  expect(search.arguments.request).toEqual({
    resultLevel: 'card',
    query: 'bolt',
    pageSize: 50,
  });
  await settle(page, 'settleSearch', search.id, {
    entries: [
      {
        entryKey: 'card:card-bolt',
        target: { kind: 'card', cardId: 'card-bolt' },
        card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: null },
        printing: null,
        quantity: { copies: 1, intended: 2 },
      },
    ],
    totalCount: 1,
    continuation: null,
    revisions: { catalogRevision: 'tags-revision', privateRevision: 'private-1' },
  });

  const result = page.locator('#tag-add-results [data-ui-entry="card:card-bolt"]');
  await expect(result.locator('[data-ui-copies]')).toHaveText(' Copies: 1');
  await expect(result.locator('[data-ui-intended]')).toHaveText(' Intended: 2');

  await result.locator('[data-ui-select]').check();
  await page.click('#tag-add-results [data-ui-tool="add-to-tag"]');
  const add = await requested<Record<string, unknown>>(page, 'createAssociation');
  expect(add.arguments).toEqual({
    tagId: 'tag-wish',
    targetLevel: 'card',
    targetId: 'card-bolt',
    quantity: 4,
  });
  await settle(
    page,
    'settleCreateAssociation',
    add.id,
    association({ targetLevel: 'card', targetId: 'card-bolt', quantity: 4, revision: 1 }),
  );

  const refresh = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', refresh.id, {
    associations: [
      association({ targetLevel: 'card', targetId: 'card-bolt', quantity: 4, revision: 1 }),
    ],
  });
  await settleCatalog(page, 0, { cards: [boltCard] });
  await expect(
    page.locator(
      '#tag-associations [data-ui-entry="association:association-1"] [data-ui-intended]',
    ),
  ).toHaveText(' Intended: 4');
  expect(errors).toEqual([]);
});
