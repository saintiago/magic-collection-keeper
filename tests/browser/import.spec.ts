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
