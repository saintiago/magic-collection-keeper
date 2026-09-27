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

import { RECOGNITION_LIMITS } from '../../src/recognition/index.js';
import type { ImportEntry, ImportSession } from '../../src/usercards/index.js';
import type {
  UiCaptureControl,
  UiCaptureEntriesRequest,
  UiCaptureRequest,
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
