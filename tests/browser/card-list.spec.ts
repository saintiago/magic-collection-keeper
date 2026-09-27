/**
 * Browser journeys: CardList (docs/user-interface.md#list-boundary, docs/user-interface.md#cardlist,
 * docs/user-interface.md#state-ownership-and-restoration, docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real CardList with the controlled sources, fragment readers and tools of
 * card-list.harness.ts and drive them in Chromium: bounded pages, basic information with the
 * entries, a refresh that keeps usable content, empty versus failed results, independent fragment
 * loading and retry, response ordering, selection through enrichment and refinement, the read
 * recovery of an invalidated sequence and a failed restart, tool outcomes, a bounded working set
 * with bounded fragment batches, retired obsolete work, retained keyboard focus, grouped copies,
 * two independent lists and the capture and restoration of one list's own state through its public
 * contract.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type {
  UiCardListRestorationReport,
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
  UiCardListState as UiCardListStateShape,
  UiListEntry,
  UiOperationOutcome,
} from '../../src/ui/index.js';
import { UI_LIMITS } from '../../src/ui/index.js';

/** State one list retains for its page's history entry; these journeys evaluate text queries. */
type UiCardListRetainedState = UiCardListStateShape<string | null | undefined>;

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

async function refine(page: Page, id: string, context: string | null | undefined): Promise<void> {
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

async function capture(page: Page, id: string): Promise<UiCardListRetainedState> {
  return page.evaluate((listId) => {
    return (globalThis as unknown as GlobalControl).keeperCardListControl.capture(listId);
  }, id);
}

async function restoration(page: Page, id: string): Promise<UiCardListRestorationReport> {
  return page.evaluate((listId) => {
    return (globalThis as unknown as GlobalControl).keeperCardListControl.restoration(listId);
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

async function invalidatePage(page: Page, id: number): Promise<void> {
  await page.evaluate((requestId) => {
    (globalThis as unknown as GlobalControl).keeperCardListControl.invalidatePage(requestId);
  }, id);
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

async function failTool(page: Page, id: number, message: string): Promise<void> {
  await page.evaluate(
    (input) => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.failTool(
        input.id,
        input.message,
      );
    },
    { id, message },
  );
}

/** The entry one list presents the keyboard focus on, as the user's keyboard interaction leaves it. */
async function focusedEntry(page: Page, list: string): Promise<string | null> {
  return page.evaluate((listId) => {
    const active = document.activeElement;
    const row = active?.closest?.(`#list-${listId} [data-ui-entry]`) ?? null;
    return row?.getAttribute('data-ui-entry') ?? null;
  }, list);
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

/** The latest request one list recorded; a journey settles or fails it by its id. */
async function lastRequest(page: Page, list: string): Promise<UiCardListPageRequest> {
  const requests = (await pageRequests(page)).filter((request) => request.list === list);
  const last = requests.at(-1);
  if (last === undefined) {
    throw new Error(`No page request of list ${list} was recorded.`);
  }
  return last;
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

/** The copy of `copy:1` after the same physical copy was corrected to another printing. */
function correctedCopy(): UiListEntry {
  return {
    key: 'copy:1',
    target: { kind: 'copy', copyId: 'copy-1' },
    basic: {
      card: { cardId: 'card-2', name: 'Lightning Bolt', matchedName: null },
      printing: {
        printingId: 'printing-2',
        edition: '2X2',
        collectorNumber: '117',
        language: 'en',
      },
    },
    quantity: { copies: 1, intended: null },
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

/** One fragment answer per key: the controlled reader resolved them as definitively empty. */
function absent(keys: readonly string[]): readonly UiFragmentResult<unknown>[] {
  return keys.map((key) => ({ key, status: 'absent', values: null }));
}

test('bounds the working set and the fragment batches of a large source', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 100, fragments: ['images'] });

  const window = (number: number): readonly UiListEntry[] =>
    Array.from({ length: 100 }, (_, index) =>
      copy(String((number - 1) * 100 + index + 1), 'printing-1'),
    );

  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, window(1), 'more-1');
  // Paging with the first enrichment held pending never grows the window, the rendering or a read
  // beyond its bound, and further results stay reachable.
  for (let number = 2; number <= 8; number += 1) {
    await page.locator('#list-a [data-ui-more]').click();
    const requests = (await pageRequests(page)).filter((request) => request.list === 'a');
    const request = requests[number - 1]!;
    expect(request).toMatchObject({ continuation: `more-${number - 1}` });
    await settlePage(page, request.id, window(number), `more-${number}`);
  }

  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(UI_LIMITS.listWindow);
  const paged = await state(page, 'a');
  expect(paged.entries).toHaveLength(UI_LIMITS.listWindow);
  expect(paged.hasMore).toBe(true);

  const reads = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  expect(reads.length).toBeGreaterThan(0);
  for (const read of reads) {
    expect(read.keys.length).toBeLessThanOrEqual(UI_LIMITS.fragmentBatch);
  }
  const waiting = reads.at(-1)!;
  expect(waiting.aborted).toBe(false);
  await settleFragment(page, waiting.id, absent(waiting.keys));
  const following = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  expect(following).toHaveLength(reads.length + 1);
  expect(following.at(-1)!.keys.length).toBe(UI_LIMITS.fragmentBatch);
});

test('never pages a retained window with the context of a failed refinement', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, context: 'old' });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1')], 'old-cursor');

  await refine(page, 'a', 'new');
  const refined = (await pageRequests(page))[1]!;
  expect(refined).toMatchObject({ context: 'new', continuation: null });
  await failPage(page, refined.id, 'Search unavailable');

  // The retained window stays presented, but it belongs to the previous query and is not paged
  // with the new one.
  await expect(page.locator('#list-a [data-ui-entry="copy:1"]')).toBeVisible();
  await expect(page.locator('#list-a [data-ui-more]')).toBeHidden();
  expect(await state(page, 'a')).toMatchObject({
    entries: ['copy:1'],
    hasMore: false,
    error: 'Search unavailable',
  });

  // Retrying repeats the new query's first page; the previous continuation is never sent with it.
  await page.locator('#list-a [data-ui-retry]').click();
  const retried = (await pageRequests(page))[2]!;
  expect(retried).toMatchObject({ context: 'new', continuation: null });
  await settlePage(page, retried.id, [copy('2', 'printing-2')], 'new-cursor');
  await expect(page.locator('#list-a [data-ui-entry="copy:2"]')).toBeVisible();
  expect(await pageRequests(page)).not.toContainEqual(
    expect.objectContaining({ context: 'new', continuation: 'old-cursor' }),
  );
});

test('retires the fragment read of an entry the window no longer holds', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, fragments: ['images'] });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  const [read] = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  expect(read?.keys).toEqual(['copy:1']);
  expect(read?.aborted).toBe(false);

  // Replacing the entry retires its outstanding read instead of waiting behind it, and the fresh
  // entry reads its own images.
  await refresh(page, 'a');
  const refreshed = (await pageRequests(page))[1]!;
  await settlePage(page, refreshed.id, [copy('2', 'printing-2')]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-fragment="images"]'),
  ).toHaveText('Loading images…');
  const reads = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  expect(reads).toHaveLength(2);
  expect(reads[0]?.aborted).toBe(true);
  expect(reads[1]?.keys).toEqual(['copy:2']);

  // The withdrawn read settling late neither populates nor disturbs the current entry.
  await settleFragment(page, read!.id, [
    {
      key: 'copy:1',
      status: 'ready',
      values: [{ src: 'https://keeper.test/old.png', alt: 'Old' }],
    },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:2"] [data-ui-fragment="images"]'),
  ).toHaveText('Loading images…');
});

test('retires an outstanding fragment read when a retained entry changes', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, fragments: ['images'] });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  const [read] = (await fragmentRequests(page)).filter((request) => request.kind === 'images');

  // The refresh corrects the entry's printing while its first read is still outstanding.
  await refresh(page, 'a');
  const refreshed = (await pageRequests(page))[1]!;
  await settlePage(page, refreshed.id, [correctedCopy()]);
  await expect(page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-printing]')).toHaveText(
    '2X2 117 · en',
  );
  const reads = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  expect(reads).toHaveLength(2);
  expect(reads[0]?.aborted).toBe(true);
  expect(reads[1]?.keys).toEqual(['copy:1']);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"]'),
  ).toHaveText('Loading images…');

  await settleFragment(page, reads[1]!.id, [
    {
      key: 'copy:1',
      status: 'ready',
      values: [{ src: 'https://keeper.test/corrected.png', alt: 'Corrected' }],
    },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"] img'),
  ).toHaveAttribute('src', 'https://keeper.test/corrected.png');
  // The withdrawn read answers for the previous printing and never replaces the fresh values.
  await settleFragment(page, read!.id, [
    {
      key: 'copy:1',
      status: 'ready',
      values: [{ src: 'https://keeper.test/old.png', alt: 'Old' }],
    },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"] img'),
  ).toHaveAttribute('src', 'https://keeper.test/corrected.png');
});

test('reads a fragment again when a settled retained entry changes', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, fragments: ['images'] });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  const [read] = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  await settleFragment(page, read!.id, [
    {
      key: 'copy:1',
      status: 'ready',
      values: [{ src: 'https://keeper.test/old.png', alt: 'Old' }],
    },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"] img'),
  ).toHaveAttribute('src', 'https://keeper.test/old.png');

  // The presented entry now names another printing, so its enrichment is read again rather than
  // presenting the values read for the previous one.
  await refresh(page, 'a');
  const refreshed = (await pageRequests(page))[1]!;
  await settlePage(page, refreshed.id, [correctedCopy()]);
  const reads = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  expect(reads).toHaveLength(2);
  expect(reads[1]?.keys).toEqual(['copy:1']);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"]'),
  ).toHaveText('Loading images…');
  await settleFragment(page, reads[1]!.id, [
    {
      key: 'copy:1',
      status: 'ready',
      values: [{ src: 'https://keeper.test/corrected.png', alt: 'Corrected' }],
    },
  ]);
  await expect(
    page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"] img'),
  ).toHaveAttribute('src', 'https://keeper.test/corrected.png');
});

test('reloads one fragment without waiting for the read it supersedes', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, fragments: ['images'] });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  const [superseded] = (await fragmentRequests(page)).filter(
    (request) => request.kind === 'images',
  );

  await reloadFragment(page, 'a', 'copy:1', 'images');
  const reads = (await fragmentRequests(page)).filter((request) => request.kind === 'images');
  expect(reads).toHaveLength(2);
  expect(reads[0]?.aborted).toBe(true);
  expect(reads[1]?.keys).toEqual(['copy:1']);

  // The superseded read failing late never reports for the entry its replacement now serves.
  await failFragment(page, superseded!.id, 'The previous read failed.');
  const slot = page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment="images"]');
  await expect(slot).toHaveAttribute('data-ui-state', 'loading');
  await expect(slot.locator('[data-ui-fragment-retry]')).toHaveCount(0);

  await settleFragment(page, reads[1]!.id, [
    {
      key: 'copy:1',
      status: 'ready',
      values: [{ src: 'https://keeper.test/bolt.png', alt: 'Lightning Bolt' }],
    },
  ]);
  await expect(slot.locator('img')).toHaveAttribute('src', 'https://keeper.test/bolt.png');
});

test('keeps keyboard focus on a retained entry through window updates', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 2, fragments: ['images'] });
  const presented = [copy('1', 'printing-1'), copy('2', 'printing-1')];
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, presented, 'more');

  // A refresh that presents the identical entries keeps the focused control of its group.
  await page.locator('#list-a [data-ui-group-select]').focus();
  await expect(page.locator('#list-a [data-ui-group-select]')).toBeFocused();
  await refresh(page, 'a');
  const refreshed = (await pageRequests(page))[1]!;
  await settlePage(page, refreshed.id, presented, 'more');
  await expect(page.locator('#list-a [data-ui-group-select]')).toBeFocused();

  // So does the page that extends the window with the focused entry still presented.
  await page.locator('#list-a [data-ui-more]').click();
  const more = (await pageRequests(page))[2]!;
  await page.locator('#list-a [data-ui-select="copy:2"]').focus();
  await settlePage(page, more.id, [copy('3', 'printing-2')]);
  await expect(page.locator('#list-a [data-ui-select="copy:2"]')).toBeFocused();

  // And a refinement that keeps the entry.
  await page.locator('#list-a [data-ui-select="copy:1"]').focus();
  await refine(page, 'a', 'refined');
  const refined = (await pageRequests(page))[3]!;
  await settlePage(page, refined.id, [copy('1', 'printing-1'), copy('4', 'printing-4')]);
  await expect(page.locator('#list-a [data-ui-select="copy:1"]')).toBeFocused();

  // A fragment that re-renders keeps the focus inside the entry it belongs to.
  const inFlight = (await fragmentRequests(page))
    .filter((request) => request.kind === 'images')
    .at(-1)!;
  await failFragment(page, inFlight.id, 'Images unavailable');
  await page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment-retry]').focus();
  expect(await focusedEntry(page, 'a')).toBe('copy:1');
  await page.locator('#list-a [data-ui-entry="copy:1"] [data-ui-fragment-retry]').click();
  expect(await focusedEntry(page, 'a')).toBe('copy:1');
});

test('reports a lost tool response as unknown instead of a definite failure', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    tools: [{ id: 'wishlist', label: 'Add to wishlist' }],
  });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [copy('1', 'printing-1')]);
  await page.locator('#list-a [data-ui-select="copy:1"]').check();

  // A tool whose write may have committed before its response was lost reports no receipt, so the
  // outcome is unknown and the explicit selection stays recoverable.
  await page.locator('#list-a [data-ui-tool="wishlist"]').click();
  const [lost] = await toolRequests(page);
  await failTool(page, lost!.id, 'Failed to fetch');
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveAttribute(
    'data-ui-outcome-status',
    'unknown',
  );
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveText(
    'The outcome is unknown; recover the recorded operation outcome.',
  );
  expect(await state(page, 'a')).toMatchObject({ selection: ['copy:1'] });

  // An unreadable answer carries no receipt either.
  await page.locator('#list-a [data-ui-tool="wishlist"]').click();
  const unreadable = (await toolRequests(page))[1]!;
  await settleTool(page, unreadable.id, { status: 'weird' } as unknown as UiOperationOutcome);
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveAttribute(
    'data-ui-outcome-status',
    'unknown',
  );

  // The operation's own report of a failure still stays a definite failure.
  await page.locator('#list-a [data-ui-tool="wishlist"]').click();
  const failed = (await toolRequests(page))[2]!;
  await settleTool(page, failed.id, { status: 'failed', message: 'The card was not saved.' });
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveAttribute(
    'data-ui-outcome-status',
    'failed',
  );
  await expect(page.locator('#list-a [data-ui-outcome]')).toHaveText('The card was not saved.');
});

for (const selectedCount of [500, 475]) {
  test(`keeps every new page accessible with ${selectedCount} selected entries`, async ({
    page,
  }) => {
    await openLists(page);
    await install(page, 'a', {
      pageSize: 100,
      fragments: ['tools', 'images'],
      tools: [{ id: 'move', label: 'Move copies' }],
    });
    const loaded: UiListEntry[] = [];
    for (let number = 0; number < 7; number += 1) {
      if (number > 0) {
        await page.locator('#list-a [data-ui-more]').click();
      }
      const request = (await pageRequests(page)).at(-1)!;
      const next = Array.from({ length: 100 }, (_, index) =>
        copy(String(number * 100 + index + 1), 'printing-1'),
      );
      loaded.push(...next);
      await settlePage(page, request.id, next, number < 6 ? `more-${number}` : null);
      await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(
        Math.min(loaded.length, UI_LIMITS.listWindow),
      );
      expect((await state(page, 'a')).entries).toEqual(
        loaded.slice(-UI_LIMITS.listWindow).map((entry) => entry.key),
      );
      if (selectedCount === 475) {
        const toolsRead = (await fragmentRequests(page))
          .filter((read) => read.kind === 'tools')
          .at(-1)!;
        await settleFragment(
          page,
          toolsRead.id,
          toolsRead.keys.map((key) => ({
            key,
            status: 'ready',
            values: ['move'],
          })),
        );
      }
      if (number === 4) {
        await page.locator('#list-a [data-ui-group-select]').check();
        await page.evaluate((count) => {
          const control = (globalThis as unknown as GlobalControl).keeperCardListControl;
          for (let index = count + 1; index <= 500; index += 1) {
            control.setSelected('a', `copy:${index}`, false);
          }
        }, selectedCount);
      }
      if (number >= 4) {
        expect((await state(page, 'a')).selection).toEqual(
          loaded.slice(0, selectedCount).map((entry) => entry.key),
        );
      }
    }
    if (selectedCount === 500) {
      // Availability is still needed for explicit selected targets after their rows retire.
      await expect(page.locator('#list-a [data-ui-tool="move"]')).toBeDisabled();
      const firstRead = (await fragmentRequests(page)).find((read) => read.kind === 'tools')!;
      expect(firstRead.aborted).toBe(false);
      await settleFragment(
        page,
        firstRead.id,
        firstRead.keys.map((key) =>
          key === 'copy:1'
            ? { key, status: 'failed', message: 'Availability unavailable' }
            : { key, status: 'ready', values: ['move'] },
        ),
      );
      const answered = new Set([firstRead.id]);
      let read;
      while (
        (read = (await fragmentRequests(page)).find(
          (candidate) =>
            candidate.kind === 'tools' && !candidate.aborted && !answered.has(candidate.id),
        ))
      ) {
        answered.add(read.id);
        await settleFragment(
          page,
          read.id,
          read.keys.map((key) => ({ key, status: 'ready', values: ['move'] })),
        );
      }
      // A failed retired entry still prevents an action on only a subset, and can be retried.
      await expect(page.locator('#list-a [data-ui-tool="move"]')).toBeDisabled();
      await reloadFragment(page, 'a', 'copy:1', 'tools');
      const retried = (await fragmentRequests(page)).at(-1)!;
      expect(retried.keys).toEqual(['copy:1']);
      await settleFragment(page, retried.id, [
        { key: 'copy:1', status: 'ready', values: ['move'] },
      ]);
    }
    expect((await state(page, 'a')).hasMore).toBe(false);
    await page.locator('#list-a [data-ui-select="copy:700"]').check();
    await page.locator('#list-a [data-ui-tool="move"]').click();
    const invocation = (await toolRequests(page)).at(-1)!;
    const expected = [...loaded.slice(0, selectedCount).map((entry) => entry.key), 'copy:700'];
    expect(invocation.selection).toEqual(expected);
    expect(invocation.targets).toEqual(expected);
    await settleTool(page, invocation.id, { status: 'committed', message: null });
    expect(
      (await fragmentRequests(page)).every((read) => read.keys.length <= UI_LIMITS.fragmentBatch),
    ).toBe(true);

    // Evicted entries remain individually deselectable and clearing releases the whole selection.
    await page.evaluate(() => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.setSelected(
        'a',
        'copy:1',
        false,
      );
    });
    expect((await state(page, 'a')).selection).toEqual(expected.slice(1));
    await page.evaluate(() => {
      (globalThis as unknown as GlobalControl).keeperCardListControl.clearSelection('a');
    });
    expect((await state(page, 'a')).selection).toEqual([]);
    await expect(page.locator('#list-a [data-ui-tool="move"]')).toBeDisabled();
  });
}

test('keeps group focus on retained members when groups reorder or shrink', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', { pageSize: 4 });
  const a = [copy('1', 'printing-a'), copy('2', 'printing-a')];
  const b = [copy('3', 'printing-b'), copy('4', 'printing-b')];
  await settlePage(page, (await onlyRequest(page, 'a')).id, [...a, ...b]);
  const groupB = page
    .locator('#list-a [data-ui-group]')
    .filter({ has: page.locator('[data-ui-entry="copy:3"]') })
    .locator('[data-ui-group-select]');
  await groupB.focus();
  await refine(page, 'a', 'reordered');
  await settlePage(page, (await pageRequests(page)).at(-1)!.id, [b[1]!, b[0]!, ...a]);
  await expect(groupB).toBeFocused();
  await page.keyboard.press('Space');
  expect((await state(page, 'a')).selection).toEqual(['copy:4', 'copy:3']);

  // A disappearing first member must not redirect focus to the group now occupying its position.
  await refresh(page, 'a');
  await settlePage(page, (await pageRequests(page)).at(-1)!.id, [...a, b[0]!]);
  await expect(page.locator('#list-a [data-ui-select="copy:3"]')).toBeFocused();
});

for (const kind of ['images', 'ownership', 'tags', 'tools'] as const) {
  test(`keeps a retried ${kind} slot focused through window updates`, async ({ page }) => {
    await openLists(page);
    await install(page, 'a', { pageSize: 2, fragments: [kind] });
    const entry = copy('1', 'printing-1');
    await settlePage(page, (await onlyRequest(page, 'a')).id, [entry], 'more');
    await failFragment(page, (await fragmentRequests(page)).at(-1)!.id, 'Unavailable');
    const slot = page.locator(`#list-a [data-ui-entry="copy:1"] [data-ui-fragment="${kind}"]`);
    await slot.locator('[data-ui-fragment-retry]').click();
    await expect(slot).toBeFocused();
    await refresh(page, 'a');
    await settlePage(page, (await pageRequests(page)).at(-1)!.id, [entry], 'more');
    await expect(slot).toBeFocused();
    await page.locator('#list-a [data-ui-more]').click();
    await slot.focus();
    await settlePage(page, (await pageRequests(page)).at(-1)!.id, [copy('2', 'printing-2')]);
    await expect(slot).toBeFocused();
    const pending = (await fragmentRequests(page)).findLast((read) =>
      read.keys.includes(entry.key),
    )!;
    await settleFragment(page, pending.id, absent(pending.keys));
    await expect(slot).toBeFocused();
    await refine(page, 'a', 'retained');
    await settlePage(page, (await pageRequests(page)).at(-1)!.id, [entry]);
    await expect(slot).toBeFocused();
  });
}

test('retires selected tool reads when a replacement result arrives', async ({ page }) => {
  await openLists(page);
  await install(page, 'a', {
    pageSize: 100,
    fragments: ['tools'],
    tools: [{ id: 'move', label: 'Move copies' }],
  });
  for (let number = 0; number < 6; number += 1) {
    if (number > 0) {
      await page.locator('#list-a [data-ui-more]').click();
    }
    await settlePage(
      page,
      (await pageRequests(page)).at(-1)!.id,
      Array.from({ length: 100 }, (_, index) =>
        copy(String(number * 100 + index + 1), 'printing-1'),
      ),
      `more-${number}`,
    );
    if (number === 0) {
      await page.locator('#list-a [data-ui-group-select]').check();
    }
  }
  expect((await state(page, 'a')).selection).toEqual(
    Array.from({ length: 100 }, (_, index) => `copy:${index + 1}`),
  );
  const oldRead = (await fragmentRequests(page)).findLast((read) => read.keys.includes('copy:1'))!;
  expect(oldRead.aborted).toBe(false);
  await refine(page, 'a', 'corrected');
  await settlePage(page, (await pageRequests(page)).at(-1)!.id, [copy('1', 'corrected-printing')]);
  expect((await state(page, 'a')).selection).toEqual(['copy:1']);
  expect((await fragmentRequests(page)).find((read) => read.id === oldRead.id)!.aborted).toBe(true);
  const freshRead = (await fragmentRequests(page)).at(-1)!;
  expect(freshRead.keys).toEqual(['copy:1']);
  await settleFragment(
    page,
    oldRead.id,
    oldRead.keys.map((key) => ({ key, status: 'ready', values: ['move'] })),
  );
  await expect(page.locator('#list-a [data-ui-tool="move"]')).toBeDisabled();
  await settleFragment(page, freshRead.id, [{ key: 'copy:1', status: 'ready', values: ['move'] }]);
  // The other selected targets are unavailable in the replacement result. Fresh availability for
  // one entry cannot authorize a subset of the selection: the user must explicitly change it.
  await expect(page.locator('#list-a [data-ui-tool="move"]')).toBeDisabled();
  expect((await capture(page, 'a')).selection).toHaveLength(100);
  expect(
    await page.evaluate(() =>
      (globalThis as unknown as GlobalControl).keeperCardListControl.invoke('a', 'move'),
    ),
  ).toBeNull();
  await page.evaluate(() => {
    (globalThis as unknown as GlobalControl).keeperCardListControl.clearSelection('a');
  });
  await page.locator('#list-a [data-ui-select="copy:1"]').check();
  await page.locator('#list-a [data-ui-tool="move"]').click();
  expect((await toolRequests(page)).at(-1)).toMatchObject({
    selection: ['copy:1'],
    targets: ['copy:1'],
  });
});

test('restores the retained window, selection and local focus from its own source position', async ({
  page,
}) => {
  const errors = await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 2,
      position: { continuation: 'cursor-1', offset: 0 },
      selection: ['card:2'],
      selectedTargets: [],
      scrollTop: 0,
      focus: { control: 'select', key: 'card:2' },
    },
  });

  // The list resumes the retained position instead of starting the result again, and it keeps the
  // window it is restoring while the source has not presented it.
  const restored = await onlyRequest(page, 'a');
  expect(restored).toMatchObject({ continuation: 'cursor-1', aborted: false });
  expect(await restoration(page, 'a')).toEqual({ status: 'pending', message: null });
  expect(await capture(page, 'a')).toEqual({
    context: 'result',
    window: 2,
    position: { continuation: 'cursor-1', offset: 0 },
    selection: ['card:2'],
    selectedTargets: [],
    scrollTop: 0,
    focus: { control: 'select', key: 'card:2' },
  });

  await settlePage(page, restored.id, [card('1'), card('2')]);

  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(2);
  await expect(page.locator('#list-a [data-ui-select="card:2"]')).toBeChecked();
  await expect(page.locator('#list-a [data-ui-select="card:2"]')).toBeFocused();
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(await capture(page, 'a')).toMatchObject({
    window: 2,
    position: { continuation: 'cursor-1', offset: 0 },
    selection: ['card:2'],
  });
  expect(errors).toEqual([]);
});

test('presents a restored window only once its further pages are back', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', {
    pageSize: 3,
    restored: {
      context: 'result',
      window: 3,
      position: { continuation: null, offset: 1 },
      selection: [],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });

  // The retained window starts inside its first page, so the entries before the position leave.
  const first = await onlyRequest(page, 'a');
  expect(first).toMatchObject({ continuation: null });
  await settlePage(page, first.id, [card('0'), card('1'), card('2')], 'next');

  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(2);
  expect(await restoration(page, 'a')).toEqual({ status: 'pending', message: null });
  await expect(page.locator('#list-a [data-ui-more]')).toBeHidden();

  // The list asks for the next page of the retained position itself and reports the presentation
  // only when the window the history entry held is back.
  const requests = await pageRequests(page);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ continuation: 'next', aborted: false });
  await settlePage(page, requests[1]!.id, [card('3'), card('4')]);

  expect(await state(page, 'a')).toMatchObject({
    entries: ['card:1', 'card:2', 'card:3', 'card:4'],
    loading: false,
    error: null,
  });
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(errors).toEqual([]);
});

test('keeps the intended state through repeated interruption, with the edits beside it', async ({
  page,
}) => {
  const errors = await openLists(page);
  const retained: UiCardListRetainedState = {
    context: 'result',
    window: 4,
    position: { continuation: 'cursor-2', offset: 1 },
    selection: ['card:0', 'card:1'],
    selectedTargets: [],
    scrollTop: 0,
    focus: null,
  };
  await install(page, 'a', { pageSize: 2, restored: retained });

  // The first page of the restoration arrives and the second is still loading when the user edits
  // the selection, which supersedes only the state it affects.
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [card('0'), card('2')], 'cursor-3');
  await page.evaluate(() => {
    const control = (globalThis as unknown as GlobalControl).keeperCardListControl;
    control.setSelected('a', 'card:0', false);
    control.setSelected('a', 'card:9', true);
  });
  await expect.poll(async () => (await capture(page, 'a')).selection).toEqual(['card:1', 'card:9']);

  // Leaving during the second page keeps the intended window, not the partial one.
  const captured = await capture(page, 'a');
  expect(captured).toMatchObject({
    window: 4,
    position: { continuation: 'cursor-2', offset: 1 },
  });
  await close(page, 'a');
  await expect.poll(() => restoration(page, 'a')).toMatchObject({ status: 'interrupted' });

  // The next visit resumes the same position and keeps the selection outside the loaded window.
  await install(page, 'a', { pageSize: 2, restored: captured });
  const resumed = await lastRequest(page, 'a');
  expect(resumed.continuation).toBe('cursor-2');
  await settlePage(page, resumed.id, [card('0'), card('2')], 'cursor-3');
  const continued = await lastRequest(page, 'a');
  expect(continued.continuation).toBe('cursor-3');
  await settlePage(page, continued.id, [card('3'), card('4')]);
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(await capture(page, 'a')).toMatchObject({ selection: ['card:1', 'card:9'] });
  expect(errors).toEqual([]);
});

test('restarts an invalidated continuation and keeps the usable window and selection', async ({
  page,
}) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 2 });
  await settlePage(page, (await onlyRequest(page, 'a')).id, [card('1'), card('2')], 'next');
  await page.locator('#list-a [data-ui-select="card:1"]').check();

  // The further page belongs to a sequence the source no longer accepts.
  await page.locator('#list-a [data-ui-more]').click();
  const continued = await lastRequest(page, 'a');
  expect(continued).toMatchObject({ continuation: 'next', aborted: false });
  await invalidatePage(page, continued.id);

  // The list asks again from the beginning of the sequence, never with the rejected continuation,
  // and the presented window and its selection stay until the replacement arrives.
  const restarted = await lastRequest(page, 'a');
  expect(restarted).toMatchObject({ continuation: null, aborted: false });
  expect(restarted.id).not.toBe(continued.id);
  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(2);
  await expect(page.locator('#list-a [data-ui-select="card:1"]')).toBeChecked();
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('');
  const requests = await pageRequests(page);
  expect(requests).toHaveLength(3);
  expect(requests[1]).toMatchObject({ id: continued.id, continuation: 'next', aborted: false });

  await settlePage(page, restarted.id, [card('1'), card('3')], 'restarted-next');
  await expect(page.locator('#list-a [data-ui-entry="card:3"]')).toBeVisible();
  await expect(page.locator('#list-a [data-ui-entry="card:2"]')).toHaveCount(0);
  await expect(page.locator('#list-a [data-ui-select="card:1"]')).toBeChecked();
  expect(await state(page, 'a')).toMatchObject({
    entries: ['card:1', 'card:3'],
    selection: ['card:1'],
    hasMore: true,
    error: null,
  });
  expect(errors).toEqual([]);
});

test('a failed restart stays recoverable at the sequence it restarted', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 2 });
  await settlePage(page, (await onlyRequest(page, 'a')).id, [card('1'), card('2')], 'next');
  await page.locator('#list-a [data-ui-more]').click();
  const continued = await lastRequest(page, 'a');
  await invalidatePage(page, continued.id);
  const restarted = await lastRequest(page, 'a');
  await failPage(page, restarted.id, 'Results unavailable');

  // The window stays usable and the failure is reported; the retry control repeats the restart's
  // own first page instead of the continuation the source rejected.
  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(2);
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('Results unavailable');
  await expect(page.locator('#list-a [data-ui-retry]')).toBeVisible();
  expect(await state(page, 'a')).toMatchObject({ error: 'Results unavailable', loading: false });

  await page.locator('#list-a [data-ui-retry]').click();
  const retried = await lastRequest(page, 'a');
  expect(retried).toMatchObject({ continuation: null, aborted: false });
  await settlePage(page, retried.id, [card('3'), card('4')]);
  await expect(page.locator('#list-a [data-ui-entry="card:3"]')).toBeVisible();
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('');
  expect(await state(page, 'a')).toMatchObject({ entries: ['card:3', 'card:4'], error: null });
  expect(errors).toEqual([]);
});

test('reports an invalidated first page instead of restarting in a loop', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 2 });
  const first = await onlyRequest(page, 'a');
  await invalidatePage(page, first.id);

  // There is no earlier position to restart from, so the list reports the failure once and waits
  // for the retry control instead of asking again by itself.
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText(
    'The list changed while it was read.',
  );
  await expect(page.locator('#list-a [data-ui-retry]')).toBeVisible();
  expect(await pageRequests(page)).toHaveLength(1);

  await page.locator('#list-a [data-ui-retry]').click();
  const retried = await lastRequest(page, 'a');
  expect(retried).toMatchObject({ continuation: null, aborted: false });
  await settlePage(page, retried.id, [card('1')]);
  await expect(page.locator('#list-a [data-ui-entry="card:1"]')).toBeVisible();
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('');
  expect(errors).toEqual([]);
});

test('reports a failed restoration, retries the retained position and starts fresh on refresh', async ({
  page,
}) => {
  await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 2,
      position: { continuation: 'stale', offset: 0 },
      selection: ['card:5'],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });

  const first = await onlyRequest(page, 'a');
  await failPage(page, first.id, 'Results changed; refresh.');
  await expect(page.locator('#list-a [data-ui-status]')).toHaveText('Results changed; refresh.');
  // The interruption is reported, and the intended window stays retained for the next visit.
  expect(await restoration(page, 'a')).toEqual({
    status: 'interrupted',
    message: 'Results changed; refresh.',
  });
  expect(await capture(page, 'a')).toMatchObject({
    window: 2,
    position: { continuation: 'stale', offset: 0 },
    selection: ['card:5'],
  });

  await page.locator('#list-a [data-ui-retry]').click();
  const retried = (await pageRequests(page)).at(-1)!;
  expect(retried).toMatchObject({ continuation: 'stale', aborted: false });
  await settlePage(page, retried.id, [card('5'), card('6')]);
  // The retry is this visit's own request again: the interruption stays reported and what the
  // source supplies now becomes the loaded window.
  expect(await restoration(page, 'a')).toEqual({
    status: 'interrupted',
    message: 'Results changed; refresh.',
  });
  await expect(page.locator('#list-a [data-ui-select="card:5"]')).toBeChecked();

  // Refresh supersedes the retained window: the result starts at its beginning and the page learns
  // that the restoration ended without presenting it.
  await close(page, 'a');
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 2,
      position: { continuation: 'stale', offset: 0 },
      selection: [],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });
  await refresh(page, 'a');
  const fresh = await lastRequest(page, 'a');
  expect(fresh).toMatchObject({ continuation: null, aborted: false });
  await expect.poll(() => restoration(page, 'a')).toMatchObject({ status: 'interrupted' });
  await settlePage(page, fresh.id, [card('1'), card('2')]);
  expect(await state(page, 'a')).toMatchObject({ entries: ['card:1', 'card:2'], error: null });
});

test('restarts a retained window whose continuation was invalidated', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 2,
      position: { continuation: 'stale', offset: 0 },
      selection: ['card:9'],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });
  const first = await onlyRequest(page, 'a');
  expect(first).toMatchObject({ continuation: 'stale' });
  await invalidatePage(page, first.id);

  // The rejected position is not asked for again: the list reacquires the window it intended from
  // the beginning of the sequence it was told to restart.
  const restarted = await lastRequest(page, 'a');
  expect(restarted).toMatchObject({ continuation: null, aborted: false });
  await settlePage(page, restarted.id, [card('1'), card('2')], 'next');
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(await capture(page, 'a')).toMatchObject({
    window: 2,
    position: { continuation: null, offset: 0 },
    selection: ['card:9'],
  });
  expect(errors).toEqual([]);
});

test('leaves no rejected continuation in the state captured during a pending restart', async ({
  page,
}) => {
  const errors = await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 2,
      position: { continuation: 'stale', offset: 0 },
      selection: ['card:9'],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });
  const first = await onlyRequest(page, 'a');
  await invalidatePage(page, first.id);

  // The restart is still loading away from the retained window; the state a leaving page captures
  // names the replacement sequence's beginning instead of the continuation the source rejected,
  // while the intended window size and the selection stay.
  const captured = await capture(page, 'a');
  expect(captured).toMatchObject({
    window: 2,
    position: { continuation: null, offset: 0 },
    selection: ['card:9'],
  });
  await close(page, 'a');
  await expect.poll(() => restoration(page, 'a')).toMatchObject({ status: 'interrupted' });

  // The next visit restarts the sequence instead of repeating the rejected request.
  await install(page, 'a', { pageSize: 2, restored: captured });
  const visited = await lastRequest(page, 'a');
  expect(visited).toMatchObject({ continuation: null, aborted: false });
  await settlePage(page, visited.id, [card('1'), card('2')]);
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(await state(page, 'a')).toMatchObject({ entries: ['card:1', 'card:2'], error: null });
  expect(errors).toEqual([]);
});

test('leaves no rejected continuation in the state captured after a failed restart', async ({
  page,
}) => {
  const errors = await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 2,
      position: { continuation: 'stale', offset: 0 },
      selection: ['card:9'],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });
  const first = await onlyRequest(page, 'a');
  await invalidatePage(page, first.id);
  const restarted = await lastRequest(page, 'a');
  await failPage(page, restarted.id, 'Results unavailable');

  // The failed restart stays recoverable: the retry control repeats the beginning of the sequence,
  // and the captured state never sends the next visit back to the rejected continuation.
  const captured = await capture(page, 'a');
  expect(captured).toMatchObject({
    window: 2,
    position: { continuation: null, offset: 0 },
    selection: ['card:9'],
  });
  await close(page, 'a');
  await install(page, 'a', { pageSize: 2, restored: captured });
  const visited = await lastRequest(page, 'a');
  expect(visited).toMatchObject({ continuation: null, aborted: false });
  await settlePage(page, visited.id, [card('3'), card('4')]);
  expect(await state(page, 'a')).toMatchObject({ entries: ['card:3', 'card:4'], error: null });
  expect(errors).toEqual([]);
});

test('leaves no rejected position in the state captured after ordinary pagination', async ({
  page,
}) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 100 });
  for (let index = 0; index < 6; index += 1) {
    await settlePage(
      page,
      (await lastRequest(page, 'a')).id,
      Array.from({ length: 100 }, (_, offset) => card(String(index * 100 + offset))),
      `page-${index + 1}`,
    );
    if (index < 5) {
      await page.locator('#list-a [data-ui-more]').click();
    }
  }

  // The window bound retired the first page, so the entry it presents first sits on a later page of
  // its own sequence.
  const capturedBefore = await capture(page, 'a');
  expect(capturedBefore).toMatchObject({
    window: 500,
    position: { continuation: 'page-1', offset: 0 },
  });

  await page.locator('#list-a [data-ui-more]').click();
  const continued = await lastRequest(page, 'a');
  expect(continued).toMatchObject({ continuation: 'page-6' });
  await invalidatePage(page, continued.id);

  // The rejected sequence is not capturable, so leaving during the restart cannot ask the next visit
  // for a position of the sequence the source refused; the usable window stays.
  const captured = await capture(page, 'a');
  expect(captured).toMatchObject({
    window: 500,
    position: { continuation: null, offset: 0 },
  });
  await expect(page.locator('#list-a [data-ui-entry]')).toHaveCount(500);
  await close(page, 'a');

  // The next visit reads the sequence from its beginning instead of repeating a page of the
  // sequence the source invalidated.
  await install(page, 'a', { pageSize: 100, restored: captured });
  const visited = await lastRequest(page, 'a');
  expect(visited).toMatchObject({ continuation: null, aborted: false });
  await settlePage(
    page,
    visited.id,
    Array.from({ length: 100 }, (_, offset) => card(String(offset))),
    'fresh-1',
  );
  await expect(page.locator('#list-a [data-ui-entry="card:0"]')).toBeVisible();
  const reread = await lastRequest(page, 'a');
  expect(reread).toMatchObject({ continuation: 'fresh-1', aborted: false });
  expect((await state(page, 'a')).error).toBeNull();
  expect(errors).toEqual([]);
});

test('reacquires the retained window when its later page is invalidated', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 4,
      position: { continuation: null, offset: 0 },
      selection: [],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });
  const first = await onlyRequest(page, 'a');
  await settlePage(page, first.id, [card('1'), card('2')], 'next');

  // The second page of the restoration belongs to a sequence the source refuses.
  const continued = await lastRequest(page, 'a');
  expect(continued).toMatchObject({ continuation: 'next' });
  await invalidatePage(page, continued.id);

  // The replacement sequence starts over with two entries; the retained window is not back yet, so
  // the list keeps acquiring it instead of reporting a window of half its intended size.
  const restarted = await lastRequest(page, 'a');
  expect(restarted).toMatchObject({ continuation: null, aborted: false });
  await settlePage(page, restarted.id, [card('1'), card('2')], 'restarted-next');
  expect(await restoration(page, 'a')).toEqual({ status: 'pending', message: null });

  const resumed = await lastRequest(page, 'a');
  expect(resumed).toMatchObject({ continuation: 'restarted-next', aborted: false });
  await settlePage(page, resumed.id, [card('3'), card('4')]);
  expect(await state(page, 'a')).toMatchObject({
    entries: ['card:1', 'card:2', 'card:3', 'card:4'],
    loading: false,
    error: null,
  });
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(errors).toEqual([]);
});

test('keeps more than a hundred selected identities across visits', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 100 });
  await settlePage(
    page,
    (await onlyRequest(page, 'a')).id,
    Array.from({ length: 100 }, (_, index) => card(String(index))),
    'next',
  );

  // The user selects more identities than any former history bound held, including entries the
  // source has not loaded yet; none of them is dropped by the state a history entry retains.
  await page.evaluate(() => {
    const control = (globalThis as unknown as GlobalControl).keeperCardListControl;
    for (let index = 0; index < 150; index += 1) {
      control.setSelected('a', `card:${index}`, true);
    }
  });
  const captured = await capture(page, 'a');
  expect(captured.window).toBe(100);
  expect(captured.selection).toHaveLength(150);

  await close(page, 'a');
  await install(page, 'a', { pageSize: 100, restored: captured });
  await settlePage(
    page,
    (await lastRequest(page, 'a')).id,
    Array.from({ length: 100 }, (_, index) => card(String(index))),
    'next',
  );

  await expect(page.locator('#list-a [data-ui-select="card:0"]')).toBeChecked();
  await expect(page.locator('#list-a [data-ui-select="card:99"]')).toBeChecked();
  expect((await capture(page, 'a')).selection).toHaveLength(150);
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(errors).toEqual([]);
});

test("restores the list's own scroll and focus with its window", async ({ page }) => {
  const errors = await openLists(page);
  const entries = Array.from({ length: 6 }, (_, index) => card(String(index)));
  await install(page, 'a', { pageSize: 6, scrollable: true });
  await settlePage(page, (await onlyRequest(page, 'a')).id, entries);

  const last = page.locator('#list-a [data-ui-select="card:5"]');
  await last.focus();
  await page.evaluate(() => {
    document.getElementById('list-a')!.scrollTop = 30;
  });
  const captured = await capture(page, 'a');
  expect(captured.focus).toEqual({ control: 'select', key: 'card:5' });
  expect(captured.scrollTop).toBe(30);

  await close(page, 'a');
  await install(page, 'a', { pageSize: 6, scrollable: true, restored: captured });
  await expect.poll(() => restoration(page, 'a')).toMatchObject({ status: 'pending' });
  await settlePage(page, (await lastRequest(page, 'a')).id, entries);

  await expect(last).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.getElementById('list-a')!.scrollTop))
    .toBe(30);
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(errors).toEqual([]);
});

test('keeps a control the page rendered for an entry focused through window updates', async ({
  page,
}) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 2, openEntry: true });
  await settlePage(page, (await onlyRequest(page, 'a')).id, [card('1'), card('2')], 'next');

  const opened = page.locator('#list-a [id="open-card:1"]');
  await opened.focus();
  // The page extends the window while the entry's own control keeps the keyboard focus.
  await page.evaluate(() => {
    (globalThis as unknown as GlobalControl).keeperCardListControl.loadMore('a');
  });
  await settlePage(page, (await lastRequest(page, 'a')).id, [card('3')]);

  // The page rendered the entry's own control; the list keeps that focus through its re-rendering
  // and retains the control by the stable id the page gave it.
  await expect(page.locator('#list-a [id="open-card:1"]')).toBeFocused();
  const captured = await capture(page, 'a');
  expect(captured.focus).toEqual({ control: 'element', id: 'open-card:1' });

  await close(page, 'a');
  await install(page, 'a', { pageSize: 3, openEntry: true, restored: captured });
  await settlePage(page, (await lastRequest(page, 'a')).id, [card('1'), card('2'), card('3')]);
  await expect(page.locator('#list-a [id="open-card:1"]')).toBeFocused();
  expect(errors).toEqual([]);
});

/** Card entries one page holds, starting at `from`, as the controlled source supplies them. */
function cards(from: number, count: number): readonly UiListEntry[] {
  return Array.from({ length: count }, (_, index) => card(String(from + index)));
}

/**
 * Answers every tool-availability read one list recorded and this journey has not answered. The
 * reads a settlement may queue further batches of, so the journey answers until the list stopped
 * asking.
 */
async function answerToolReads(page: Page, list: string, answered: Set<number>): Promise<void> {
  for (;;) {
    const waiting = (await fragmentRequests(page)).filter(
      (read) => read.list === list && !answered.has(read.id),
    );
    if (waiting.length === 0) {
      return;
    }
    for (const read of waiting) {
      answered.add(read.id);
      await settleFragment(
        page,
        read.id,
        read.keys.map((key) => ({ key, status: 'ready' as const, values: ['move'] })),
      );
    }
  }
}

test('restores the typed targets of the selection its retained window retired', async ({
  page,
}) => {
  const errors = await openLists(page);
  const tool = { id: 'move', label: 'Move copies' };
  const answered = new Set<number>();
  await install(page, 'a', { pageSize: 100, fragments: ['tools'], tools: [tool] });

  // Six pages fill more than the bounded window, so the first hundred entries leave it; the first
  // entry is selected before paging retires it.
  for (let number = 0; number < 6; number += 1) {
    if (number > 0) {
      await page.locator('#list-a [data-ui-more]').click();
    }
    await settlePage(
      page,
      (await lastRequest(page, 'a')).id,
      cards(number * 100, 100),
      number === 5 ? null : `more-${number}`,
    );
    if (number === 0) {
      await page.evaluate(() => {
        const control = (globalThis as unknown as GlobalControl).keeperCardListControl;
        control.setSelected('a', 'card:0', true);
      });
    }
    await answerToolReads(page, 'a', answered);
  }
  await page.evaluate(() => {
    const control = (globalThis as unknown as GlobalControl).keeperCardListControl;
    control.setSelected('a', 'card:599', true);
  });

  // The state names the explicit selection and the typed target the window no longer presents.
  const captured = await capture(page, 'a');
  expect(captured.selection).toEqual(['card:0', 'card:599']);
  expect(captured.selectedTargets).toEqual([
    { key: 'card:0', target: { kind: 'card', cardId: '0' } },
  ]);
  await close(page, 'a');

  // The next visit re-acquires the retained window from the position it held.
  const recorded = (await fragmentRequests(page)).length;
  await install(page, 'a', {
    pageSize: 100,
    fragments: ['tools'],
    tools: [tool],
    restored: captured,
  });
  expect(await restoration(page, 'a')).toEqual({ status: 'pending', message: null });
  for (let number = 1; number < 6; number += 1) {
    await settlePage(
      page,
      (await lastRequest(page, 'a')).id,
      cards(number * 100, 100),
      number === 5 ? null : `more-${number}`,
    );
  }
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect(await state(page, 'a')).toMatchObject({ selection: ['card:0', 'card:599'] });
  expect(await capture(page, 'a')).toMatchObject({
    selection: ['card:0', 'card:599'],
    selectedTargets: [{ key: 'card:0', target: { kind: 'card', cardId: '0' } }],
  });

  // Tool availability is read again for the retired target, exactly as for a presented entry.
  await expect(page.locator('#list-a [data-ui-tool="move"]')).toBeDisabled();
  await answerToolReads(page, 'a', answered);
  expect(
    (await fragmentRequests(page))
      .slice(recorded)
      .some((read) => read.kind === 'tools' && read.keys.includes('card:0')),
  ).toBe(true);
  await expect(page.locator('#list-a [data-ui-tool="move"]')).toBeEnabled();

  // The invocation acts on the explicit selection across the restored window, targets included.
  await page.locator('#list-a [data-ui-tool="move"]').click();
  expect((await toolRequests(page)).at(-1)).toMatchObject({
    selection: ['card:0', 'card:599'],
    targets: ['card:0', 'card:599'],
  });
  expect(errors).toEqual([]);
});

test('offers the further results of a restored window once it presented it', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', {
    pageSize: 2,
    restored: {
      context: 'result',
      window: 2,
      position: { continuation: null, offset: 0 },
      selection: [],
      selectedTargets: [],
      scrollTop: 0,
      focus: null,
    },
  });

  await settlePage(page, (await onlyRequest(page, 'a')).id, [card('1'), card('2')], 'next');

  // The restored window is back, so the list offers the further results of the same query again.
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });
  expect((await state(page, 'a')).hasMore).toBe(true);
  await expect(page.locator('#list-a [data-ui-more]')).toBeVisible();
  await page.locator('#list-a [data-ui-more]').click();

  const following = await lastRequest(page, 'a');
  expect(following).toMatchObject({ continuation: 'next', aborted: false });
  await settlePage(page, following.id, [card('3')]);
  expect((await state(page, 'a')).entries).toEqual(['card:1', 'card:2', 'card:3']);
  expect(errors).toEqual([]);
});

test('replaces the source position of the entries a replacement result reorders', async ({
  page,
}) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 2 });
  await settlePage(page, (await onlyRequest(page, 'a')).id, [card('1'), card('2')], 'next');

  // The refreshed result still holds an entry the previous result held elsewhere: the source owns
  // the ordering, so the retained position follows the entry the window starts with now.
  await refresh(page, 'a');
  await settlePage(page, (await lastRequest(page, 'a')).id, [card('2'), card('3')]);
  const refreshed = await capture(page, 'a');
  expect(refreshed).toMatchObject({ position: { continuation: null, offset: 0 }, window: 2 });

  await close(page, 'a');
  await install(page, 'a', { pageSize: 2, restored: refreshed });
  await settlePage(page, (await lastRequest(page, 'a')).id, [card('2'), card('3')]);
  expect((await state(page, 'a')).entries).toEqual(['card:2', 'card:3']);
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });

  // A refinement replaces the positions the same way, and the state names the refined query.
  await refine(page, 'a', 'corrected');
  await settlePage(page, (await lastRequest(page, 'a')).id, [card('3'), card('2')]);
  const refined = await capture(page, 'a');
  expect(refined).toMatchObject({
    context: 'corrected',
    position: { continuation: null, offset: 0 },
    window: 2,
  });

  await close(page, 'a');
  await install(page, 'a', { pageSize: 2, restored: refined });
  const resumed = await lastRequest(page, 'a');
  expect(resumed).toMatchObject({ context: 'corrected', continuation: null });
  await settlePage(page, resumed.id, [card('3'), card('2')]);
  expect((await state(page, 'a')).entries).toEqual(['card:3', 'card:2']);
  expect(errors).toEqual([]);
});

test('keeps the interaction the user made while a delayed restoration loads', async ({ page }) => {
  const errors = await openLists(page);
  const entries = cards(0, 6);
  await page.evaluate(() => {
    const draft = document.createElement('input');
    draft.id = 'draft';
    draft.setAttribute('aria-label', 'Draft');
    document.getElementById('root')!.prepend(draft);
  });
  const retained: UiCardListRetainedState = {
    context: 'result',
    window: 6,
    position: { continuation: null, offset: 0 },
    selection: [],
    selectedTargets: [],
    scrollTop: 30,
    focus: { control: 'select', key: 'card:5' },
  };
  await install(page, 'a', { pageSize: 6, scrollable: true, restored: retained });
  await expect.poll(() => restoration(page, 'a')).toMatchObject({ status: 'pending' });

  // The user edits a draft beside the list while its window is still loading: the arriving window
  // must not move the focus the user chose or scroll the list under it.
  await page.locator('#draft').focus();
  await page.keyboard.type('draft');
  await settlePage(page, (await lastRequest(page, 'a')).id, entries);

  await expect.poll(() => restoration(page, 'a')).toMatchObject({ status: 'presented' });
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('draft');
  expect(await page.evaluate(() => document.getElementById('list-a')!.scrollTop)).toBe(0);
  expect(await capture(page, 'a')).toMatchObject({ focus: null, scrollTop: 0, window: 6 });

  // An interaction inside the list supersedes the retained interaction as well: the user's own
  // control keeps the focus while the rest of the retained window arrives.
  await close(page, 'a');
  await install(page, 'b', {
    pageSize: 2,
    scrollable: true,
    restored: { ...retained, window: 4, focus: { control: 'select', key: 'card:4' } },
  });
  await settlePage(page, (await lastRequest(page, 'b')).id, [card('1'), card('2')], 'next');
  await page.locator('#list-b [data-ui-select="card:1"]').click();
  await settlePage(page, (await lastRequest(page, 'b')).id, [card('3'), card('4')]);

  await expect.poll(() => restoration(page, 'b')).toMatchObject({ status: 'presented' });
  await expect(page.locator('#list-b [data-ui-select="card:1"]')).toBeFocused();
  expect(await page.evaluate(() => document.getElementById('list-b')!.scrollTop)).toBe(0);
  expect((await state(page, 'b')).entries).toEqual(['card:1', 'card:2', 'card:3', 'card:4']);
  expect(errors).toEqual([]);
});

test('keeps the intended window through a retry and finishes acquiring it', async ({ page }) => {
  const errors = await openLists(page);
  const retained: UiCardListRetainedState = {
    context: 'result',
    window: 4,
    position: { continuation: 'p3', offset: 1 },
    selection: ['card:9'],
    selectedTargets: [],
    scrollTop: 0,
    focus: null,
  };
  await install(page, 'a', { pageSize: 4, restored: retained });

  // The first request of the retained window fails; the intended window stays retained.
  const first = await onlyRequest(page, 'a');
  expect(first).toMatchObject({ continuation: 'p3' });
  await failPage(page, first.id, 'Results unavailable');
  expect(await capture(page, 'a')).toMatchObject({
    window: 4,
    position: { continuation: 'p3', offset: 1 },
  });

  // Retry repeats the failed request of the restoration, so the intended window stays retained
  // while it is pending and the source is asked for the same position again.
  await page.locator('#list-a [data-ui-retry]').click();
  const retried = await lastRequest(page, 'a');
  expect(retried).toMatchObject({ continuation: 'p3', aborted: false });
  expect(await capture(page, 'a')).toMatchObject({
    window: 4,
    position: { continuation: 'p3', offset: 1 },
  });

  // The recovered page resumes inside its own page, and the list keeps acquiring the retained
  // window instead of stopping at the partial one.
  await settlePage(page, retried.id, [card('0'), card('1'), card('2'), card('3')], 'p4');
  const continued = await lastRequest(page, 'a');
  expect(continued).toMatchObject({ continuation: 'p4', aborted: false });
  await settlePage(page, continued.id, [card('4')]);
  expect((await state(page, 'a')).entries).toEqual(['card:1', 'card:2', 'card:3', 'card:4']);
  expect(await restoration(page, 'a')).toEqual({
    status: 'interrupted',
    message: 'Results unavailable',
  });
  expect(await capture(page, 'a')).toMatchObject({
    window: 4,
    position: { continuation: 'p3', offset: 1 },
  });

  // A later page of the restoration fails as well: the retry continues from that page, never from
  // the beginning of the result, and the partial window is never captured.
  await close(page, 'a');
  await install(page, 'a', {
    pageSize: 4,
    restored: { ...retained, position: { continuation: 'p3', offset: 0 }, selection: [] },
  });
  await settlePage(page, (await lastRequest(page, 'a')).id, [card('1'), card('2')], 'p4');
  const later = await lastRequest(page, 'a');
  expect(later).toMatchObject({ continuation: 'p4' });
  await failPage(page, later.id, 'Results unavailable');
  expect(await capture(page, 'a')).toMatchObject({
    window: 4,
    position: { continuation: 'p3', offset: 0 },
  });

  await page.locator('#list-a [data-ui-retry]').click();
  const resumedPage = await lastRequest(page, 'a');
  expect(resumedPage).toMatchObject({ continuation: 'p4', aborted: false });
  await settlePage(page, resumedPage.id, [card('3'), card('4')]);
  expect((await state(page, 'a')).entries).toEqual(['card:1', 'card:2', 'card:3', 'card:4']);
  expect(await capture(page, 'a')).toMatchObject({
    window: 4,
    position: { continuation: 'p3', offset: 0 },
  });
  expect(errors).toEqual([]);
});

test('retains the query a refinement intends while its result is unavailable', async ({ page }) => {
  const errors = await openLists(page);
  await install(page, 'a', { pageSize: 2, context: 'old' });
  await settlePage(page, (await onlyRequest(page, 'a')).id, [card('1'), card('2')], 'old-page-3');
  expect((await capture(page, 'a')).context).toBe('old');

  // The user refines the query and leaves before the replacement arrives: the state names the
  // refined query and holds no position of the previous one.
  await refine(page, 'a', 'new');
  const pending = await capture(page, 'a');
  expect(pending).toMatchObject({ context: 'new', position: null, window: 0 });

  await close(page, 'a');
  await install(page, 'a', { pageSize: 2, context: 'stale', restored: pending });
  const started = await lastRequest(page, 'a');
  expect(started).toMatchObject({ context: 'new', continuation: null, aborted: false });
  await settlePage(page, started.id, [card('7'), card('8')], 'new-page-2');
  expect((await state(page, 'a')).entries).toEqual(['card:7', 'card:8']);

  // A completed refinement is retained with its own query and position, so the next visit restores
  // it without the page mirroring the list's query.
  const refined = await capture(page, 'a');
  expect(refined).toMatchObject({
    context: 'new',
    window: 2,
    position: { continuation: null, offset: 0 },
  });
  await close(page, 'a');
  await install(page, 'a', { pageSize: 2, context: 'stale', restored: refined });
  const resumed = await lastRequest(page, 'a');
  expect(resumed).toMatchObject({ context: 'new', continuation: null });
  await settlePage(page, resumed.id, [card('7'), card('8')], 'new-page-2');
  expect((await state(page, 'a')).entries).toEqual(['card:7', 'card:8']);
  expect(await restoration(page, 'a')).toEqual({ status: 'presented', message: null });

  // A refinement whose replacement never arrived keeps the refined query as well.
  await refine(page, 'a', 'other');
  const failed = await lastRequest(page, 'a');
  expect(failed).toMatchObject({ context: 'other', continuation: null });
  await failPage(page, failed.id, 'Search unavailable');
  expect(await capture(page, 'a')).toMatchObject({ context: 'other', position: null, window: 0 });
  expect(errors).toEqual([]);
});

for (const availability of [false, true]) {
  test(`partial restoration prevents subset invocation with availability ${availability}`, async ({
    page,
  }) => {
    const errors = await openLists(page);
    const options: UiCardListInstall = {
      pageSize: 2,
      tools: [{ id: 'move', label: 'Move' }],
      fragments: availability ? ['tools'] : [],
    };
    await install(page, 'a', options);
    await settlePage(page, (await lastRequest(page, 'a')).id, [card('1'), card('2')], 'next');
    await page.locator('#list-a [data-ui-more]').click();
    await settlePage(page, (await lastRequest(page, 'a')).id, [card('3'), card('4')]);
    await page.evaluate(() => {
      const control = (globalThis as unknown as GlobalControl).keeperCardListControl;
      control.setSelected('a', 'card:1', true);
      control.setSelected('a', 'card:4', true);
    });
    const retained = await capture(page, 'a');
    await close(page, 'a');
    const answered = new Set((await fragmentRequests(page)).map((read) => read.id));
    await install(page, 'a', { ...options, restored: retained });
    await settlePage(page, (await lastRequest(page, 'a')).id, [card('1'), card('2')], 'next');
    await answerToolReads(page, 'a', answered);
    expect((await capture(page, 'a')).selection).toEqual(['card:1', 'card:4']);
    const tool = page.locator('#list-a [data-ui-tool="move"]');
    await expect(tool).toBeDisabled();
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as GlobalControl).keeperCardListControl.invoke('a', 'move'),
      ),
    ).toBeNull();
    expect(await toolRequests(page)).toEqual([]);

    await failPage(page, (await lastRequest(page, 'a')).id, 'Unavailable');
    await expect(tool).toBeDisabled();
    expect(
      await page.evaluate(() =>
        (globalThis as unknown as GlobalControl).keeperCardListControl.invoke('a', 'move'),
      ),
    ).toBeNull();
    await page.locator('#list-a [data-ui-retry]').click();
    await settlePage(page, (await lastRequest(page, 'a')).id, [card('3'), card('4')]);
    if (availability) {
      await expect(tool).toBeDisabled();
      const read = (await fragmentRequests(page)).at(-1)!;
      await failFragment(page, read.id, 'Availability unavailable');
      await expect(tool).toBeDisabled();
      await reloadFragment(page, 'a', 'card:4', 'tools');
      answered.add(read.id);
      await answerToolReads(page, 'a', answered);
    }
    await expect(tool).toBeEnabled();
    await tool.click();
    expect((await toolRequests(page)).at(-1)).toMatchObject({
      selection: ['card:1', 'card:4'],
      targets: ['card:1', 'card:4'],
    });
    expect(errors).toEqual([]);
  });
}

for (const context of [null, undefined]) {
  test(`retains ${String(context)} query context through pending and completed refinement`, async ({
    page,
  }) => {
    const errors = await openLists(page);
    await install(page, 'a', { context: 'old' });
    await settlePage(page, (await lastRequest(page, 'a')).id, [card('1'), card('2')], 'old-next');
    await refine(page, 'a', context);
    const pending = await capture(page, 'a');
    expect(pending.context).toBe(context);
    expect(Object.hasOwn(pending, 'context')).toBe(true);
    await close(page, 'a');
    await install(page, 'a', { context: 'fallback', restored: pending });
    expect(await lastRequest(page, 'a')).toMatchObject({ context, continuation: null });
    await settlePage(page, (await lastRequest(page, 'a')).id, [card('3'), card('4')]);
    const completed = await capture(page, 'a');
    expect(completed.context).toBe(context);
    await close(page, 'a');
    await install(page, 'a', { context: 'fallback', restored: completed });
    expect(await lastRequest(page, 'a')).toMatchObject({ context, continuation: null });
    await settlePage(page, (await lastRequest(page, 'a')).id, [card('3'), card('4')]);
    expect(await restoration(page, 'a')).toMatchObject({ status: 'presented' });
    expect(errors).toEqual([]);
  });
}
