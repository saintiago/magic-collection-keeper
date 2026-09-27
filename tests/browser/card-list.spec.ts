/**
 * Browser journeys: CardList (docs/user-interface.md#list-boundary, docs/user-interface.md#cardlist,
 * docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real CardList with the controlled sources, fragment readers and tools of
 * card-list.harness.ts and drive them in Chromium: bounded pages, basic information with the
 * entries, a refresh that keeps usable content, empty versus failed results, independent fragment
 * loading and retry, response ordering, selection through enrichment and refinement, tool outcomes,
 * grouped copies and two independent lists.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type {
  UiCardListControl,
  UiCardListFragmentRequest,
  UiCardListInstall,
  UiCardListPageRequest,
  UiCardListState,
  UiCardListToolRequest,
} from './card-list.harness.js';
import type {
  UiFragmentKind,
  UiFragmentResult,
  UiListEntry,
  UiOperationOutcome,
} from '../../src/ui/index.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = path.join(repoRoot, 'tests', 'browser', 'card-list.harness.ts');
const harnessPage = '<!doctype html><html><body><div id="root"></div></body></html>';

let bundle: Promise<string> | null = null;

/** Bundles the CardList with the journey harness, as a page bundles the UI entry point. */
function listBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({
      stdin: {
        contents: [
          `import { installCardListHarness } from ${JSON.stringify(harnessPath)};`,
          "globalThis.keeperCardListControl = installCardListHarness(document.getElementById('root'));",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'card-list-consumer.ts',
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

/** Serves a fresh document and installs the harness control into it. */
async function openLists(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-list.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: harnessPage }),
  );
  await page.goto('http://keeper-list.test/');
  await page.addScriptTag({ content: await listBundle(), type: 'module' });
  return errors;
}

type GlobalControl = { readonly keeperCardListControl: UiCardListControl };

async function install(page: Page, id: string, options?: UiCardListInstall): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.install(
        input.id,
        input.options,
      );
    },
    { id, options },
  );
}

async function refine(page: Page, id: string, context: string): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.refine(
        input.id,
        input.context,
      );
    },
    { id, context },
  );
}

async function refresh(page: Page, id: string): Promise<void> {
  await page.evaluate((listId) => {
    (globalThis as unknown as GlobalControl).keeperCardListControl.refresh(listId);
  }, id);
}

async function close(page: Page, id: string): Promise<void> {
  await page.evaluate((listId) => {
    (globalThis as unknown as GlobalControl).keeperCardListControl.close(listId);
  }, id);
}

async function state(page: Page, id: string): Promise<UiCardListState> {
  return page.evaluate((listId) => {
    return (globalThis as unknown as GlobalControl).keeperCardListControl.state(listId);
  }, id);
}

async function pageRequests(page: Page): Promise<readonly UiCardListPageRequest[]> {
  return page.evaluate(() =>
    (globalThis as unknown as GlobalControl).keeperCardListControl.pageRequests(),
  );
}

async function settlePage(
  page: Page,
  id: number,
  entries: readonly UiListEntry[],
  continuation: string | null = null,
): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.settlePage(input.id, {
        entries: input.entries,
        continuation: input.continuation,
      });
    },
    { id, entries, continuation },
  );
}

async function failPage(page: Page, id: number, message: string): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.failPage(
        input.id,
        input.message,
      );
    },
    { id, message },
  );
}

async function fragmentRequests(page: Page): Promise<readonly UiCardListFragmentRequest[]> {
  return page.evaluate(() =>
    (globalThis as unknown as GlobalControl).keeperCardListControl.fragmentRequests(),
  );
}

async function settleFragment(
  page: Page,
  id: number,
  results: readonly UiFragmentResult<unknown>[],
): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.settleFragment(
        input.id,
        input.results,
      );
    },
    { id, results },
  );
}

async function failFragment(page: Page, id: number, message: string): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.failFragment(
        input.id,
        input.message,
      );
    },
    { id, message },
  );
}

async function reloadFragment(
  page: Page,
  id: string,
  key: string,
  kind: UiFragmentKind,
): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.reloadFragment(
        input.id,
        input.key,
        input.kind,
      );
    },
    { id, key, kind },
  );
}

async function toolRequests(page: Page): Promise<readonly UiCardListToolRequest[]> {
  return page.evaluate(() =>
    (globalThis as unknown as GlobalControl).keeperCardListControl.toolRequests(),
  );
}

async function settleTool(page: Page, id: number, outcome: UiOperationOutcome): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.settleTool(
        input.id,
        input.outcome,
      );
    },
    { id, outcome },
  );
}

/** The first request one list recorded; a journey settles or fails it by its id. */
async function onlyRequest(page: Page, list: string): Promise<UiCardListPageRequest> {
  const requests = (await pageRequests(page)).filter((request) => request.list === list);
  const [first] = requests;
  if (first === undefined) {
    throw new Error(`No page request of list ${list} was recorded.`);
  }
  return first;
}

function copy(copyId: string, printingId: string, name = 'Lightning Bolt'): UiListEntry {
  return {
    key: `copy:${copyId}`,
    target: { kind: 'copy', copyId },
    basic: {
      card: { cardId: `card-${printingId}`, name, matchedName: null },
      printing: { printingId, edition: 'BLB', collectorNumber: '1', language: 'en' },
    },
    quantity: { copies: 1, intended: null },
  };
}

function card(cardId: string, name = 'Lightning Bolt'): UiListEntry {
  return {
    key: `card:${cardId}`,
    target: { kind: 'card', cardId },
    basic: {
      card: { cardId, name, matchedName: null },
      printing: null,
    },
    quantity: null,
  };
}

test('loads bounded pages and presents basic information with the entries', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 2, context: 'bolt' });

  const first = await onlyRequest(page, 'a');
  expect(first).toMatchObject({
    list: 'a',
    context: 'bolt',
    pageSize: 2,
    continuation: null,
    aborted: false,
  });
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('Loading…');

  await settlePage(
    page,
    first.id,
    [
      {
        key: 'copy:1',
        target: { kind: 'copy', copyId: 'copy-1' },
        basic: {
          card: { cardId: 'card-1', name: 'Lightning Bolt', matchedName: 'Rayo' },
          printing: {
            printingId: 'printing-1',
            edition: 'BLB',
            collectorNumber: '12',
            language: 'es',
          },
        },
        quantity: { copies: 2, intended: 3 },
      },
      { key: 'copy:2', target: { kind: 'copy', copyId: 'copy-2' }, basic: null, quantity: null },
    ],
    'next',
  );

  const row = page.locator('#list-a [data-ui-entry="copy:1"]');
  await expect(row.locator('[data-ui-name]')).toHaveText('Lightning Bolt');
  await expect(row.locator('[data-ui-matched-name]')).toHaveText('(Rayo)');
  await expect(row.locator('[data-ui-printing]')).toHaveText('BLB 12 · es');
  await expect(row.locator('[data-ui-copies]')).toHaveText('Copies: 2');
  await expect(row.locator('[data-ui-intended]')).toHaveText('Intended: 3');
  await expect(page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-name]')).toHaveText(
    'Unresolved entry',
  );
  expect(await state(page, 'a')).toEqual({
    entries: ['copy:1', 'copy:2'],
    selection: [],
    hasMore: true,
    loading: false,
    error: null,
  });

  await page.locator('#list-a [data-ui-more]').click();
  const requests = await pageRequests(page);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ pageSize: 2, continuation: 'next' });
  await settlePage(page, requests[1]!.id, [copy('3', 'printing-2')]);

  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(3);
  await expect(page.locator('#list-a [data-ui-more]')).toBeHidden();
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('');
  expect(errors).toEqual([]);
});

test('keeps usable entries through a refresh and distinguishes empty from failed', async ({
  page,
}) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2 });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  await expect(page.locator('#list-a [data-ui-entry="copy:1"]')).toBeVisible();

  await refresh(page, 'a');
  const refreshed = (await pageRequests(page))[1]!;
  expect(refreshed).toMatchObject({ continuation: null, aborted: false });
  // The usable window stays presented while the fresh page is in flight.
  await expect(page.locator('#list-a [data-ui-entry="copy:1"]')).toBeVisible();

  await failPage(page, refreshed.id, 'Catalog unavailable');
  await expect(page.locator('#list-a [data-ui-entry="copy:1"]')).toBeVisible();
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('Catalog unavailable');
  await expect(page.locator('#list-a [data-ui-retry]')).toBeVisible();
  expect(await state(page, 'a')).toMatchObject({
    entries: ['copy:1'],
    loading: false,
    error: 'Catalog unavailable',
  });

  await page.locator('#list-a [data-ui-retry]').click();
  const retried = (await pageRequests(page))[2]!;
  await settlePage(page, retried.id, []);
  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(0);
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('No entries');
  await expect(page.locator('#list-a [data-ui-retry]')).toBeHidden();
  expect(await state(page, 'a')).toMatchObject({ entries: [], error: null });
});

test('fails a page beyond the requested bound instead of rendering it', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2 });
  const first = await onlyRequest(page, 'a');

  await settlePage(page, first.id, [
    copy('1', 'printing-1'),
    copy('2', 'printing-1'),
    copy('3', 'printing-2'),
  ]);

  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(0);
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText(
    'The list source returned more than the 2 requested entries.',
  );
  expect(await state(page, 'a')).toMatchObject({
    loading: false,
    error: 'The list source returned more than the 2 requested entries.',
  });
});

test('loads images, ownership, tags and tools independently and retries one failure', async ({
  page,
}) => {
  await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    fragments: ['images', 'ownership', 'tags', 'tools'],
    tools: [{ id: 'wishlist', label: 'Add to wishlist' }],
  });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1'), copy('2', 'printing-1')]);

  // Each kind is read once for the active window, not once per entry.
  const requests = await fragmentRequests(page);
  expect(requests.map((request) => request.kind).sort()).toEqual([
    'images',
    'ownership',
    'tags',
    'tools',
  ]);
  for (const request of requests) {
    expect(request.keys).toEqual(['copy:1', 'copy:2']);
  }

  const images = requests.find((request) => request.kind === 'images')!;
  await settleFragment(page, images.id, [
    {
      key: 'copy:1',
      status: 'ready',
      values: [{ src: 'https://keeper.test/bolt.png', alt: 'Lightning Bolt' }],
    },
    { key: 'copy:2', status: 'ready', values: [] },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"] img'),
  ).toHaveAttribute('src', 'https://keeper.test/bolt.png');
  await expect(
    page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-fragment="images"]'),
  ).toHaveText('No images');

  const ownership = requests.find((request) => request.kind === 'ownership')!;
  await failFragment(page, ownership.id, 'Ownership unavailable');
  const ownershipSlot = page.locator(
    '#list-a [data-ui-entry="copy:1"] [data-ui-fragment="ownership"]',
  );
  await expect(ownershipSlot).toHaveAttribute('data-ui-state', 'failed');
  await expect(ownershipSlot).toContainText('ownership unavailable: Ownership unavailable');
  await expect(
    page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-fragment="ownership"]'),
  ).toHaveAttribute('data-ui-state', 'failed');

  const tags = requests.find((request) => request.kind === 'tags')!;
  await settleFragment(page, tags.id, [
    { key: 'copy:1', status: 'ready', values: [{ tagId: 'tag-1', name: 'Deck' }] },
    { key: 'copy:2', status: 'absent', values: null },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="tags"]'),
  ).toHaveText('Deck');
  await expect(
    page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-fragment="tags"]'),
  ).toHaveText('No tags');

  const availability = requests.find((request) => request.kind === 'tools')!;
  // Tool availability is the entry's own fragment: a tool is offered once every selected entry
  // reports it, and not while the fragment is still loading.
  const tool = page.locator('#list-a [data-ui-tool="wishlist"]');
  await page.locator('#list-a [data-ui-select="copy:1"]').check();
  await expect(tool).toBeDisabled();
  await settleFragment(page, availability.id, [
    { key: 'copy:1', status: 'ready', values: ['wishlist'] },
    { key: 'copy:2', status: 'ready', values: [] },
  ]);
  await expect(tool).toBeEnabled();
  await page.locator('#list-a [data-ui-select="copy:2"]').check();
  await expect(tool).toBeDisabled();
  await expect(
    page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-fragment="tools"]'),
  ).toHaveText('No tools available');
  await page.locator('#list-a [data-ui-select="copy:2"]').uncheck();
  await expect(tool).toBeEnabled();

  // Retrying one entry's failed fragment reads only that entry; the other entry stays failed.
  await ownershipSlot.locator('[data-ui-fragment-retry]').click();
  const retried = (await fragmentRequests(page)).filter((request) => request.kind === 'ownership');
  expect(retried).toHaveLength(2);
  expect(retried[1]?.keys).toEqual(['copy:1']);
  await settleFragment(page, retried[1]!.id, [
    { key: 'copy:1', status: 'ready', values: { owned: 2, locations: 1 } },
  ]);
  await expect(ownershipSlot).toHaveText('Owned: 2 · Locations: 1');
  await expect(
    page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-fragment="ownership"]'),
  ).toHaveAttribute('data-ui-state', 'failed');

  // An unreadable answer is a reported failure, never an empty answer.
  await reloadFragment(page, 'a', 'copy:1', 'tags');
  const reloaded = (await fragmentRequests(page)).filter((request) => request.kind === 'tags');
  expect(reloaded).toHaveLength(2);
  await settleFragment(page, reloaded[1]!.id, [
    { key: 'copy:1', status: 'ready', values: [{ tagId: 5, name: 'Deck' }] },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="tags"]'),
  ).toHaveAttribute('data-ui-state', 'failed');
});

test('drops an obsolete page instead of replacing the active result', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, context: 'first' });
  const first = await onlyRequest(page, 'a');

  await refine(page, 'a', 'second');
  const requests = await pageRequests(page);
  expect(requests[1]).toMatchObject({ context: 'second', continuation: null });
  expect(requests[0]?.aborted).toBe(true);

  await settlePage(page, requests[1]!.id, [copy('2', 'printing-2')], 'later');
  await expect(page.locator('#list-a [data-ui-entry="copy:2"]')).toBeVisible();

  // The withdrawn request settles late and never replaces the active result.
  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  await expect(page.locator('#list-a [data-ui-entry="copy:1"]')).toHaveCount(0);
  expect(await state(page, 'a')).toMatchObject({ entries: ['copy:2'], hasMore: true });

  // A further page of the replaced result never extends the result that replaced it.
  await page.locator('#list-a [data-ui-more]').click();
  const more = (await pageRequests(page))[2]!;
  expect(more).toMatchObject({ continuation: 'later' });
  await refine(page, 'a', 'third');
  const after = await pageRequests(page);
  const third = after[3]!;
  expect(after.find((request) => request.id === more.id)?.aborted).toBe(true);
  await settlePage(page, more.id, [copy('3', 'printing-3')]);
  await expect(page.locator('#list-a [data-ui-entry="copy:3"]')).toHaveCount(0);

  await settlePage(page, third.id, [copy('4', 'printing-4')]);
  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(1);
  await expect(page.locator('#list-a [data-ui-entry="copy:4"]')).toBeVisible();
});

test('keeps the selection through enrichment and refinement and acts through a tool', async ({
  page,
}) => {
  await openLists(page);
  await install(page, 'a', {
    pageSize: 3,
    fragments: ['images'],
    tools: [{ id: 'wishlist', label: 'Add to wishlist' }],
  });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1'), copy('2', 'printing-1'), card('1')]);

  await page.locator('#list-a [data-ui-select="copy:1"]').check();
  await page.locator('#list-a [data-ui-select="copy:2"]').check();
  await expect(page.locator('#list-a [data-ui-selection-count]')).toHaveText('2 selected');
  await expect(page.getByRole('checkbox', { name: 'Select Lightning Bolt (BLB 1)' })).toHaveCount(
    2,
  );
  expect(await state(page, 'a')).toMatchObject({ selection: ['copy:1', 'copy:2'] });

  // Enrichment does not change the explicit selection.
  const images = (await fragmentRequests(page))[0]!;
  await settleFragment(page, images.id, [
    { key: 'copy:1', status: 'ready', values: [] },
    { key: 'copy:2', status: 'ready', values: [] },
    { key: 'card:1', status: 'absent', values: null },
  ]);
  await expect(page.locator('#list-a [data-ui-select="copy:1"]')).toBeChecked();
  expect(await state(page, 'a')).toMatchObject({ selection: ['copy:1', 'copy:2'] });

  const tool = page.locator('#list-a [data-ui-tool="wishlist"]');
  await expect(tool).toBeEnabled();
  await tool.click();
  const [invocation] = await toolRequests(page);
  expect(invocation).toMatchObject({
    tool: 'wishlist',
    targets: ['copy:1', 'copy:2'],
    selection: ['copy:1', 'copy:2'],
  });
  await settleTool(page, invocation!.id, { status: 'committed', message: null });
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveAttribute(
    'data-ui-outcome-status',
    'committed',
  );
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveText('Saved.');
  expect(await state(page, 'a')).toMatchObject({ selection: ['copy:1', 'copy:2'] });

  // A conflict keeps the explicit selection and its explanation for a retry.
  await tool.click();
  const conflicted = (await toolRequests(page))[1]!;
  await settleTool(page, conflicted.id, { status: 'conflict', message: 'The tag changed.' });
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveAttribute(
    'data-ui-outcome-status',
    'conflict',
  );
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveText('The tag changed.');
  expect(await state(page, 'a')).toMatchObject({ selection: ['copy:1', 'copy:2'] });

  // A refinement keeps the selection of the keys the new result still holds.
  await refine(page, 'a', 'refined');
  const refined = (await pageRequests(page))[1]!;
  await settlePage(page, refined.id, [copy('1', 'printing-1'), copy('5', 'printing-5'), card('1')]);
  expect(await state(page, 'a')).toMatchObject({
    entries: ['copy:1', 'copy:5', 'card:1'],
    selection: ['copy:1'],
  });
  await expect(page.locator('#list-a [data-ui-select="card:1"]')).not.toBeChecked();
  // The entry kept its enriched fragment; the entry that arrived with the new result reads it.
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"]'),
  ).toHaveText('No images');
  await expect(
    page.locator('#list-a [data-ui-entry="copy:5"] [data-ui-fragment="images"]'),
  ).toHaveText('Loading images…');
  const enriched = (await fragmentRequests(page)).at(-1)!;
  expect(enriched.keys).toEqual(['copy:5']);
});

test('presents equivalent copies as one group without losing individual copies', async ({
  page,
}) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 4 });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [
    copy('1', 'printing-1'),
    copy('2', 'printing-1'),
    copy('3', 'printing-2'),
    copy('4', 'printing-1'),
  ]);

  const groups = page.locator('#list-a [data-ui-group]');
  // The two copies of printing-1 share a group; the lone copies present as plain rows.
  await expect(groups).toHaveCount(1);
  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(4);
  const equivalent = groups.first();
  await expect(equivalent.locator('[data-ui-group-count]')).toHaveText('2 equivalent copies');
  await expect(equivalent.locator('[data-ui-entry]')).toHaveCount(2);

  await equivalent.locator('[data-ui-group-select]').check();
  expect(await state(page, 'a')).toMatchObject({ selection: ['copy:1', 'copy:2'] });
  await expect(equivalent.locator('[data-ui-group-select]')).toBeChecked();

  await page.locator('#list-a [data-ui-select="copy:2"]').uncheck();
  await expect(equivalent.locator('[data-ui-group-select]')).not.toBeChecked();
  expect(
    await equivalent
      .locator('[data-ui-group-select]')
      .evaluate((element) => (element as HTMLInputElement).indeterminate),
  ).toBe(true);
  expect(await state(page, 'a')).toMatchObject({ selection: ['copy:1'] });
});

test('keeps two lists independent in query, window, selection and failure state', async ({
  page,
}) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 1, context: 'first' });
  await install(page, 'b', { pageSize: 2, context: 'second' });

  const first = await onlyRequest(page, 'a');
  const second = await onlyRequest(page, 'b');
  expect(first).toMatchObject({ context: 'first', pageSize: 1 });
  expect(second).toMatchObject({ context: 'second', pageSize: 2 });

  await settlePage(page, first.id, [copy('1', 'printing-1')], 'more');
  await settlePage(page, second.id, [copy('2', 'printing-2'), copy('3', 'printing-3')]);

  await page.locator('#list-a [data-ui-select="copy:1"]').check();
  await page.locator('#list-a [data-ui-more]').click();
  const more = (await pageRequests(page)).filter((request) => request.list === 'a')[1]!;
  expect(more).toMatchObject({ continuation: 'more' });

  expect(await state(page, 'b')).toEqual({
    entries: ['copy:2', 'copy:3'],
    selection: [],
    hasMore: false,
    loading: false,
    error: null,
  });
  expect(await state(page, 'a')).toMatchObject({
    entries: ['copy:1'],
    selection: ['copy:1'],
    loading: true,
  });

  await failPage(page, more.id, 'The collection is unavailable.');
  expect(await state(page, 'a')).toMatchObject({ error: 'The collection is unavailable.' });
  expect(await state(page, 'b')).toMatchObject({ error: null });
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText(
    'The collection is unavailable.',
  );
  await expect(page.locator('#list-b [data-ui-status]')).toHaveText('');
  await expect(page.locator('#list-b [data-ui-entry]')).toHaveCount(2);
  await expect(page.locator('#list-b [data-ui-select="copy:2"]')).not.toBeChecked();
});

test('cancels outstanding work when the page closes and drops its late results', async ({
  page,
}) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, fragments: ['images'] });
  const first = await onlyRequest(page, 'a');

  await close(page, 'a');
  await expect(page.locator('#list-a [data-ui-card-list]')).toHaveCount(0);
  expect((await pageRequests(page))[0]?.aborted).toBe(true);

  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(0);
});
