/**
 * Browser journeys: the Import page (docs/user-interface.md#capture-and-review,
 * docs/user-cards.md#import-and-capture-state, docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real shell with the real Import page and the controlled component access of
 * import.harness.ts and drive them in Chromium: a manual entry stages a catalog printing as a
 * pending line and only its confirmation creates copies, a reviewed entry exposes and corrects its
 * printing, finish, condition and quantity, an unresolved entry is resolved before confirmation, a
 * lost confirmation response is recovered through the recorded outcome of its operation, and
 * discarding ends pending membership without creating copies. A source import keeps the identity of
 * the list it composes with its input through a pending or lost response, a reload, a source-method
 * switch and the account that dispatched it, so importing the same source again retries that list
 * instead of staging a second one.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type { ApplicationFailureCode } from '../../src/application/index.js';
import type { CardRecord, PrintingRecord } from '../../src/catalog/index.js';
import type {
  ImportEntry,
  ImportSession,
  StageSourceImportInput,
  Tag,
} from '../../src/usercards/index.js';
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
          'globalThis.keeperImportControl = installImportHarness(',
          "  document.getElementById('ui-root'),",
          '  globalThis.keeperImportOptions,',
          ');',
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

/**
 * Serves a fresh document for the Import page, enters it at `hash` and loads the UI over the
 * deployment capabilities the journey names.
 */
async function openImport(
  page: Page,
  hash: string,
  options: {
    readonly sourceImports?: boolean;
    readonly failDestinationReads?: {
      readonly code: ApplicationFailureCode;
      readonly message: string;
    } | null;
  } = {},
): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-import.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: importPageHtml }),
  );
  await page.goto(`http://keeper-import.test/${hash}`);
  await loadImport(page, options);
  return errors;
}

/** Loads a fresh UserInterface into the current document, as a reload of the app does. */
async function loadImport(
  page: Page,
  options: {
    readonly sourceImports?: boolean;
    readonly failDestinationReads?: {
      readonly code: ApplicationFailureCode;
      readonly message: string;
    } | null;
  } = {},
): Promise<void> {
  await page.evaluate((capabilities) => {
    (globalThis as unknown as { keeperImportOptions: unknown }).keeperImportOptions = capabilities;
  }, options);
  await page.addScriptTag({ content: await importBundle(), type: 'module' });
  await page.waitForFunction(() => Reflect.has(globalThis, 'keeperImportControl'));
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

/**
 * Reopens one waiting import through the explicit control the page presents for its identity.
 * A new-import submission and a reopen are distinct intents: reopening reads the import the
 * identity already names instead of deciding one from the input the form holds
 * (docs/ui/editors.md#internal-design).
 */
async function reopenWaitingImport(page: Page, operationId: string): Promise<void> {
  await page.click(`#import-source-waiting [data-ui-source-waiting="${operationId}"] button`);
}

/** The status the page presents after a source import whose outcome is not established. */
const sourceOutcomeUnknown =
  'The staging outcome is unknown. Reopen the waiting import to read its recorded rows.';

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
  const printingId = overrides.printingId === undefined ? m11.printingId : overrides.printingId;
  return {
    entryId: 'entry-1',
    sessionId: 'manual',
    position: 1,
    state: 'pending',
    // A reviewed printing carries its card identity; an entry without one stays unresolved.
    cardId: printingId === null ? null : m11.cardId,
    printingId,
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
    status: 'ready',
    entries: printings.map((printing) => printingResult(printing)),
    totalCount: printings.length,
    continuation: null,
    revisions: {
      generation: 'imports-generation',
      catalogRevision: 'imports-revision',
      catalogPosition: '1',
      privateRevision: 'private-1',
    },
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
/**
 * Chooses one printing through a pending row's picker: the owner selects the entry the search
 * presents and expresses the explicit choice over it.
 */
async function chooseImportPrinting(
  page: Page,
  entryId: string,
  printingId: string,
): Promise<void> {
  const picker = page.locator(`[data-ui-import-picker="pending:${entryId}"]`);
  await picker.locator(`[data-ui-select="printing:${printingId}"]`).check();
  await picker.locator('[data-ui-tool="choose-entry"]').click();
}

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

  await row.locator('[data-ui-select="pending:entry-1"]').check();
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
  await expect(page.locator('#import-pending-list')).toHaveText('No pending entries to review.');
  expect(errors).toEqual([]);
});

/** One card-level search page of the review's card picker. */
function cardSearchPage(cards: readonly CardRecord[]) {
  return {
    status: 'ready',
    entries: cards.map((card) => ({
      key: `card:${card.cardId}`,
      target: { kind: 'card' as const, cardId: card.cardId },
      card: { cardId: card.cardId, name: card.name, matchedName: null },
      printing: null,
      quantity: null,
      tools: [],
    })),
    totalCount: cards.length,
    continuation: null,
    revisions: {
      generation: 'imports-generation',
      catalogRevision: 'imports-revision',
      catalogPosition: '1',
      privateRevision: 'private-1',
    },
  };
}

test('accepts an unowned deck from card names and quantities without creating copies', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  await control(page, 'scriptDestinationTags', []);
  await settle(page, 'settleSessions', (await requested(page, 'sessions')).id, []);

  // A pasted list of names stages one unresolved line: no printing is required to accept the deck.
  await page.fill('#import-source-text', '4 Lightning Bolt');
  await page.click('#import-source-submit');
  const source = await requested<Record<string, unknown>>(page, 'source');
  const sessionId = source.arguments.sessionId as string;
  const deck = session({ sessionId, sourceKind: 'pasted-list', sourceId: sessionId });
  await settle(page, 'settleSource', source.id, {
    session: deck,
    rows: [
      {
        position: 1,
        line: {
          name: 'Lightning Bolt',
          section: null,
          set: null,
          collectorNumber: null,
          language: null,
          finish: null,
          declaredQuantity: 4,
          problem: 'The source named no printing; choose one during review.',
        },
        outcome: 'staged',
        problem: 'The source named no printing; choose one during review.',
        entryId: 'entry-1',
        sessionId,
      },
    ],
    staged: 1,
  });
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [deck]);

  const unresolved = entry({
    sessionId,
    printingId: null,
    finish: null,
    cardId: null,
    quantity: 4,
  });
  await settle(page, 'settleEntries', (await requested(page, 'entries')).id, {
    session: deck,
    entries: [unresolved],
  });
  const row = page.locator('#import-pending [data-ui-entry="pending:entry-1"]');
  await expect(row.locator('[data-ui-import-card]')).toHaveText('Card: unresolved');
  // The ownership destination presents physical attributes; the deck destination does not.
  await expect(row.locator('[data-ui-import-finish]')).toHaveCount(1);

  // Reviewing the card identity needs no printing: the card picker resolves the playable identity.
  await page.fill('#import-card-query-entry-1', 'Lightning Bolt');
  await page.click('#import-card-find-entry-1');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  expect(search.arguments).toMatchObject({ resultLevel: 'card', query: 'Lightning Bolt' });
  await settle(page, 'settleSearch', search.id, cardSearchPage([boltCard]));
  const picker = page.locator('[data-ui-import-picker="pending:entry-1"]');
  await picker.locator(`[data-ui-select="card:${boltCard.cardId}"]`).check();
  await picker.locator('[data-ui-tool="choose-entry"]').click();
  // The choice reaches the form with its identity; the card's name follows the next read.
  await expect(page.locator('#import-review-card-entry-1')).toHaveText('Card card-bolt');

  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  expect(review.arguments).toMatchObject({
    entryId: 'entry-1',
    cardId: boltCard.cardId,
    printingId: null,
    finish: null,
    quantity: 4,
  });
  const reviewed = entry({
    sessionId,
    cardId: boltCard.cardId,
    printingId: null,
    finish: null,
    quantity: 4,
    revision: 4,
  });
  await settle(page, 'settleReview', review.id, { entry: reviewed, session: deck });
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: deck,
    entries: [reviewed],
  });
  await expect(page.locator('#import-review-card-entry-1')).toHaveText(
    'Lightning Bolt (card-bolt)',
  );

  // The owner names the deck the list is accepted into without leaving the review.
  await page.fill('#import-new-deck', 'Burn');
  await page.click('#import-create-deck');
  const creation = await requested<Record<string, unknown>>(page, 'createdTags');
  expect(creation.arguments).toEqual({ kind: 'deck', label: 'Burn' });
  const burn: Tag = {
    tagId: 'tag-burn',
    kind: 'deck',
    label: 'Burn',
    system: false,
    revision: 1,
  };
  await control(page, 'scriptDestinationTags', [burn]);
  await settle(page, 'settleCreateTag', creation.id, burn);
  await expect(page.locator('#import-destination')).toHaveValue(`tag:${burn.tagId}`);
  await expect(page.locator('#import-destination-region')).toContainText(
    'Deck “Burn” is the destination.',
  );
  // Physical attributes are not presented while a deck destination is chosen.
  await expect(row.locator('[data-ui-import-finish]')).toHaveCount(0);
  await expect(row.locator('[data-ui-import-condition]')).toHaveCount(0);

  await row.locator('[data-ui-select="pending:entry-1"]').check();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  expect(confirmation.arguments).toMatchObject({
    sessionId,
    destination: { kind: 'tag', tagId: burn.tagId },
    entries: [{ entryId: 'entry-1', expectedRevision: 4 }],
  });
  await settle(page, 'settleConfirm', confirmation.id, {
    operationId: confirmation.arguments.operationId as string,
    sessionId,
    sourceKind: 'pasted-list',
    sourceId: sessionId,
    destination: { kind: 'tag', tagId: burn.tagId },
    associations: [
      {
        associationId: 'association-1',
        tagId: burn.tagId,
        targetLevel: 'card',
        targetId: boltCard.cardId,
        quantity: 4,
        revision: 1,
      },
    ],
    copies: [],
  });
  await expect(page.locator('#import-review-status')).toHaveText(
    'Confirmed: 1 association recorded in the destination tag.',
  );

  // The accepted import leaves the review without reporting a copy or an owned change.
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 2)).id, []);
  const finished = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', finished.id, {
    session: session({
      sessionId,
      sourceKind: 'pasted-list',
      sourceId: sessionId,
      state: 'confirmed',
      pendingEntries: 0,
      confirmedEntries: 1,
      revision: 5,
    }),
    entries: [],
  });
  await expect(page.locator('#import-pending-list')).toHaveText('No pending entries to review.');
  expect(errors).toEqual([]);
});

test('restores the deck destination the review chose on the way back', async ({ page }) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  await control(page, 'scriptDestinationTags', []);
  await settle(page, 'settleSessions', (await requested(page, 'sessions')).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries')).id, {
    session: session(),
    entries: [entry()],
  });

  // The owner names the deck the list is accepted into without leaving the review.
  await page.fill('#import-new-deck', 'Burn');
  await page.click('#import-create-deck');
  const creation = await requested<Record<string, unknown>>(page, 'createdTags');
  const burn: Tag = {
    tagId: 'tag-burn',
    kind: 'deck',
    label: 'Burn',
    system: false,
    revision: 1,
  };
  await control(page, 'scriptDestinationTags', [burn]);
  await settle(page, 'settleCreateTag', creation.id, burn);
  await expect(page.locator('#import-destination')).toHaveValue(`tag:${burn.tagId}`);

  // Leaving the review and returning applies the destination the owner chose; the selected deck is
  // never silently replaced by the ownership action.
  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session(),
    entries: [entry()],
  });
  await expect(page.locator('#import-destination')).toHaveValue(`tag:${burn.tagId}`);
  await expect(page.locator('#import-destination option:checked')).toHaveText('Deck: Burn');
  expect(errors).toEqual([]);
});

test('repeats a failed destination read through refresh and keeps the chosen deck', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import', {
    failDestinationReads: { code: 'unavailable', message: 'Offline' },
  });
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  await settle(page, 'settleSessions', (await requested(page, 'sessions')).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries')).id, {
    session: session(),
    entries: [entry()],
  });

  // A destination read that failed stays visible beside the control that repeats it, and as the
  // shell's notice with the same refresh.
  await expect(page.locator('#import-destination-status')).toContainText(
    'The destinations could not be read: Offline',
  );
  const notice = page.locator('[data-ui-notice="navigation:page:alice:import-destinations"]');
  await expect(notice).toContainText('The destinations could not be read');

  const burn: Tag = {
    tagId: 'tag-burn',
    kind: 'deck',
    label: 'Burn',
    system: false,
    revision: 1,
  };
  await control(page, 'scriptDestinationFailure', null);
  await control(page, 'scriptDestinationTags', [burn]);
  await page.click('#import-refresh');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session(),
    entries: [entry()],
  });
  await expect(page.locator('#import-destination option[value="tag:tag-burn"]')).toHaveCount(1);
  await expect(page.locator('#import-destination-status')).toHaveText('');
  await expect(notice).toHaveCount(0);

  // The deck the owner selected stays selected while the read it needs fails again.
  await page.selectOption('#import-destination', `tag:${burn.tagId}`);
  await control(page, 'scriptDestinationFailure', { code: 'unavailable', message: 'Offline' });
  await page.click('#import-refresh');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 2)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 2)).id, {
    session: session(),
    entries: [entry()],
  });
  await expect(page.locator('#import-destination')).toHaveValue(`tag:${burn.tagId}`);
  await expect(page.locator('#import-destination-status')).toContainText(
    'The destinations could not be read',
  );

  // The next successful read presents a destination added since and keeps the chosen one.
  const swamp: Tag = {
    tagId: 'tag-swamp',
    kind: 'deck',
    label: 'Swamp',
    system: false,
    revision: 1,
  };
  await control(page, 'scriptDestinationFailure', null);
  await control(page, 'scriptDestinationTags', [burn, swamp]);
  await page.click('#import-refresh');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 3)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 3)).id, {
    session: session(),
    entries: [entry()],
  });
  await expect(page.locator('#import-destination option[value="tag:tag-swamp"]')).toHaveCount(1);
  await expect(page.locator('#import-destination')).toHaveValue(`tag:${burn.tagId}`);
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
  // The row's picker offers the printing the search resolved, and the review saves it by its id.
  await chooseImportPrinting(page, 'entry-capture', m10.printingId);
  await expect(page.locator('#import-review-printing-entry-capture')).toHaveText('M10 146 · en');
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

test('reads further printing pages of a review search and saves an exact printing', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry({ printingId: null, finish: null })]);
  await page.fill('#import-printing-query-entry-1', 'Lightning Bolt');
  await page.click('#import-printing-find-entry-1');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  await settle(page, 'settleSearch', search.id, searchSlice([m11], 'printing-page-2'));
  const picker = page.locator('[data-ui-import-picker="pending:entry-1"]');
  await expect(picker.locator('[data-ui-entry]')).toHaveCount(1);

  // The exact printing is beyond the first page: the picker offers the continuation of the rest,
  // owned by the list it is built over (docs/card-list.md#interface).
  await picker.locator('[data-ui-more]').click();
  const next = await requested<Record<string, unknown>>(page, 'searches', 1);
  expect(next.arguments.continuation).toBe('printing-page-2');
  await settle(page, 'settleSearch', next.id, searchSlice([m10], null));
  await expect(picker.locator('[data-ui-entry]')).toHaveCount(2);
  await expect(picker.locator('[data-ui-more]')).toBeHidden();

  await chooseImportPrinting(page, 'entry-1', m10.printingId);
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  await page.selectOption('#import-review-finish-entry-1', 'nonfoil');
  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  expect(review.arguments).toMatchObject({ printingId: m10.printingId, finish: 'nonfoil' });
  await settle(page, 'settleReview', review.id, {
    entry: entry({ printingId: m10.printingId, finish: 'nonfoil', revision: 4 }),
    session: session({ revision: 5 }),
  });
  const refreshed = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', refreshed.id, {
    session: session({ revision: 5 }),
    entries: [entry({ printingId: m10.printingId, finish: 'nonfoil', revision: 4 })],
  });
  await expect(
    page.locator('#import-pending [data-ui-entry="pending:entry-1"] [data-ui-import-printing]'),
  ).toHaveText('Printing: M10 146 · en');
  expect(errors).toEqual([]);
});

test('reports an indexing printing search instead of offering no printing', async ({ page }) => {
  const errors = await openPendingReview(page, [
    entry({
      entryId: 'entry-capture',
      printingId: null,
      finish: null,
      candidates: [{ printingId: m10.printingId, provider: 'visual', evidence: 'art-match' }],
    }),
  ]);
  await page.fill('#import-printing-query-entry-capture', 'Lightning Bolt');
  await page.click('#import-printing-find-entry-capture');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  // The index has no complete answer yet: mapping the empty page to no printing would tell the
  // account that the catalog publishes none for the search (docs/search.md#freshness).
  await settle(page, 'settleSearch', search.id, {
    status: 'updating',
    entries: [],
    totalCount: null,
    continuation: null,
    revisions: null,
  });

  const picker = page.locator('[data-ui-import-picker="pending:entry-capture"]');
  await expect(picker.locator('[data-ui-status]')).toHaveText(
    'The search results are still being indexed.',
  );
  await expect(picker.locator('[data-ui-entry]')).toHaveCount(0);
  await expect(page.locator('#import-entry-status-entry-capture')).toBeEmpty();
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
      'records it reported are listed.',
  );
  const afterRecovery = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', afterRecovery.id, []);
  expect(errors).toEqual([]);
});

test('rereads an already open import after an unknown staging outcome', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.fill('#import-manual-query', 'Lightning Bolt');
  await page.click('#import-manual-submit');
  const search = await requested<Record<string, unknown>>(page, 'searches');
  await settle(page, 'settleSearch', search.id, searchPage([m11]));
  await page.locator('#import-results [data-ui-select]').check();
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const staged = await requested<Record<string, unknown>>(page, 'stage');
  await control(page, 'fail', staged.id, { code: 'busy', message: 'Response lost after commit.' });
  // The staging outcome is not established: the editor keeps the retained attempt and the shell's
  // notice keeps the failure visible with that same explicit retry
  // (docs/ui/navigation.md#error-notices).
  const notice = page.locator('[data-ui-notice="navigation:page:alice:import-manual"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice.getByRole('button', { name: 'Retry the pending staging' })).toBeVisible();
  const sessions = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', sessions.id, [session()]);
  const reread = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', reread.id, {
    session: session(),
    entries: [entry(), { ...entry(), entryId: 'new-entry' }],
  });
  await expect(page.locator('#import-pending [data-ui-entry="pending:new-entry"]')).toBeVisible();
  expect(await control<unknown[]>(page, 'stage')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('keeps one line identity when a staging response is lost and retries it explicitly', async ({
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

  // The outcome is unknown: the page reads the pending import again and presents the retained
  // attempt with the retry its outcome needs.
  await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
    'The staging outcome is unknown',
  );
  const refresh = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', refresh.id, []);
  await expect(page.locator('#import-manual-recovery')).toBeVisible();

  // Adding more lines while that attempt is unresolved is refused before anything is dispatched.
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
    'Retry it before adding more lines',
  );
  expect(await control<unknown[]>(page, 'stage')).toHaveLength(1);

  const notice = page.locator('[data-ui-notice="navigation:page:alice:import-manual"]');
  await expect(notice).toContainText('The staging outcome is unknown');
  await notice.getByRole('button', { name: 'Retry the pending staging' }).click();
  const unresolved = await requested<Record<string, unknown>>(page, 'stage', 1);
  expect(unresolved.arguments).toEqual(first.arguments);
  await control(page, 'fail', unresolved.id, { code: 'unavailable', message: 'Still offline.' });
  await expect(page.locator('#import-manual-recover')).toBeEnabled();
  await expect(page.locator('[data-ui-notice]')).toHaveCount(1);
  await expect(notice).toContainText('The staging outcome is unknown');
  const retryRefresh = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', retryRefresh.id, []);

  // Retrying the retained attempt replays the line identity it was begun with.
  await page.click('#import-manual-recover');
  const second = await requested<Record<string, unknown>>(page, 'stage', 2);
  const secondLine = (second.arguments.entries as readonly Record<string, unknown>[])[0];
  expect(secondLine?.entryId).toBe(firstLine?.entryId);
  await settle(page, 'settleStage', second.id, {
    session: session(),
    entries: [entry()],
    staged: 0,
    replayed: true,
  });
  await expect(page.locator('#import-manual-status')).toHaveText(
    'Those lines were already in review; no new entries were added.',
  );
  await expect(page.locator('#import-manual-recovery')).toBeHidden();
  await expect(page.locator('[data-ui-notice]')).toHaveCount(0);
  const reconciled = await requested<UiImportSessionsRequest>(page, 'sessions', 3);
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
  await expect(page.locator('#import-pending-list')).toHaveText('No pending entries to review.');

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
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M11 149 · en');

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

  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M11 149 · en');
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
  await chooseImportPrinting(page, 'entry-1', m11.printingId);
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M11 149 · en');
  // The record of the chosen printing is read, so the finish control follows its finishes.
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

for (const duringRecovery of [false, true]) {
  test(`a rejected confirmation removes unavailable recovery actions (recovery: ${duringRecovery})`, async ({
    page,
  }) => {
    const errors = await openPendingReview(page, [entry()]);
    await page.locator('#import-pending [data-ui-select]').check();
    await page.click('#import-pending [data-ui-tool="confirm-import"]');
    const confirmation = await requested(page, 'confirm');
    const notice = page.locator('[data-ui-notice="navigation:page:alice:import-confirm"]');
    if (duringRecovery) {
      await control(page, 'fail', confirmation.id, {
        code: 'unavailable',
        message: 'Lost response',
      });
      await control(page, 'fail', (await requested(page, 'recover')).id, {
        code: 'unavailable',
        message: 'Offline',
      });
      await expect(page.locator('#import-recover')).toBeEnabled();
      await notice.getByRole('button', { name: 'Check the confirmation outcome' }).click();
      await settle(page, 'settleRecover', (await requested(page, 'recover', 1)).id, {
        outcome: 'absent',
      });
      await expect(notice).toContainText('not recorded');
    } else {
      await control(page, 'fail', confirmation.id, {
        code: 'conflict',
        message: 'Review changed.',
      });
      await expect(notice).toContainText('Review changed.');
      expect(await control<unknown[]>(page, 'recover')).toHaveLength(0);
    }
    await expect(page.locator('#import-recover')).toBeHidden();
    await expect(
      notice.getByRole('button', { name: 'Check the confirmation outcome' }),
    ).toHaveCount(0);
    await expect(notice.getByRole('button', { name: 'Dismiss' })).toBeVisible();
    expect(await control<unknown[]>(page, 'confirm')).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

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
  // The unresolved confirmation is an operation failure of the presented view: the floating
  // notice keeps it visible after the view is left, with the recorded outcome that establishes
  // what the confirmation created (docs/ui/navigation.md#error-notices).
  const notice = page.locator('[data-ui-notice="navigation:page:alice:import-confirm"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice.locator('.ui-notice-mark')).toHaveText('Error:');
  await expect(notice.locator('.ui-notice-spinner')).toBeHidden();
  await expect(
    notice.getByRole('button', { name: 'Check the confirmation outcome' }),
  ).toBeVisible();

  // Reading the pending import finds the confirmed session without any pending entry left.
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', listing.id, []);
  const read = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', read.id, {
    session: session({ state: 'confirmed', pendingEntries: 0, confirmedEntries: 1, revision: 6 }),
    entries: [],
  });
  await expect(page.locator('#import-pending-list')).toHaveText('No pending entries to review.');

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
    'Confirmed: 1 physical copy created. This confirmation had already been recorded; the records ' +
      'it reported are listed.',
  );
  // The established outcome ends the notice of the confirmation it resolved.
  await expect(notice).toHaveCount(0);
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
    'Confirmed: 1 physical copy created. This confirmation had already been recorded; the records ' +
      'it reported are listed.',
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

test('restarts the pending entries when their continuation was invalidated', async ({ page }) => {
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
  await page.locator('#import-pending [data-ui-entry="pending:entry-1"] [data-ui-select]').check();

  await page.locator('#import-pending [data-ui-more]').click();
  const stale = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  expect(stale.arguments.continuation).toBe('cursor-50');
  await settle(page, 'fail', stale.id, {
    code: 'conflict',
    message: 'The private data changed after this page was read; start the pending import again.',
  });

  // The list restarts the pending entries from their first page, keeps the presented rows and
  // their selection, and never repeats the continuation the provider rejected.
  const restart = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  expect(restart.arguments).toEqual({ sessionId: 'manual', pageSize: 50, continuation: null });
  await expect(page.locator('#import-pending [data-ui-entry="pending:entry-1"]')).toHaveCount(1);
  await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText('1 selected');
  await settle(page, 'settleEntries', restart.id, {
    session: session({ pendingEntries: 51 }),
    entries: all.slice(0, 50),
  });
  await expect(page.locator('#import-pending [data-ui-entry="pending:entry-1"]')).toHaveCount(1);
  await expect(page.locator('#import-pending [data-ui-more]')).toBeHidden();
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
  type TrackedEditor = { retiredEditor: WeakRef<Element> };
  await page.locator('[data-ui-import-editor="pending:entry-1"]').evaluate((editor) => {
    (globalThis as unknown as TrackedEditor).retiredEditor = new WeakRef(editor);
  });

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
  await page.requestGC();
  expect(
    await page.evaluate(
      () => (globalThis as unknown as TrackedEditor).retiredEditor.deref() === undefined,
    ),
  ).toBe(true);

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
    const picker = page.locator('[data-ui-import-picker="pending:entry-1"]');
    await page.fill('#import-printing-query-entry-1', 'newer');

    if (obsolete === 'changed session') {
      // Selecting another import releases the row's picker: the obsolete search cannot present
      // through a view that no longer holds it.
      await page.selectOption('#import-session', 'capture');
      const otherRead = await requested(page, 'entries', 1);
      await settle(page, 'settleEntries', otherRead.id, {
        session: other,
        entries: [entry({ entryId: 'other', sessionId: 'capture' })],
      });
      await settle(page, 'settleSearch', older.id, searchPage([m10]));
      await expect(page.locator('[data-ui-import-picker="pending:entry-1"]')).toHaveCount(0);
      await page.selectOption('#import-session', 'manual');
      const back = await requested(page, 'entries', 2);
      await settle(page, 'settleEntries', back.id, { session: session(), entries: [entry()] });
      await expect(page.locator('#import-printing-query-entry-1')).toHaveValue('newer');
      expect(errors).toEqual([]);
      return;
    }

    if (obsolete === 'edited query') {
      // The typed expression stays the row's draft; the picker presents the search the owner
      // submitted, and the list owns ignoring an answer a newer search superseded.
      await settle(page, 'settleSearch', older.id, searchPage([m10]));
      await expect(page.locator('#import-printing-query-entry-1')).toHaveValue('newer');
      await expect(picker.locator('[data-ui-entry]')).toHaveCount(1);
      expect(errors).toEqual([]);
      return;
    }

    // A further search refines the picker's own list; the obsolete answer never replaces it.
    await page.click('#import-printing-find-entry-1');
    const newer = await requested(page, 'searches', 1);
    if (obsolete === 'failure') {
      await control(page, 'fail', older.id, { code: 'unavailable', message: 'Obsolete failure' });
    }
    await settle(page, 'settleSearch', newer.id, searchPage([m10]));
    await expect(picker.locator('[data-ui-status]')).toHaveText('');
    await expect(picker.locator('[data-ui-entry]')).toHaveCount(1);
    if (obsolete === 'success') {
      await settle(page, 'settleSearch', older.id, searchPage([]));
      await expect(picker.locator('[data-ui-entry]')).toHaveCount(1);
      await expect(picker.locator('[data-ui-status]')).toHaveText('');
    }
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

test('restores a source reference within the bound its control accepts', async ({ page }) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  // A reference longer than one identifier but inside the source-reference bound is accepted by the
  // control, so leaving the view and returning must present it unchanged
  // (docs/user-cards.md#browser-operation-lifecycle).
  const official = 'https://magic.wizards.com/en/news/feature/';
  const reference = `${official}${'deadly-disguise-'.repeat(16)}`;
  expect(reference.length).toBeGreaterThan(200);
  expect(reference.length).toBeLessThanOrEqual(500);
  await page.selectOption('#import-source-format', 'wizards-precon');
  await page.fill('#import-source-identity', 'wizards:mkm:deadly-disguise:regular:en');
  await page.fill('#import-source-reference', reference);
  await page.fill('#import-source-lines', '1 Kadena, Slinking Sorcerer');

  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const restored = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', restored.id, []);
  await expect(page.locator('#import-source-reference')).toHaveValue(reference);
  await expect(page.locator('#import-source-identity')).toHaveValue(
    'wizards:mkm:deadly-disguise:regular:en',
  );
  expect(errors).toEqual([]);
});

test('reattaches the manual staging attempt a reload left unresolved', async ({ page }) => {
  const errors = await selectManualPrintings(page, 1);
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  const first = await requested<Record<string, unknown>>(page, 'stage');
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Lost response' });
  await expect(page.locator('#import-manual-recovery')).toBeVisible();
  const refresh = await requested(page, 'sessions', 1);
  await settle(page, 'settleSessions', refresh.id, []);

  // A reload reattaches the attempt UserCards retained: the page presents the retry its outcome
  // needs, and that retry reuses the line identities its request carried
  // (docs/user-cards.md#browser-operation-lifecycle).
  await page.reload();
  await loadImport(page);
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const restored = await requested(page, 'sessions');
  await settle(page, 'settleSessions', restored.id, []);
  await expect(page.locator('#import-manual-recovery')).toBeVisible();
  await page.click('#import-manual-recover');
  const retry = await requested<Record<string, unknown>>(page, 'stage');
  expect(retry.arguments.entries).toEqual(first.arguments.entries);
  await settle(page, 'settleStage', retry.id, {
    session: session(),
    entries: [entry()],
    staged: 1,
    replayed: false,
  });
  await expect(page.locator('#import-manual-status')).toContainText('1 line is in review');
  const reconciled = await requested(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconciled.id, [session()]);
  const read = await requested(page, 'entries');
  await settle(page, 'settleEntries', read.id, { session: session(), entries: [entry()] });
  await expect(page.locator('#import-pending [data-ui-entry="pending:entry-1"]')).toBeVisible();
  await expect(page.locator('#import-manual-recovery')).toBeHidden();
  expect(errors).toEqual([]);
});

test('begins a distinct import for the same source while another is unresolved', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  await page.selectOption('#import-source-format', 'moxfield');
  await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-same-0001');
  await page.click('#import-source-submit');
  const first = await requested<StageSourceImportInput>(page, 'source');
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });

  // The same contents and the same source URL never merge two imports: this submission begins an
  // import of its own, and the account keeps both attempts
  // (docs/user-cards.md#import-state-and-identity).
  await page.click('#import-source-submit');
  const second = await requested<StageSourceImportInput>(page, 'source', 1);
  expect(second.arguments).toMatchObject({
    format: 'moxfield',
    url: 'https://moxfield.com/decks/deck-same-0001',
  });
  expect(second.arguments.sessionId).not.toBe(first.arguments.sessionId);
  for (const request of [first, second]) {
    await expect(
      page.locator(
        `#import-source-waiting [data-ui-source-waiting="${request.arguments.sessionId}"]`,
      ),
    ).toBeVisible();
  }
  expect(errors).toEqual([]);
});

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
  await expect(page.locator('#import-manual-recovery')).toBeVisible();
  await page.click('#import-manual-recover');
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
  // Changing the manual input cannot mint new identities for an uncertain acquisition: the
  // retained attempt is the only identity the unresolved lines have.
  await page.fill('#import-manual-quantity', '2');
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
    'Retry it before adding more lines',
  );
  expect(await control<unknown[]>(page, 'stage')).toHaveLength(1);
  await page.fill('#import-manual-quantity', '1');
  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const restored = await requested(page, 'sessions', 2);
  await settle(page, 'settleSessions', restored.id, []);
  await restoreManualPrintings(page, 501);
  // The retained attempt survives the view change and retries the batch it was begun with.
  await expect(page.locator('#import-manual-recovery')).toBeVisible();
  await page.click('#import-manual-recover');
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
    const unreadable = context === 'missing lookup' || context === 'failed lookup';
    // The record of the printing the row reads may be missing (or its read may fail): the choice
    // keeps its identity while the finish control falls back to the published vocabulary.
    await scriptCatalog(page, {
      cards: [boltCard],
      printings: unreadable ? [m11] : [m11, foil],
    });
    await page.fill('#import-printing-query-entry-1', 'set:m10');
    await page.click('#import-printing-find-entry-1');
    const search = await requested(page, 'searches');
    await settle(page, 'settleSearch', search.id, searchPage([foil]));
    await chooseImportPrinting(page, 'entry-1', foil.printingId);
    if (unreadable) {
      await expect(page.locator('#import-review-printing-entry-1')).toHaveText(
        `Printing ${foil.printingId}`,
      );
      await expect(page.locator('#import-review-finish-entry-1')).toHaveValue('nonfoil');
    } else {
      await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
      await expect(page.locator('#import-review-finish-entry-1')).toHaveValue('');
    }
    if (context === 'another search') {
      await page.fill('#import-printing-query-entry-1', 'set:m11');
      await page.click('#import-printing-find-entry-1');
      const newer = await requested(page, 'searches', 1);
      await settle(page, 'settleSearch', newer.id, searchPage([m11]));
      await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
    } else if (context === 'Back') {
      await control(page, 'navigate', { page: 'home' });
      await control(page, 'back');
      const sessions = await requested(page, 'sessions', 1);
      await settle(page, 'settleSessions', sessions.id, [session()]);
      const entries = await requested(page, 'entries', 1);
      await settle(page, 'settleEntries', entries.id, { session: session(), entries: [entry()] });
      await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
    }
    const catalogCount = (await control<unknown[]>(page, 'catalogRequests')).length;
    if (context === 'failed lookup') await control(page, 'scriptCatalog', null);
    await page.click('#import-review-save-entry-1');
    if (context === 'failed lookup') {
      const lookup = await requested(page, 'catalogRequests', catalogCount);
      await control(page, 'fail', lookup.id, { code: 'unavailable', message: 'Offline' });
    }
    if (unreadable) {
      // A chosen printing the review cannot read is never saved as another printing.
      await expect(page.locator('#import-entry-status-entry-1')).toContainText(
        context === 'missing lookup' ? 'unavailable' : 'could not be read',
      );
      expect(await control<unknown[]>(page, 'review')).toHaveLength(0);
      await expect(page.locator('#import-review-printing-entry-1')).toHaveText(
        `Printing ${foil.printingId}`,
      );
      await expect(page.locator('#import-printing-query-entry-1')).toHaveValue('set:m10');
    } else {
      const review = await requested<Record<string, unknown>>(page, 'review');
      expect(review.arguments).toMatchObject({ printingId: foil.printingId, finish: 'foil' });
    }
    expect(errors).toEqual([]);
  });
}

test('a failed printing read clears when reopening the review presents the printing', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  const foil: PrintingRecord = { ...m10, finishes: ['nonfoil', 'foil'] };
  // The search offers a printing the catalog does not publish: choosing it keeps the choice's
  // identity while the lookup that would resolve its record stays unanswered.
  await page.fill('#import-printing-query-entry-1', 'set:m10');
  await page.click('#import-printing-find-entry-1');
  await settle(page, 'settleSearch', (await requested(page, 'searches')).id, searchPage([foil]));
  const reads = (await control<unknown[]>(page, 'catalogRequests')).length;
  await control(page, 'scriptCatalog', null);
  await chooseImportPrinting(page, 'entry-1', foil.printingId);
  await settle(page, 'settleCatalog', (await requested(page, 'catalogRequests', reads)).id, {});
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText(
    `Printing ${foil.printingId}`,
  );

  // Saving re-reads the printing it must quote; the lookup fails, so the row keeps the failure
  // beside the printing it names and the shell keeps it visible under the identity of this
  // entry's catalog read (docs/ui/navigation.md#error-notices).
  await page.click('#import-review-save-entry-1');
  await control(page, 'fail', (await requested(page, 'catalogRequests', reads + 1)).id, {
    code: 'unavailable',
    message: 'Offline',
  });
  await expect(page.locator('#import-entry-status-entry-1')).toContainText('could not be read');
  const notice = page.locator(
    '[data-ui-notice="navigation:page:alice:import-entry:entry-1:printing"]',
  );
  await expect(notice).toContainText('The selected printing could not be read');
  expect(await control<unknown[]>(page, 'review')).toHaveLength(0);

  // Leaving the review keeps the service failure visible.
  await control(page, 'navigate', { page: 'home' });
  await expect(notice).toContainText('The selected printing could not be read');

  // Returning reads the entries again — the stored printing stays unanswered for this fixture —
  // and the review reads the printing its draft names once more. That lookup answers, so it
  // reconciles the failure the replaced editor presented
  // (docs/ui/navigation.md#error-notices).
  await control(page, 'back');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session(),
    entries: [entry()],
  });
  await settle(page, 'settleCatalog', (await requested(page, 'catalogRequests', reads + 2)).id, {});
  await settle(page, 'settleCatalog', (await requested(page, 'catalogRequests', reads + 3)).id, {
    printings: [foil],
  });
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('reopening reconciles a failed printing read supplied by CardList enrichment', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, {});
  await settle(page, 'settleSessions', (await requested(page, 'sessions')).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries')).id, {
    session: session(),
    entries: [entry()],
  });
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText(
    `Printing ${m11.printingId}`,
  );
  // Neither the list enrichment nor the editor's fallback resolved the unchanged printing.
  await expect.poll(async () => (await control<unknown[]>(page, 'catalogRequests')).length).toBe(2);
  await control(page, 'scriptCatalog', null);
  await page.click('#import-review-save-entry-1');
  await control(page, 'fail', (await requested(page, 'catalogRequests', 2)).id, {
    code: 'unavailable',
    message: 'Offline',
  });
  const notice = page.locator(
    '[data-ui-notice="navigation:page:alice:import-entry:entry-1:printing"]',
  );
  await expect(notice).toContainText('The selected printing could not be read');
  await control(page, 'navigate', { page: 'home' });
  await expect(notice).toBeVisible();
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  await control(page, 'back');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session(),
    entries: [entry()],
  });
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M11 149 · en');
  await expect(notice).toHaveCount(0);
  expect(await control<unknown[]>(page, 'review')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('keeps an unestablished review outcome when a later printing read fails', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  // The entry names a printing the review already read, so the save is attempted without a lookup
  // and its lost response stays unestablished.
  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  await control(page, 'fail', review.id, { code: 'unavailable', message: 'Lost response' });
  const write = page.locator('[data-ui-notice="navigation:page:alice:import-entry:entry-1"]');
  await expect(write).toContainText('The review outcome is unknown');
  await expect(page.locator('#import-entry-status-entry-1')).toHaveText(
    'The review outcome is unknown. Reload the pending import before retrying.',
  );
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session(),
    entries: [entry()],
  });

  // A later review of another printing fails its lookup before any write: the read reports its own
  // failure without displacing the warning for the write that stays unresolved
  // (docs/ui/navigation.md#error-notices).
  await page.fill('#import-printing-query-entry-1', 'set:m10');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches')).id,
    searchPage([{ ...m10, finishes: ['nonfoil', 'foil'] }]),
  );
  const reads = (await control<unknown[]>(page, 'catalogRequests')).length;
  await control(page, 'scriptCatalog', null);
  await chooseImportPrinting(page, 'entry-1', m10.printingId);
  await settle(page, 'settleCatalog', (await requested(page, 'catalogRequests', reads)).id, {});
  await page.click('#import-review-save-entry-1');
  await control(page, 'fail', (await requested(page, 'catalogRequests', reads + 1)).id, {
    code: 'unavailable',
    message: 'Offline',
  });
  await expect(page.locator('#import-entry-status-entry-1')).toContainText('could not be read');
  const read = page.locator(
    '[data-ui-notice="navigation:page:alice:import-entry:entry-1:printing"]',
  );
  await expect(read).toContainText('The selected printing could not be read');
  await expect(write).toContainText('The review outcome is unknown');
  expect(await control<unknown[]>(page, 'review')).toHaveLength(1);
  expect(errors).toEqual([]);
});

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
      await page.click('#import-manual-recover');
      attempt = await requested<Record<string, unknown>>(page, 'stage', 1);
      expect(attempt.arguments.entries).toEqual(original);
    }
    await control(page, 'fail', attempt.id, {
      code: 'invalid-request',
      message: 'Unsupported attributes',
    });
    if (priorUnknown) {
      // A refused retry of an unresolved attempt does not establish that it did not write: the
      // outcome stays open, and the retained identity stays the one the lines were staged under.
      await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
        'The staging outcome is unknown',
      );
      await expect(page.locator('#import-manual-recovery')).toBeVisible();
    } else {
      await expect(page.locator('#import-results [data-ui-outcome]')).toContainText(
        'Unsupported attributes',
      );
    }
    await page.fill('#import-manual-quantity', '2');
    await page.click('#import-results [data-ui-tool="add-to-review"]');
    if (priorUnknown) {
      // A refused retry does not establish the earlier attempt: the retained identity stays the
      // one the lines were staged under, and changed values are never dispatched under it.
      await expect(page.locator('#import-manual-recovery')).toBeVisible();
      expect(await control<unknown[]>(page, 'stage')).toHaveLength(2);
    } else {
      const corrected = await requested<Record<string, unknown>>(page, 'stage', 1);
      expect(corrected.arguments.entries).toMatchObject([{ quantity: 2 }]);
    }
    expect(errors).toEqual([]);
  });
}

/** One parsed line of the Lightning Bolt paste the source journeys present. */
const boltSourceLine = {
  name: 'Lightning Bolt',
  section: null,
  set: 'M11',
  collectorNumber: '149',
  language: null,
  finish: null,
  declaredQuantity: 4,
  problem: 'The source named no printing; choose one during review.',
};

/** The Counterspell line of the two-line paste the recovery journey presents. */
const counterspellSourceLine = {
  name: 'Counterspell',
  section: null,
  set: '7ED',
  collectorNumber: '67',
  language: null,
  finish: null,
  declaredQuantity: 2,
  problem: 'The source named no printing; choose one during review.',
};

/**
 * The import identity one source request quoted: a non-empty identity inside the bound every
 * UserCards reference accepts. Contents and source URLs describe an import; they never identify it
 * (docs/user-interface.md#source-imports).
 */
function sourceImportIdentity(request: StageSourceImportInput): string {
  expect(request.sessionId.length).toBeGreaterThan(0);
  expect(request.sessionId.length).toBeLessThanOrEqual(200);
  return request.sessionId;
}

test('parses a pasted source into the same pending review and explains every row', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  await expect(page.locator('#import-source-heading')).toBeVisible();
  await expect(page.locator('#import-source-note')).toHaveText(
    'Parsing a source only stages pending entries. Confirm the reviewed lines to create their ' +
      'physical copies.',
  );

  // The page identifies the import it composes: that identity crosses the contract with the paste,
  // instead of the entered contents describing or merging the import
  // (docs/user-interface.md#source-imports).
  await page.selectOption('#import-source-format', 'pasted-list');
  await expect(page.locator('#import-source-url')).toBeHidden();
  await page.fill('#import-source-text', '4 Lightning Bolt (M11) 149\nnot a line');
  await page.click('#import-source-submit');

  const parsed = await requested<StageSourceImportInput>(page, 'source');
  expect(parsed.arguments).toMatchObject({
    format: 'pasted-list',
    text: '4 Lightning Bolt (M11) 149\nnot a line',
  });
  expect(sourceImportIdentity(parsed.arguments)).toBe(parsed.arguments.sessionId);

  const parsedSession = session({
    sessionId: parsed.arguments.sessionId,
    sourceKind: 'pasted-list',
    sourceId: parsed.arguments.sessionId,
    pendingEntries: 1,
  });
  await settle(page, 'settleSource', parsed.id, {
    session: parsedSession,
    rows: [
      {
        position: 1,
        line: boltSourceLine,
        outcome: 'staged',
        problem: boltSourceLine.problem,
        entryId: 'source-entry-1',
        sessionId: parsedSession.sessionId,
      },
      {
        position: 2,
        line: null,
        outcome: 'invalid',
        problem: 'Use “quantity card name”, optionally followed by “(SET) number”.',
        entryId: null,
        sessionId: null,
      },
    ],
    staged: 1,
  });

  // The progress names the line in review and the separate row that could not be read; no part of
  // it claims ownership.
  await expect(page.locator('#import-source-status')).toHaveText(
    '1 line is in review; 1 row could not be read. Confirm the reviewed lines to create their ' +
      'physical copies.',
  );
  const rows = page.locator('#import-source-rows li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText(
    'Row 1 · added to review · Lightning Bolt · (M11 149) · The source named no printing; ' +
      'choose one during review.',
  );
  await expect(rows.nth(1)).toHaveText(
    'Row 2 · not read · Use “quantity card name”, optionally followed by “(SET) number”.',
  );

  // The parsed rows belong to a pending import the review presents like manual entry.
  const refresh = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', refresh.id, [parsedSession]);
  const read = await requested<UiImportEntriesRequest>(page, 'entries');
  expect(read.arguments).toEqual({
    sessionId: parsedSession.sessionId,
    pageSize: 50,
    continuation: null,
  });
  await settle(page, 'settleEntries', read.id, {
    session: parsedSession,
    entries: [
      entry({
        entryId: 'source-entry-1',
        sessionId: parsedSession.sessionId,
        printingId: null,
        finish: null,
        quantity: 4,
        sourceLine: boltSourceLine,
      }),
    ],
  });
  await expect(
    page.locator(
      '#import-pending [data-ui-entry="pending:source-entry-1"] [data-ui-import-source]',
    ),
  ).toHaveText(
    ' Source: Lightning Bolt · (M11 149) · The source named no printing; choose one during review.',
  );
  await expect(page.locator('#import-provenance')).toHaveText('Pasted list');
  expect(errors).toEqual([]);
});

test('starts another import for the same paste instead of merging with the first', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  const firstSession = session({
    sessionId: 'pasted-list:1',
    sourceKind: 'pasted-list',
    sourceId: 'pasted-list:1',
    pendingEntries: 1,
  });
  const stored = (sessionId: string, entryId: string, position = 1) =>
    entry({
      entryId,
      sessionId,
      position,
      printingId: null,
      finish: null,
      quantity: 4,
      sourceLine: boltSourceLine,
    });

  await page.fill('#import-source-text', '4 Lightning Bolt (M11) 149');
  await page.click('#import-source-submit');
  const first = await requested<StageSourceImportInput>(page, 'source');
  await settle(page, 'settleSource', first.id, {
    session: firstSession,
    rows: [
      {
        position: 1,
        line: boltSourceLine,
        outcome: 'staged',
        problem: boltSourceLine.problem,
        entryId: 'source-entry-1',
        sessionId: firstSession.sessionId,
      },
    ],
    staged: 1,
  });
  const presented = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', presented.id, [firstSession]);
  const read = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', read.id, {
    session: firstSession,
    entries: [stored(firstSession.sessionId, 'source-entry-1')],
  });

  // The established import is not reopened by the same paste: the page starts another import with
  // its own identity, and that list's lines enter review as its own pending entries
  // (docs/user-interface.md#source-imports).
  await page.click('#import-source-submit');
  const second = await requested<StageSourceImportInput>(page, 'source', 1);
  expect(sourceImportIdentity(second.arguments)).not.toBe(first.arguments.sessionId);
  const secondSession = session({
    sessionId: 'pasted-list:2',
    sourceKind: 'pasted-list',
    sourceId: 'pasted-list:2',
    pendingEntries: 1,
  });
  await settle(page, 'settleSource', second.id, {
    session: secondSession,
    rows: [
      {
        position: 1,
        line: boltSourceLine,
        outcome: 'staged',
        problem: boltSourceLine.problem,
        entryId: 'source-entry-2',
        sessionId: secondSession.sessionId,
      },
    ],
    staged: 1,
  });
  await expect(page.locator('#import-source-status')).toHaveText(
    '1 line is in review. Confirm the reviewed lines to create their physical copies.',
  );
  await expect(page.locator('#import-source-rows li')).toHaveText(
    'Row 1 · added to review · Lightning Bolt · (M11 149) · The source named ' +
      'no printing; choose one during review.',
  );

  // The review presents the import that just staged, beside the first list the account keeps.
  const listed = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', listed.id, [secondSession, firstSession]);
  const listedEntries = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  expect(listedEntries.arguments).toMatchObject({ sessionId: 'pasted-list:2' });
  await settle(page, 'settleEntries', listedEntries.id, {
    session: secondSession,
    entries: [stored(secondSession.sessionId, 'source-entry-2')],
  });
  await expect(
    page.locator('#import-pending [data-ui-entry="pending:source-entry-2"]'),
  ).toBeVisible();
  await expect(page.locator('#import-session option')).toHaveCount(2);
  await expect(page.locator('#import-session')).toHaveValue('pasted-list:2');
  expect(errors).toEqual([]);
});

test('recovers a source whose response was lost and explains what the import holds', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  const paste = '4 Lightning Bolt (M11) 149\n2 Counterspell (7ED) 67';

  await page.fill('#import-source-text', paste);
  await page.click('#import-source-submit');
  const first = await requested<StageSourceImportInput>(page, 'source');
  expect(first.arguments).toMatchObject({ format: 'pasted-list', text: paste });
  await control(page, 'fail', first.id, {
    code: 'unavailable',
    message: 'The import could not be read within the time limit; no import is proven.',
  });
  await expect(page.locator('#import-source-status')).toHaveText(sourceOutcomeUnknown);
  await expect(page.locator('#import-source-waiting')).toContainText(
    'waiting for its recorded rows',
  );

  // The parse had committed: the page reads the import the account holds and presents it, so the
  // owner reviews the list a lost response would otherwise hide.
  const recorded = session({
    sessionId: first.arguments.sessionId,
    sourceKind: 'pasted-list',
    sourceId: first.arguments.sessionId,
    pendingEntries: 1,
  });
  const reconcile = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconcile.id, [recorded]);
  const read = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', read.id, {
    session: recorded,
    entries: [
      entry({
        entryId: 'source-entry-1',
        sessionId: recorded.sessionId,
        printingId: null,
        finish: null,
        quantity: 4,
        sourceLine: boltSourceLine,
      }),
    ],
  });

  // Reopening the waiting import keeps its identity, so the provider reports what it already holds
  // instead of staging the list twice.
  await reopenWaitingImport(page, first.arguments.sessionId);
  const retry = await requested<StageSourceImportInput>(page, 'source', 1);
  expect(retry.arguments).toEqual(first.arguments);
  await settle(page, 'settleSource', retry.id, {
    session: recorded,
    rows: [
      {
        position: 1,
        line: boltSourceLine,
        outcome: 'pending',
        problem: boltSourceLine.problem,
        entryId: 'source-entry-1',
        sessionId: recorded.sessionId,
      },
      {
        position: 2,
        line: counterspellSourceLine,
        outcome: 'acquired',
        problem: counterspellSourceLine.problem,
        entryId: 'source-entry-2',
        sessionId: recorded.sessionId,
      },
    ],
    staged: 0,
  });
  await expect(page.locator('#import-source-status')).toHaveText(
    '1 line was already in review; 1 line was already acquired by this import. Nothing new was ' +
      'staged; a reviewed line becomes a copy only through confirmation.',
  );
  const rows = page.locator('#import-source-rows li');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveText(
    'Row 1 · already in review · Lightning Bolt · (M11 149) · The source named no printing; ' +
      'choose one during review.',
  );
  await expect(rows.nth(1)).toHaveText(
    'Row 2 · already acquired by this import · Counterspell · (7ED 67) · The source named no ' +
      'printing; choose one during review.',
  );

  // The import is already the presented one: its own review reloads instead of being replaced, so
  // the owner keeps the entry the response never reported.
  const reload = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', reload.id, [recorded]);
  const reloaded = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', reloaded.id, {
    session: recorded,
    entries: [
      entry({
        entryId: 'source-entry-1',
        sessionId: recorded.sessionId,
        printingId: null,
        finish: null,
        quantity: 4,
        sourceLine: boltSourceLine,
      }),
    ],
  });
  await expect(
    page.locator('#import-pending [data-ui-entry="pending:source-entry-1"]'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps a source whose response was lost and recovers it by reopening its import', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  await page.selectOption('#import-source-format', 'moxfield');
  await expect(page.locator('#import-source-text')).toBeHidden();
  await expect(page.locator('#import-source-identity')).toBeHidden();
  await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-identity-0001');
  await page.click('#import-source-submit');
  const first = await requested<StageSourceImportInput>(page, 'source');
  expect(first.arguments).toMatchObject({
    format: 'moxfield',
    url: 'https://moxfield.com/decks/deck-identity-0001',
  });
  expect(sourceImportIdentity(first.arguments)).toBe(first.arguments.sessionId);
  await control(page, 'fail', first.id, {
    code: 'unavailable',
    message: 'Moxfield could not be reached within the time limit; no import changed.',
  });
  await expect(page.locator('#import-source-status')).toHaveText(sourceOutcomeUnknown);
  // The page reads what the account holds instead of inferring that the source staged nothing.
  const reconcile = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconcile.id, []);

  // Leaving the view keeps the unfinished import, so returning presents it as a waiting import
  // while the form keeps the link the owner typed.
  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const restored = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', restored.id, []);
  await expect(page.locator('#import-source-url')).toHaveValue(
    'https://moxfield.com/decks/deck-identity-0001',
  );
  await expect(
    page.locator(`#import-source-waiting [data-ui-source-waiting="${first.arguments.sessionId}"]`),
  ).toBeVisible();

  // The link describes the import and never identifies it: reopening the waiting import keeps the
  // identity it was begun with, so the provider reconciles this list instead of staging another.
  await reopenWaitingImport(page, first.arguments.sessionId);
  const retry = await requested<StageSourceImportInput>(page, 'source', 1);
  expect(retry.arguments).toEqual(first.arguments);
  const deckSession = session({
    sessionId: 'moxfield:1',
    sourceKind: 'moxfield',
    sourceId: 'deck-identity-0001',
    sourceReference: 'https://moxfield.com/decks/deck-identity-0001',
    pendingEntries: 1,
  });
  await settle(page, 'settleSource', retry.id, {
    session: deckSession,
    rows: [
      {
        position: 1,
        line: { ...boltSourceLine, problem: null },
        outcome: 'staged',
        problem: null,
        entryId: 'deck-entry-1',
        sessionId: 'moxfield:1',
      },
    ],
    staged: 1,
  });
  await expect(page.locator('#import-source-status')).toHaveText(
    '1 line is in review. Confirm the reviewed lines to create their physical copies.',
  );
  const presented = await requested<UiImportSessionsRequest>(page, 'sessions', 3);
  await settle(page, 'settleSessions', presented.id, [deckSession]);
  const read = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', read.id, {
    session: deckSession,
    entries: [
      entry({
        entryId: 'deck-entry-1',
        sessionId: 'moxfield:1',
        sourceLine: { ...boltSourceLine, problem: null },
      }),
    ],
  });
  await expect(page.locator('#import-provenance')).toHaveText('Moxfield deck · Open the source ↗');
  await expect(page.locator('#import-provenance a')).toHaveAttribute(
    'href',
    'https://moxfield.com/decks/deck-identity-0001',
  );
  expect(errors).toEqual([]);
});

test('imports a reviewed Wizards list with its identity and official reference', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  await page.selectOption('#import-source-format', 'wizards-precon');
  await expect(page.locator('#import-source-text')).toBeHidden();
  await page.fill('#import-source-identity', 'wizards:mkm:deadly-disguise:regular:en');
  await page.fill(
    '#import-source-reference',
    'https://magic.wizards.com/en/news/feature/deadly-disguise-decklist',
  );
  await page.fill(
    '#import-source-lines',
    ['1 Kadena, Slinking Sorcerer', '', '10 Forest'].join('\n'),
  );
  await page.click('#import-source-submit');

  // The reviewed lines cross the contract with the leading count the owner pasted; a blank row is
  // formatting rather than a line, and the product identity describes the import instead of
  // identifying it.
  const parsed = await requested<StageSourceImportInput>(page, 'source');
  expect(parsed.arguments).toMatchObject({
    format: 'wizards-precon',
    sourceId: 'wizards:mkm:deadly-disguise:regular:en',
    reference: 'https://magic.wizards.com/en/news/feature/deadly-disguise-decklist',
    entries: [
      { name: 'Kadena, Slinking Sorcerer', quantity: 1 },
      { name: 'Forest', quantity: 10 },
    ],
  });
  expect(sourceImportIdentity(parsed.arguments)).toBe(parsed.arguments.sessionId);

  const deckSession = session({
    sessionId: parsed.arguments.sessionId,
    sourceKind: 'wizards-precon',
    sourceId: 'wizards:mkm:deadly-disguise:regular:en',
    sourceReference: 'https://magic.wizards.com/en/news/feature/deadly-disguise-decklist',
    pendingEntries: 2,
  });
  await settle(page, 'settleSource', parsed.id, {
    session: deckSession,
    rows: [
      {
        position: 1,
        line: {
          ...boltSourceLine,
          name: 'Kadena, Slinking Sorcerer',
          set: null,
          collectorNumber: null,
          declaredQuantity: 1,
        },
        outcome: 'staged',
        problem: 'The source named no printing; choose one during review.',
        entryId: 'wizard-entry-1',
        sessionId: deckSession.sessionId,
      },
      {
        position: 2,
        line: {
          ...boltSourceLine,
          name: 'Forest',
          set: null,
          collectorNumber: null,
          declaredQuantity: 10,
        },
        outcome: 'staged',
        problem: 'The source named no printing; choose one during review.',
        entryId: 'wizard-entry-2',
        sessionId: deckSession.sessionId,
      },
    ],
    staged: 2,
  });
  await expect(page.locator('#import-source-status')).toHaveText(
    '2 lines are in review. Confirm the reviewed lines to create their physical copies.',
  );

  const presented = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', presented.id, [deckSession]);
  const read = await requested<UiImportEntriesRequest>(page, 'entries');
  await settle(page, 'settleEntries', read.id, {
    session: deckSession,
    entries: [
      entry({
        entryId: 'wizard-entry-1',
        sessionId: deckSession.sessionId,
        printingId: null,
        finish: null,
        quantity: 1,
      }),
      entry({
        entryId: 'wizard-entry-2',
        sessionId: deckSession.sessionId,
        position: 2,
        printingId: null,
        finish: null,
        quantity: 10,
      }),
    ],
  });
  await expect(
    page.locator('#import-pending [data-ui-entry="pending:wizard-entry-1"]'),
  ).toBeVisible();
  // The reviewed list keeps its official reference as the session's provenance.
  await expect(page.locator('#import-provenance')).toHaveText(
    'Wizards preconstructed deck · Official Wizards decklist ↗',
  );
  await expect(page.locator('#import-provenance a')).toHaveAttribute(
    'href',
    'https://magic.wizards.com/en/news/feature/deadly-disguise-decklist',
  );
  expect(errors).toEqual([]);
});

/**
 * The three source methods, each with the fields a journey fills and the provenance of the import
 * the provider records for it.
 */
const sourceMethods = [
  {
    format: 'pasted-list',
    fill: async (page: Page) => {
      await page.selectOption('#import-source-format', 'pasted-list');
      await page.fill('#import-source-text', '4 Lightning Bolt (M11) 149');
    },
    fillAnother: async (page: Page) => {
      await page.fill('#import-source-text', '2 Counterspell (M10) 51');
    },
    recorded: (sessionId: string) =>
      session({
        sessionId,
        sourceKind: 'pasted-list',
        sourceId: sessionId,
        pendingEntries: 1,
      }),
    provenance: 'Pasted list',
  },
  {
    format: 'moxfield',
    fill: async (page: Page) => {
      await page.selectOption('#import-source-format', 'moxfield');
      await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-reload-0001');
    },
    fillAnother: async (page: Page) => {
      await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-another-0002');
    },
    recorded: (sessionId: string) =>
      session({
        sessionId,
        sourceKind: 'moxfield',
        sourceId: 'deck-reload-0001',
        sourceReference: 'https://moxfield.com/decks/deck-reload-0001',
        pendingEntries: 1,
      }),
    provenance: 'Moxfield deck · Open the source ↗',
  },
  {
    format: 'wizards-precon',
    fill: async (page: Page) => {
      await page.selectOption('#import-source-format', 'wizards-precon');
      await page.fill('#import-source-identity', 'wizards:mkm:deadly-disguise:regular:en');
      await page.fill(
        '#import-source-reference',
        'https://magic.wizards.com/en/news/feature/deadly-disguise-decklist',
      );
      await page.fill('#import-source-lines', '1 Kadena, Slinking Sorcerer');
    },
    fillAnother: async (page: Page) => {
      await page.fill('#import-source-lines', '2 Kadena, Slinking Sorcerer');
    },
    recorded: (sessionId: string) =>
      session({
        sessionId,
        sourceKind: 'wizards-precon',
        sourceId: 'wizards:mkm:deadly-disguise:regular:en',
        sourceReference: 'https://magic.wizards.com/en/news/feature/deadly-disguise-decklist',
        pendingEntries: 1,
      }),
    provenance: 'Wizards preconstructed deck · Official Wizards decklist ↗',
  },
] as const;

for (const scenario of ['single', 'older retained', 'reopening'] as const) {
  const olderAttempt = scenario === 'older retained';
  test(`source recovery follows its reported attempt through discard (${scenario})`, async ({
    page,
  }) => {
    const errors = await openImport(page, '#/import');
    await settle(page, 'settleSessions', (await requested(page, 'sessions')).id, []);
    if (olderAttempt) {
      await page.fill('#import-source-text', '1 Counterspell');
      await page.click('#import-source-submit');
      const older = await requested<StageSourceImportInput>(page, 'source');
      await control(page, 'fail', older.id, {
        code: 'unavailable',
        message: 'Older response lost.',
      });
      await expect(page.locator('#import-source-status')).toHaveText(sourceOutcomeUnknown);
      await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, []);
    }
    const index = olderAttempt ? 1 : 0;
    await page.fill('#import-source-text', '4 Lightning Bolt');
    await page.click('#import-source-submit');
    const started = await requested<StageSourceImportInput>(page, 'source', index);
    await control(page, 'fail', started.id, { code: 'unavailable', message: 'Response lost.' });
    const notice = page.locator('[data-ui-notice="navigation:page:alice:import-source"]');
    await expect(notice).toContainText(sourceOutcomeUnknown);
    const recorded = session({ sessionId: started.arguments.sessionId, sourceKind: 'pasted-list' });
    await settle(page, 'settleSessions', (await requested(page, 'sessions', index + 1)).id, [
      recorded,
    ]);
    await settle(page, 'settleEntries', (await requested(page, 'entries')).id, {
      session: recorded,
      entries: [entry({ sessionId: recorded.sessionId, printingId: null, finish: null })],
    });
    await notice.getByRole('button', { name: 'Reopen the retained import' }).click();
    const reopened = await requested<StageSourceImportInput>(page, 'source', index + 1);
    expect(reopened.arguments).toEqual(started.arguments);
    if (scenario !== 'reopening') {
      await control(page, 'fail', reopened.id, { code: 'unavailable', message: 'Still unknown.' });
      await expect(page.locator('#import-source-submit')).toBeEnabled();
    }
    await page.click('#import-discard-session');
    await page
      .locator('dialog', { hasText: 'Discard this import?' })
      .getByRole('button', { name: 'Discard import' })
      .click();
    const discarded = await requested(page, 'discardSession');
    await settle(page, 'settleDiscardSession', discarded.id, {
      ...recorded,
      state: 'discarded',
      pendingEntries: 0,
      discardedEntries: 1,
      revision: 3,
    });
    await expect(notice).toHaveCount(0);
    await expect(page.locator(`[data-ui-source-waiting="${recorded.sessionId}"]`)).toHaveCount(0);
    await expect(page.locator('#import-source-status')).toBeEmpty();
    if (scenario === 'reopening') {
      await control(page, 'fail', reopened.id, { code: 'unavailable', message: 'Late response.' });
      await expect(page.locator('#import-source-submit')).toBeEnabled();
      await expect(notice).toHaveCount(0);
    }
    if (olderAttempt) {
      const older = await requested<StageSourceImportInput>(page, 'source');
      await reopenWaitingImport(page, older.arguments.sessionId);
      const retry = await requested<StageSourceImportInput>(page, 'source', index + 2);
      expect(retry.arguments).toEqual(older.arguments);
    }
    expect(errors).toEqual([]);
  });
}

for (const method of sourceMethods) {
  for (const secondOutcome of ['rejected', 'committed', 'unknown'] as const) {
    test(`keeps an unresolved ${method.format} import when another input is ${secondOutcome}`, async ({
      page,
    }) => {
      const errors = await openImport(page, '#/import');
      const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
      await settle(page, 'settleSessions', listing.id, []);
      await method.fill(page);
      await page.click('#import-source-submit');
      const first = await requested<StageSourceImportInput>(page, 'source');
      await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
      await expect(page.locator('#import-source-status')).toHaveText(sourceOutcomeUnknown);
      await expect(
        page.locator(
          `#import-source-waiting [data-ui-source-waiting="${first.arguments.sessionId}"]`,
        ),
      ).toBeVisible();

      // A different input begins its own import without resolving or abandoning the first one.
      await method.fillAnother(page);
      await page.click('#import-source-submit');
      const second = await requested<StageSourceImportInput>(page, 'source', 1);
      expect(second.arguments.sessionId).not.toBe(first.arguments.sessionId);
      if (secondOutcome === 'committed') {
        await settle(page, 'settleSource', second.id, {
          session: method.recorded(second.arguments.sessionId),
          rows: [],
          staged: 0,
        });
        await requested<UiImportSessionsRequest>(page, 'sessions', 2);
      } else {
        await control(page, 'fail', second.id, {
          code: secondOutcome === 'rejected' ? 'invalid-request' : 'unavailable',
          message: 'Second input refused.',
        });
        await expect(page.locator('#import-source-status')).toContainText(
          secondOutcome === 'rejected' ? 'Second input refused.' : 'outcome is unknown',
        );
      }

      // Neither another submission nor its outcome can retire the first import's identity.
      // Reload also verifies that the records survive beyond this page's in-memory state.
      await page.reload();
      await loadImport(page);
      const restored = await requested<UiImportSessionsRequest>(page, 'sessions');
      await settle(page, 'settleSessions', restored.id, []);
      await expect(
        page.locator(
          `#import-source-waiting [data-ui-source-waiting="${first.arguments.sessionId}"]`,
        ),
      ).toBeVisible();
      await reopenWaitingImport(page, first.arguments.sessionId);
      const retry = await requested<StageSourceImportInput>(page, 'source');
      expect(retry.arguments).toEqual(first.arguments);
      await settle(page, 'settleSource', retry.id, {
        session: method.recorded(first.arguments.sessionId),
        rows: [],
        staged: 0,
      });
      await requested<UiImportSessionsRequest>(page, 'sessions', 1);
      // The resolved import leaves the waiting list; the other one keeps its own row.
      await expect(
        page.locator(
          `#import-source-waiting [data-ui-source-waiting="${first.arguments.sessionId}"]`,
        ),
      ).toBeHidden();

      // Resolving the first import releases only that one. The second keeps its identity if its
      // outcome is still unknown, and every submission of the form begins a list of its own.
      await page.reload();
      await loadImport(page);
      const secondRestored = await requested<UiImportSessionsRequest>(page, 'sessions');
      await settle(page, 'settleSessions', secondRestored.id, []);
      if (secondOutcome === 'unknown') {
        await expect(
          page.locator(
            `#import-source-waiting [data-ui-source-waiting="${second.arguments.sessionId}"]`,
          ),
        ).toBeVisible();
        await reopenWaitingImport(page, second.arguments.sessionId);
        const secondRetry = await requested<StageSourceImportInput>(page, 'source');
        expect(secondRetry.arguments).toEqual(second.arguments);
      } else {
        await method.fill(page);
        await method.fillAnother(page);
        await page.click('#import-source-submit');
        const secondRetry = await requested<StageSourceImportInput>(page, 'source');
        expect(secondRetry.arguments.sessionId).not.toBe(second.arguments.sessionId);
      }
      expect(errors).toEqual([]);
    });
  }

  test(`reopens a ${method.format} import a lost response recorded, also after a reload`, async ({
    page,
  }) => {
    const errors = await openImport(page, '#/import');
    await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
    const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
    await settle(page, 'settleSessions', listing.id, []);

    // The parse committed and its response was lost: the page reads the import the account holds
    // instead of inferring that the source staged nothing
    // (docs/user-interface.md#source-imports).
    await method.fill(page);
    await page.click('#import-source-submit');
    const parsed = await requested<StageSourceImportInput>(page, 'source');
    await control(page, 'fail', parsed.id, {
      code: 'unavailable',
      message: 'The source could not be read within the time limit; no import is proven.',
    });
    await expect(page.locator('#import-source-status')).toHaveText(sourceOutcomeUnknown);

    const recorded = method.recorded(parsed.arguments.sessionId);
    const reconcile = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
    await settle(page, 'settleSessions', reconcile.id, [recorded]);
    const read = await requested<UiImportEntriesRequest>(page, 'entries');
    const recordedEntry = entry({
      entryId: `${method.format}-entry`,
      sessionId: recorded.sessionId,
      printingId: null,
      finish: null,
      quantity: 4,
      sourceLine: boltSourceLine,
    });
    await settle(page, 'settleEntries', read.id, { session: recorded, entries: [recordedEntry] });
    await expect(page.locator('#import-provenance')).toHaveText(method.provenance);
    await expect(
      page.locator(`#import-pending [data-ui-entry="pending:${recordedEntry.entryId}"]`),
    ).toBeVisible();

    // A reload opens the import the provider holds, with the provenance of its source, so the owner
    // reviews and confirms the recorded list instead of staging it again.
    await page.reload();
    await loadImport(page);
    await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
    const reopened = await requested<UiImportSessionsRequest>(page, 'sessions');
    await settle(page, 'settleSessions', reopened.id, [recorded]);
    const reopenedEntries = await requested<UiImportEntriesRequest>(page, 'entries');
    await settle(page, 'settleEntries', reopenedEntries.id, {
      session: recorded,
      entries: [recordedEntry],
    });
    await expect(
      page.locator(`#import-pending [data-ui-entry="pending:${recordedEntry.entryId}"]`),
    ).toBeVisible();
    await expect(page.locator('#import-provenance')).toHaveText(method.provenance);

    // The unfinished import survives the reload: the page presents it with the source it was
    // begun from, and reopening it reads that import again instead of staging another list
    // (docs/user-interface.md#source-imports).
    await expect(
      page.locator(
        `#import-source-waiting [data-ui-source-waiting="${parsed.arguments.sessionId}"]`,
      ),
    ).toBeVisible();
    await reopenWaitingImport(page, parsed.arguments.sessionId);
    const retried = await requested<StageSourceImportInput>(page, 'source');
    expect(retried.arguments).toEqual(parsed.arguments);
    expect(errors).toEqual([]);
  });
}

test('keeps the unfinished import of a source method across a method switch', async ({ page }) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  await page.selectOption('#import-source-format', 'moxfield');
  await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-switch-0001');
  await page.click('#import-source-submit');
  const moxfield = await requested<StageSourceImportInput>(page, 'source');
  await control(page, 'fail', moxfield.id, {
    code: 'unavailable',
    message: 'Moxfield could not be reached within the time limit; no import is proven.',
  });
  const reconcile = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconcile.id, []);

  // Another method's import is a list of its own and does not take over the identity of the
  // unfinished deck (docs/user-interface.md#source-imports).
  await page.selectOption('#import-source-format', 'pasted-list');
  await page.fill('#import-source-text', '4 Lightning Bolt (M11) 149');
  await page.click('#import-source-submit');
  const pasted = await requested<StageSourceImportInput>(page, 'source', 1);
  expect(pasted.arguments).toMatchObject({ format: 'pasted-list' });
  expect(pasted.arguments.sessionId).not.toBe(moxfield.arguments.sessionId);
  await control(page, 'fail', pasted.id, {
    code: 'invalid-request',
    message: 'The source listed no card lines this import can parse.',
  });

  // Coming back to the method keeps its own draft on the form, and the waiting list still names the
  // unfinished deck: reopening it reads that import instead of staging a second deck
  // (docs/user-interface.md#source-imports).
  await page.selectOption('#import-source-format', 'moxfield');
  await expect(page.locator('#import-source-url')).toHaveValue(
    'https://moxfield.com/decks/deck-switch-0001',
  );
  await expect(
    page.locator(
      `#import-source-waiting [data-ui-source-waiting="${moxfield.arguments.sessionId}"]`,
    ),
  ).toBeVisible();
  await reopenWaitingImport(page, moxfield.arguments.sessionId);
  const retry = await requested<StageSourceImportInput>(page, 'source', 2);
  expect(retry.arguments).toEqual(moxfield.arguments);
  expect(errors).toEqual([]);
});

test('keeps newer unresolved source imports when a departed page receives a late outcome', async ({
  page,
}) => {
  const errors = await openImport(page, '#/import');
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);
  await page.fill('#import-source-text', '4 Lightning Bolt (M11) 149');
  await page.click('#import-source-submit');
  const departed = await requested<StageSourceImportInput>(page, 'source');

  await control(page, 'navigate', { page: 'home' });
  await control(page, 'back');
  const reopened = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reopened.id, []);
  await page.fill('#import-source-text', '2 Counterspell (M10) 51');
  await page.click('#import-source-submit');
  const current = await requested<StageSourceImportInput>(page, 'source', 1);
  await control(page, 'fail', current.id, { code: 'unavailable', message: 'Response lost.' });
  await expect(page.locator('#import-source-status')).toContainText('outcome is unknown');

  // The departed page's late outcome resolves only the import that page began; the unfinished
  // import the current page began stays retained under its own identity.
  await settle(page, 'settleSource', departed.id, {
    session: session({
      sessionId: departed.arguments.sessionId,
      sourceKind: 'pasted-list',
      sourceId: departed.arguments.sessionId,
    }),
    rows: [],
    staged: 0,
  });
  await page.reload();
  await loadImport(page);
  const restored = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', restored.id, []);
  await expect(
    page.locator(
      `#import-source-waiting [data-ui-source-waiting="${current.arguments.sessionId}"]`,
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      `#import-source-waiting [data-ui-source-waiting="${departed.arguments.sessionId}"]`,
    ),
  ).toBeHidden();
  await reopenWaitingImport(page, current.arguments.sessionId);
  const retry = await requested<StageSourceImportInput>(page, 'source');
  expect(retry.arguments).toEqual(current.arguments);
  expect(errors).toEqual([]);
});

test('keeps a source import whose request is still pending across a reload', async ({ page }) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  await page.selectOption('#import-source-format', 'moxfield');
  await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-pending-0001');
  await page.click('#import-source-submit');
  const first = await requested<StageSourceImportInput>(page, 'source');

  // The response never arrived: the page is reloaded while its request is still pending, and the
  // import it began keeps its identity as a waiting import
  // (docs/user-interface.md#source-imports).
  await page.reload();
  await loadImport(page);
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const reopened = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', reopened.id, []);
  await expect(
    page.locator(`#import-source-waiting [data-ui-source-waiting="${first.arguments.sessionId}"]`),
  ).toBeVisible();
  await reopenWaitingImport(page, first.arguments.sessionId);
  const retry = await requested<StageSourceImportInput>(page, 'source');
  expect(retry.arguments).toEqual(first.arguments);
  expect(errors).toEqual([]);
});

test('keeps an unfinished source import out of another account', async ({ page }) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  await page.selectOption('#import-source-format', 'moxfield');
  await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-shared-0001');
  await page.click('#import-source-submit');
  const first = await requested<StageSourceImportInput>(page, 'source');
  await control(page, 'fail', first.id, {
    code: 'unavailable',
    message: 'Moxfield could not be reached within the time limit; no import is proven.',
  });
  const reconcile = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', reconcile.id, []);

  // The unfinished import belongs to the account that dispatched it: another account neither sees
  // its input nor retries its identity (docs/user-cards.md#persistence-and-recovery).
  await control(page, 'signOut');
  await control(page, 'signInAs', 'bob');
  const next = await requested<UiImportSessionsRequest>(page, 'sessions', 2);
  await settle(page, 'settleSessions', next.id, []);
  await page.selectOption('#import-source-format', 'moxfield');
  await expect(page.locator('#import-source-url')).toHaveValue('');
  await page.fill('#import-source-url', 'https://moxfield.com/decks/deck-shared-0001');
  await page.click('#import-source-submit');
  const second = await requested<StageSourceImportInput>(page, 'source', 1);
  expect(second.arguments.sessionId).not.toBe(first.arguments.sessionId);
  expect(errors).toEqual([]);
});

test('excludes the fields of other source methods from this submission', async ({ page }) => {
  const errors = await openImport(page, '#/import');
  await scriptCatalog(page, { cards: [boltCard], printings: [m11] });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  // A link the hidden Moxfield field still holds is not this paste's input, so it cannot refuse
  // the submission (docs/user-interface.md#source-imports).
  await page.selectOption('#import-source-format', 'moxfield');
  await page.fill('#import-source-url', 'not a deck link');
  await page.selectOption('#import-source-format', 'pasted-list');
  await expect(page.locator('#import-source-url')).toBeDisabled();
  await page.fill('#import-source-text', '4 Lightning Bolt (M11) 149');
  await page.click('#import-source-submit');
  const pasted = await requested<StageSourceImportInput>(page, 'source');
  expect(pasted.arguments).toMatchObject({
    format: 'pasted-list',
    text: '4 Lightning Bolt (M11) 149',
  });
  await control(page, 'fail', pasted.id, {
    code: 'invalid-request',
    message: 'The source listed no card lines this import can parse.',
  });

  // The same holds for the official reference of a reviewed Wizards list.
  await page.selectOption('#import-source-format', 'wizards-precon');
  await page.fill('#import-source-identity', 'wizards:mkm:deadly-disguise:regular:en');
  await page.fill('#import-source-reference', 'not an official link');
  await page.fill('#import-source-lines', '1 Kadena, Slinking Sorcerer');
  await page.selectOption('#import-source-format', 'pasted-list');
  await expect(page.locator('#import-source-reference')).toBeDisabled();
  await page.click('#import-source-submit');
  const again = await requested<StageSourceImportInput>(page, 'source', 1);
  expect(again.arguments).toMatchObject({
    format: 'pasted-list',
    text: '4 Lightning Bolt (M11) 149',
  });
  expect(errors).toEqual([]);
});

test('presents no source method when the deployment disables source imports', async ({ page }) => {
  const errors = await openImport(page, '#/import', { sourceImports: false });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions');
  await settle(page, 'settleSessions', listing.id, []);

  await expect(page.locator('#import-source-heading')).toHaveCount(0);
  await expect(page.locator('#import-source')).toHaveCount(0);
  await expect(page.locator('#import-manual-heading')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps review input typed while a source import lands in another session', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  // The owner corrects a presented entry, then imports a source before saving the review.
  await page.fill('#import-review-quantity-entry-1', '5');
  await page.fill('#import-source-text', '4 Lightning Bolt (M11) 149');
  await page.click('#import-source-submit');
  const parsed = await requested<Record<string, unknown>>(page, 'source');
  const parsedSession = session({
    sessionId: 'pasted-list:1',
    sourceKind: 'pasted-list',
    sourceId: 'pasted-list:1',
    pendingEntries: 1,
  });
  await settle(page, 'settleSource', parsed.id, {
    session: parsedSession,
    rows: [
      {
        position: 1,
        line: boltSourceLine,
        outcome: 'staged',
        problem: boltSourceLine.problem,
        entryId: 'source-entry-1',
        sessionId: 'pasted-list:1',
      },
    ],
    staged: 1,
  });
  const listing = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', listing.id, [session(), parsedSession]);
  const read = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  await settle(page, 'settleEntries', read.id, {
    session: parsedSession,
    entries: [
      entry({
        entryId: 'source-entry-1',
        sessionId: 'pasted-list:1',
        printingId: null,
        finish: null,
      }),
    ],
  });

  // Returning to the reviewed import presents the input the source staging did not overwrite.
  await page.selectOption('#import-session', 'manual');
  const back = await requested<UiImportEntriesRequest>(page, 'entries', 2);
  await settle(page, 'settleEntries', back.id, { session: session(), entries: [entry()] });
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('5');
  expect(errors).toEqual([]);
});

for (const reopen of [false, true]) {
  test(`clears a disappeared pending selection before confirming remaining entries (reopen: ${reopen})`, async ({
    page,
  }) => {
    const errors = await openPendingReview(page, [entry()]);
    await page.locator('#import-pending [data-ui-select]').check();
    const confirm = page.locator('#import-pending [data-ui-tool="confirm-import"]');
    await expect(confirm).toBeEnabled();
    if (reopen) {
      await control(page, 'navigate', { page: 'home' });
      await control(page, 'back');
    } else {
      await page.click('#import-refresh');
    }
    const sessions = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
    await settle(page, 'settleSessions', sessions.id, [session()]);
    const replacement = await requested<UiImportEntriesRequest>(page, 'entries', 1);
    await settle(page, 'settleEntries', replacement.id, {
      session: session(),
      entries: [entry({ entryId: 'entry-2' })],
    });
    await expect(page.locator('#import-pending [data-ui-entry="pending:entry-2"]')).toBeVisible();
    await expect(confirm).toBeDisabled();
    await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText(
      '1 selected',
    );
    await expect(page.locator('#import-pending [data-ui-status]')).toContainText(
      '1 selected entry changed',
    );
    expect(await control<readonly unknown[]>(page, 'confirm')).toHaveLength(0);

    // Toggling a visible entry cannot remove the missing identity. The user must explicitly
    // clear the selection before confirming only the entries that remain.
    const remaining = page.locator('#import-pending [data-ui-select="pending:entry-2"]');
    await remaining.check();
    await remaining.uncheck();
    await expect(confirm).toBeDisabled();
    const clear = page.locator('#import-pending').getByRole('button', { name: 'Clear selection' });
    await clear.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText(
      '0 selected',
    );
    await expect(clear).toBeDisabled();
    await expect(page.locator('#import-pending [data-ui-status]')).toBeEmpty();
    await remaining.check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
    expect(confirmation.arguments.entries).toEqual([{ entryId: 'entry-2', expectedRevision: 3 }]);
    expect(errors).toEqual([]);
  });
}

test('releases replaced import editor controls while preserving drafts and selected revisions', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  const client = await page.context().newCDPSession(page);
  const observers = async (): Promise<number> => {
    const counted = await client.send('Runtime.evaluate', {
      expression: "getEventListeners(document)['focusin']?.length ?? 0",
      includeCommandLineAPI: true,
      returnByValue: true,
    });
    return counted.result.value as number;
  };
  const baseline = await observers();
  await page.fill('#import-review-quantity-entry-1', '5');
  await page.locator('#import-pending [data-ui-select]').check();
  type TrackedEditors = { retiredEditors: WeakRef<Element>[] };
  await page.evaluate(() => {
    (globalThis as unknown as TrackedEditors).retiredEditors = [];
  });
  for (let index = 1; index <= 6; index += 1) {
    await page.fill(`#import-printing-query-entry-${index}`, 'Bolt');
    await page.click(`#import-printing-find-entry-${index}`);
    await settle(
      page,
      'settleSearch',
      (await requested(page, 'searches', index - 1)).id,
      searchSlice([m10], null),
    );
    await expect(page.locator('[data-ui-import-picker] [data-ui-entry]')).toHaveCount(1);
    expect(await observers()).toBe(baseline + 1);
    await page.locator('[data-ui-import-picker]').evaluate((picker) => {
      (globalThis as unknown as TrackedEditors).retiredEditors.push(new WeakRef(picker));
    });
    await page.locator('[data-ui-import-editor]').evaluate((editor) => {
      (globalThis as unknown as TrackedEditors).retiredEditors.push(new WeakRef(editor));
    });
    await page.click('#import-refresh');
    const sessions = await requested<UiImportSessionsRequest>(page, 'sessions', index);
    await settle(page, 'settleSessions', sessions.id, [session()]);
    const replacement = await requested<UiImportEntriesRequest>(page, 'entries', index);
    await settle(page, 'settleEntries', replacement.id, {
      session: session(),
      entries: [entry({ entryId: `entry-${index + 1}` })],
    });
    await expect(
      page.locator(`[data-ui-import-editor="pending:entry-${index + 1}"]`),
    ).toBeVisible();
    expect(await observers()).toBe(baseline);
  }
  await page.requestGC();
  expect(
    await page.evaluate(
      () =>
        (globalThis as unknown as TrackedEditors).retiredEditors.filter(
          (editor) => editor.deref() !== undefined,
        ).length,
    ),
  ).toBe(0);
  await expect(page.locator('#import-pending [data-ui-selection-count]')).toHaveText('1 selected');

  await page.click('#import-refresh');
  const sessions = await requested<UiImportSessionsRequest>(page, 'sessions', 7);
  await settle(page, 'settleSessions', sessions.id, [session()]);
  const replacement = await requested<UiImportEntriesRequest>(page, 'entries', 7);
  await settle(page, 'settleEntries', replacement.id, { session: session(), entries: [entry()] });
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('5');
  await expect(page.locator('#import-pending [data-ui-select]')).toBeChecked();
  await page.click('#import-pending [data-ui-tool="confirm-import"]');
  const confirmation = await requested<Record<string, unknown>>(page, 'confirm');
  expect(confirmation.arguments.entries).toEqual([{ entryId: 'entry-1', expectedRevision: 3 }]);
  expect(errors).toEqual([]);
});

test('preserves the focused review choice and draft through a printing correction', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.click('#import-refresh');
  const sessions = await requested<UiImportSessionsRequest>(page, 'sessions', 1);
  await settle(page, 'settleSessions', sessions.id, [session()]);
  const replacement = await requested<UiImportEntriesRequest>(page, 'entries', 1);
  const condition = page.locator('#import-review-condition-entry-1');
  await condition.selectOption('LP');
  await condition.focus();
  await settle(page, 'settleEntries', replacement.id, {
    session: session(),
    entries: [entry({ printingId: m10.printingId, revision: 4 })],
  });
  await expect(condition).toBeFocused();
  await expect(condition).toHaveValue('LP');
  expect(errors).toEqual([]);
});

test('keeps pending selection and paging independent of its nested printing picker', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  // Give the parent a continuation so a bubbled Load more would issue an observable read.
  await page.click('#import-refresh');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session(),
    entries: [entry()],
    continuation: 'pending-next',
  });
  const parentSelection = page.locator('[data-ui-select="pending:entry-1"]');
  await parentSelection.check();
  await page.fill('#import-printing-query-entry-1', 'Bolt');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches')).id,
    searchSlice([m11], 'printing-next'),
  );
  const picker = page.locator('[data-ui-import-picker="pending:entry-1"]');
  await picker.locator('[data-ui-select]').check();
  await picker.getByRole('button', { name: 'Clear selection' }).click();
  await expect(parentSelection).toBeChecked();
  await picker.locator('[data-ui-more]').click();
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches', 1)).id,
    searchSlice([m10], null),
  );
  await expect(picker.locator('[data-ui-entry]')).toHaveCount(2);
  expect(await control<unknown[]>(page, 'entries')).toHaveLength(2);
  await expect(parentSelection).toBeChecked();
  expect(errors).toEqual([]);
});

test('rejects ambiguous review choices and applies cached choices to the refreshed row', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.fill('#import-printing-query-entry-1', 'Bolt');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches')).id,
    searchSlice([m10, m11], null),
  );
  const picker = page.locator('[data-ui-import-picker="pending:entry-1"]');
  await chooseImportPrinting(page, 'entry-1', m10.printingId);
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  await page.click('#import-refresh');
  await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session(),
    entries: [entry()],
  });
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches', 1)).id,
    searchSlice([m10, m11], null),
  );
  await chooseImportPrinting(page, 'entry-1', m11.printingId);
  await expect(page.locator('#import-entry-status-entry-1')).toHaveText(
    'Select exactly one printing, then choose it.',
  );
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  expect(await control<unknown[]>(page, 'review')).toHaveLength(0);
  await picker.locator(`[data-ui-select="printing:${m10.printingId}"]`).uncheck();
  await picker.locator('[data-ui-tool="choose-entry"]').click();
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M11 149 · en');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches', 2)).id,
    searchSlice([m10, m11], null),
  );
  await picker.locator('[data-ui-clear-selection]').click();
  await chooseImportPrinting(page, 'entry-1', m10.printingId);
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  await page.click('#import-review-save-entry-1');
  expect((await requested<Record<string, unknown>>(page, 'review')).arguments.printingId).toBe(
    m10.printingId,
  );
  expect(errors).toEqual([]);
});

test('saves the chosen printing while its catalog lookup is pending', async ({ page }) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.fill('#import-printing-query-entry-1', 'Bolt');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches')).id,
    searchSlice([m10], null),
  );
  const reads = (await control<unknown[]>(page, 'catalogRequests')).length;
  await control(page, 'scriptCatalog', null);
  await chooseImportPrinting(page, 'entry-1', m10.printingId);
  const lookup = await requested(page, 'catalogRequests', reads);
  // Save validates the chosen record separately; leave the earlier enrichment read pending.
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  // Submit before Catalog answers, without a row refresh to repaint the form for us.
  await page.click('#import-review-save-entry-1');
  expect((await requested<Record<string, unknown>>(page, 'review')).arguments).toMatchObject({
    printingId: m10.printingId,
    finish: 'nonfoil',
  });
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText(
    `Printing ${m10.printingId}`,
  );
  // A reopened picker remains independently usable when the earlier lookup redraws the form.
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches', 1)).id,
    searchSlice([m10], null),
  );
  const choice = page.locator(`[data-ui-select="printing:${m10.printingId}"]`);
  await choice.focus();
  await settle(page, 'settleCatalog', lookup.id, { printings: [m10] });
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  await expect(choice).toBeFocused();
  expect(errors).toEqual([]);
});

test('saves the chosen printing with the identity of its own card', async ({ page }) => {
  // The entry names another card than the printing the owner now chooses: the review must quote
  // the printing's own card, however long its lookup takes.
  const errors = await openPendingReview(page, [
    entry({ cardId: 'card-other', printingId: m11.printingId, finish: 'nonfoil' }),
  ]);
  await page.fill('#import-printing-query-entry-1', 'Bolt');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches')).id,
    searchSlice([m10], null),
  );
  const reads = (await control<unknown[]>(page, 'catalogRequests')).length;
  await control(page, 'scriptCatalog', null);
  await chooseImportPrinting(page, 'entry-1', m10.printingId);
  const lookup = await requested(page, 'catalogRequests', reads);
  // Save resolves the printing it must quote while the earlier enrichment read stays unanswered.
  await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  expect(review.arguments).toMatchObject({
    cardId: boltCard.cardId,
    printingId: m10.printingId,
    finish: 'nonfoil',
  });
  // The stored review comes back authoritative, carrying the quantity this confirmation read.
  await settle(page, 'settleReview', review.id, {
    entry: entry({
      cardId: boltCard.cardId,
      printingId: m10.printingId,
      finish: 'nonfoil',
      quantity: 7,
      revision: 4,
    }),
    session: session({ revision: 5 }),
  });
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session({ revision: 5 }),
    entries: [
      entry({
        cardId: boltCard.cardId,
        printingId: m10.printingId,
        finish: 'nonfoil',
        quantity: 7,
        revision: 4,
      }),
    ],
  });
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('7');
  await settle(page, 'settleCatalog', lookup.id, {});
  expect(errors).toEqual([]);
});

test('clears a saved review draft the resolved printing identity belongs to', async ({ page }) => {
  // An entry that names no identity resolves through a printing choice: the saved draft leaves
  // with its own submission instead of hiding the review the provider now holds.
  const errors = await openPendingReview(page, [
    entry({ cardId: null, printingId: null, finish: null, quantity: 1 }),
  ]);
  await page.fill('#import-printing-query-entry-1', 'Bolt');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches')).id,
    searchSlice([m10], null),
  );
  await chooseImportPrinting(page, 'entry-1', m10.printingId);
  await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M10 146 · en');
  await page.click('#import-review-save-entry-1');
  const review = await requested<Record<string, unknown>>(page, 'review');
  expect(review.arguments).toMatchObject({
    cardId: boltCard.cardId,
    printingId: m10.printingId,
    finish: 'nonfoil',
  });
  await settle(page, 'settleReview', review.id, {
    entry: entry({
      cardId: boltCard.cardId,
      printingId: m10.printingId,
      finish: 'nonfoil',
      quantity: 7,
      revision: 4,
    }),
    session: session({ revision: 5 }),
  });
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session({ revision: 5 }),
    entries: [
      entry({
        cardId: boltCard.cardId,
        printingId: m10.printingId,
        finish: 'nonfoil',
        quantity: 7,
        revision: 4,
      }),
    ],
  });
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('7');
  expect(errors).toEqual([]);
});

test('keeps nested printing picker focus when a review save refreshes its parent', async ({
  page,
}) => {
  const errors = await openPendingReview(page, [entry()]);
  await page.fill('#import-review-quantity-entry-1', '2');
  await page.click('#import-review-save-entry-1');
  const review = await requested(page, 'review');
  await page.fill('#import-printing-query-entry-1', 'Bolt');
  await page.click('#import-printing-find-entry-1');
  await settle(
    page,
    'settleSearch',
    (await requested(page, 'searches')).id,
    searchSlice([m10], null),
  );
  const choice = page.locator('[data-ui-select="printing:printing-m10-146-en"]');
  await choice.focus();
  await settle(page, 'settleReview', review.id, {
    entry: entry({ quantity: 2, revision: 4 }),
    session: session({ revision: 5 }),
  });
  await expect(choice).toBeFocused();
  await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
    session: session({ revision: 5 }),
    entries: [entry({ quantity: 2, revision: 4 })],
  });
  await expect(page.locator('#import-review-quantity-entry-1')).toHaveValue('2');
  await expect(choice).toBeFocused();
  await choice.press('Space');
  await expect(choice).toBeChecked();
  await expect(page.locator('[data-ui-select="pending:entry-1"]')).not.toBeChecked();
  expect(errors).toEqual([]);
});

for (const superseded of [false, true]) {
  test(`resolves a printing choice across row replacement (superseded: ${superseded})`, async ({
    page,
  }) => {
    const errors = await openPendingReview(page, [entry()]);
    await page.fill('#import-printing-query-entry-1', 'Bolt');
    await page.click('#import-printing-find-entry-1');
    await settle(
      page,
      'settleSearch',
      (await requested(page, 'searches')).id,
      searchSlice([m10, m11], null),
    );
    const picker = page.locator('[data-ui-import-picker="pending:entry-1"]');
    await expect(picker.locator('[data-ui-entry]')).toHaveCount(2);
    const reads = (await control<unknown[]>(page, 'catalogRequests')).length;
    await control(page, 'scriptCatalog', null);
    await chooseImportPrinting(page, 'entry-1', m10.printingId);
    const lookup = await requested(page, 'catalogRequests', reads);
    await scriptCatalog(page, { cards: [boltCard], printings: [m11, m10] });
    await page.click('#import-refresh');
    await settle(page, 'settleSessions', (await requested(page, 'sessions', 1)).id, [session()]);
    await settle(page, 'settleEntries', (await requested(page, 'entries', 1)).id, {
      session: session(),
      entries: [entry()],
    });
    await expect(page.locator('#import-review-printing-entry-1')).toHaveText(
      `Printing ${m10.printingId}`,
    );
    if (superseded) {
      await page.click('#import-printing-find-entry-1');
      await settle(
        page,
        'settleSearch',
        (await requested(page, 'searches', 1)).id,
        searchSlice([m10, m11], null),
      );
      await picker.locator('[data-ui-clear-selection]').click();
      await chooseImportPrinting(page, 'entry-1', m11.printingId);
      await expect(page.locator('#import-review-printing-entry-1')).toHaveText('M11 149 · en');
    }
    // Resolving the older choice must neither paint detached controls nor clear a newer finish.
    await settle(page, 'settleCatalog', lookup.id, { printings: [{ ...m10, finishes: ['foil'] }] });
    await expect(page.locator('#import-review-printing-entry-1')).toHaveText(
      superseded ? 'M11 149 · en' : 'M10 146 · en',
    );
    if (superseded) {
      await expect(page.locator('#import-review-finish-entry-1')).toHaveValue('nonfoil');
    } else {
      await page.selectOption('#import-review-finish-entry-1', 'foil');
    }
    await page.click('#import-review-save-entry-1');
    expect((await requested<Record<string, unknown>>(page, 'review')).arguments).toMatchObject({
      printingId: superseded ? m11.printingId : m10.printingId,
      finish: superseded ? 'nonfoil' : 'foil',
    });
    expect(errors).toEqual([]);
  });
}
