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
import { organizationContinuationFailures } from '../support/organization-pagination.js';
import type { SearchCount } from '../../src/search/index.js';
import type { Association, PhysicalCopy, Tag } from '../../src/usercards/index.js';
import type {
  UiTagsAssociationListRequest,
  UiTagsControl,
  UiTagsCountsRequest,
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

/** One page of generated tags, ordered by stable identity like the provider's pages. */
function tagPage(from: number, count: number): readonly Tag[] {
  return Array.from({ length: count }, (_, index) =>
    tag({
      tagId: `tag-${String(from + index).padStart(4, '0')}`,
      kind: 'other',
      label: `Tag ${from + index}`,
    }),
  );
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

const staBolt: PrintingRecord = {
  printingId: 'printing-2',
  cardId: 'card-bolt',
  edition: 'STA',
  collectorNumber: '109',
  language: 'en',
  finishes: ['etched'],
  physical: true,
  images: {
    small: 'https://cards.test/small-sta.jpg',
    normal: 'https://cards.test/normal-sta.jpg',
    large: null,
    artCrop: null,
  },
};

const catalogRevision = {
  revisionId: 'tags-revision',
  sourceName: 'fixture',
  sourceVersion: '1',
  publishedAt: '2026-09-01T00:00:00.000Z',
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

const counterspellCard: CardRecord = {
  cardId: 'card-counter',
  name: 'Counterspell',
  names: [],
  rulesText: 'Counter target spell.',
  typeLine: 'Instant',
  colors: ['U'],
  colorIdentity: ['U'],
  manaValue: 2,
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

/**
 * Answers every private count read from this table, like the provider the pages read through: a
 * reference the table does not name is answered with an exact zero and no intention.
 */
async function scriptCounts(
  page: Page,
  counts: readonly (readonly [string, SearchCount])[],
): Promise<void> {
  await control(page, 'scriptCounts', counts);
}

/** The counts of the association fixture's printing, as the real provider would evaluate them. */
const wishlistCounts: readonly (readonly [string, SearchCount])[] = [
  ['printing:printing-1', { owned: 1, locations: 1, intended: 2 }],
];

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
  await scriptCounts(page, wishlistCounts);
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
  // The provider's own counts are presented: the account's owned copies, the requirement the
  // tag holds and the physical locations of those copies stay distinct.
  await expect(row.locator('[data-ui-copies]')).toHaveText(' Copies: 1');
  await expect(row.locator('[data-ui-intended]')).toHaveText(' Intended: 2');
  await expect(row.locator('[data-ui-locations]')).toHaveText(' Locations: 1');
  const counted = await requested<UiTagsCountsRequest>(page, 'counts', 0);
  expect(counted.arguments.tagId).toBe('tag-wish');
  expect(counted.arguments.references).toEqual([{ kind: 'printing', printingId: 'printing-1' }]);

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

test('keeps the unsaved rename label when a lost response stays unknown', async ({ page }) => {
  const errors = await openTags(page, '#/tags');
  const listing = await requested<UiTagsListRequest>(page, 'listTags');
  await settle(page, 'settleListTags', listing.id, { tags: [tag()], continuation: null });

  await page.fill('#tag-label-tag-burn', 'My draft');
  await page.click('#tag-rename-tag-burn');
  const rename = await requested<{ readonly label: string }>(page, 'renameTag');
  await settle(page, 'fail', rename.id, {
    code: 'unavailable',
    message: 'The service is down.',
  });

  // The lost response is recovered by reading the tag, but the outcome stays unknown: the state
  // the read observed is presented as the one a retry quotes without replacing the user's label.
  const recovery = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', recovery.id, [
    tag({ label: 'Other saved label', revision: 2 }),
  ]);
  await expect(page.locator('#tag-label-tag-burn')).toHaveValue('My draft');
  await expect(page.locator('#tag-row-status-tag-burn')).toHaveText(
    'The outcome is unknown. Review the record before retrying.',
  );

  await page.click('#tag-rename-tag-burn');
  const retry = await requested<{ readonly expectedRevision: number; readonly label: string }>(
    page,
    'renameTag',
    1,
  );
  expect(retry.arguments).toEqual({
    tagId: 'tag-burn',
    expectedRevision: 2,
    label: 'My draft',
  });
  expect(errors).toEqual([]);
});

test('never replaces a committed tag with a late list response', async ({ page }) => {
  const errors = await openTags(page, '#/tags');
  const listing = await requested<UiTagsListRequest>(page, 'listTags');

  // The user creates a tag while the account's first list read is still outstanding.
  await page.selectOption('#tag-create-kind', 'wishlist');
  await page.fill('#tag-create-label', 'To buy');
  await page.click('#tag-create-submit');
  const create = await requested<{ readonly label: string }>(page, 'createTag');
  await settle(
    page,
    'settleCreateTag',
    create.id,
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'To buy' }),
  );
  await expect(page.locator('#tags-list [data-ui-tag="tag-wish"] a')).toHaveText('To buy');

  // The read that started before the create arrives late with the account's older, empty page: it
  // never replaces the window the committed change published.
  await settle(page, 'settleListTags', listing.id, { tags: [], continuation: null });
  await expect(page.locator('#tags-list [data-ui-tag="tag-wish"] a')).toHaveText('To buy');
  const replacement = await requested<UiTagsListRequest>(page, 'listTags', 1);
  expect(replacement.arguments.continuation).toBeNull();
  await settle(page, 'settleListTags', replacement.id, {
    tags: [tag(), tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'To buy' })],
    continuation: 'next',
  });
  await expect(page.locator('#tags-list [data-ui-tag="tag-burn"] a')).toHaveText('Burn');
  await page.click('#tags-more');
  expect((await requested<UiTagsListRequest>(page, 'listTags', 2)).arguments.continuation).toBe(
    'next',
  );
  expect(errors).toEqual([]);
});

test('keeps a typed quantity while a further association page loads', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  await scriptCounts(page, wishlistCounts);
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association()],
    continuation: 'association-page-2',
  });
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

  // Loading a further page re-renders the presented window; the unsaved input stays with the page.
  await page.click('#tag-associations [data-ui-more]');
  const more = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', more.id, {
    associations: [association({ associationId: 'association-2', quantity: 1 }), association()],
    continuation: null,
  });
  await settleCatalog(page, 2, { printings: [boltPrinting] });
  await settleCatalog(page, 3, { cards: [boltCard] });
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');
  expect(errors).toEqual([]);
});

test('recovers from an association conflict against the reviewed revision', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  await scriptCounts(page, wishlistCounts);
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
    code: 'conflict',
    message: 'The association changed after this revision; reload it before changing it.',
  });

  // The page reads the association the conflict names, presents its recorded state and keeps the
  // unsaved input for a deliberate retry.
  const reread = await requested<readonly string[]>(page, 'readAssociations');
  expect(reread.arguments).toEqual(['association-1']);
  await settle(page, 'settleReadAssociations', reread.id, [
    association({ quantity: 3, revision: 7 }),
  ]);
  await expect(page.locator('#tag-association-status-association-1')).toHaveText(
    'The association changed after this revision; reload it before changing it. Its saved state ' +
      'is now printing intention of 3. Your input stays for the retry.',
  );
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');

  // The retry quotes the revision the read presented instead of the obsolete one.
  await page.click('#tag-quantity-save-association-1');
  const retry = await requested<Record<string, unknown>>(page, 'changeAssociation', 1);
  expect(retry.arguments).toEqual({
    associationId: 'association-1',
    expectedRevision: 7,
    targetLevel: 'printing',
    targetId: 'printing-1',
    quantity: 9,
  });
  await settle(
    page,
    'settleChangeAssociation',
    retry.id,
    association({ quantity: 9, revision: 8 }),
  );
  const refresh = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', refresh.id, {
    associations: [association({ quantity: 9, revision: 8 })],
  });
  await settleCatalog(page, 2, { printings: [boltPrinting] });
  await settleCatalog(page, 3, { cards: [boltCard] });
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');
  expect(errors).toEqual([]);
});

test('allows removing an association again after a failed request', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-burn');
  await scriptCounts(page, wishlistCounts);
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-burn', kind: 'deck', label: 'Burn' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association({ tagId: 'tag-burn' })],
  });
  await settleCatalog(page, 0, { printings: [boltPrinting] });
  await settleCatalog(page, 1, { cards: [boltCard] });

  await page.click('#tag-remove-association-1');
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  const removal = await requested<Record<string, unknown>>(page, 'removeAssociation');
  await settle(page, 'fail', removal.id, {
    code: 'unavailable',
    message: 'The service is down.',
  });

  // The association stays presented, so its control is usable again for another attempt.
  const control = page.locator('#tag-remove-association-1');
  await expect(control).toBeEnabled();
  await control.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  const retry = await requested<Record<string, unknown>>(page, 'removeAssociation', 1);
  expect(retry.arguments).toEqual({ associationId: 'association-1', expectedRevision: 1 });
  expect(errors).toEqual([]);
});

test('reports the committed part of a bulk addition and reconciles the list', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  await scriptCounts(page, []);
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, { associations: [] });

  await page.fill('#tag-add-query', 'bolt');
  await page.selectOption('#tag-add-level', 'card');
  await page.fill('#tag-add-quantity', '2');
  await page.click('#tag-add-submit');
  const search = await requested<{ readonly request: Record<string, unknown> }>(page, 'searches');
  await settle(page, 'settleSearch', search.id, {
    entries: [
      {
        entryKey: 'card:card-bolt',
        target: { kind: 'card', cardId: 'card-bolt' },
        card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: null },
        printing: null,
        quantity: null,
      },
      {
        entryKey: 'card:card-counter',
        target: { kind: 'card', cardId: 'card-counter' },
        card: {
          cardId: counterspellCard.cardId,
          name: counterspellCard.name,
          matchedName: null,
        },
        printing: null,
        quantity: null,
      },
    ],
    totalCount: 2,
    continuation: null,
    revisions: { catalogRevision: 'tags-revision', privateRevision: 'private-1' },
  });

  const results = page.locator('#tag-add-results [data-ui-entry]');
  await results.nth(0).locator('[data-ui-select]').check();
  await results.nth(1).locator('[data-ui-select]').check();
  await page.click('#tag-add-results [data-ui-tool="add-to-tag"]');

  // The first entry commits; the second is a duplicate the provider refuses.
  const first = await requested<Record<string, unknown>>(page, 'createAssociation');
  await settle(
    page,
    'settleCreateAssociation',
    first.id,
    association({
      associationId: 'association-1',
      targetLevel: 'card',
      targetId: 'card-bolt',
      quantity: 2,
    }),
  );
  const second = await requested<Record<string, unknown>>(page, 'createAssociation', 1);
  await settle(page, 'fail', second.id, {
    code: 'conflict',
    message: 'This tag already associates that target; change the existing association instead.',
  });

  // The committed portion is reported beside the failure, and the association list reads the tag
  // again so the entry that committed is visible.
  await expect(page.locator('#tag-add-results [data-ui-outcome]')).toHaveAttribute(
    'data-ui-outcome-status',
    'conflict',
  );
  await expect(page.locator('#tag-add-results [data-ui-outcome]')).toHaveText(
    '1 of 2 entries were added; 1 were not. This tag already associates that target; change the ' +
      'existing association instead.',
  );
  const refresh = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', refresh.id, {
    associations: [
      association({
        associationId: 'association-1',
        targetLevel: 'card',
        targetId: 'card-bolt',
        quantity: 2,
      }),
    ],
  });
  await settleCatalog(page, 0, { cards: [boltCard] });
  await expect(
    page.locator('#tag-associations [data-ui-entry="association:association-1"]'),
  ).toContainText('Lightning Bolt');
  expect(errors).toEqual([]);
});

test('reads further printings when the exact one is not on the first page', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  await scriptCounts(page, [['card:card-bolt', { owned: 1, locations: 0, intended: 1 }]]);
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association({ targetLevel: 'card', targetId: 'card-bolt', quantity: 1 })],
  });
  await settleCatalog(page, 0, { cards: [boltCard] });

  await page.click('#tag-refine-choose-association-1');
  const first = await requested<{ readonly cardId: string }>(page, 'printingsRequests');
  await settle(page, 'settlePrintings', first.id, {
    cardId: 'card-bolt',
    cardExists: true,
    revision: catalogRevision,
    printings: [boltPrinting],
    continuation: 'printing-page-2',
  });

  // The first page is not the whole choice set: the row offers the continuation of the rest.
  await expect(page.locator('#tag-refine-more-association-1')).toBeVisible();
  await expect(page.locator('#tag-refine-association-1 option')).toHaveText(['M11 149 · en']);
  await page.click('#tag-refine-more-association-1');
  const second = await requested<{
    readonly cardId: string;
    readonly options: { readonly continuation?: string };
  }>(page, 'printingsRequests', 1);
  expect(second.arguments.options.continuation).toBe('printing-page-2');
  await settle(page, 'settlePrintings', second.id, {
    cardId: 'card-bolt',
    cardExists: true,
    revision: catalogRevision,
    printings: [staBolt],
    continuation: null,
  });

  await expect(page.locator('#tag-refine-association-1 option')).toHaveText([
    'M11 149 · en',
    'STA 109 · en',
  ]);
  await expect(page.locator('#tag-refine-more-association-1')).toBeHidden();
  await page.selectOption('#tag-refine-association-1', 'printing-2');
  await page.click('#tag-refine-save-association-1');
  const change = await requested<Record<string, unknown>>(page, 'changeAssociation');
  expect(change.arguments).toEqual({
    associationId: 'association-1',
    expectedRevision: 1,
    targetLevel: 'printing',
    targetId: 'printing-2',
    quantity: 1,
  });
  expect(errors).toEqual([]);
});

test('presents a deck’s required count beside the physical copies it holds', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-burn');
  await scriptCounts(page, [
    ['card:card-bolt', { owned: 1, locations: 1, intended: 4 }],
    ['copy:copy-1', { owned: 1, locations: 1, intended: 4 }],
  ]);
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-burn', kind: 'deck', label: 'Burn' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [
      association({
        associationId: 'association-1',
        tagId: 'tag-burn',
        targetLevel: 'card',
        targetId: 'card-bolt',
        quantity: 4,
      }),
      association({
        associationId: 'association-2',
        tagId: 'tag-burn',
        targetLevel: 'copy',
        targetId: 'copy-1',
        quantity: null,
      }),
    ],
  });
  const copies = await requested<readonly string[]>(page, 'readCopies');
  await settle(page, 'settleReadCopies', copies.id, [
    {
      copyId: 'copy-1',
      printingId: 'printing-1',
      finish: 'nonfoil',
      condition: 'NM',
      revision: 5,
    },
  ]);
  await settleCatalog(page, 0, { printings: [boltPrinting] });
  await settleCatalog(page, 1, { cards: [boltCard] });

  // The required count the deck holds and the copies the account owns stay distinct.
  const required = page.locator('#tag-associations [data-ui-entry="association:association-1"]');
  await expect(required.locator('[data-ui-intended]')).toHaveText(' Intended: 4');
  await expect(required.locator('[data-ui-copies]')).toHaveText(' Copies: 1');

  // A physical-copy row presents the requirement covering its printing beside its own copies.
  const physical = page.locator('#tag-associations [data-ui-entry="association:association-2"]');
  await expect(physical.locator('[data-ui-copies]')).toHaveText(' Copies: 1');
  await expect(physical.locator('[data-ui-intended]')).toHaveText(' Intended: 4');
  expect(errors).toEqual([]);
});

test('reads further location pages for a move', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-binder');
  await scriptCounts(page, [['copy:copy-1', { owned: 1, locations: 1, intended: null }]]);
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-binder', kind: 'location', label: 'Binder' }),
  ]);
  const locations = await requested<UiTagsListRequest>(page, 'listTags');
  await settle(page, 'settleListTags', locations.id, {
    tags: [tag({ tagId: 'tag-binder', kind: 'location', label: 'Binder' })],
    continuation: 'tag-page-2',
  });
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association({ targetLevel: 'copy', targetId: 'copy-1', quantity: null })],
  });
  const copies = await requested<readonly string[]>(page, 'readCopies');
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

  // The first tag page holds no further destination and continues: the view offers the rest.
  await expect(page.locator('#tag-move-association-1 option')).toHaveText([
    'No location',
    'Binder',
  ]);
  await expect(page.locator('#tag-locations-more')).toBeVisible();
  await page.click('#tag-locations-more');
  const more = await requested<UiTagsListRequest>(page, 'listTags', 1);
  expect(more.arguments.continuation).toBe('tag-page-2');
  await settle(page, 'settleListTags', more.id, {
    tags: [
      tag({ tagId: 'tag-bulk', kind: 'other', label: 'Bulk' }),
      tag({ tagId: 'tag-box', kind: 'location', label: 'Box' }),
    ],
    continuation: null,
  });

  // Only location tags are destinations, and the destination beyond the first page is offered.
  await expect(page.locator('#tag-move-association-1 option')).toHaveText([
    'No location',
    'Binder',
    'Box',
  ]);
  await expect(page.locator('#tag-locations-more')).toBeHidden();
  expect(errors).toEqual([]);
});

test('restarts the association list when its continuation went stale', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  await scriptCounts(page, wishlistCounts);
  const read = await requested<readonly string[]>(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist', label: 'Wanted' }),
  ]);
  const listing = await requested<UiTagsAssociationListRequest>(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association()],
    continuation: 'association-page-2',
  });
  await settleCatalog(page, 0, { printings: [boltPrinting] });
  await settleCatalog(page, 1, { cards: [boltCard] });

  await page.click('#tag-associations [data-ui-more]');
  const stale = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 1);
  expect(stale.arguments.continuation).toBe('association-page-2');
  await settle(page, 'fail', stale.id, (await organizationContinuationFailures()).associations);

  // The page reads the sequence again from its first page instead of repeating the unusable cursor.
  const restart = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 2);
  expect(restart.arguments).toEqual({
    tagId: 'tag-wish',
    pageSize: 50,
    continuation: null,
  });
  await settle(page, 'settleListAssociations', restart.id, { associations: [association()] });
  await settleCatalog(page, 2, { printings: [boltPrinting] });
  await settleCatalog(page, 3, { cards: [boltCard] });
  await expect(
    page.locator('#tag-associations [data-ui-entry="association:association-1"]'),
  ).toContainText('Lightning Bolt');
  await expect(page.locator('#tag-associations-status')).toHaveText(
    'The associations changed; the list was reloaded from the start.',
  );
  expect(errors).toEqual([]);
});

test('restores the browsed tag window when returning to the tags page', async ({ page }) => {
  const errors = await openTags(page, '#/tags');
  const first = await requested<UiTagsListRequest>(page, 'listTags');
  expect(first.arguments).toEqual({ pageSize: 50, continuation: null });
  await settle(page, 'settleListTags', first.id, {
    tags: tagPage(0, 50),
    continuation: 'tag-page-2',
  });

  // Fill the retained window and page once beyond it: the presented window now holds tags 50–549.
  for (let index = 2; index <= 11; index += 1) {
    await page.click('#tags-more');
    const request = await requested<UiTagsListRequest>(page, 'listTags', index - 1);
    expect(request.arguments.continuation).toBe(`tag-page-${index}`);
    await settle(page, 'settleListTags', request.id, {
      tags: tagPage((index - 1) * 50, 50),
      continuation: index === 11 ? null : `tag-page-${index + 1}`,
    });
  }

  // The rendering stays bounded and the retained window starts at the second page's first tag.
  const rendered = page.locator('#tags-list [data-ui-tag]');
  await expect(rendered).toHaveCount(500);
  await expect(page.locator('#tags-list [data-ui-tag="tag-0000"]')).toHaveCount(0);
  await expect(page.locator('#tags-list [data-ui-tag="tag-0050"]')).toHaveCount(1);
  await expect(page.locator('#tags-list [data-ui-tag="tag-0549"]')).toHaveCount(1);

  // Leaving for a tag and returning re-reads the window from its own position, not from the start.
  await page.click('#tags-list [data-ui-tag="tag-0549"] a');
  await expect(page.locator('#tag-heading')).toBeVisible();
  await page.goBack();
  const reread = await requested<UiTagsListRequest>(page, 'listTags', 11);
  expect(reread.arguments).toEqual({ pageSize: 50, continuation: 'tag-page-2' });
  await settle(page, 'settleListTags', reread.id, {
    tags: tagPage(50, 50),
    continuation: 'tag-page-3',
  });
  for (let index = 3; index <= 11; index += 1) {
    const request = await requested<UiTagsListRequest>(page, 'listTags', 9 + index);
    await settle(page, 'settleListTags', request.id, {
      tags: tagPage((index - 1) * 50, 50),
      continuation: index === 11 ? null : `tag-page-${index + 1}`,
    });
  }
  await expect(page.locator('#tags-list [data-ui-tag="tag-0549"]')).toHaveCount(1);
  await expect(page.locator('#tags-list [data-ui-tag="tag-0000"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keeps a typed intended quantity when the change fails', async ({ page }) => {
  const errors = await openTags(page, '#/tags/tag-wish');
  await scriptCounts(page, wishlistCounts);
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
  await scriptCounts(page, [['card:card-bolt', { owned: 1, locations: 1, intended: 1 }]]);
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
  await scriptCounts(page, [['copy:copy-1', { owned: 1, locations: 1, intended: null }]]);
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
  await scriptCounts(page, [['card:card-bolt', { owned: 1, locations: 1, intended: 2 }]]);
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
        // A public catalog query evaluates no private quantity; the counts the row presents come
        // from the provider's count read for exactly the entry the query selected.
        quantity: null,
      },
      {
        entryKey: 'card:card-counter',
        target: { kind: 'card', cardId: 'card-counter' },
        card: { cardId: 'card-counter', name: 'Counterspell', matchedName: null },
        printing: null,
        quantity: null,
      },
    ],
    totalCount: 2,
    continuation: null,
    revisions: { catalogRevision: 'tags-revision', privateRevision: 'private-1' },
  });

  const result = page.locator('#tag-add-results [data-ui-entry="card:card-bolt"]');
  await expect(result.locator('[data-ui-copies]')).toHaveText(' Copies: 1');
  await expect(result.locator('[data-ui-intended]')).toHaveText(' Intended: 2');
  await expect(result.locator('[data-ui-locations]')).toHaveText(' Locations: 1');
  // An entry the account does not own keeps its place with an exact zero: the counts enrich the
  // result instead of restricting its membership.
  const unowned = page.locator('#tag-add-results [data-ui-entry="card:card-counter"]');
  await expect(unowned.locator('[data-ui-copies]')).toHaveText(' Copies: 0');
  // The read names the presented entry and the tag whose intention the page presents, so an
  // unowned entry keeps its place with an exact zero instead of being dropped from the search.
  const counted = await requested<UiTagsCountsRequest>(page, 'counts', 0);
  expect(counted.arguments.tagId).toBe('tag-wish');
  expect(counted.arguments.references).toEqual([
    { kind: 'card', cardId: 'card-bolt' },
    { kind: 'card', cardId: 'card-counter' },
  ]);

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

/** A resolved card association, with its optional counts deliberately still pending. */
async function openCardAssociation(page: Page, continuation: string | null = null): Promise<void> {
  await openTags(page, '#/tags/tag-wish');
  const read = await requested(page, 'readTags');
  await settle(page, 'settleReadTags', read.id, [tag({ tagId: 'tag-wish', kind: 'wishlist' })]);
  const listing = await requested(page, 'listAssociations');
  await settle(page, 'settleListAssociations', listing.id, {
    associations: [association({ targetLevel: 'card', targetId: 'card-bolt' })],
    continuation,
  });
  await settleCatalog(page, 0, { cards: [boltCard] });
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('2');
}

async function printingPage(
  page: Page,
  index: number,
  printings: readonly PrintingRecord[],
  continuation: string | null = null,
): Promise<void> {
  const read = await requested(page, 'printingsRequests', index);
  await settle(page, 'settlePrintings', read.id, {
    cardId: 'card-bolt',
    cardExists: true,
    revision: catalogRevision,
    printings,
    continuation,
  });
}

test('refining preserves a separately drafted quantity and a later edit during save', async ({
  page,
}) => {
  await openCardAssociation(page);
  await page.fill('#tag-quantity-association-1', '9');
  await page.click('#tag-refine-choose-association-1');
  await printingPage(page, 0, [boltPrinting]);
  await page.click('#tag-refine-save-association-1');
  const change = await requested(page, 'changeAssociation');
  await settle(page, 'settleChangeAssociation', change.id, association({ revision: 2 }));
  const refresh = await requested(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', refresh.id, {
    associations: [association({ revision: 2 })],
  });
  await settleCatalog(page, 1, { printings: [boltPrinting] });
  await settleCatalog(page, 2, { cards: [boltCard] });
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');
  await page.click('#tag-quantity-save-association-1');
  const quantity = await requested<Record<string, unknown>>(page, 'changeAssociation', 1);
  expect(quantity.arguments.quantity).toBe(9);
  await page.fill('#tag-quantity-association-1', '12');
  await settle(
    page,
    'settleChangeAssociation',
    quantity.id,
    association({ revision: 3, quantity: 9 }),
  );
  const refreshed = await requested(page, 'listAssociations', 2);
  await settle(page, 'settleListAssociations', refreshed.id, {
    associations: [association({ revision: 3, quantity: 9 })],
  });
  await settleCatalog(page, 3, { printings: [boltPrinting] });
  await settleCatalog(page, 4, { cards: [boltCard] });
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('12');
});

test('printing reads retry after initial failure and complete into the current editor after paging', async ({
  page,
}) => {
  await openCardAssociation(page, 'next');
  await page.click('#tag-refine-choose-association-1');
  await settle(page, 'fail', (await requested(page, 'printingsRequests')).id, {
    code: 'unavailable',
    message: 'Offline',
  });
  await expect(page.locator('#tag-refine-more-association-1')).toHaveText('Retry printings');
  await page.click('#tag-refine-more-association-1');
  await requested(page, 'printingsRequests', 1);
  await page.locator('#tag-associations [data-ui-more]').click();
  const more = await requested(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', more.id, {
    associations: [
      association({ associationId: 'second', targetLevel: 'card', targetId: 'card-counter' }),
    ],
  });
  await settleCatalog(page, 1, { cards: [counterspellCard] });
  await expect(page.locator('#tag-quantity-second')).toBeVisible();
  await printingPage(page, 1, [boltPrinting]);
  await expect(page.locator('#tag-refine-association-1')).toBeEnabled();
  await expect(page.locator('#tag-refine-save-association-1')).toBeEnabled();
  await expect(page.locator('#tag-refine-status-association-1')).toHaveCount(0);
});

test('retains an unloaded printing choice through Back and expired Catalog pagination', async ({
  page,
}) => {
  await openCardAssociation(page);
  await page.click('#tag-refine-choose-association-1');
  await printingPage(page, 0, [boltPrinting], 'next');
  await page.click('#tag-refine-more-association-1');
  await printingPage(page, 1, [staBolt]);
  await page.selectOption('#tag-refine-association-1', staBolt.printingId);
  await control(page, 'navigate', { page: 'tags' });
  await page.goBack();
  await settle(page, 'settleReadTags', (await requested(page, 'readTags', 1)).id, [
    tag({ tagId: 'tag-wish', kind: 'wishlist' }),
  ]);
  await settle(page, 'settleListAssociations', (await requested(page, 'listAssociations', 1)).id, {
    associations: [association({ targetLevel: 'card', targetId: 'card-bolt' })],
  });
  await settleCatalog(page, 1, { cards: [boltCard] });
  await page.click('#tag-refine-choose-association-1');
  await printingPage(page, 2, [boltPrinting], 'expired');
  await expect(page.locator('#tag-refine-association-1')).toHaveValue('printing-2');
  await expect(page.locator('#tag-refine-save-association-1')).toBeDisabled();
  await page.click('#tag-refine-more-association-1');
  const expired = await requested(page, 'printingsRequests', 3);
  await settle(page, 'fail', expired.id, (await organizationContinuationFailures()).printings);
  const restarted = await requested<{ options: { continuation?: string } }>(
    page,
    'printingsRequests',
    4,
  );
  expect(restarted.arguments.options.continuation).toBeUndefined();
  await printingPage(page, 4, [staBolt]);
  await expect(page.locator('#tag-refine-association-1')).toHaveValue('printing-2');
  await page.click('#tag-refine-save-association-1');
  expect(
    (await requested<Record<string, unknown>>(page, 'changeAssociation')).arguments.targetId,
  ).toBe('printing-2');
});

for (const recovery of ['conflict', 'unavailable'] as const) {
  test(`${recovery} recovery displays the recovered card and edition before broadening`, async ({
    page,
  }) => {
    await openCardAssociation(page);
    await page.fill('#tag-quantity-association-1', '9');
    await page.click('#tag-quantity-save-association-1');
    await settle(page, 'fail', (await requested(page, 'changeAssociation')).id, {
      code: recovery,
      message: 'Changed',
    });
    const current = association({ targetId: 'printing-counter', quantity: 3, revision: 7 });
    await settle(page, 'settleReadAssociations', (await requested(page, 'readAssociations')).id, [
      current,
    ]);
    await expect(page.locator('#tag-quantity-save-association-1')).toBeDisabled();
    const refresh = await requested(page, 'listAssociations', 1);
    await settle(page, 'settleListAssociations', refresh.id, { associations: [current] });
    await settleCatalog(page, 1, {
      printings: [
        { ...boltPrinting, printingId: 'printing-counter', cardId: 'card-counter', edition: 'ICE' },
      ],
    });
    await settleCatalog(page, 2, { cards: [counterspellCard] });
    const row = page.locator('#tag-associations [data-ui-entry="association:association-1"]');
    await expect(row).toContainText('Counterspell');
    await expect(row).toContainText('ICE 149');
    await expect(row).not.toContainText('Lightning Bolt');
    await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');
    await page.click('#tag-broaden-association-1');
    expect(
      (await requested<Record<string, unknown>>(page, 'changeAssociation', 1)).arguments,
    ).toMatchObject({ targetId: 'card-counter', expectedRevision: 7 });
  });
}

test('late tag recovery cannot regress a later committed label or revision', async ({ page }) => {
  await openTags(page, '#/tags');
  await settle(page, 'settleListTags', (await requested(page, 'listTags')).id, { tags: [tag()] });
  await page.fill('#tag-label-tag-burn', 'First');
  await page.click('#tag-rename-tag-burn');
  await settle(page, 'fail', (await requested(page, 'renameTag')).id, {
    code: 'conflict',
    message: 'Changed',
  });
  const recovery = await requested(page, 'readTags');
  await page.fill('#tag-label-tag-burn', 'Latest');
  await page.click('#tag-rename-tag-burn');
  await settle(
    page,
    'settleRenameTag',
    (await requested(page, 'renameTag', 1)).id,
    tag({ label: 'Latest', revision: 3 }),
  );
  await settle(page, 'settleReadTags', recovery.id, [tag({ label: 'Older', revision: 2 })]);
  await expect(page.locator('#tag-link-tag-burn')).toHaveText('Latest');
  await page.fill('#tag-label-tag-burn', 'Next');
  await page.click('#tag-rename-tag-burn');
  expect(
    (await requested<Record<string, unknown>>(page, 'renameTag', 2)).arguments.expectedRevision,
  ).toBe(3);
});

test('obsolete association hydration cannot overwrite a committed quantity during further paging', async ({
  page,
}) => {
  await openCardAssociation(page, 'next');
  await page.locator('#tag-associations [data-ui-more]').click();
  const old = await requested(page, 'listAssociations', 1);
  await settle(page, 'settleListAssociations', old.id, {
    associations: [association({ targetLevel: 'card', targetId: 'card-bolt' })],
    continuation: 'old-next',
  });
  await requested(page, 'catalogRequests', 1);
  await page.fill('#tag-quantity-association-1', '9');
  await page.click('#tag-quantity-save-association-1');
  const current = association({
    targetLevel: 'card',
    targetId: 'card-bolt',
    revision: 2,
    quantity: 9,
  });
  await settle(
    page,
    'settleChangeAssociation',
    (await requested(page, 'changeAssociation')).id,
    current,
  );
  await settle(page, 'settleListAssociations', (await requested(page, 'listAssociations', 2)).id, {
    associations: [current],
    continuation: 'fresh-next',
  });
  await settleCatalog(page, 2, { cards: [boltCard] });
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');
  await settleCatalog(page, 1, { cards: [boltCard] });
  await page.locator('#tag-associations [data-ui-more]').click();
  const further = await requested<UiTagsAssociationListRequest>(page, 'listAssociations', 3);
  expect(further.arguments.continuation).toBe('fresh-next');
  await settle(page, 'settleListAssociations', further.id, {
    associations: [
      association({ associationId: 'second', targetLevel: 'card', targetId: 'card-counter' }),
    ],
  });
  await settleCatalog(page, 3, { cards: [counterspellCard] });
  await expect(page.locator('#tag-quantity-second')).toBeVisible();
  await expect(page.locator('#tag-quantity-association-1')).toHaveValue('9');
  await page.click('#tag-quantity-save-association-1');
  expect(
    (await requested<Record<string, unknown>>(page, 'changeAssociation', 1)).arguments
      .expectedRevision,
  ).toBe(2);
});

for (const source of ['associations', 'search'] as const) {
  test(`${source} basics are usable while counts are pending and all quantities recover on retry`, async ({
    page,
  }) => {
    await openCardAssociation(page);
    let index = 0;
    let row = page.locator('#tag-associations [data-ui-entry="association:association-1"]');
    if (source === 'search') {
      await page.click('#tag-add-submit');
      const search = await requested(page, 'searches');
      await settle(page, 'settleSearch', search.id, {
        resultLevel: 'card',
        entries: [
          {
            entryKey: 'card:card-bolt',
            target: { kind: 'card', cardId: 'card-bolt' },
            card: { cardId: 'card-bolt', name: 'Lightning Bolt', matchedName: null },
            printing: null,
            quantity: null,
          },
        ],
        continuation: null,
      });
      index = 1;
      row = page.locator('#tag-add-results [data-ui-entry="card:card-bolt"]');
    }
    await expect(row).toContainText('Lightning Bolt');
    const counts = await requested<UiTagsCountsRequest>(page, 'counts', index);
    expect(counts.arguments.tagId).toBe('tag-wish');
    await expect(row).toContainText('Loading ownership');
    await settle(page, 'fail', counts.id, { code: 'unavailable', message: 'Counts offline' });
    await expect(row).toContainText('Counts offline');
    await row.getByRole('button', { name: 'Retry ownership' }).click();
    const retry = await requested(page, 'counts', index + 1);
    await settle(page, 'settleCounts', retry.id, [
      ['card:card-bolt', { owned: 4, intended: 2, locations: 1 }],
    ]);
    await expect(row.locator('[data-ui-copies]')).toHaveText(' Copies: 4');
    await expect(row.locator('[data-ui-intended]')).toHaveText(' Intended: 2');
    await expect(row.locator('[data-ui-locations]')).toHaveText(' Locations: 1');
  });
}

async function resolveLocationVisit(page: Page, visit: number): Promise<void> {
  const read = await requested(page, 'readTags', visit);
  await settle(page, 'settleReadTags', read.id, [
    tag({ tagId: 'tag-binder', kind: 'location', label: 'Binder' }),
  ]);
  await settle(
    page,
    'settleListAssociations',
    (await requested(page, 'listAssociations', visit)).id,
    {
      associations: [association({ targetLevel: 'copy', targetId: 'copy-1', quantity: null })],
    },
  );
  await settle(page, 'settleReadCopies', (await requested(page, 'readCopies', visit)).id, [
    { copyId: 'copy-1', printingId: 'printing-1', finish: 'nonfoil', condition: 'NM', revision: 5 },
  ]);
  await settleCatalog(page, visit * 2, { printings: [boltPrinting] });
  await settleCatalog(page, visit * 2 + 1, { cards: [boltCard] });
}

test('location choices retry, restart expired pages, and preserve an unloaded destination after Back', async ({
  page,
}) => {
  await openTags(page, '#/tags/tag-binder');
  await resolveLocationVisit(page, 0);
  const initial = await requested(page, 'listTags');
  await settle(page, 'fail', initial.id, { code: 'unavailable', message: 'Locations offline' });
  await expect(page.locator('#tag-locations-more')).toHaveText('Retry locations');
  await page.click('#tag-locations-more');
  await settle(page, 'settleListTags', (await requested(page, 'listTags', 1)).id, {
    tags: [],
    continuation: 'next',
  });
  await page.click('#tag-locations-more');
  const box = tag({ tagId: 'tag-box', kind: 'location', label: 'Box' });
  await settle(page, 'settleListTags', (await requested(page, 'listTags', 2)).id, { tags: [box] });
  await page.selectOption('#tag-move-association-1', 'tag-box');
  await control(page, 'navigate', { page: 'tags' });
  await requested(page, 'listTags', 3);
  await page.goBack();
  await resolveLocationVisit(page, 1);
  await settle(page, 'settleListTags', (await requested(page, 'listTags', 4)).id, {
    tags: [],
    continuation: 'expired',
  });
  await expect(page.locator('#tag-move-association-1')).toHaveValue('tag-box');
  await expect(page.locator('#tag-move-save-association-1')).toBeDisabled();
  expect(await control(page, 'setCopyLocation')).toEqual([]);
  await page.click('#tag-locations-more');
  await settle(
    page,
    'fail',
    (await requested(page, 'listTags', 5)).id,
    (await organizationContinuationFailures()).tags,
  );
  const restart = await requested<UiTagsListRequest>(page, 'listTags', 6);
  expect(restart.arguments.continuation).toBeNull();
  await settle(page, 'settleListTags', restart.id, { tags: [box] });
  await expect(page.locator('#tag-move-association-1')).toHaveValue('tag-box');
  await page.click('#tag-move-save-association-1');
  await settle(page, 'settleReadCopies', (await requested(page, 'readCopies', 2)).id, [
    { copyId: 'copy-1', printingId: 'printing-1', finish: 'nonfoil', condition: 'NM', revision: 5 },
  ]);
  expect(
    (await requested<Record<string, unknown>>(page, 'setCopyLocation')).arguments.locationTagId,
  ).toBe('tag-box');
});

test('tag pagination restarts actual private conflicts without losing rename drafts', async ({
  page,
}) => {
  await openTags(page, '#/tags');
  await settle(page, 'settleListTags', (await requested(page, 'listTags')).id, {
    tags: [tag()],
    continuation: 'expired',
  });
  await page.fill('#tag-label-tag-burn', 'Draft');
  await page.click('#tags-more');
  await settle(
    page,
    'fail',
    (await requested(page, 'listTags', 1)).id,
    (await organizationContinuationFailures()).tags,
  );
  const restart = await requested<UiTagsListRequest>(page, 'listTags', 2);
  expect(restart.arguments.continuation).toBeNull();
  await settle(page, 'settleListTags', restart.id, { tags: [tag()], continuation: 'fresh' });
  await expect(page.locator('#tag-label-tag-burn')).toHaveValue('Draft');
  await page.click('#tags-more');
  expect((await requested<UiTagsListRequest>(page, 'listTags', 3)).arguments.continuation).toBe(
    'fresh',
  );
});

test('rename draft retention is bounded independently of the tag window and history', async ({
  page,
}) => {
  await openTags(page, '#/tags');
  for (let index = 0; index < 11; index += 1) {
    if (index > 0) await page.click('#tags-more');
    await settle(page, 'settleListTags', (await requested(page, 'listTags', index)).id, {
      tags: tagPage(index * 50, 50),
      continuation: `page-${index + 1}`,
    });
    await page.locator(`[data-ui-tag="tag-${String(index * 50).padStart(4, '0')}"]`).waitFor();
    // Edit the newly loaded labels through DOM input events; every page retains a separate draft.
    await page.evaluate((start) => {
      for (let id = start; id < start + 50; id += 1) {
        const input = document.getElementById(
          `tag-label-tag-${String(id).padStart(4, '0')}`,
        ) as HTMLInputElement;
        input.value = `Draft ${id}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, index * 50);
  }
  await page.click('#tag-link-tag-0549');
  await page.goBack();
  const retained = await requested<UiTagsListRequest>(page, 'listTags', 11);
  expect(retained.arguments.continuation).toBe('page-1');
  await settle(page, 'fail', retained.id, (await organizationContinuationFailures()).tags);
  const restart = await requested<UiTagsListRequest>(page, 'listTags', 12);
  expect(restart.arguments.continuation).toBeNull();
  await settle(page, 'settleListTags', restart.id, {
    tags: [...tagPage(0, 1), ...tagPage(549, 1)],
  });
  await expect(page.locator('#tag-label-tag-0000')).toHaveValue('Tag 0');
  await expect(page.locator('#tag-label-tag-0549')).toHaveValue('Draft 549');
});

for (const view of ['tags', 'tag'] as const) {
  test(`${view} rename completion preserves text typed after submission`, async ({ page }) => {
    await openTags(page, view === 'tags' ? '#/tags' : '#/tags/tag-burn');
    if (view === 'tags') {
      await settle(page, 'settleListTags', (await requested(page, 'listTags')).id, {
        tags: [tag()],
      });
    } else {
      await settle(page, 'settleReadTags', (await requested(page, 'readTags')).id, [tag()]);
    }
    const input = view === 'tags' ? '#tag-label-tag-burn' : '#tag-label';
    const save = view === 'tags' ? '#tag-rename-tag-burn' : '#tag-rename-submit';
    await page.fill(input, 'Submitted');
    await page.click(save);
    const submitted = await requested(page, 'renameTag');
    await page.fill(input, 'Next draft');
    await settle(page, 'settleRenameTag', submitted.id, tag({ label: 'Submitted', revision: 2 }));
    await expect(page.locator(input)).toHaveValue('Next draft');
    await page.click(save);
    expect(
      (await requested<Record<string, unknown>>(page, 'renameTag', 1)).arguments,
    ).toMatchObject({ label: 'Next draft', expectedRevision: 2 });
  });
}
