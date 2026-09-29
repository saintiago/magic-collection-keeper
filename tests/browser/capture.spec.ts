/**
 * Browser journeys: hands-free camera capture (docs/user-interface.md#capture-and-review,
 * docs/recognition.md#interface, docs/user-cards.md#import-and-capture-state,
 * docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the real shell with the real Import page, a synthetic camera and the real
 * Recognition lifecycle over a scripted engine pipeline, and drive them in Chromium: a granted
 * camera captures hands-free, a refused one reports the failure without starting recognition, an
 * unresolved reading receives no success cue while a later comparison may still resolve it, a
 * reading without established single-card geometry admits nothing, large landscape and portrait
 * frames stay inside the Recognition image bound, a repeated card stays one entry, an accepted
 * capture survives a later unresolved comparison, a lost staging response is recovered by an
 * identical replay, late alternatives are attached to the admitted entry and external names stay
 * text, and leaving or stopping the view releases the camera and its work.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import { createCatalog } from '../../src/catalog/index.js';
import { RECOGNITION_LIMITS } from '../../src/recognition/index.js';
import {
  createUserCards,
  type AttachImportCandidatesInput,
  type ImportEntry,
  type ImportSession,
  type StageCaptureInput,
} from '../../src/usercards/index.js';
import { publishCatalog } from '../support/catalog-database.js';
import { createUserCardsTestDatabase } from '../support/usercards-database.js';
import type {
  UiCaptureControl,
  UiCaptureEntriesRequest,
  UiCaptureRequest,
  UiCaptureReading,
  UiCaptureSessionsRequest,
} from './capture.harness.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = path.join(repoRoot, 'tests', 'browser', 'capture.harness.ts');
const capturePageHtml = '<!doctype html><html><body><div id="ui-root"></div></body></html>';

// Capture is a phone-first interaction, so the journeys drive real touch events.
test.use({ hasTouch: true });

let bundle: Promise<string> | null = null;

/** Bundles the Import page with the capture harness, as a deployment bundles the UI. */
function captureBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({
      stdin: {
        contents: [
          `import { installCaptureHarness } from ${JSON.stringify(harnessPath)};`,
          "globalThis.keeperCaptureControl = installCaptureHarness(document.getElementById('ui-root'));",
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'capture-consumer.ts',
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

/** Serves a fresh document for the Import page, enters it at the import view and loads the UI. */
async function openCapture(page: Page, hash = '#/import'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-capture.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: capturePageHtml }),
  );
  await page.goto(`http://keeper-capture.test/${hash}`);
  await page.addScriptTag({ content: await captureBundle(), type: 'module' });
  await page.waitForFunction(() => Reflect.has(globalThis, 'keeperCaptureControl'));
  return errors;
}

/** Calls one operation of the installed harness with the supplied arguments. */
async function control<Value>(
  page: Page,
  method: keyof UiCaptureControl,
  ...args: readonly unknown[]
): Promise<Value> {
  return page.evaluate(
    ({ name, values }) => {
      const target = (
        globalThis as unknown as {
          keeperCaptureControl: Record<string, (...parameters: readonly unknown[]) => unknown>;
        }
      ).keeperCaptureControl;
      return target[name as string]?.(...values) as unknown;
    },
    { name: method, values: args },
  ) as Promise<Value>;
}

/** Requests one operation recorded so far, waiting for it. */
async function requested<Arguments>(
  page: Page,
  method: keyof UiCaptureControl,
  index = 0,
): Promise<UiCaptureRequest<Arguments>> {
  await expect
    .poll(async () => (await control<readonly unknown[]>(page, method)).length)
    .toBeGreaterThan(index);
  const requests = await control<readonly UiCaptureRequest<Arguments>[]>(page, method);
  const request = requests[index];
  if (request === undefined) {
    throw new Error(`The capture page did not issue ${String(method)} request ${index}.`);
  }
  return request;
}

/** Settles the pending-import reads the Import page issues while it mounts and after a capture. */
async function settleSessions(
  page: Page,
  index: number,
  sessions: readonly ImportSession[],
  continuation: string | null = null,
): Promise<UiCaptureRequest<UiCaptureSessionsRequest>> {
  const request = await requested<UiCaptureSessionsRequest>(page, 'sessions', index);
  await control(page, 'settleSessions', request.id, sessions, continuation);
  return request;
}

async function settleEntries(
  page: Page,
  index: number,
  result: {
    readonly session: ImportSession;
    readonly entries: readonly ImportEntry[];
    readonly continuation?: string | null;
  },
): Promise<UiCaptureRequest<UiCaptureEntriesRequest>> {
  const request = await requested<UiCaptureEntriesRequest>(page, 'entries', index);
  await control(page, 'settleEntries', request.id, result);
  return request;
}

function captureSession(overrides: Partial<ImportSession> = {}): ImportSession {
  return {
    sessionId: 'ui-capture-1',
    sourceKind: 'capture',
    sourceId: 'ui-capture-1',
    sourceReference: null,
    state: 'pending',
    pendingEntries: 1,
    confirmedEntries: 0,
    discardedEntries: 0,
    revision: 2,
    ...overrides,
  };
}

function captureEntry(overrides: Partial<ImportEntry> = {}): ImportEntry {
  return {
    entryId: 'capture-1',
    sessionId: 'ui-capture-1',
    position: 1,
    state: 'pending',
    printingId: 'printing-bolt',
    finish: 'nonfoil',
    condition: null,
    quantity: 1,
    candidates: [
      { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
    ],
    sourceLine: null,
    revision: 3,
    ...overrides,
  };
}

function hostName(reading: 'bolt' | 'ring'): { cardId: string; printingId: string } {
  return reading === 'bolt'
    ? { cardId: 'card-bolt', printingId: 'printing-bolt' }
    : { cardId: 'card-ring', printingId: 'printing-ring' };
}

test('a refused camera reports the failure and starts no recognition work', async ({ page }) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'denyCamera', 'Camera permission was refused.');

  // Keyboard activation starts the same journey as a pointer or touch tap.
  await page.locator('#import-camera-start').focus();
  await page.keyboard.press('Enter');

  await expect(page.locator('#import-camera-status')).toHaveText(
    'Camera unavailable: Camera permission was refused.',
  );
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'error',
  );
  await expect(page.locator('#import-camera-start')).toBeEnabled();
  expect(await control(page, 'preparations')).toEqual([]);
  expect(await control(page, 'recognitions')).toEqual([]);
  const camera = await control<{ opened: number }>(page, 'camera');
  expect(camera.opened).toBe(1);
  expect(errors).toEqual([]);
});

test('a settled single-card frame is admitted hands-free and a repeat stays one entry', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    cardPresence: 'single',
  });

  await page.locator('#import-camera-start').tap();
  await expect(page.locator('#import-camera-status')).toHaveText(/Scanner ready/);

  const staged = await requested<Record<string, unknown>>(page, 'captures');
  // The observation stages the suggested printing with the alternatives the reading reported.
  expect(staged.arguments).toMatchObject({
    printingId: 'printing-bolt',
    finish: null,
    candidates: [
      { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
    ],
  });
  const preparation = (
    await control<readonly { engines: readonly string[] }[]>(page, 'preparations')
  )[0];
  expect(preparation?.engines).toEqual(['browser-onnx']);

  await control(page, 'settleCapture', staged.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry(),
  });
  // The repeat is queued before the next attempt is due, so it reads the same card again.
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    cardPresence: 'single',
  });

  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  await expect(page.locator('#import-camera-status')).toHaveText(
    /Accepted Lightning Bolt into review\. Check printing, finish, condition and quantity before confirming\./,
  );

  // The review presents the capture session and the entry the success cue announced.
  await settleSessions(page, 1, [captureSession()]);
  await settleEntries(page, 0, { session: captureSession(), entries: [captureEntry()] });
  const row = page.locator('#import-pending [data-ui-entry="pending:capture-1"]');
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: TST 149 · en');
  await expect(row.locator('[data-ui-import-finish]')).toHaveText(' Finish: nonfoil');
  await expect(row.locator('[data-ui-import-condition]')).toHaveText(' Condition: unknown');
  await expect(row.locator('[data-ui-import-quantity]')).toHaveText(' Quantity: 1');
  await expect(row.locator('[data-ui-import-candidates]')).toHaveText(
    ' Candidates: printing-bolt (recognition, title-evidence)',
  );

  // The same card again: the provider suppresses the repeat, so no second entry and no success cue.
  const repeated = await requested<Record<string, unknown>>(page, 'captures', 1);
  await control(page, 'settleCapture', repeated.id, {
    outcome: 'suppressed',
    replayed: false,
    session: captureSession(),
    entry: null,
  });
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'repeat',
  );
  await expect(page.locator('#import-camera-status')).toHaveText(
    'The same card is already in review. Show a different card or set its quantity in review.',
  );
  // The presented import is refreshed, so no further session list is read.
  await settleEntries(page, 1, { session: captureSession(), entries: [captureEntry()] });
  await expect(page.locator('#import-pending [data-ui-entry]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a provisional reading is presented while its staging is unresolved', async ({ page }) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
  });

  await page.click('#import-camera-start');
  const staged = await requested<StageCaptureInput>(page, 'captures');
  // The submission is still unresolved, so the reading the attempt delivered is the evidence the
  // controls present; it earns no cue of its own
  // (docs/ui/capture-controls.md#presentation-and-lifetime).
  await expect(page.locator('#import-camera-status')).toHaveText('Reading Lightning Bolt.');
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'idle',
  );

  await control(page, 'settleCapture', staged.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry(),
  });

  // The outcome the provider established replaces the provisional text and earns the cue.
  await expect(page.locator('#import-camera-status')).toHaveText(
    /Accepted Lightning Bolt into review\./,
  );
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  expect(errors).toEqual([]);
});

test('an unresolved reading receives no success cue while a later comparison may resolve it', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    status: 'unknown',
    cardPresence: 'single',
    provisional: true,
    later: { candidates: [hostName('bolt')], printingId: 'printing-bolt' },
  });

  await page.click('#import-camera-start');
  await expect
    .poll(
      async () =>
        (await control<readonly { readonly captureId: string }[]>(page, 'recognitions')).length,
    )
    .toBeGreaterThan(0);
  const attempt = (
    await control<readonly { readonly captureId: string }[]>(page, 'recognitions')
  )[0];
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'error',
  );
  await expect(page.locator('#import-camera-status')).toHaveText(
    /could not be identified.*no card was counted\./,
  );
  expect(await control(page, 'captures')).toEqual([]);

  await control(page, 'completeLater');
  const staged = await requested<Record<string, unknown>>(page, 'captures');
  // The late reading resolves the same capture, so the provider sees one observation.
  expect((staged.arguments as { captureId: string }).captureId).toBe(attempt?.captureId);
  await control(page, 'settleCapture', staged.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry(),
  });
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  expect(errors).toEqual([]);
});

test('a later comparison adds alternatives and external names stay text', async ({ page }) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: {
      candidates: [hostName('bolt'), hostName('ring')],
      printingId: 'printing-bolt',
    },
  });

  await page.click('#import-camera-start');
  const staged = await requested<Record<string, unknown>>(page, 'captures');
  await control(page, 'settleCapture', staged.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry(),
  });
  await settleSessions(page, 1, [captureSession()]);
  await settleEntries(page, 0, { session: captureSession(), entries: [captureEntry()] });
  await expect(page.locator('#import-pending [data-ui-entry]')).toHaveCount(1);

  await control(page, 'completeLater');
  const attached = await requested<Record<string, unknown>>(page, 'attachments');
  // Every alternative of the later reading is offered; the provider stores the ones it lacks.
  expect(attached.arguments).toEqual({
    entryId: 'capture-1',
    candidates: [
      { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
      { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
    ],
  });
  await control(page, 'settleAttach', attached.id, {
    session: captureSession({ revision: 3 }),
    entry: captureEntry({
      revision: 4,
      candidates: [
        { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
        { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
      ],
    }),
  });
  await expect(page.locator('#import-camera-status')).toHaveText(
    /A later comparison added Lightning Bolt, Sol Ring <img src=x onerror=alert\(1\)> as alternatives\. Identification is uncertain\./,
  );
  // The external name is presented as text, never as markup the page renders.
  expect(await page.locator('#import-camera-status img').count()).toBe(0);
  await settleEntries(page, 1, {
    session: captureSession({ revision: 3 }),
    entries: [
      captureEntry({
        revision: 4,
        candidates: [
          { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
          { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
        ],
      }),
    ],
  });
  const row = page.locator('#import-pending [data-ui-entry="pending:capture-1"]');
  await expect(row.locator('[data-ui-import-candidates]')).toHaveText(
    ' Candidates: printing-bolt (recognition, title-evidence); ' +
      'printing-ring (recognition, engine-ranking)',
  );
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: TST 149 · en');
  expect(errors).toEqual([]);
});

test('stopping and leaving the view release the camera and its outstanding readings', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    status: 'unknown',
    cardPresence: 'single',
    provisional: true,
    later: { candidates: [hostName('bolt')], printingId: 'printing-bolt' },
  });

  await page.click('#import-camera-start');
  await requested(page, 'recognitions');
  const running = await control<{ liveTracks: number }>(page, 'camera');
  expect(running.liveTracks).toBeGreaterThan(0);

  await page.click('#import-camera-stop');
  await expect(page.locator('#import-camera-status')).toHaveText(
    'Capture stopped. Start the camera to scan more cards.',
  );
  const stopped = await control<{ closed: boolean; released: number; liveTracks: number }>(
    page,
    'camera',
  );
  expect(stopped.closed).toBe(true);
  expect(stopped.liveTracks).toBe(0);
  expect(stopped.released).toBe(1);

  // A reading that arrives after the view closed stages and attaches nothing.
  await control(page, 'completeLater');
  expect(await control(page, 'captures')).toEqual([]);
  expect(await control(page, 'attachments')).toEqual([]);
  const log = await control<readonly string[]>(page, 'log');
  expect(log).toContain('recognition-disposed');

  // Starting again opens a fresh camera session, and leaving the view releases it.
  await control(page, 'scriptReading', { status: 'unknown' });
  await page.click('#import-camera-start');
  await requested(page, 'recognitions', 1);
  await control(page, 'navigate', { page: 'home' });
  await expect(page.locator('#import-camera-start')).toHaveCount(0);
  const left = await control<{ closed: boolean; released: number; liveTracks: number }>(
    page,
    'camera',
  );
  expect(left.closed).toBe(true);
  expect(left.liveTracks).toBe(0);
  expect(left.released).toBe(2);
  expect(errors).toEqual([]);
});

test('signing out ends the capture session and its outstanding readings', async ({ page }) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    status: 'unknown',
    cardPresence: 'single',
    provisional: true,
    later: { candidates: [hostName('bolt')], printingId: 'printing-bolt' },
  });

  await page.click('#import-camera-start');
  await requested(page, 'recognitions');
  await control(page, 'signOut');

  // The private presentation is withdrawn and the authenticated session ended.
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('#import-camera-start')).toHaveCount(0);
  const log = await control<readonly string[]>(page, 'log');
  expect(log).toContain('session-ended');

  // The camera is released and a reading that arrives afterwards stages nothing.
  const signedOut = await control<{ closed: boolean; released: number; liveTracks: number }>(
    page,
    'camera',
  );
  expect(signedOut.closed).toBe(true);
  expect(signedOut.liveTracks).toBe(0);
  // The capture view releases the camera it held, and the shell releases the device of the account
  // it leaves; both releases are best effort and idempotent.
  expect(signedOut.released).toBe(2);
  await control(page, 'completeLater');
  expect(await control(page, 'captures')).toEqual([]);
  expect(errors).toEqual([]);
});

test('a reading without established single-card geometry admits nothing', async ({ page }) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  // The engine named a card but reported no card count, so the frame was never established as
  // holding one card and its candidate is not affirmative evidence.
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    cardPresence: null,
  });
  // The next frame the runtime reports as one card is admitted as usual, so a browser runtime
  // whose engines report no geometry themselves still captures.
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    cardPresence: 'single',
  });

  await page.click('#import-camera-start');
  await expect(page.locator('#import-camera-status')).toHaveText(
    'The frame was not admitted as one card. Hold one card still to retry; no card was counted.',
  );
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'error',
  );
  expect(await control(page, 'captures')).toEqual([]);

  const staged = await requested<Record<string, unknown>>(page, 'captures');
  expect(staged.arguments).toMatchObject({ printingId: 'printing-bolt' });
  await control(page, 'settleCapture', staged.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry(),
  });
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  expect(errors).toEqual([]);
});

for (const size of [
  { width: 3840, height: 2160 },
  { width: 2160, height: 3840 },
  // A square just above the provider's pixel bound: the bounded frame may only round down.
  { width: 2001, height: 2001 },
]) {
  test(`a ${size.width}×${size.height} camera frame stays inside the Recognition image bound`, async ({
    page,
  }) => {
    const errors = await openCapture(page);
    await settleSessions(page, 0, []);
    await control(page, 'cameraSize', size.width, size.height);
    await control(page, 'scriptReading', {
      candidates: [hostName('bolt')],
      printingId: 'printing-bolt',
    });

    await page.click('#import-camera-start');
    // The attempt reached the engine, so the bounded frame passed the provider's image validation
    // instead of being rejected as too large.
    await expect
      .poll(async () => (await control<readonly unknown[]>(page, 'recognitions')).length)
      .toBeGreaterThan(0);
    const attempt = (
      await control<readonly { readonly width: number; readonly height: number }[]>(
        page,
        'recognitions',
      )
    )[0];
    expect(attempt?.width).toBeGreaterThanOrEqual(1);
    expect(attempt?.height).toBeGreaterThanOrEqual(1);
    expect((attempt?.width ?? 0) * (attempt?.height ?? 0)).toBeLessThanOrEqual(
      RECOGNITION_LIMITS.maxImagePixels,
    );
    const staged = await requested<Record<string, unknown>>(page, 'captures');
    await control(page, 'settleCapture', staged.id, {
      outcome: 'admitted',
      replayed: false,
      session: captureSession(),
      entry: captureEntry(),
    });
    await expect(page.locator('#import-camera-status')).toHaveAttribute(
      'data-ui-capture-cue',
      'accepted',
    );
    expect(errors).toEqual([]);
  });
}

test('an accepted capture survives a later unresolved comparison', async ({ page }) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: { status: 'unknown', cardPresence: 'single' },
  });

  await page.click('#import-camera-start');
  const staged = await requested<Record<string, unknown>>(page, 'captures');
  await control(page, 'settleCapture', staged.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry(),
  });
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  await settleSessions(page, 1, [captureSession()]);
  await settleEntries(page, 0, { session: captureSession(), entries: [captureEntry()] });
  await expect(page.locator('#import-pending [data-ui-entry="pending:capture-1"]')).toHaveCount(1);

  // The comparison of the same capture finds no usable identity: the pending entry stays accepted,
  // no error cue replaces the success cue, and the status never claims nothing was counted.
  await control(page, 'completeLater');
  await expect(page.locator('#import-camera-status')).toHaveText(
    'A later comparison found no usable identity. Check the accepted card before confirming.',
  );
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  expect(await control(page, 'attachments')).toEqual([]);
  await expect(page.locator('#import-pending [data-ui-entry="pending:capture-1"]')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a lost staging response is recovered by an identical replay before late alternatives', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: { candidates: [hostName('bolt'), hostName('ring')], printingId: 'printing-bolt' },
  });

  await page.click('#import-camera-start');
  const first = await requested<Record<string, unknown>>(page, 'captures', 0);
  // The staging response is lost: the observation may have been admitted, so its content stays
  // recoverable through the identity of the capture it belongs to.
  await control(page, 'fail', first.id, {
    code: 'unavailable',
    message: 'The service is unavailable.',
  });
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'error',
  );
  await settleSessions(page, 1, []);

  // The later comparison arrives: the page replays exactly the observation it submitted and the
  // provider answers with its recorded decision instead of the same capture staging new content.
  await control(page, 'completeLater');
  const replay = await requested<Record<string, unknown>>(page, 'captures', 1);
  expect(replay.arguments).toEqual(first.arguments);
  await control(page, 'settleCapture', replay.id, {
    outcome: 'admitted',
    replayed: true,
    session: captureSession(),
    entry: captureEntry(),
  });

  // The recovered entry receives the alternatives of the reading that triggered the replay.
  const attached = await requested<Record<string, unknown>>(page, 'attachments', 0);
  expect(attached.arguments).toEqual({
    entryId: 'capture-1',
    candidates: [
      { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
      { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
    ],
  });
  await control(page, 'settleAttach', attached.id, {
    session: captureSession({ revision: 3 }),
    entry: captureEntry({
      revision: 4,
      candidates: [
        { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
        { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
      ],
    }),
  });
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  await expect(page.locator('#import-camera-status')).toHaveText(
    /A later comparison added Lightning Bolt, Sol Ring <img src=x onerror=alert\(1\)> as alternatives\./,
  );

  // The recovered entry is presented in the same pending review as any other capture.
  await settleSessions(page, 2, [captureSession()]);
  await settleEntries(page, 0, {
    session: captureSession({ revision: 3 }),
    entries: [
      captureEntry({
        revision: 4,
        candidates: [
          { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
          { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
        ],
      }),
    ],
  });
  const row = page.locator('#import-pending [data-ui-entry="pending:capture-1"]');
  await expect(row.locator('[data-ui-import-printing]')).toHaveText('Printing: TST 149 · en');
  expect(errors).toEqual([]);
});

test('a lost staging outcome stays visible as a shell notice with its recovery action', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
  });

  await page.click('#import-camera-start');
  const capture = await requested<Record<string, unknown>>(page, 'captures', 0);
  await control(page, 'fail', capture.id, {
    code: 'unavailable',
    message: 'The service is unavailable.',
  });

  // The status line keeps the staging outcome beside the controls; the floating notice keeps the
  // unknown capture visible after the view is left, with the recovery that replays it
  // (docs/ui/navigation.md#error-notices, docs/ui/capture-controls.md#presentation-and-lifetime).
  const notice = page.locator('[data-ui-notice="navigation:page:alice:import-capture"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice.locator('.ui-notice-mark')).toHaveText('Error:');
  await expect(notice.locator('.ui-notice-spinner')).toBeHidden();
  await expect(notice).toContainText('The staging outcome is unknown.');
  await expect(notice.getByRole('button', { name: 'Recover the capture' })).toBeVisible();

  // The notice's recovery action recovers the attempt the session already submitted: it replays
  // that observation under its own identity instead of starting another one.
  await notice.getByRole('button', { name: 'Recover the capture' }).click();
  const replay = await requested<Record<string, unknown>>(page, 'captures', 1);
  expect(replay.arguments).toEqual(capture.arguments);
  const camera = await control<{ opened: number }>(page, 'camera');
  expect(camera.opened).toBe(1);
  expect(errors).toEqual([]);
});

test('geometry decides admission independently of the identity the engine reported', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  // The engine named a card, but the frame holds more than one: nothing is admitted.
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    cardPresence: 'multiple',
  });
  // The card leaves the frame: an empty frame guides the owner the same way.
  await control(page, 'scriptReading', { status: 'unknown', cardPresence: 'none' });

  await page.click('#import-camera-start');
  await control(page, 'show', 'empty');
  await expect(page.locator('#import-camera-status')).toHaveText(
    'Wait until only one card is visible.',
  );
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'idle',
  );
  expect(await control(page, 'captures')).toEqual([]);

  // Neither guidance is an error cue, and neither observation created an entry.
  await expect(page.locator('#import-camera-status')).toHaveText(
    'Place one card inside the frame.',
  );
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'idle',
  );
  expect(await control(page, 'captures')).toEqual([]);
  expect(errors).toEqual([]);
});

/**
 * One frame per documented geometry that does not admit a capture, with the feedback it earns:
 * no-card, multiple-card and ambiguous geometry guide the owner without a cue, while a frame
 * whose geometry is not established is unresolved with its bounded error cue
 * (docs/user-interface.md#capture-and-review, docs/testing.md#userinterface).
 */
const nonAdmittingFrames: {
  readonly name: string;
  readonly reading: UiCaptureReading;
  readonly message: string;
  readonly cue: string;
}[] = [
  {
    name: 'an empty frame',
    reading: { status: 'unknown', cardPresence: 'none' },
    message: 'Place one card inside the frame.',
    cue: 'idle',
  },
  {
    name: 'a frame holding more than one card',
    reading: {
      candidates: [hostName('ring')],
      printingId: 'printing-ring',
      cardPresence: 'multiple',
    },
    message: 'Wait until only one card is visible.',
    cue: 'idle',
  },
  {
    name: 'a frame with ambiguous geometry',
    reading: {
      candidates: [hostName('ring')],
      printingId: 'printing-ring',
      cardPresence: 'ambiguous',
    },
    message: 'Wait until only one card is visible.',
    cue: 'idle',
  },
  {
    name: 'a frame whose geometry is not established',
    reading: {
      candidates: [hostName('ring')],
      printingId: 'printing-ring',
      cardPresence: null,
    },
    message:
      'The frame was not admitted as one card. Hold one card still to retry; no card was counted.',
    cue: 'error',
  },
];

for (const { name, reading, message, cue } of nonAdmittingFrames) {
  test(`${name} after an accepted capture stages nothing and presents no success cue`, async ({
    page,
  }) => {
    const errors = await openCapture(page);
    await settleSessions(page, 0, []);
    await control(page, 'scriptReading', {
      candidates: [hostName('bolt')],
      printingId: 'printing-bolt',
    });
    await page.click('#import-camera-start');
    const staged = await requested<Record<string, unknown>>(page, 'captures');
    await control(page, 'settleCapture', staged.id, {
      outcome: 'admitted',
      replayed: false,
      session: captureSession(),
      entry: captureEntry(),
    });
    // The frame after the accepted capture is the next one the runtime reports; scripting it for
    // the attempts that follow keeps that frame presented while the journey observes it.
    await control(page, 'scriptReading', reading);
    await control(page, 'scriptReading', reading);
    await expect(page.locator('#import-camera-status')).toHaveAttribute(
      'data-ui-capture-cue',
      'accepted',
    );

    // The frame that was not admitted stages nothing and is never presented with the success cue
    // of the attempt before it.
    await control(page, 'show', 'empty');
    await expect(page.locator('#import-camera-status')).toHaveText(message);
    await expect(page.locator('#import-camera-status')).toHaveAttribute('data-ui-capture-cue', cue);
    expect(await control(page, 'captures')).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test('repeated lost responses retain the capture and its final alternatives through completion', async ({
  page,
}) => {
  const database = await createUserCardsTestDatabase();
  try {
    await publishCatalog(database, {
      revisionId: 'capture-recovery',
      cards: [
        { cardId: 'card-bolt', name: 'Lightning Bolt' },
        { cardId: 'card-ring', name: 'Sol Ring' },
      ],
      printings: ['bolt', 'ring'].map((name) => ({
        printingId: `printing-${name}`,
        cardId: `card-${name}`,
        edition: 'TST',
        collectorNumber: name === 'bolt' ? '149' : '264',
        language: 'en',
        finishes: ['nonfoil', 'foil'],
        physical: true,
      })),
    });
    const userCards = createUserCards({
      sql: database.sql,
      catalog: createCatalog({ sql: database.sql }),
    });
    const account = { accountId: 'alice' };
    const errors = await openCapture(page);
    await settleSessions(page, 0, []);
    await control(page, 'scriptReading', {
      candidates: [hostName('bolt')],
      printingId: 'printing-bolt',
      provisional: true,
      later: { candidates: [hostName('bolt'), hostName('ring')], printingId: 'printing-bolt' },
    });
    await page.click('#import-camera-start');
    const first = await requested<StageCaptureInput>(page, 'captures');
    const admitted = await userCards.stageCaptureObservation(account, first.arguments);
    expect(admitted.outcome).toBe('admitted');
    if (admitted.entry === null) {
      throw new Error('Expected an admitted entry.');
    }
    const reviewed = await userCards.reviewImportEntry(account, {
      entryId: admitted.entry.entryId,
      expectedRevision: admitted.entry.revision,
      printingId: 'printing-ring',
      finish: 'foil',
      condition: 'LP',
      quantity: 3,
    });
    await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
    await expect(page.locator('#import-camera-status')).toContainText('staging outcome is unknown');
    await control(page, 'completeLater');
    const finalReplay = await requested<StageCaptureInput>(page, 'captures', 1);
    expect(finalReplay.arguments).toEqual(first.arguments);
    expect((await userCards.stageCaptureObservation(account, finalReplay.arguments)).replayed).toBe(
      true,
    );
    await control(page, 'fail', finalReplay.id, {
      code: 'unavailable',
      message: 'Replay response lost.',
    });
    const recover = page.getByRole('button', { name: 'Recover capture' });
    await expect(recover).toBeEnabled();

    // A changed camera scene cannot replace the outstanding capture with a new identity.
    await page.clock.install();
    await control(page, 'show', 'empty');
    await page.clock.runFor(2000);
    expect(await control<readonly unknown[]>(page, 'recognitions')).toHaveLength(1);
    expect(await control<readonly unknown[]>(page, 'captures')).toHaveLength(2);
    await recover.focus();
    await page.keyboard.press('Enter');
    const rejectedReplay = await requested<StageCaptureInput>(page, 'captures', 2);
    expect(rejectedReplay.arguments).toEqual(first.arguments);
    // A definite rejection of a retry still says nothing about the first committed request.
    await control(page, 'fail', rejectedReplay.id, {
      code: 'conflict',
      message: 'Retry rejected.',
    });
    await expect(page.locator('#import-camera-status')).toContainText('staging outcome is unknown');
    await recover.tap();
    const replay = await requested<StageCaptureInput>(page, 'captures', 3);
    expect(replay.arguments).toEqual(first.arguments);
    const recovered = await userCards.stageCaptureObservation(account, replay.arguments);
    expect(recovered.entry?.entryId).toBe(admitted.entry?.entryId);
    await control(page, 'settleCapture', replay.id, recovered);
    const attached = await requested<AttachImportCandidatesInput>(page, 'attachments');
    expect(attached.arguments.entryId).toBe(admitted.entry?.entryId);
    expect(attached.arguments.candidates?.map((candidate) => candidate.printingId)).toEqual([
      'printing-bolt',
      'printing-ring',
    ]);
    const stored = await userCards.attachImportCandidates(account, attached.arguments);
    await control(page, 'fail', attached.id, {
      code: 'unavailable',
      message: 'Attachment response lost.',
    });
    await expect(page.locator('#import-camera-status')).toContainText(
      'later alternatives are not yet verified',
    );
    await recover.tap();
    const attachmentReplay = await requested<AttachImportCandidatesInput>(page, 'attachments', 1);
    expect(attachmentReplay.arguments).toEqual(attached.arguments);
    const repeated = await userCards.attachImportCandidates(account, attachmentReplay.arguments);
    expect(repeated.entry).toEqual(stored.entry);
    await control(page, 'settleAttach', attachmentReplay.id, repeated);
    await expect(recover).toBeHidden();
    await expect(page.locator('#import-camera-status')).toHaveAttribute(
      'data-ui-capture-cue',
      'accepted',
    );
    const entries = await userCards.listImportEntries(account, {
      sessionId: first.arguments.sessionId,
    });
    expect(entries.entries).toHaveLength(1);
    expect(entries.entries[0]?.candidates).toEqual(
      expect.arrayContaining([...(attached.arguments.candidates ?? [])]),
    );
    expect(entries.entries[0]).toMatchObject({
      printingId: reviewed.entry.printingId,
      finish: 'foil',
      condition: 'LP',
      quantity: 3,
    });
    expect(errors).toEqual([]);
  } finally {
    await database.close();
  }
});

const unusableComparisons: { name: string; reading: UiCaptureReading }[] = [
  { name: 'unresolved identity', reading: { status: 'unknown', cardPresence: 'single' } },
  { name: 'missing geometry', reading: { candidates: [hostName('ring')], cardPresence: null } },
  { name: 'multiple cards', reading: { candidates: [hostName('ring')], cardPresence: 'multiple' } },
  { name: 'empty frame', reading: { status: 'unknown', cardPresence: 'none' } },
  {
    name: 'ambiguous geometry',
    reading: { candidates: [hostName('ring')], cardPresence: 'ambiguous' },
  },
];
for (const { name, reading } of unusableComparisons) {
  test(`an unknown staging outcome survives a final comparison with ${name}`, async ({ page }) => {
    const errors = await openCapture(page);
    await settleSessions(page, 0, []);
    await control(page, 'scriptReading', {
      candidates: [hostName('bolt')],
      printingId: 'printing-bolt',
      provisional: true,
      later: reading,
    });
    await page.click('#import-camera-start');
    const first = await requested<StageCaptureInput>(page, 'captures');
    await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
    await control(page, 'completeLater');
    const replay = await requested<StageCaptureInput>(page, 'captures', 1);
    expect(replay.arguments).toEqual(first.arguments);
    await control(page, 'fail', replay.id, {
      code: 'unavailable',
      message: 'Replay response lost.',
    });
    await expect(page.locator('#import-camera-status')).toContainText('staging outcome is unknown');
    await expect(page.locator('#import-camera-status')).not.toContainText('no card was counted');
    await page.getByRole('button', { name: 'Recover capture' }).click();
    const recovered = await requested<StageCaptureInput>(page, 'captures', 2);
    expect(recovered.arguments).toEqual(first.arguments);
    await control(page, 'settleCapture', recovered.id, {
      outcome: 'admitted',
      replayed: true,
      session: captureSession(),
      entry: captureEntry(),
    });
    await expect(page.locator('#import-camera-status')).toHaveText(
      'The earlier capture was already accepted into review.',
    );
    expect(await control(page, 'attachments')).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const outcome of ['admitted', 'suppressed'] as const) {
  test(`a capture without later readings can recover its ${outcome} decision after camera stop`, async ({
    page,
  }) => {
    const errors = await openCapture(page);
    await settleSessions(page, 0, []);
    await control(page, 'scriptReading', {
      candidates: [hostName('bolt')],
      printingId: 'printing-bolt',
    });
    await page.click('#import-camera-start');
    const first = await requested<StageCaptureInput>(page, 'captures');
    // Stop while the write is still in flight; releasing the camera must not discard that write.
    await page.click('#import-camera-stop');
    await expect(page.getByRole('button', { name: 'Recover capture' })).toBeDisabled();
    expect((await control<{ liveTracks: number }>(page, 'camera')).liveTracks).toBe(0);
    await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
    await expect(page.locator('#import-camera-status')).toContainText('staging outcome is unknown');
    await expect(page.locator('#import-camera-start')).toBeDisabled();
    await page.getByRole('button', { name: 'Recover capture' }).click();
    const replay = await requested<StageCaptureInput>(page, 'captures', 1);
    expect(replay.arguments).toEqual(first.arguments);
    await control(page, 'settleCapture', replay.id, {
      outcome,
      replayed: true,
      session: captureSession(),
      entry: outcome === 'admitted' ? captureEntry() : null,
    });
    await expect(page.getByRole('button', { name: 'Recover capture' })).toBeHidden();
    await expect(page.locator('#import-camera-start')).toBeEnabled();
    await expect(page.locator('#import-camera-status')).toHaveAttribute(
      'data-ui-capture-cue',
      outcome === 'admitted' ? 'accepted' : 'repeat',
    );
    expect(await control(page, 'attachments')).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('sign-out cancels capture recovery and prevents a late replay from attaching alternatives', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: { candidates: [hostName('ring')], printingId: 'printing-ring' },
  });
  await page.click('#import-camera-start');
  const first = await requested<StageCaptureInput>(page, 'captures');
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
  await control(page, 'completeLater');
  const replay = await requested<StageCaptureInput>(page, 'captures', 1);
  await control(page, 'signOut');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  const requests = await control<readonly UiCaptureRequest<StageCaptureInput>[]>(page, 'captures');
  expect(requests[1]?.aborted).toBe(true);
  await control(page, 'settleCapture', replay.id, {
    outcome: 'admitted',
    replayed: true,
    session: captureSession(),
    entry: captureEntry(),
  });
  expect(await control(page, 'attachments')).toEqual([]);
  expect(await control<readonly unknown[]>(page, 'sessions')).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('a definite first attachment rejection does not leave capture waiting for recovery', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: { candidates: [hostName('ring')], printingId: 'printing-ring' },
  });
  await page.click('#import-camera-start');
  const first = await requested<StageCaptureInput>(page, 'captures');
  await control(page, 'settleCapture', first.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry(),
  });
  await control(page, 'completeLater');
  const attachment = await requested<AttachImportCandidatesInput>(page, 'attachments');
  await control(page, 'fail', attachment.id, {
    code: 'invalid-request',
    message: 'No more alternatives fit in this entry.',
  });
  await expect(page.locator('#import-camera-status')).toHaveText(
    'No more alternatives fit in this entry.',
  );
  await expect(page.getByRole('button', { name: 'Recover capture' })).toBeHidden();
  await expect(page.locator('#import-camera-status')).toHaveAttribute(
    'data-ui-capture-cue',
    'accepted',
  );
  await page.click('#import-camera-stop');
  await expect(page.locator('#import-camera-start')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('all comparisons accumulated during unknown staging attach in order after recovery', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: [
      { candidates: [hostName('ring')], printingId: 'printing-ring', provisional: true },
      { candidates: [hostName('bolt'), hostName('ring')], printingId: 'printing-bolt' },
    ],
  });
  await page.click('#import-camera-start');
  const first = await requested<StageCaptureInput>(page, 'captures');
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
  for (const index of [1, 2]) {
    await control(page, 'completeLater');
    const replay = await requested<StageCaptureInput>(page, 'captures', index);
    expect(replay.arguments).toEqual(first.arguments);
    await control(page, 'fail', replay.id, {
      code: 'unavailable',
      message: 'Replay response lost.',
    });
  }
  await page.getByRole('button', { name: 'Recover capture' }).click();
  const replay = await requested<StageCaptureInput>(page, 'captures', 3);
  expect(replay.arguments).toEqual(first.arguments);
  await control(page, 'settleCapture', replay.id, {
    outcome: 'admitted',
    replayed: true,
    session: captureSession(),
    entry: captureEntry(),
  });
  const earlier = await requested<AttachImportCandidatesInput>(page, 'attachments');
  expect(earlier.arguments.candidates).toEqual([
    { printingId: 'printing-ring', provider: 'recognition', evidence: 'title-evidence' },
  ]);
  await control(page, 'fail', earlier.id, {
    code: 'unavailable',
    message: 'Attachment response lost.',
  });
  await page.getByRole('button', { name: 'Recover capture' }).click();
  const rejected = await requested<AttachImportCandidatesInput>(page, 'attachments', 1);
  expect(rejected.arguments).toEqual(earlier.arguments);
  await control(page, 'fail', rejected.id, { code: 'conflict', message: 'Retry rejected.' });
  await expect(page.locator('#import-camera-status')).toContainText(
    'later alternatives are not yet verified',
  );
  await page.getByRole('button', { name: 'Recover capture' }).click();
  const repeated = await requested<AttachImportCandidatesInput>(page, 'attachments', 2);
  expect(repeated.arguments).toEqual(earlier.arguments);
  await control(page, 'settleAttach', repeated.id, {
    session: captureSession(),
    entry: captureEntry(),
  });
  const final = await requested<AttachImportCandidatesInput>(page, 'attachments', 3);
  expect(final.arguments.entryId).toBe('capture-1');
  expect(final.arguments.candidates).toEqual([
    { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
    { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
  ]);
  await control(page, 'settleAttach', final.id, {
    session: captureSession(),
    entry: captureEntry(),
  });
  await expect(page.getByRole('button', { name: 'Recover capture' })).toBeHidden();
  expect(await control<readonly unknown[]>(page, 'captures')).toHaveLength(4);
  expect(errors).toEqual([]);
});

for (const inFlight of ['staging', 'attachment'] as const) {
  for (const response of ['received', 'lost'] as const) {
    test(`a comparison delivered during ${inFlight} survives camera stop when its response is ${response}`, async ({
      page,
    }) => {
      const errors = await openCapture(page);
      await settleSessions(page, 0, []);
      await control(page, 'scriptReading', {
        candidates: [hostName('bolt')],
        printingId: 'printing-bolt',
        provisional: true,
        later: [
          ...(inFlight === 'attachment'
            ? [{ candidates: [hostName('ring')], printingId: 'printing-ring', provisional: true }]
            : []),
          { candidates: [hostName('bolt'), hostName('ring')], printingId: 'printing-bolt' },
        ],
      });
      await page.click('#import-camera-start');
      const staged = await requested<StageCaptureInput>(page, 'captures');
      const admission = {
        outcome: 'admitted',
        replayed: false,
        session: captureSession(),
        entry: captureEntry(),
      };
      const attachment = { session: captureSession(), entry: captureEntry() };
      let outstanding: UiCaptureRequest<StageCaptureInput | AttachImportCandidatesInput> = staged;
      if (inFlight === 'attachment') {
        await control(page, 'settleCapture', staged.id, admission);
        await control(page, 'completeLater');
        outstanding = await requested<AttachImportCandidatesInput>(page, 'attachments');
      }

      // Establish delivery and Recognition completion while the earlier write still waits.
      await control(page, 'completeLater');
      await expect.poll(() => control(page, 'log')).toContain('recognition-completed');
      const log = await control<string[]>(page, 'log');
      expect(log.filter((event) => event === 'recognition-reading-delivered')).toHaveLength(
        inFlight === 'attachment' ? 2 : 1,
      );
      expect(await control<unknown[]>(page, 'captures')).toHaveLength(1);
      expect(await control<unknown[]>(page, 'attachments')).toHaveLength(
        inFlight === 'attachment' ? 1 : 0,
      );
      await page.click('#import-camera-stop');
      expect((await control<{ liveTracks: number }>(page, 'camera')).liveTracks).toBe(0);
      const recover = page.getByRole('button', { name: 'Recover capture' });
      await expect(recover).toBeDisabled();

      if (response === 'lost') {
        await control(page, 'fail', outstanding.id, {
          code: 'unavailable',
          message: 'Response lost.',
        });
        await expect(recover).toBeEnabled();
        await recover.click();
        const replay = await requested<StageCaptureInput | AttachImportCandidatesInput>(
          page,
          inFlight === 'staging' ? 'captures' : 'attachments',
          1,
        );
        expect(replay.arguments).toEqual(outstanding.arguments);
        outstanding = replay;
      }
      await control(
        page,
        inFlight === 'staging' ? 'settleCapture' : 'settleAttach',
        outstanding.id,
        inFlight === 'staging' ? { ...admission, replayed: response === 'lost' } : attachment,
      );
      const final = await requested<AttachImportCandidatesInput>(
        page,
        'attachments',
        inFlight === 'staging' ? 0 : response === 'lost' ? 2 : 1,
      );
      expect(final.arguments).toEqual({
        entryId: 'capture-1',
        candidates: [
          { printingId: 'printing-bolt', provider: 'recognition', evidence: 'title-evidence' },
          { printingId: 'printing-ring', provider: 'recognition', evidence: 'engine-ranking' },
        ],
      });
      await control(page, 'settleAttach', final.id, attachment);
      await expect(recover).toBeHidden();
      await expect(page.locator('#import-camera-start')).toBeEnabled();
      await expect(page.locator('#import-camera-status')).toContainText('A later comparison added');
      expect(errors).toEqual([]);
    });
  }
}

for (const inFlight of ['staging', 'attachment'] as const) {
  for (const exit of ['navigation', 'account change'] as const) {
    test(`a delivered comparison behind ${inFlight} cannot continue saving after ${exit}`, async ({
      page,
    }) => {
      const errors = await openCapture(page);
      await settleSessions(page, 0, []);
      await control(page, 'scriptReading', {
        candidates: [hostName('bolt')],
        printingId: 'printing-bolt',
        provisional: true,
        later: [
          ...(inFlight === 'attachment'
            ? [{ candidates: [hostName('ring')], printingId: 'printing-ring', provisional: true }]
            : []),
          { candidates: [hostName('bolt'), hostName('ring')], printingId: 'printing-bolt' },
        ],
      });
      await page.click('#import-camera-start');
      let outstanding = await requested(page, 'captures');
      const result = {
        outcome: 'admitted',
        replayed: false,
        session: captureSession(),
        entry: captureEntry(),
      };
      if (inFlight === 'attachment') {
        await control(page, 'settleCapture', outstanding.id, result);
        await control(page, 'completeLater');
        outstanding = await requested(page, 'attachments');
      }
      await control(page, 'completeLater');
      await expect.poll(() => control(page, 'log')).toContain('recognition-completed');
      expect(await control(page, 'log')).toContain('recognition-reading-delivered');

      if (exit === 'navigation') {
        await control(page, 'navigate', { page: 'home' });
      } else {
        await control(page, 'signOut');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      }
      const requests = await control<UiCaptureRequest[]>(
        page,
        inFlight === 'staging' ? 'captures' : 'attachments',
      );
      expect(requests[0]?.aborted).toBe(true);
      const sessions = await control<unknown[]>(page, 'sessions');
      await control(
        page,
        inFlight === 'staging' ? 'settleCapture' : 'settleAttach',
        outstanding.id,
        result,
      );
      expect(await control<unknown[]>(page, 'attachments')).toHaveLength(
        inFlight === 'staging' ? 0 : 1,
      );
      expect(await control<unknown[]>(page, 'sessions')).toHaveLength(sessions.length);
      expect(errors).toEqual([]);
    });
  }
}

test('a delivered comparison can stage after the earlier submission is definitely rejected', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: { candidates: [hostName('ring')], printingId: 'printing-ring' },
  });
  await page.click('#import-camera-start');
  const first = await requested<StageCaptureInput>(page, 'captures');
  await control(page, 'completeLater');
  await expect.poll(() => control(page, 'log')).toContain('recognition-completed');
  await control(page, 'fail', first.id, {
    code: 'invalid-request',
    message: 'Printing unavailable.',
  });
  const next = await requested<StageCaptureInput>(page, 'captures', 1);
  expect(next.arguments.captureId).toBe(first.arguments.captureId);
  expect(next.arguments.printingId).toBe('printing-ring');
  await control(page, 'settleCapture', next.id, {
    outcome: 'admitted',
    replayed: false,
    session: captureSession(),
    entry: captureEntry({ printingId: 'printing-ring' }),
  });
  await expect(page.locator('#import-camera-status')).toContainText('Accepted Sol Ring');
  await expect(page.getByRole('button', { name: 'Recover capture' })).toBeHidden();
  expect(await control(page, 'attachments')).toEqual([]);
  expect(errors).toEqual([]);
});

test('a comparison delivered after camera stop is excluded from pending capture recovery', async ({
  page,
}) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
    provisional: true,
    later: { candidates: [hostName('ring')], printingId: 'printing-ring' },
  });
  await page.click('#import-camera-start');
  const first = await requested<StageCaptureInput>(page, 'captures');
  await page.click('#import-camera-stop');
  await control(page, 'completeLater');
  await expect.poll(() => control(page, 'log')).toContain('recognition-completed');
  expect(await control(page, 'log')).not.toContain('recognition-reading-delivered');
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
  const recover = page.getByRole('button', { name: 'Recover capture' });
  await recover.click();
  const replay = await requested<StageCaptureInput>(page, 'captures', 1);
  expect(replay.arguments).toEqual(first.arguments);
  await control(page, 'settleCapture', replay.id, {
    outcome: 'admitted',
    replayed: true,
    session: captureSession(),
    entry: captureEntry(),
  });
  await expect(recover).toBeHidden();
  expect(await control(page, 'attachments')).toEqual([]);
  expect(errors).toEqual([]);
});

test('recovers a capture whose staging outcome was lost across a reload', async ({ page }) => {
  const errors = await openCapture(page);
  await settleSessions(page, 0, []);
  await control(page, 'scriptReading', {
    candidates: [hostName('bolt')],
    printingId: 'printing-bolt',
  });
  await page.click('#import-camera-start');
  const first = await requested<StageCaptureInput>(page, 'captures');
  await control(page, 'fail', first.id, { code: 'unavailable', message: 'Response lost.' });
  await expect(page.locator('#import-camera-status')).toContainText('staging outcome is unknown');

  // The observation and its identity belong to UserCards: a reloaded view presents the retained
  // attempt and recovers it through that attempt's own handle
  // (docs/user-cards.md#browser-operation-lifecycle).
  await page.reload();
  await page.addScriptTag({ content: await captureBundle(), type: 'module' });
  await page.waitForFunction(() => Reflect.has(globalThis, 'keeperCaptureControl'));
  await settleSessions(page, 0, []);
  const recover = page.getByRole('button', { name: 'Recover capture' });
  await expect(recover).toBeVisible();
  await expect(page.locator('#import-camera-start')).toBeDisabled();
  await recover.click();
  const replay = await requested<StageCaptureInput>(page, 'captures');
  expect(replay.arguments).toEqual(first.arguments);
  await control(page, 'settleCapture', replay.id, {
    outcome: 'admitted',
    replayed: true,
    session: captureSession(),
    entry: captureEntry(),
  });
  await expect(page.locator('#import-camera-status')).toHaveText(
    'The earlier capture was already accepted into review.',
  );
  await expect(recover).toBeHidden();
  await expect(page.locator('#import-camera-start')).toBeEnabled();
  expect(errors).toEqual([]);
});
