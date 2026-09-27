/**
 * Browser journeys: the Import page (docs/user-interface.md#capture-and-review,
 * docs/user-cards.md#import-and-capture-state, docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real shell with the real Import page and the controlled component access of
 * import.harness.ts and drive them in Chromium: a manual entry stages a catalog printing as a
 * pending line and only its confirmation creates copies, a reviewed entry exposes and corrects its
 * printing, finish, condition and quantity, an unresolved entry is resolved before confirmation, a
 * lost confirmation response is recovered through the recorded outcome of its operation, and
 * discarding ends pending membership without creating copies.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type { CardRecord, PrintingRecord } from '../../src/catalog/index.js';
import type { ImportEntry, ImportSession } from '../../src/usercards/index.js';
import type {
  UiImportControl,
  UiImportEntriesRequest,
  UiImportRequest,
  UiImportSessionsRequest,
} from './import.harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = path.join(repoRoot, 'tests', 'browser', 'import.harness.ts');
const importPageHtml = '<!doctype html><html><body><div id="ui-root"></div></body></html>';

let bundle: Promise<string> | null = null;

/** Bundles the Import page with the journey harness, as a deployment bundles the UI. */
function importBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({
      stdin: {
        contents: [
          `import { installImportHarness } from ${JSON.stringify(harnessPath)};`,
          "globalThis.keeperImportControl = installImportHarness(document.getElementById('ui-root'));",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'import-consumer.ts',
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

/** Serves a fresh document for the Import page, enters it at `hash` and loads the UI. */
async function openImport(page: Page, hash: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-import.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: importPageHtml }),
  );
  await page.goto(`http://keeper-import.test/${hash}`);
  await page.addScriptTag({ content: await importBundle(), type: 'module' });
  await page.waitForFunction(() => Reflect.has(globalThis, 'keeperImportControl'));
  return errors;
}

/** Calls one operation of the installed harness with the supplied arguments. */
async function control<Value>(
  page: Page,
  method: keyof UiImportControl,
  ...args: readonly unknown[]
): Promise<Value> {
  return page.evaluate(
    ({ name, values }) => {
      const target = (
        globalThis as unknown as {
          keeperImportControl: Record<string, (...parameters: readonly unknown[]) => unknown>;
        }
      ).keeperImportControl;
      return target[name as string]?.(...values) as unknown;
    },
    { name: method, values: args },
  ) as Promise<Value>;
}

/** Requests one operation recorded so far, waiting for it. */
async function requested<Arguments>(
  page: Page,
  method: keyof UiImportControl,
  index = 0,
): Promise<UiImportRequest<Arguments>> {
  await expect
    .poll(async () => (await control<readonly unknown[]>(page, method)).length)
    .toBeGreaterThan(index);
  const requests = await control<readonly UiImportRequest<Arguments>[]>(page, method);
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`The Import page did not issue ${String(method)} request ${index}.`);
  }
  return request;
}

async function settle<Value>(
  page: Page,
  method: keyof UiImportControl,
  id: number,
  value: Value,
): Promise<void> {
  await control(page, method, id, value);
}

/** Answers every catalog resolve of the journey from this table, like the provider the page reads. */
async function scriptCatalog(
  page: Page,
  records: Parameters<UiImportControl['settleCatalog']>[1],
): Promise<void> {
  await control(page, 'scriptCatalog', records);
}

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

const m11: PrintingRecord = {
  printingId: 'printing-m11-149-en',
  cardId: 'card-bolt',
  edition: 'M11',
  collectorNumber: '149',
  language: 'en',
  finishes: ['nonfoil', 'foil'],
  physical: true,
  images: { small: null, normal: null, large: null, artCrop: null },
};

const m10: PrintingRecord = {
  printingId: 'printing-m10-146-en',
  cardId: 'card-bolt',
  edition: 'M10',
  collectorNumber: '146',
  language: 'en',
  finishes: ['nonfoil'],
  physical: true,
  images: { small: null, normal: null, large: null, artCrop: null },
};

function session(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    sessionId: 'manual',
    sourceKind: 'manual',
    sourceId: 'manual',
    sourceReference: null,
    state: 'pending',
    pendingEntries: 1,
    confirmedEntries: 0,
    discardedEntries: 0,
    revision: 2,
    ...overrides,
  };
}

function entry(overrides: Partial<ImportEntry> = {}): ImportEntry {
  return {
    entryId: 'entry-1',
    sessionId: 'manual',
    position: 1,
    state: 'pending',
    printingId: m11.printingId,
    finish: 'nonfoil',
    condition: null,
    quantity: 1,
    candidates: [],
    sourceLine: null,
    revision: 3,
    ...overrides,
  };
}

/** One printing result of the manual entry search. */
function printingResult(printing: PrintingRecord) {
  return {
    entryKey: `printing:${printing.printingId}`,
    target: { kind: 'printing' as const, printingId: printing.printingId },
    card: { cardId: boltCard.cardId, name: boltCard.name, matchedName: null },
    printing: {
      printingId: printing.printingId,
      edition: printing.edition,
      collectorNumber: printing.collectorNumber,
      language: printing.language,
    },
    quantity: null,
  };
}

/** One search page of the manual entry form. */
function searchPage(printings: readonly PrintingRecord[]) {
  return {
    entries: printings.map((printing) => printingResult(printing)),
    totalCount: printings.length,
    continuation: null,
    revisions: { catalogRevision: 'imports-revision', privateRevision: 'private-1' },
  };
}

/** One printing of the fixture card, distinguished by its collector number. */
function printingWith(collectorNumber: number): PrintingRecord {
  return {
    ...m11,
    printingId: `printing-m11-${collectorNumber}-en`,
    collectorNumber: String(collectorNumber),
  };
}

/** One page of a longer printing result, with the continuation that follows it. */
function searchSlice(printings: readonly PrintingRecord[], continuation: string | null) {
  return { ...searchPage(printings), continuation };
}

/** Pending entries of one import in capture order. */
function pendingEntries(count: number): ImportEntry[] {
  return Array.from({ length: count }, (_, index) =>
    entry({ entryId: `entry-${index + 1}`, position: index + 1 }),
  );
}

/** The copies one confirmation receipt names for `count` confirmed lines. */
function receiptCopies(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    copyId: `copy-${offset + index + 1}`,
    printingId: m11.printingId,
    finish: 'nonfoil' as const,
    condition: null,
    revision: 1,
  }));
}

/** Selects every entry the list currently presents through its own control. */
async function selectAllRendered(page: Page, host: string): Promise<void> {
  await page.locator(`${host} [data-ui-select]`).evaluateAll((inputs) => {
    for (const input of inputs) {
      (input as HTMLInputElement).click();
    }
  });
}

/** Presents the pending review of one account that already has a manual import. */
async function openPendingReview(
  page: Page,
  entries: readonly ImportEntry[],
  sessions: readonly ImportSession[] = [session()],
): Promise<string[]> {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  expect(listing.arguments).toEqual({ pageSize: 50, continuation: null });
  await settle(page, 'settleSessions', listing.id, sessions);
  if (sessions.length === 0) {
    return errors;
  }
  const read = await requested<UiImportEntriesRequest>(page, 'entries');
  expect(read.arguments).toEqual({ sessionId: 'manual', pageSize: 50, continuation: null });
  await settle(page, 'settleEntries', read.id, { session: sessions[0]!, entries });
  return errors;
}

test('stages a manual printing into review and only its confirmation creates copies', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  await expect(page.locator('#import-session')).toBeDisabled();
  await expect(page.locator('#import-manual-heading')).toBeVisible();

  await page.fill('#import-manual-query', 'Lightning Bolt');
  await page.fill('#import-manual-quantity', '2');
  await page.selectOption('#import-manual-finish', 'foil');
  await page.selectOption('#import-manual-condition', 'NM');
  await page.click('#import-manual-submit');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  expect(search.arguments).toMatchObject({ resultLevel: 'printing', query: 'Lightning Bolt' });
  await settle(page, 'settleSearch', search.id, searchPage([m11]));

  const result = page.locator('#import-results [data-ui-entry="printing:printing-m11-149-en"]');
  await expect(result).toBeVisible();
  await result.locator('[data-ui-select]').check();
  await page.click('#import-results [data-ui-tool="add-to-review"]');

  const staged = await requested<Record<string, unknown>>(page, 'stage');
  expect(staged.arguments).toMatchObject({
    sessionId: 'manual',
    source: { kind: 'manual', id: 'manual' },
  });
  const lines = staged.arguments.entries as readonly Record<string, unknown>[];
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    printingId: m11.printingId,
    finish: 'foil',
    condition: 'NM',
    quantity: 2,
  });
  await settle(page, 'settleStage', staged.id, {
    session: session(),
    entries: [entry({ finish: 'foil', condition: 'NM', quantity: 2 })],
    staged: 1,
    replayed: false,
  });

  // A staged line is in review, never owned: the cue names the review, not a collection change.
  await expect(page.locator('#import-results [data-ui-outcome]')).toHaveText(
    '1 line is in review. Confirmation creates the physical copies.',
  );

  // The page reconciles the pending import after the committed staging.
  const refresh = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', refresh.id, [session()]);
  const entriesRead = await requested<UiImportEntriesRequest>(page, 'entries', 0);
  await settle(page, 'settleEntries', entriesRead.id, {
    session: session(),
    entries: [entry({ finish: 'foil', condition: 'NM', quantity: 2 })],
  });

  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: M11 149 · en');
  await expect(row.locator('[data-ui-import-finish]')).toHaveText(' Finish: foil');
  await expect(row.locator('[data-ui-import-condition]')).toHaveText(' Condition: NM');
  await expect(row.locator('[data-ui-import-quantity]')).toHaveText(' Quantity: 2');

  await row.locator('[data-ui-select]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  expect(confirmation.arguments).toMatchObject({ sessionId: 'manual' });
  expect(confirmation.arguments.entries).toEqual([{ entryId: 'entry-1', expectedRevision: 3 }]);
  await settle(page, 'settleConfirm', confirmation.id, {
    operationId: confirmation.arguments.operationId as string,
    sessionId: 'manual',
    sourceKind: 'manual',
    sourceId: 'manual',
    copies: [
      {
        copyId: 'copy-1',
        printingId: m11.printingId,
        finish: 'foil',
        condition: 'NM',
        revision: 1,
      },
      {
        copyId: 'copy-2',
        printingId: m11.printingId,
        finish: 'foil',
        condition: 'NM',
        revision: 1,
      },
    ],
    replayed: false,
  });

  await expect(page.locator('#import-review-status')).toHaveText(
    'Confirmed: 2 physical copies created.',
  );
  const afterConfirmation = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', afterConfirmation.id, []);
  // The confirmed import has no pending entries left, so the review leaves it instead of
  // presenting a finished import as if it were still reviewable.
  const finished = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', finished.id, {
    session: session({ state: 'confirmed', pendingEntries: 0, confirmedEntries: 2, revision: 5 }),
    entries: [],
  });
  await expect(page.locator('#import-pending')).toHaveText('No pending entries to review.');
  expect(errors).toEqual([]);
});

test('reviews and corrects a pending entry before its confirmation', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');

  await page.fill('#import-review-quantity-entry-1', '3');
  await page.selectOption('#import-review-condition-entry-1', 'LP');
  await row.locator('[data-ui-select]').check();
  // The confirmation is available while the reviewed values are still the stored ones.
  await expect(page.locator('#import-pending [data-ui-tool="confirm-import"]')).toBeEnabled();

  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  expect(review.arguments).toMatchObject({
    entryId: 'entry-1',
    expectedRevision: 3,
    printingId: m11.printingId,
    finish: 'nonfoil',
    condition: 'LP',
    quantity: 3,
  });
  await settle(page, 'settleReview', review.id, {
    entry: entry({ condition: 'LP', quantity: 3, revision: 4 }),
    session: session({ revision: 5 }),
  });
  await expect(page.locator('#import-entry-status-entry-1')).toHaveText('Review saved.');

  const refreshed = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', refreshed.id, {
    session: session({ revision: 5 }),
    entries: [entry({ condition: 'LP', quantity: 3, revision: 4 })],
  });
  await expect(row.locator('[data-ui-import-condition]')).toHaveText(' Condition: LP');
  await expect(row.locator('[data-ui-import-quantity]')).toHaveText(' Quantity: 3');
  expect(errors).toEqual([]);
});

test('resolves an unresolved pending entry before confirming it', async ({ page }) => {
  const errors = await openPendingReview(page, [
    entry({
      entryId: 'entry-capture',
      printingId: null,
      finish: null,
      candidates: [{ printingId: m10.printingId, provider: 'visual', evidence: 'art-match' }],
    }),
  ]);
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-capture"]');
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: unresolved');
  await expect(row.locator('[data-ui-import-finish]')).toHaveText(' Finish: not chosen yet');
  await expect(row.locator('[data-ui-import-candidates]')).toContainText('visual, art-match');

  await page.fill('#import-printing-query-entry-capture', 'Lightning Bolt');
  await page.click('#import-printing-find-entry-capture');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  await settle(page, 'settleSearch', search.id, searchPage([m10]));
  // The finding row offers the printing the search resolved, and the review saves it by its id.
  await page.selectOption('#import-review-printing-entry-capture', m10.printingId);
  await page.selectOption('#import-review-finish-entry-capture', 'nonfoil');
  await page.selectOption('#import-review-condition-entry-capture', 'NM');
  await page.fill('#import-review-quantity-entry-capture', '1');
  await page.click('#import-review-save-entry-capture');

  const review = await requested<Record<string, unknown>>(page, 'review');
  expect(review.arguments).toMatchObject({
    entryId: 'entry-capture',
    expectedRevision: 3,
    printingId: m10.printingId,
    condition: 'NM',
    quantity: 1,
  });
  await settle(page, 'settleReview', review.id, {
    entry: entry({
      entryId: 'entry-capture',
      printingId: m10.printingId,
      finish: 'nonfoil',
      condition: 'NM',
      revision: 4,
    }),
    session: session({ revision: 5 }),
  });
  const refreshed = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', refreshed.id, {
    session: session({ revision: 5 }),
    entries: [
      entry({
        entryId: 'entry-capture',
        printingId: m10.printingId,
        finish: 'nonfoil',
        condition: 'NM',
        revision: 4,
      }),
    ],
  });
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: M10 146 · en');
  expect(errors).toEqual([]);
});

test('recovers a lost confirmation through its recorded operation outcome', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');
  await row.locator('[data-ui-select]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  await control(page, 'fail', confirmation.id, {
    code: 'busy',
    message: 'The service is busy.',
  });

  const recovery = await requested<string>(page, 'recover');
  expect(recovery.arguments).toBe(confirmation.arguments.operationId);
  await settle(page, 'settleRecover', recovery.id, {
    outcome: 'recorded',
    receipt: {
      operationId: confirmation.arguments.operationId as string,
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      copies: [
        {
          copyId: 'copy-1',
          printingId: m11.printingId,
          finish: 'nonfoil',
          condition: null,
          revision: 1,
        },
      ],
    },
  });

  await expect(page.locator('#import-review-status')).toHaveText(
    'Confirmed: 1 physical copy created. This confirmation had already been recorded; the ' +
      'copies it created are listed.',
  );
  const afterRecovery = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', afterRecovery.id, []);
  expect(errors).toEqual([]);
});

test('keeps one line identity when a staging response is lost and replays it on retry', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  await page.fill('#import-manual-query', 'Lightning Bolt');
  await page.click('#import-manual-submit');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  await settle(page, 'settleSearch', search.id, searchPage([m11]));
  const result = page.locator('#import-results [data-ui-entry="printing:printing-m11-149-en"]');
  await result.locator('[data-ui-select]').check();
  await page.click('#import-results [data-ui-tool="add-to-review"]');

  const first = await requested<Record<string, unknown>>(page, 'stage');
  const firstLine = (first.arguments.entries as readonly Record<string, unknown>[])[0];
  expect(firstLine?.entryId).toBeTruthy();
  await control(page, 'fail', first.id, { code: 'busy', message: 'The service is busy.' });

  // The outcome is unknown: the page reads the pending import again and keeps the selection.
  await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
    'The staging outcome is unknown',
  );
  const refresh = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', refresh.id, []);

  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const second = await requested<Record<string, unknown>>(page, 'stage', 1);
  const secondLine = (second.arguments.entries as readonly Record<string, unknown>[])[0];
  expect(secondLine?.entryId).toBe(firstLine?.entryId);
  await settle(page, 'settleStage', second.id, {
    session: session(),
    entries: [entry()],
    staged: 0,
    replayed: true,
  });
  await expect(page.locator('#import-results [data-ui-outcome]')).toHaveText(
    'Those lines were already in review; no new entries were added.',
  );
  const reconciled = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', reconciled.id, [session()]);
  const entriesRead = await requested<UiImportEntriesRequest>(page, 'entries', 0);
  await settle(page, 'settleEntries', entriesRead.id, { session: session(), entries: [entry()] });
  await expect(page.locator('#import-pending [data-ui-entry="pending:entry-1"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('discards one pending entry and one import without creating copies', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  await expect(page.locator('#import-pending [data-ui-entry="pending:entry-1"]')).toBeVisible();

  await page.click('#import-review-discard-entry-1');
  const dialog = page.locator('dialog', { hasText: 'Discard this pending entry?' });
  await dialog.getByRole('button', { name: 'Discard entry' }).click();
  const removed = await requested<Record<string, unknown>>(page, 'discardEntry');
  expect(removed.arguments).toEqual({ entryId: 'entry-1', expectedRevision: 3 });
  await settle(page, 'settleDiscardEntry', removed.id, {
    entry: entry({ state: 'discarded' }),
    session: session({ pendingEntries: 0, discardedEntries: 1, revision: 4 }),
  });
  const afterRemove = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', afterRemove.id, []);
  const refresh = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', refresh.id, {
    session: session({ state: 'discarded', pendingEntries: 0, discardedEntries: 1, revision: 4 }),
    entries: [],
  });
  await expect(page.locator('#import-session')).toBeDisabled();
  await expect(page.locator('#import-pending')).toHaveText('No pending entries to review.');

  await page.click('#import-refresh');
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', listing.id, [session()]);
  const entriesRead = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', entriesRead.id, { session: session(), entries: [entry()] });
  await page.click('#import-discard-session');
  const sessionDialog = page.locator('dialog', { hasText: 'Discard this import?' });
  await sessionDialog.getByRole('button', { name: 'Discard import' }).click();
  const discarded = await requested<Record<string, unknown>>(page, 'discardSession');
  expect(discarded.arguments).toEqual({ sessionId: 'manual', expectedRevision: 2 });
  await settle(
    page,
    'settleDiscardSession',
    discarded.id,
    session({ state: 'discarded', pendingEntries: 0, discardedEntries: 1, revision: 3 }),
  );
  const afterDiscard = await requested<UiImportSessionsRequest>(page, 'sessions', 3);
  await settle(page, 'settleSessions', afterDiscard.id, []);
  const afterDiscardEntries = await requested<UiImportEntriesRequest>(page, 'entries', 3);
  await settle(page, 'settleEntries', afterDiscardEntries.id, {
    session: session({ state: 'discarded', pendingEntries: 0, discardedEntries: 1, revision: 3 }),
    entries: [],
  });
  await expect(page.locator('#import-review-status')).toHaveText(
    'The import was discarded; no copies were created.',
  );
  expect(errors).toEqual([]);
});

test('restores the presented import and an unsaved review draft on the way back', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.fill('#import-review-quantity-entry-1', '4');

  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');

  // The view is presented again from the state its history entry kept: the pending import and the
  // input the owner did not save are read back with the window the list retained.
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', listing.id, [session()]);
  const restored = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', restored.id, { session: session(), entries: [entry()] });
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('4');
  await expect(page.locator('#import-pending [data-ui-entry="pending:entry-1"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps every stored review value while one attribute is corrected', async ({ page }) => {
  const errors = await openPendingReview(page, [
    entry({ finish: 'foil', condition: 'NM', quantity: 1 }),
  ]);
  await expect(page.locator('#import-review-printing-entry-1')).toHaveValue(m11.printingId);

  // Correcting one attribute must keep the reviewed printing, finish and condition of the entry.
  await page.fill('#import-review-quantity-entry-1', '2');
  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', listing.id, [session()]);
  const restored = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', restored.id, {
    session: session(),
    entries: [entry({ finish: 'foil', condition: 'NM', quantity: 1 })],
  });

  await expect(page.locator('#import-review-printing-entry-1')).toHaveValue(m11.printingId);
  await expect(page.locator('#import-review-finish-entry-1')).toHaveValue('foil');
  await expect(page.locator('#import-review-condition-entry-1')).toHaveValue('NM');
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('2');
  expect(errors).toEqual([]);
});

test('offers the finish options of the printing a review selects', async ({ page }) => {
  const errors = await openPendingReview(page, [entry({ printingId: m10.printingId })]);
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: M10 146 · en');

  // The M10 printing the entry names offers no foil; the M11 the review selects does.
  await page.fill('#import-printing-query-entry-1', 'Lightning Bolt');
  await page.click('#import-printing-find-entry-1');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  await settle(page, 'settleSearch', search.id, searchPage([m11]));
  await page.selectOption('#import-review-printing-entry-1', m11.printingId);
  await expect(page.locator('#import-review-finish-entry-1 option[value="foil"]')).toHaveCount(1);

  await page.selectOption('#import-review-finish-entry-1', 'foil');
  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  expect(review.arguments).toMatchObject({
    entryId: 'entry-1',
    printingId: m11.printingId,
    finish: 'foil',
  });
  await settle(page, 'settleReview', review.id, {
    entry: entry({ printingId: m11.printingId, finish: 'foil', revision: 4 }),
    session: session({ revision: 5 }),
  });
  const refreshed = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', refreshed.id, {
    session: session({ revision: 5 }),
    entries: [entry({ printingId: m11.printingId, finish: 'foil', revision: 4 })],
  });
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: M11 149 · en');
  expect(errors).toEqual([]);
});

test('restores a selected pending entry on the way back', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  const selection = '#import-pending [data-ui-entry="pending:entry-1"] [data-ui-select]';
  await page.locator(selection).check();
  await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText('1 selected');

  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', listing.id, [session()]);
  const restored = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', restored.id, { session: session(), entries: [entry()] });

  // The list's own captured state keeps the interaction: the entry stays selected and actionable.
  await expect(page.locator(selection)).toBeChecked();
  await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText('1 selected');
  await expect(page.locator('#import-pending [data-ui-tool="confirm-import"]')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('keeps the reviewed revision the page read when an older read answers late', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');

  // Two refreshes leave the first read in flight; the second one reports the newer revision.
  await page.click('#import-refresh');
  const firstListing = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', firstListing.id, [session()]);
  const older = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await page.click('#import-refresh');
  const secondListing = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', secondListing.id, [session()]);
  const newer = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', newer.id, {
    session: session({ revision: 5 }),
    entries: [entry({ quantity: 2, revision: 4 })],
  });
  await expect(row.locator('[data-ui-import-quantity]')).toHaveText(' Quantity: 2');

  // The withdrawn read answers late with the older revision; it cannot replace what is presented.
  await settle(page, 'settleEntries', older.id, {
    session: session({ revision: 4 }),
    entries: [entry({ revision: 3 })],
  });

  await row.locator('[data-ui-select]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  expect(confirmation.arguments.entries).toEqual([{ entryId: 'entry-1', expectedRevision: 4 }]);
  await settle(page, 'settleConfirm', confirmation.id, {
    operationId: confirmation.arguments.operationId as string,
    sessionId: 'manual',
    sourceKind: 'manual',
    sourceId: 'manual',
    copies: receiptCopies(1),
    replayed: false,
  });
  const afterConfirmation = await requested<UiImportSessionsRequest>(page, 'sessions', 3);
  await settle(page, 'settleSessions', afterConfirmation.id, []);
  const refresh = await requested<UiImportEntriesRequest>(page, 'entries', 3);
  await settle(page, 'settleEntries', refresh.id, {
    session: session({ state: 'confirmed', pendingEntries: 0, confirmedEntries: 1, revision: 5 }),
    entries: [],
  });
  expect(errors).toEqual([]);
});

test('keeps the presented import when a review of another import completes', async ({ page }) => {
  const captureSession = session({
    sessionId: 'capture',
    sourceKind: 'capture',
    sourceId: 'session-1',
    revision: 99,
  });
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, [session(), captureSession]);
  const manual = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', manual.id, { session: session(), entries: [entry()] });

  // The owner saves a review of the manual import, switches to another import while the request is
  // in flight, and the response of the first import arrives afterwards.
  await page.fill('#import-review-quantity-entry-1', '3');
  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  await page.selectOption('#import-session', 'capture');
  const other = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  expect(other.arguments.sessionId).toBe('capture');
  await settle(page, 'settleEntries', other.id, {
    session: captureSession,
    entries: [entry({ entryId: 'entry-capture', sessionId: 'capture', revision: 7 })],
  });
  await settle(page, 'settleReview', review.id, {
    entry: entry({ quantity: 3, revision: 4 }),
    session: session({ revision: 5 }),
  });

  // The presented import keeps its own values and its own revision for the discard.
  await expect(page.locator('#import-review-quantity-entry-capture')).toHaveValue('1');
  await page.click('#import-discard-session');
  const dialog = page.locator('dialog', { hasText: 'Discard this import?' });
  await dialog.getByRole('button', { name: 'Discard import' }).click();
  const discarded = await requested<Record<string, unknown>>(page, 'discardSession');
  expect(discarded.arguments).toEqual({ sessionId: 'capture', expectedRevision: 99 });
  await settle(
    page,
    'settleDiscardSession',
    discarded.id,
    session({ sessionId: 'capture', state: 'discarded', pendingEntries: 0 }),
  );
  const afterDiscard = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', afterDiscard.id, []);
  const afterDiscardEntries = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', afterDiscardEntries.id, {
    session: session({ state: 'discarded', pendingEntries: 0 }),
    entries: [],
  });
  expect(errors).toEqual([]);
});

test('keeps review input typed while a saved review was in flight', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.fill('#import-review-quantity-entry-1', '2');
  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  // The owner corrects the quantity again before the response of the save arrives.
  await page.fill('#import-review-quantity-entry-1', '7');
  await settle(page, 'settleReview', review.id, {
    entry: entry({ quantity: 2, revision: 4 }),
    session: session({ revision: 5 }),
  });
  const refreshed = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', refreshed.id, {
    session: session({ revision: 5 }),
    entries: [entry({ quantity: 2, revision: 4 })],
  });

  // The committed save cleared only the input it submitted; the newer correction stays.
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('7');
  expect(errors).toEqual([]);
});

test('keeps another import saved review input when one import is discarded', async ({ page }) => {
  const captureSession = session({
    sessionId: 'capture',
    sourceKind: 'capture',
    sourceId: 'session-1',
    revision: 99,
  });
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, [session(), captureSession]);
  const manual = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', manual.id, { session: session(), entries: [entry()] });
  await page.fill('#import-review-quantity-entry-1', '7');

  await page.selectOption('#import-session', 'capture');
  const other = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', other.id, {
    session: captureSession,
    entries: [entry({ entryId: 'entry-capture', sessionId: 'capture', revision: 7 })],
  });
  await page.click('#import-discard-session');
  const dialog = page.locator('dialog', { hasText: 'Discard this import?' });
  await dialog.getByRole('button', { name: 'Discard import' }).click();
  const discarded = await requested<Record<string, unknown>>(page, 'discardSession');
  await settle(
    page,
    'settleDiscardSession',
    discarded.id,
    session({ sessionId: 'capture', state: 'discarded', pendingEntries: 0, revision: 100 }),
  );
  const afterDiscard = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', afterDiscard.id, [session()]);
  const manualAgain = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', manualAgain.id, { session: session(), entries: [entry()] });

  // The discarded import cleared its own review input only; the other import keeps its draft.
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('7');
  expect(errors).toEqual([]);
});

test('stages a manual selection larger than one provider request', async ({ page }) => {
  const printings = Array.from({ length: 51 }, (_, index) => printingWith(200 + index));
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  await page.fill('#import-manual-query', 'Lightning Bolt');
  await page.click('#import-manual-submit');

  const first = await requested<Record<string, unknown>>(page, 'searches');
  await settle(page, 'settleSearch', first.id, searchSlice(printings.slice(0, 20), 'cursor-20'));
  for (const offset of [20, 40]) {
    await page.locator('#import-results [data-ui-more]').click();
    const next = await requested<Record<string, unknown>>(page, 'searches', offset / 20);
    const continuation = offset + 20 < printings.length ? `cursor-${offset + 20}` : null;
    await settle(
      page,
      'settleSearch',
      next.id,
      searchSlice(printings.slice(offset, offset + 20), continuation),
    );
  }
  await selectAllRendered(page, '#import-results');
  await expect(page.locator('#import-results [data-ui-selection-count]')).toHaveText('51 selected');

  // The staging is decided through requests the provider accepts, with every line's own identity.
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const staged = await requested<Record<string, unknown>>(page, 'stage');
  expect((staged.arguments.entries as readonly unknown[]).length).toBe(50);
  await settle(page, 'settleStage', staged.id, {
    session: session({ pendingEntries: 50 }),
    entries: [],
    staged: 50,
    replayed: false,
  });
  const rest = await requested<Record<string, unknown>>(page, 'stage', 1);
  expect((rest.arguments.entries as readonly unknown[]).length).toBe(1);
  await settle(page, 'settleStage', rest.id, {
    session: session({ pendingEntries: 51 }),
    entries: [],
    staged: 1,
    replayed: false,
  });

  await expect(page.locator('#import-results [data-ui-outcome]')).toHaveText(
    '51 lines are in review. Confirmation creates the physical copies.',
  );
  const reconciled = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconciled.id, []);
  expect(errors).toEqual([]);
});

test('confirms a selection larger than one provider request', async ({ page }) => {
  const all = pendingEntries(51);
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, [session({ pendingEntries: 51 })]);
  const first = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', first.id, {
    session: session({ pendingEntries: 51 }),
    entries: all.slice(0, 50),
    continuation: 'cursor-50',
  });
  await page.locator('#import-pending [data-ui-more]').click();
  const second = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', second.id, {
    session: session({ pendingEntries: 51 }),
    entries: all.slice(50),
  });
  await selectAllRendered(page, '#import-pending');
  await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText('51 selected');

  // The confirmation covers the selection through requests the provider accepts.
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmed = await requested<Record<string, unknown>>(page, 'confirm');
  expect((confirmed.arguments.entries as readonly unknown[]).length).toBe(50);
  await settle(page, 'settleConfirm', confirmed.id, {
    operationId: confirmed.arguments.operationId as string,
    sessionId: 'manual',
    sourceKind: 'manual',
    sourceId: 'manual',
    copies: receiptCopies(50),
    replayed: false,
  });
  const rest = await requested<Record<string, unknown>>(page, 'confirm', 1);
  expect((rest.arguments.entries as readonly unknown[]).length).toBe(1);
  await settle(page, 'settleConfirm', rest.id, {
    operationId: rest.arguments.operationId as string,
    sessionId: 'manual',
    sourceKind: 'manual',
    sourceId: 'manual',
    copies: receiptCopies(1, 50),
    replayed: false,
  });

  await expect(page.locator('#import-review-status')).toHaveText(
    'Confirmed: 51 physical copies created.',
  );
  const reconciled = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconciled.id, []);
  const refresh = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', refresh.id, {
    session: session({ state: 'confirmed', pendingEntries: 0, confirmedEntries: 51, revision: 6 }),
    entries: [],
  });
  expect(errors).toEqual([]);
});

test('recovers a lost confirmation whose pending entries are gone', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');
  await row.locator('[data-ui-select]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  // Both the confirmation and the recovery read of its outcome are lost.
  await control(page, 'fail', confirmation.id, { code: 'busy', message: 'The service is busy.' });
  const lost = await requested<string>(page, 'recover');
  expect(lost.arguments).toBe(confirmation.arguments.operationId);
  await control(page, 'fail', lost.id, { code: 'unavailable', message: 'Offline.' });
  await expect(page.locator('#import-recover')).toBeVisible();

  // Reading the pending import finds the confirmed session without any pending entry left.
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', listing.id, []);
  const read = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', read.id, {
    session: session({ state: 'confirmed', pendingEntries: 0, confirmedEntries: 1, revision: 6 }),
    entries: [],
  });
  await expect(page.locator('#import-pending')).toHaveText('No pending entries to review.');

  // The kept operation identity recovers the outcome without any pending entry or selection.
  const recovery = await requested<string>(page, 'recover', 1);
  expect(recovery.arguments).toBe(confirmation.arguments.operationId);
  await settle(page, 'settleRecover', recovery.id, {
    outcome: 'recorded',
    receipt: {
      operationId: confirmation.arguments.operationId as string,
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      copies: receiptCopies(1),
    },
  });
  await expect(page.locator('#import-review-status')).toHaveText(
    'Confirmed: 1 physical copy created. This confirmation had already been recorded; the copies ' +
      'it created are listed.',
  );
  const afterRecovery = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', afterRecovery.id, []);
  expect(errors).toEqual([]);
});

test('recovers the confirmation a restored page kept', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');
  await row.locator('[data-ui-select]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  await control(page, 'fail', confirmation.id, { code: 'busy', message: 'The service is busy.' });
  const lost = await requested<string>(page, 'recover');
  await control(page, 'fail', lost.id, { code: 'unavailable', message: 'Offline.' });
  const reconciled = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconciled.id, [session()]);
  const refresh = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', refresh.id, { session: session(), entries: [entry()] });

  // Leaving the view and returning to it reads the kept confirmation's recorded outcome again.
  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const restored = await requested<string>(page, 'recover', 1);
  expect(restored.arguments).toBe(confirmation.arguments.operationId);
  await settle(page, 'settleRecover', restored.id, {
    outcome: 'recorded',
    receipt: {
      operationId: confirmation.arguments.operationId as string,
      sessionId: 'manual',
      sourceKind: 'manual',
      sourceId: 'manual',
      copies: receiptCopies(1),
    },
  });
  await expect(page.locator('#import-review-status')).toHaveText(
    'Confirmed: 1 physical copy created. This confirmation had already been recorded; the copies ' +
      'it created are listed.',
  );
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', listing.id, []);
  const restoredEntries = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', restoredEntries.id, {
    session: session({ state: 'confirmed', pendingEntries: 0, confirmedEntries: 1, revision: 6 }),
    entries: [],
  });
  expect(errors).toEqual([]);
});

test('confirms a selected entry the loaded window no longer presents', async ({ page }) => {
  const all = pendingEntries(550);
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, [session({ pendingEntries: 550 })]);
  const first = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', first.id, {
    session: session({ pendingEntries: 550 }),
    entries: all.slice(0, 50),
    continuation: 'cursor-50',
  });
  await page.locator('#import-pending [data-ui-entry="pending:entry-1"] [data-ui-select]').check();

  // Paging beyond the working window retires the row of the selected entry, not the selection.
  for (let index = 1; index <= 10; index += 1) {
    await page.locator('#import-pending [data-ui-more]').click();
    const read = await requested<UiImportEntriesRequest>(page, 'entries', index);
    expect(read.arguments).toEqual({
      sessionId: 'manual',
      pageSize: 50,
      continuation: `cursor-${index * 50}`,
    });
    await settle(page, 'settleEntries', read.id, {
      session: session({ pendingEntries: 550 }),
      entries: all.slice(index * 50, index * 50 + 50),
      continuation: index < 10 ? `cursor-${(index + 1) * 50}` : null,
    });
  }
  await expect(page.locator('#import-pending [data-ui-entry="pending:entry-1"]')).toHaveCount(0);
  await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText('1 selected');

  // The confirmation still quotes the revision the page read for that entry.
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  expect(confirmation.arguments.entries).toEqual([{ entryId: 'entry-1', expectedRevision: 3 }]);
  await settle(page, 'settleConfirm', confirmation.id, {
    operationId: confirmation.arguments.operationId as string,
    sessionId: 'manual',
    sourceKind: 'manual',
    sourceId: 'manual',
    copies: receiptCopies(1),
    replayed: false,
  });
  await expect(page.locator('#import-review-status')).toHaveText(
    'Confirmed: 1 physical copy created.',
  );
  const reconciled = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconciled.id, []);
  const refresh = await requested<UiImportEntriesRequest>(page, 'entries', 11);
  await settle(page, 'settleEntries', refresh.id, {
    session: session({ state: 'confirmed', pendingEntries: 549, confirmedEntries: 1, revision: 7 }),
    entries: all.slice(1),
    continuation: null,
  });
  expect(errors).toEqual([]);
});

for (const obsolete of ['success', 'failure', 'edited query', 'changed session'] as const) {
  test(`ignores an obsolete printing search after ${obsolete}`, async ({ page }) => {
    const other = session({ sessionId: 'capture', sourceKind: 'capture' });
    const errors = await openPendingReview(page, [entry()], [session(), other]);
    await page.fill('#import-printing-query-entry-1', 'older');
    await page.click('#import-printing-find-entry-1');
    const older = await requested(page, 'searches');
    await page.fill('#import-printing-query-entry-1', 'newer');
    if (obsolete === 'changed session') {
      await page.selectOption('#import-session', 'capture');
      const otherRead = await requested(page, 'entries', 1);
      await settle(page, 'settleEntries', otherRead.id, {
        session: other,
        entries: [entry({ entryId: 'other', sessionId: 'capture' })],
      });
      await page.selectOption('#import-session', 'manual');
      const back = await requested(page, 'entries', 2);
      await settle(page, 'settleEntries', back.id, { session: session(), entries: [entry()] });
    } else if (obsolete !== 'edited query') {
      await page.click('#import-printing-find-entry-1');
      const newer = await requested(page, 'searches', 1);
      if (obsolete === 'failure') {
        await control(page, 'fail', older.id, { code: 'unavailable', message: 'Obsolete failure' });
        await expect(page.locator('#import-entry-status-entry-1')).toHaveText(
          'Searching for printings…',
        );
      }
      await settle(page, 'settleSearch', newer.id, searchPage([m10]));
      await expect(page.locator('#import-review-printing-entry-1 option')).toHaveCount(3);
    }
    if (obsolete !== 'failure') {
      await settle(page, 'settleSearch', older.id, searchPage(obsolete === 'success' ? [] : [m10]));
    }
    // Redraw from page state as well as checking the current controls, so a detached editor
    // cannot hide an obsolete result stored for the next render.
    await page.selectOption('#import-review-printing-entry-1', m11.printingId);
    await expect(page.locator('#import-printing-query-entry-1')).toHaveValue('newer');
    await expect(page.locator('#import-entry-status-entry-1')).toBeEmpty();
    await expect(page.locator('#import-review-printing-entry-1 option')).toHaveCount(
      obsolete === 'success' || obsolete === 'failure' ? 3 : 2,
    );
    expect(errors).toEqual([]);
  });
}

test('keeps printing search input typed during a review save', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.fill('#import-review-quantity-entry-1', '2');
  await page.click('#import-review-save-entry-1');
  const review = await requested(page, 'review');
  await page.fill('#import-printing-query-entry-1', 'set:m10');
  await settle(page, 'settleReview', review.id, {
    entry: entry({ quantity: 2, revision: 4 }),
    session: session({ revision: 5 }),
  });
  const refresh = await requested(page, 'entries', 1);
  await settle(page, 'settleEntries', refresh.id, {
    session: session({ revision: 5 }),
    entries: [entry({ quantity: 2, revision: 4 })],
  });
  await expect(page.locator('#import-printing-query-entry-1')).toHaveValue('set:m10');
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('2');
  expect(errors).toEqual([]);
});

/** Loads and selects a manual search across pages, including selections beyond the DOM window. */
async function selectManualPrintings(page: Page, count: number): Promise<string[]> {
  const printings = Array.from({ length: count }, (_, index) => printingWith(200 + index));
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings });
  const listing = await requested(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  await page.fill('#import-manual-query', 'Lightning Bolt');
  await page.click('#import-manual-submit');
  for (let offset = 0; offset < count; offset += 20) {
    if (offset > 0) {
      await page.locator('#import-results [data-ui-more]').click();
    }
    const read = await requested(page, 'searches', offset / 20);
    await settle(
      page,
      'settleSearch',
      read.id,
      searchSlice(
        printings.slice(offset, offset + 20),
        offset + 20 < count ? `cursor-${offset + 20}` : null,
      ),
    );
    await page.locator('#import-results [data-ui-select]:not(:checked)').evaluateAll((inputs) => {
      for (const input of inputs) (input as HTMLInputElement).click();
    });
  }
  await expect(page.locator('#import-results [data-ui-selection-count]')).toHaveText(
    `${count} selected`,
  );
  return errors;
}

/** Answers the restored result window through the same bounded search boundary. */
async function restoreManualPrintings(page: Page, count: number): Promise<void> {
  let index = Math.ceil(count / 20);
  for (;;) {
    const read = await requested<{ continuation?: string }>(page, 'searches', index++);
    const offset = Number(read.arguments.continuation?.replace('cursor-', '') ?? 0);
    const end = Math.min(count, offset + 20);
    await settle(
      page,
      'settleSearch',
      read.id,
      searchSlice(
        Array.from({ length: end - offset }, (_, i) => printingWith(200 + offset + i)),
        end < count ? `cursor-${end}` : null,
      ),
    );
    if (end === count) return;
  }
}

test('retries only the unresolved staging batch after a partial bulk success and Back', async ({
  page,
}) => {
  const errors = await selectManualPrintings(page, 51);
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const first = await requested(page, 'stage');
  await settle(page, 'settleStage', first.id, {
    session: session(),
    entries: [],
    staged: 50,
    replayed: false,
  });
  const last = await requested<Record<string, unknown>>(page, 'stage', 1);
  await control(page, 'fail', last.id, { code: 'unavailable', message: 'Lost response' });
  await expect(page.locator('#import-results [data-ui-selection-count]')).toHaveText('1 selected');
  const refresh = await requested(page, 'sessions', 1);
  await settle(page, 'settleSessions', refresh.id, []);
  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const restored = await requested(page, 'sessions', 2);
  await settle(page, 'settleSessions', restored.id, []);
  await restoreManualPrintings(page, 51);
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const retry = await requested<Record<string, unknown>>(page, 'stage', 2);
  expect(retry.arguments.entries).toEqual(last.arguments.entries);
  await settle(page, 'settleStage', retry.id, {
    session: session(),
    entries: [],
    staged: 0,
    replayed: true,
  });
  await expect(page.locator('#import-results [data-ui-selection-count]')).toHaveText('0 selected');
  expect(errors).toEqual([]);
});

test('retains staging identities beyond the rendering window and through Back', async ({
  page,
}) => {
  const errors = await selectManualPrintings(page, 501);
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const first = await requested<Record<string, unknown>>(page, 'stage');
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Lost response' });
  await expect(page.locator('#import-results [data-ui-outcome]')).toContainText('unknown');
  const refresh = await requested(page, 'sessions', 1);
  await settle(page, 'settleSessions', refresh.id, []);
  // Changing the manual input cannot mint new identities for an uncertain acquisition.
  await page.fill('#import-manual-quantity', '2');
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  await expect(page.locator('#import-results [data-ui-outcome]')).toContainText('original finish');
  expect(await control<unknown[]>(page, 'stage')).toHaveLength(1);
  await page.fill('#import-manual-quantity', '1');
  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const restored = await requested(page, 'sessions', 2);
  await settle(page, 'settleSessions', restored.id, []);
  await restoreManualPrintings(page, 501);
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const retry = await requested<Record<string, unknown>>(page, 'stage', 1);
  expect(retry.arguments.entries).toEqual(first.arguments.entries);
  expect(retry.arguments.entries as unknown[]).toHaveLength(50);
  expect(errors).toEqual([]);
});

for (const recovered of ['recorded', 'absent'] as const) {
  test(`protects unresolved confirmation during other actions until recovery is ${recovered}`, async ({
    page,
  }) => {
    const errors = await openPendingReview(page, pendingEntries(2));
    const select = (id: number) =>
      page.locator(`#import-pending [data-ui-entry="pending:entry-${id}"] [data-ui-select]`);
    await select(1).check();
    await page.click('#import-pending [data-ui-tool="confirm-import"]');
    const first = await requested<Record<string, unknown>>(page, 'confirm');
    await control(page, 'fail', first.id, { code: 'unavailable', message: 'Lost' });
    const lost = await requested(page, 'recover');
    await control(page, 'fail', lost.id, { code: 'unavailable', message: 'Offline' });
    await expect(page.locator('#import-recover')).toBeEnabled();
    await select(1).uncheck();
    await select(2).check();
    await page.click('#import-pending [data-ui-tool="confirm-import"]');
    await expect(page.locator('#import-pending [data-ui-outcome]')).toContainText(
      'outstanding confirmation',
    );
    expect(await control<unknown[]>(page, 'confirm')).toHaveLength(1);
    await page.click('#import-recover');
    const recovery = await requested<string>(page, 'recover', 1);
    expect(recovery.arguments).toBe(first.arguments.operationId);
    await page.click('#import-pending [data-ui-tool="confirm-import"]');
    await expect(page.locator('#import-pending [data-ui-outcome]')).toContainText(
      'outstanding confirmation',
    );
    expect(await control<unknown[]>(page, 'confirm')).toHaveLength(1);
    await page.click('#import-discard-session');
    await page
      .locator('dialog')
      .getByRole('button', { name: 'Discard import', exact: true })
      .click();
    const discarded = await requested(page, 'discardSession');
    await settle(
      page,
      'settleDiscardSession',
      discarded.id,
      session({ state: 'discarded', pendingEntries: 0 }),
    );
    await expect(page.locator('#import-recover')).toBeVisible();
    await settle(
      page,
      'settleRecover',
      recovery.id,
      recovered === 'absent'
        ? { outcome: 'absent' }
        : {
            outcome: 'recorded',
            receipt: {
              operationId: recovery.arguments,
              sessionId: 'manual',
              sourceKind: 'manual',
              sourceId: 'manual',
              copies: receiptCopies(1),
            },
          },
    );
    await expect(page.locator('#import-recover')).toBeHidden();
    await expect(page.locator('#import-review-status')).toContainText(
      recovered === 'absent' ? 'not recorded' : '1 physical copy',
    );
    expect(errors).toEqual([]);
  });
}

for (const context of ['Back', 'another search', 'missing lookup', 'failed lookup'] as const) {
  test(`resolves the selected printing finish after ${context}`, async ({ page }) => {
    const errors = await openPendingReview(page, [entry()]);
    const foil: PrintingRecord = { ...m10, finishes: ['foil'] };
    await scriptCatalog(page, { cards: [boltCard], printings: [m11, foil] });
    await page.fill('#import-printing-query-entry-1', 'set:m10');
    await page.click('#import-printing-find-entry-1');
    const search = await requested(page, 'searches');
    await settle(page, 'settleSearch', search.id, searchPage([foil]));
    await page.selectOption('#import-review-printing-entry-1', foil.printingId);
    await expect(page.locator('#import-review-finish-entry-1')).toHaveValue('');
    if (context === 'another search') {
      await page.fill('#import-printing-query-entry-1', 'set:m11');
      await page.click('#import-printing-find-entry-1');
      const newer = await requested(page, 'searches', 1);
      await settle(page, 'settleSearch', newer.id, searchPage([m11]));
      await expect(page.locator('#import-review-printing-entry-1')).toHaveValue(foil.printingId);
    } else {
      await control(page, 'navigate', { page: 'home' });
      await control(page, 'back');
      const sessions = await requested(page, 'sessions', 1);
      await settle(page, 'settleSessions', sessions.id, [session()]);
      const entries = await requested(page, 'entries', 1);
      await settle(page, 'settleEntries', entries.id, { session: session(), entries: [entry()] });
      await expect(page.locator('#import-review-printing-entry-1')).toHaveValue(foil.printingId);
    }
    if (context === 'missing lookup')
      await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
    const catalogCount = (await control<unknown[]>(page, 'catalogRequests')).length;
    if (context === 'failed lookup') await control(page, 'scriptCatalog', null);
    await page.click('#import-review-save-entry-1');
    if (context === 'failed lookup') {
      const lookup = await requested(page, 'catalogRequests', catalogCount);
      await control(page, 'fail', lookup.id, { code: 'unavailable', message: 'Offline' });
    }
    if (context === 'missing lookup' || context === 'failed lookup') {
      await expect(page.locator('#import-entry-status-entry-1')).toContainText(
        context === 'missing lookup' ? 'unavailable' : 'could not be read',
      );
      expect(await control<unknown[]>(page, 'review')).toHaveLength(0);
      await expect(page.locator('#import-review-printing-entry-1')).toHaveValue(foil.printingId);
      await expect(page.locator('#import-printing-query-entry-1')).toHaveValue('set:m10');
    } else {
      const review = await requested<Record<string, unknown>>(page, 'review');
      expect(review.arguments).toMatchObject({ printingId: foil.printingId, finish: 'foil' });
    }
    expect(errors).toEqual([]);
  });
}

test('serializes confirmation across sessions and releases it after explicit absence', async ({
  page,
}) => {
  const other = session({ sessionId: 'capture', sourceKind: 'capture' });
  const errors = await openPendingReview(page, [entry()], [session(), other]);
  await page.locator('#import-pending [data-ui-select]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const first = await requested<Record<string, unknown>>(page, 'confirm');
  await expect(page.locator('#import-recover')).toBeDisabled();
  await page.selectOption('#import-session', 'capture');
  const read = await requested(page, 'entries', 1);
  await settle(page, 'settleEntries', read.id, {
    session: other,
    entries: [entry({ entryId: 'other', sessionId: 'capture' })],
  });
  await page.locator('#import-pending [data-ui-select]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  await expect(page.locator('#import-pending [data-ui-outcome]')).toContainText(
    'outstanding confirmation',
  );
  expect(await control<unknown[]>(page, 'confirm')).toHaveLength(1);
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Lost response' });
  const recover = await requested<string>(page, 'recover');
  expect(recover.arguments).toBe(first.arguments.operationId);
  await settle(page, 'settleRecover', recover.id, { outcome: 'absent' });
  await expect(page.locator('#import-recover')).toBeHidden();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const second = await requested<Record<string, unknown>>(page, 'confirm', 1);
  expect(second.arguments.sessionId).toBe('capture');
  expect(second.arguments.operationId).not.toBe(first.arguments.operationId);
  expect(second.arguments.entries).toEqual([{ entryId: 'other', expectedRevision: 3 }]);
  expect(errors).toEqual([]);
});

for (const priorUnknown of [false, true]) {
  test(`allows staging corrections only after a definite first-attempt failure (prior unknown: ${priorUnknown})`, async ({
    page,
  }) => {
    const errors = await selectManualPrintings(page, 1);
    await page.click('#import-results [data-ui-tool="add-to-review"]');
    let attempt = await requested<Record<string, unknown>>(page, 'stage');
    const original = attempt.arguments.entries;
    if (priorUnknown) {
      await control(page, 'fail', attempt.id, { code: 'unavailable', message: 'Lost response' });
      await expect(page.locator('#import-results [data-ui-outcome]')).toContainText('unknown');
      await page.click('#import-results [data-ui-tool="add-to-review"]');
      attempt = await requested<Record<string, unknown>>(page, 'stage', 1);
      expect(attempt.arguments.entries).toEqual(original);
    }
    await control(page, 'fail', attempt.id, {
      code: 'invalid-request',
      message: 'Unsupported attributes',
    });
    await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
      'Unsupported attributes',
    );
    await page.fill('#import-manual-quantity', '2');
    await page.click('#import-results [data-ui-tool="add-to-review"]');
    if (priorUnknown) {
      await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
        'original finish',
      );
      expect(await control<unknown[]>(page, 'stage')).toHaveLength(2);
    } else {
      const corrected = await requested<Record<string, unknown>>(page, 'stage', 1);
      expect(corrected.arguments.entries).toMatchObject([{ quantity: 2 }]);
    }
    expect(errors).toEqual([]);
  });
}
