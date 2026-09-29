/**
 * Browser journeys: the UserInterface shell (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation, docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the shell with the page, identity and device substitutes of
 * ui-shell.harness.ts and drive them in Chromium: deep links and reload, nested Back with
 * restored query, selection, focus and scroll, browser-driven traversals that capture the entry
 * they leave, interruption of a restoration a page still presents asynchronously, token lifetime
 * across reload, a late result, dialog or device release of a closed page, delayed, rejected and
 * completed sign-out, a redirect that happens while a page mounts or presents the restored entry,
 * and a brief dialog.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

import type { UiShellControl, UiShellStart } from './ui-shell.harness.js';
import { UI_LIMITS } from '../../src/ui/index.js';
import type { SearchIndexingStatus } from '../../src/search/browser.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = path.join(repoRoot, 'tests', 'browser', 'ui-shell.harness.ts');
const shellPage = '<!doctype html><html><body><div id="ui-root"></div></body></html>';

let bundle: Promise<string> | null = null;

/** Bundles the shell with the journey harness, as a deployment bundles the UI entry point. */
function shellBundle(): Promise<string> {
  bundle ??= (async () => {
    const result = await build({
      stdin: {
        contents: [
          `import { installUiShell } from ${JSON.stringify(harnessPath)};`,
          "globalThis.keeperUiControl = installUiShell(document.getElementById('ui-root'), {",
          '  signedOut: globalThis.keeperUiStartSignedOut === true,',
          '  deferredSignOut: globalThis.keeperUiDeferredSignOut === true,',
          '  deviceRelease: globalThis.keeperUiDeviceRelease,',
          '  asyncResults: globalThis.keeperUiAsyncResults === true,',
          '  presentedRedirect: globalThis.keeperUiPresentedRedirect,',
          '  rejectRedirect: globalThis.keeperUiRejectRedirect,',
          '  listResults: globalThis.keeperUiListResults,',
          '  pageNotices: globalThis.keeperUiPageNotices === true,',
          '  deferredPages: globalThis.keeperUiDeferredPages === true,',
          '});',
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'ui-shell-consumer.ts',
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

/** Serves a fresh document for the shell, enters it at `hash` and loads the bundled UI. */
async function openShell(page: Page, hash: string, start: UiShellStart = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-ui.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: shellPage }),
  );
  await page.goto(`http://keeper-ui.test/${hash}`);
  await page.evaluate((flags) => {
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.keeperUiStartSignedOut = flags.signedOut === true;
    globals.keeperUiDeferredSignOut = flags.deferredSignOut === true;
    globals.keeperUiDeviceRelease = flags.deviceRelease;
    globals.keeperUiAsyncResults = flags.asyncResults === true;
    globals.keeperUiPresentedRedirect = flags.presentedRedirect;
    globals.keeperUiRejectRedirect = flags.rejectRedirect;
    globals.keeperUiListResults = flags.listResults;
    globals.keeperUiPageNotices = flags.pageNotices === true;
    globals.keeperUiDeferredPages = flags.deferredPages === true;
  }, start);
  await loadShell(page);
  return errors;
}

async function loadShell(page: Page): Promise<void> {
  await page.addScriptTag({ content: await shellBundle(), type: 'module' });
}

/** Notes the harness recorded, oldest first. */
async function notes(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (globalThis as unknown as { keeperUiControl: { log(): string[] } }).keeperUiControl.log(),
  );
}

async function accountId(page: Page): Promise<string | null> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { keeperUiControl: { accountId(): string | null } }
    ).keeperUiControl.accountId(),
  );
}

/** Result requests the asynchronous page holds, waiting for the journey to answer them. */
async function asyncPending(page: Page): Promise<number> {
  return page.evaluate(() =>
    (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl.asyncPending(),
  );
}

/** Answers every held result request, as the asynchronous source's responses arriving would. */
async function answerAsyncResults(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.answerAsyncResults();
  });
}

/** Rejects every held result request, as a failing source would. */
async function failAsyncResults(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.failAsyncResults();
  });
}

/** Answers held result requests until the asynchronous page presented `count` results. */
async function completeAsyncResults(page: Page, count: number): Promise<void> {
  const entry = page.locator(`#async-result-${count}`);
  while ((await entry.count()) === 0) {
    await page.waitForFunction(
      () =>
        (
          globalThis as unknown as { keeperUiControl: UiShellControl }
        ).keeperUiControl.asyncPending() > 0,
    );
    await answerAsyncResults(page);
  }
  await expect(entry).toBeVisible();
}

/** Reports a verified account change inside the installed shell. */
async function signInAs(page: Page, accountIdValue: string): Promise<void> {
  await page.evaluate((value) => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.signInAs(value);
  }, accountIdValue);
}

/** Completes the sign-out the shell awaits, as the deployment's authentication would. */
async function completeSignOut(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.completeSignOut();
  });
}

/** Rejects the sign-out the shell awaits, as an authentication outage would. */
async function failSignOut(page: Page, message: string): Promise<void> {
  await page.evaluate((text) => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.failSignOut(text);
  }, message);
}

/** Releases the shell and its listeners. */
async function disposeShell(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.dispose();
  });
}

/** Publishes one indexing status of an account, as Search's progress tracker would. */
async function publishIndexing(
  page: Page,
  accountId: string,
  state: SearchIndexingStatus['state'],
  outstanding: readonly string[] = [],
): Promise<void> {
  await page.evaluate(
    (input) => {
      const control = (globalThis as unknown as { keeperUiControl: UiShellControl })
        .keeperUiControl;
      control.publishIndexing(input.accountId, input.state, input.outstanding);
    },
    { accountId, state, outstanding },
  );
}

/** Status checks the indexing notice's retry action requested. */
async function indexingChecks(page: Page, accountId: string): Promise<number> {
  return page.evaluate(
    (id) =>
      (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl.indexingChecks(
        id,
      ),
    accountId,
  );
}

/** Listeners one account's progress tracker still holds. */
async function indexingListeners(page: Page, accountId: string): Promise<number> {
  return page.evaluate(
    (id) =>
      (
        globalThis as unknown as { keeperUiControl: UiShellControl }
      ).keeperUiControl.indexingListeners(id),
    accountId,
  );
}

/** Resolves the deferred page factory of the late-factory journeys. */
async function resolveDeferredPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.resolveDeferredPage();
  });
}

/** Rejects the deferred page factory of the late-factory journeys. */
async function rejectDeferredPage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.rejectDeferredPage();
  });
}

test('a deep link presents its view and a reload keeps it', async ({ page }) => {
  const errors = await openShell(page, '#/cards/card-1/printing-1');
  await expect(page.getByRole('heading', { name: 'Card details' })).toBeVisible();
  await expect(page.locator('#card-level')).toHaveText('card-1/printing-1/-');
  await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();

  await page.reload();
  await loadShell(page);

  await expect(page.locator('#card-level')).toHaveText('card-1/printing-1/-');
  expect(page.url()).toBe('http://keeper-ui.test/#/cards/card-1/printing-1');
  expect(errors).toEqual([]);
});

test('every card level and a search query are directly enterable', async ({ page }) => {
  await openShell(page, '#/cards/card-1');
  await expect(page.locator('#card-level')).toHaveText('card-1/-/-');

  await openShell(page, '#/cards/card-1/printing-1/copy-1');
  await expect(page.locator('#card-level')).toHaveText('card-1/printing-1/copy-1');

  await openShell(page, '#/catalog?query=set%3Ablb+cn%3A1');
  await expect(page.locator('#catalog-query')).toHaveText('Query: set:blb cn:1');
});

test('a signed-out visitor gets the sign-in prompt instead of private presentation', async ({
  page,
}) => {
  await openShell(page, '#/collection', { signedOut: true });

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Collection' })).toHaveCount(0);
  await expect(page.locator('#collection-marker')).toHaveCount(0);

  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.locator('#collection-marker')).toBeVisible();
  expect(await accountId(page)).toBe('bob');
});

test('an unknown address presents a recoverable page', async ({ page }) => {
  await openShell(page, '#/not-a-page');

  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to Home' }).click();

  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
});

test('Back follows nested history and restores query, selection, focus and scroll', async ({
  page,
}) => {
  await openShell(page, '#/');
  await page.getByLabel('Search cards').fill('lightning bolt');
  await page.getByLabel('Select Bolt').check();
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);

  await page.getByRole('link', { name: 'Open printing' }).click();
  await expect(page.getByRole('heading', { name: 'Card details' })).toBeVisible();
  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();

  await page.goBack();
  await expect(page.locator('#card-level')).toHaveText('card-1/printing-1/-');

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByLabel('Search cards')).toHaveValue('lightning bolt');
  await expect(page.getByLabel('Select Bolt')).toBeChecked();
  await expect(page.locator('#home-open')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);
  expect(await notes(page)).toContain('home-restored');
});

test('a late result of a closed page never reaches the new view', async ({ page }) => {
  await openShell(page, '#/cards/card-1/printing-1');
  await expect(page.locator('#card-level')).toHaveText('card-1/printing-1/-');

  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();

  await expect.poll(() => notes(page)).toContain('card-loaded');
  expect(await notes(page)).toContain('card-aborted');
  await expect(page.locator('#card-late')).toHaveCount(0);
  await expect(page.locator('#collection-marker')).toBeVisible();
});

test('every page implementation learns that the shell left an account', async ({ page }) => {
  await openShell(page, '#/cards/card-1');
  await expect(page.locator('#card-level')).toHaveText('card-1/-/-');

  // The card is presented, and the Home implementation still learns that its account ended.
  await signInAs(page, 'bob');
  expect(await notes(page)).toContain('account-ended:alice');

  // Disposal ends the presented account too, so no page keeps private state past the shell.
  await disposeShell(page);
  expect(await notes(page)).toContain('account-ended:bob');
});

test('page-owned state survives history without a storage bound', async ({ page }) => {
  await openShell(page, '#/tags');

  // The page retains a selection far beyond any former history bound beside an unrelated draft;
  // navigation keeps that representation without reading or restricting it.
  await page.getByRole('button', { name: 'Select many' }).click();
  await expect(page.locator('#state-count')).toHaveText('150 selected');
  await page.getByLabel('State draft').fill('draft beside the selection');
  await page.locator('#state-open').click();
  await expect(page.locator('#collection-marker')).toBeVisible();

  await page.goBack();
  await expect(page.locator('#state-count')).toHaveText('150 selected');
  await expect(page.getByLabel('State draft')).toHaveValue('draft beside the selection');
});

test('history eviction releases the state of the oldest entries', async ({ page }) => {
  await openShell(page, '#/tags');
  await page.getByLabel('State draft').fill('oldest');
  const visits = UI_LIMITS.viewStates + 2;
  for (let index = 1; index <= visits; index += 1) {
    await page.locator('#state-open').click();
    await expect(page.locator('#collection-marker')).toBeVisible();
    await page.getByRole('link', { name: 'Tags', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();
    await page.getByLabel('State draft').fill(`draft-${index}`);
  }

  // Back reaches every entry again. The entries beyond the history bound were evicted with the
  // state they retained, while the entries inside it restore their own draft.
  const drafts: string[] = [];
  for (let index = visits; index >= 1; index -= 1) {
    await page.goBack();
    await expect(page.locator('#collection-marker')).toBeVisible();
    // The last step reaches the very first entry of the journey.
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();
    drafts.push(await page.getByLabel('State draft').inputValue());
  }

  expect(drafts.at(0)).toBe(`draft-${visits - 1}`);
  // Every entry inside the bound still restores the draft it captured, in its own order...
  const retained = drafts.filter((value) => value.length > 0);
  expect(retained).toEqual(retained.map((_, index) => `draft-${visits - 1 - index}`));
  expect(retained.length).toBeGreaterThanOrEqual(UI_LIMITS.viewStates / 2 - 1);
  // ...while every entry beyond it kept nothing, the first entry of the journey included.
  expect(drafts.slice(retained.length).every((value) => value === '')).toBe(true);
  expect(drafts.at(-1)).toBe('');

  // The page whose state was evicted still works: the entry captures a fresh draft again.
  await page.getByLabel('State draft').fill('fresh');
  await page.locator('#state-open').click();
  await expect(page.locator('#collection-marker')).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('State draft')).toHaveValue('fresh');
});

test('sign-out removes private presentation state and ends the session', async ({ page }) => {
  await openShell(page, '#/');
  await page.getByLabel('Search cards').fill('lightning bolt');
  await page.getByLabel('Select Bolt').check();
  await page.getByRole('link', { name: 'Open printing' }).click();
  await expect(page.getByRole('heading', { name: 'Card details' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Search cards')).toHaveCount(0);
  expect(await notes(page)).toEqual(
    expect.arrayContaining(['session-ended', 'device-released', 'card-aborted']),
  );

  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Card details' })).toBeVisible();
  expect(await accountId(page)).toBe('bob');

  // The signed-out account's restoration state never reaches the account that signs in next.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByLabel('Search cards')).toHaveValue('');
  await expect(page.getByLabel('Select Bolt')).not.toBeChecked();
});

test('a brief dialog reports the user decision', async ({ page }) => {
  await openShell(page, '#/');

  await page.getByRole('button', { name: 'Edit tag' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#home-dialog-answer')).toHaveText('cancelled');

  await page.getByRole('button', { name: 'Edit tag' }).click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#home-dialog-answer')).toHaveText('confirmed');
});

test('edits between repeated Back and Forward traversals are kept', async ({ page }) => {
  await openShell(page, '#/');
  await page.getByLabel('Search cards').fill('initial');
  await page.getByRole('link', { name: 'Open printing' }).click();
  await expect(page.locator('#card-level')).toHaveText('card-1/printing-1/-');

  // The browser traverses, not the shell: leaving Home must capture what the page holds now.
  await page.goBack();
  await expect(page.getByLabel('Search cards')).toHaveValue('initial');
  await page.getByLabel('Search cards').fill('latest');
  await page.getByLabel('Select Bolt').check();
  await page.evaluate(() => window.scrollTo(0, 800));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(800);

  await page.goForward();
  await expect(page.locator('#card-level')).toHaveText('card-1/printing-1/-');

  await page.goBack();
  await expect(page.getByLabel('Search cards')).toHaveValue('latest');
  await expect(page.getByLabel('Select Bolt')).toBeChecked();
  await expect(page.getByLabel('Select Bolt')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(800);
  expect(await notes(page)).toContain('home-restored');
});

test('an interrupted restoration keeps the saved window and focused result', async ({ page }) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);

  // Leave the view from its last result, so the entry keeps the whole window, the focused result
  // link and the scroll offset.
  await page.locator('#async-result-100').focus();
  const savedScroll = await page.evaluate(() => window.scrollY);
  await page.locator('#async-result-100').click();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

  // Back presents the entry while its restored window is still loading; Forward leaves it again
  // before the first response of the source arrived.
  await page.goBack();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await page.goForward();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');
  await page.goBack();

  // A second interruption before the response arrives must keep the same context.
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await page.goForward();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');
  await page.goBack();

  // The interrupted entry kept the context it was restoring instead of the empty window and the
  // heading the shell focused while the page was still empty.
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-100')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(savedScroll);
  expect(errors).toEqual([]);
});

test('leaving through a link while the second page loads keeps the whole window', async ({
  page,
}) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);
  await page.locator('#async-result-100').focus();
  const savedScroll = await page.evaluate(() => window.scrollY);
  await page.locator('#async-result-100').click();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

  // Back presents the entry and the source answers its first page; the second page is still
  // loading when the user opens an entry of the presented page.
  await page.goBack();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await answerAsyncResults(page);
  await expect(page.locator('#async-result-50')).toBeVisible();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await page.locator('#async-result-50').click();
  await expect(page.locator('#card-level')).toHaveText('card-50/-/-');

  // The interrupted entry kept the window it was restoring, not the fifty entries loaded so far
  // and the result the user left through.
  await page.goBack();
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-100')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(savedScroll);
  expect(errors).toEqual([]);
});

test('a restored entry captures its live state once the page presented it', async ({ page }) => {
  await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);
  await page.locator('#async-result-100').click();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

  // Back restores the entry and the page presents its whole window; the entry then captures the
  // state of the presented view again.
  await page.goBack();
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-100')).toBeFocused();
  await page.locator('#async-result-50').focus();
  await page.locator('#async-result-50').click();
  await expect(page.locator('#card-level')).toHaveText('card-50/-/-');

  await page.goBack();
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-50')).toBeFocused();
});

test('early input still allows later interaction to replace the restored focus and scroll', async ({
  page,
}) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);
  await page.locator('#async-result-100').click();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

  // The user acts while the restored window is still loading: the automatic restoration of the
  // entry's focus and scroll is cancelled, but the entry keeps its context.
  await page.goBack();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-100')).not.toBeFocused();

  // Later interaction becomes the entry's own context, including keyboard activation.
  const first = page.locator('#async-result-1');
  await first.focus();
  await first.evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().top - 90));
  const savedTop = await first.evaluate((element) => element.getBoundingClientRect().top);
  await first.press('Enter');
  await expect(page.locator('#card-level')).toHaveText('card-1/-/-');

  await page.goBack();
  await completeAsyncResults(page, 100);
  await expect(first).toBeFocused();
  await expect
    .poll(async () =>
      Math.abs((await first.evaluate((element) => element.getBoundingClientRect().top)) - savedTop),
    )
    .toBeLessThan(2);
  expect(errors).toEqual([]);
});

test('a restored entry keeps its visible result while late content arrives', async ({ page }) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);
  await page.locator('#async-result-100').focus();
  await page
    .locator('#async-result-100')
    .evaluate((element) => window.scrollBy(0, element.getBoundingClientRect().top - 120));
  const anchor = await visibleAnchor(page);
  await page.locator('#async-result-100').click();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

  // Back presents the window again; late content is inserted above it, as decoded images or
  // fragments arriving after the presentation would shift it.
  await page.goBack();
  await completeAsyncResults(page, 100);
  await page.evaluate(() => {
    const control = (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl;
    control.shiftAsyncLayout();
  });

  const moved = await visibleAnchor(page);
  expect(moved?.id).toBe(anchor?.id);
  expect(Math.abs((moved?.top ?? 0) - (anchor?.top ?? 0))).toBeLessThan(2);
  expect(errors).toEqual([]);
});

/** The element and viewport offset the shell keeps for an entry, computed as the shell does. */
async function visibleAnchor(
  page: Page,
): Promise<{ readonly id: string; readonly top: number } | null> {
  return page.evaluate(() => {
    let closest: { id: string; top: number } | null = null;
    for (const element of document.querySelectorAll<HTMLElement>('main [id]')) {
      const rect = element.getBoundingClientRect();
      if (
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.top < innerHeight &&
        (closest === null || Math.abs(rect.top) < Math.abs(closest.top))
      ) {
        closest = { id: element.id, top: rect.top };
      }
    }
    return closest;
  });
}

test('an account change during a pending restoration presents the new account alone', async ({
  page,
}) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);
  await page.locator('#async-result-100').focus();
  await page.locator('#async-result-100').click();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');
  await page.goBack();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);

  await signInAs(page, 'bob');

  // The account change cleared the pending restoration with the entry it belonged to: the new
  // account presents its own result window and the stale restoration changes nothing.
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-100')).not.toBeFocused();
  expect(errors).toEqual([]);
});

for (const redirect of ['navigate', 'replace'] as const) {
  test(`a page that ${redirect}s while presenting leaves the destination restoring`, async ({
    page,
  }) => {
    const errors = await openShell(page, '#/', { asyncResults: true, presentedRedirect: redirect });
    await completeAsyncResults(page, 100);
    await page.locator('#async-result-100').click();
    await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

    // Back restores the entry; while presenting the kept window, Home sends the user to Collection.
    await page.goBack();
    await expect(page.locator('#collection-marker')).toBeVisible();

    // The destination owns the shell's restoration from here: leaving it captures its focused
    // link and scroll offset, and Back returns them.
    await page.locator('#collection-open').focus();
    await page.evaluate(() => window.scrollTo(0, 459));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(459);
    await page.locator('#collection-open').click();
    await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();

    await page.goBack();
    await expect(page.locator('#collection-marker')).toBeVisible();
    await expect(page.locator('#collection-open')).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(459);
    expect(errors).toEqual([]);
  });
}

test('a reload never lets a new capture reach a surviving history entry', async ({ page }) => {
  await openShell(page, '#/');
  await page.getByLabel('Search cards').fill('before reload');
  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await page.getByLabel('Search cards').fill('second entry');
  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();

  await page.reload();
  await loadShell(page);

  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByLabel('Search cards').fill('after reload');
  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();

  // The entry the user left after the reload restores its own state...
  await page.goBack();
  await expect(page.getByLabel('Search cards')).toHaveValue('after reload');

  // ...while every entry the reload made stateless restores nothing, not the new snapshot.
  await page.goBack();
  await page.goBack();
  await expect(page.getByLabel('Search cards')).toHaveValue('');
  await page.goBack();
  await page.goBack();
  await expect(page.getByLabel('Search cards')).toHaveValue('');
});

test('a delayed sign-out withdraws the private page and completes', async ({ page }) => {
  await openShell(page, '#/', { deferredSignOut: true });
  await page.getByLabel('Search cards').fill('private query');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#ui-root main')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeDisabled();

  await completeSignOut(page);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Search cards')).toHaveCount(0);
  expect(await notes(page)).toEqual(expect.arrayContaining(['session-ended', 'device-released']));
});

test('a rejected sign-out returns a live page with working controls', async ({ page }) => {
  await openShell(page, '#/', { deferredSignOut: true });
  await page.getByLabel('Search cards').fill('private query');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#ui-root main')).toBeHidden();
  await failSignOut(page, 'Authentication unavailable');

  await expect(page.getByText('Authentication unavailable')).toBeVisible();
  await expect(page.getByLabel('Search cards')).toHaveValue('private query');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  await page.getByRole('button', { name: 'Go to collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();
});

test('a page without a state handle keeps focus and scroll for the way back', async ({ page }) => {
  await openShell(page, '#/collection');
  await expect(page.locator('#collection-marker')).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);

  await page.getByRole('link', { name: 'Open tags' }).click();
  await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();

  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Collection' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open tags' })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(500);
});

test('a page that redirects while mounting leaves the destination in charge', async ({ page }) => {
  await openShell(page, '#/tags/redirect');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.locator('#tag-marker')).toHaveCount(0);
  expect(await notes(page)).toEqual(
    expect.arrayContaining(['redirect-mounted', 'redirect-disposed']),
  );

  await page.getByLabel('Search cards').fill('kept');
  await page.getByRole('link', { name: 'Collection' }).click();
  await page.goBack();

  await expect(page.getByLabel('Search cards')).toHaveValue('kept');
});

test('a closed page cannot open a dialog or release the device of the new view', async ({
  page,
}) => {
  await openShell(page, '#/cards/card-1');
  await expect(page.locator('#card-level')).toHaveText('card-1/-/-');

  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();

  await expect.poll(() => notes(page)).toContain('card-dialog:false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await notes(page)).not.toContain('device-released');
});

test('an account change ends the previous page dialog and device access', async ({ page }) => {
  await openShell(page, '#/cards/card-1');
  await expect(page.locator('#card-level')).toHaveText('card-1/-/-');

  await signInAs(page, 'bob');
  await expect(page.getByRole('heading', { name: 'Card details' })).toBeVisible();

  await expect.poll(() => notes(page)).toContain('card-dialog:false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The account change released the device once; the closed page's delayed attempt changed nothing.
  expect((await notes(page)).filter((note) => note === 'device-released')).toHaveLength(1);
});

test('a disposed shell ignores the delayed work of its last page', async ({ page }) => {
  await openShell(page, '#/cards/card-1');
  await expect(page.locator('#card-level')).toHaveText('card-1/-/-');

  await disposeShell(page);
  await expect(page.locator('#ui-root')).toBeEmpty();

  await expect.poll(() => notes(page)).toContain('card-dialog:false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a failed restoration keeps the entry interaction until explicit input', async ({ page }) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);

  // Leave the entry from one of its results, with the focused element and the scroll offset the
  // entry keeps for the way back.
  await page.locator('#async-result-70').focus();
  await page.locator('#async-result-70').evaluate((element) => {
    window.scrollBy(0, element.getBoundingClientRect().top - 120);
  });
  const savedScroll = await page.evaluate(() => window.scrollY);
  await page.locator('#async-result-70').click();
  await expect(page.locator('#card-level')).toHaveText('card-70/-/-');

  // Back restores the entry, and the source rejects the request the page presents it through.
  await page.goBack();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await failAsyncResults(page);

  // The failed presentation stops the automatic restoration without discarding the entry's
  // interaction: leaving and returning supplies the saved focus and scroll offset again, not the
  // empty view the shell focused while the page was still empty.
  await page.goForward();
  await expect(page.locator('#card-level')).toHaveText('card-70/-/-');
  await page.goBack();
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-70')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(savedScroll);
  expect(errors).toEqual([]);
});

test('input after a failed restoration replaces the retained interaction', async ({ page }) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);
  await page.locator('#async-result-70').focus();
  await page.locator('#async-result-70').click();
  await expect(page.locator('#card-level')).toHaveText('card-70/-/-');

  await page.goBack();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await failAsyncResults(page);

  // The user acts after the presentation failed: the entry stops keeping the context it could not
  // apply and captures the interaction the user chose from here on.
  await page.keyboard.press('Tab');
  await page.goForward();
  await expect(page.locator('#card-level')).toHaveText('card-70/-/-');
  await page.goBack();
  await completeAsyncResults(page, 100);
  await expect(page.locator('#async-result-70')).not.toBeFocused();
  expect(errors).toEqual([]);
});

test('an explicitly cleared page state stays cleared for the way back', async ({ page }) => {
  const errors = await openShell(page, '#/', { asyncResults: true });
  await completeAsyncResults(page, 100);
  await page.locator('#async-result-100').click();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

  // Back presents the entry while its window is still loading; the page clears the state it
  // retains before the user leaves it again.
  await page.goBack();
  await expect.poll(() => asyncPending(page)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Clear results' }).click();
  await page.goForward();
  await expect(page.locator('#card-level')).toHaveText('card-100/-/-');

  // The entry kept what the page captured — no page state at all — instead of the state it was
  // still restoring.
  const mounts = (await notes(page)).filter((note) => note.startsWith('async-state:')).length;
  await page.goBack();
  await completeAsyncResults(page, 100);
  const supplied = (await notes(page)).filter((note) => note.startsWith('async-state:'));
  expect(supplied.slice(mounts)).toEqual(['async-state:none']);
  expect(errors).toEqual([]);
});

for (const transition of ['navigate', 'replace', 'back', 'hash', 'account', 'dispose'] as const) {
  test(`device teardown releases before ownership passes on ${transition}`, async ({ page }) => {
    await openShell(page, '#/collection');
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Release device', exact: true })).toBeVisible();

    if (transition === 'navigate')
      await page.getByRole('link', { name: 'Collection', exact: true }).click();
    else if (transition === 'replace')
      await page.getByRole('button', { name: 'Replace with collection' }).click();
    else if (transition === 'back') await page.goBack();
    else if (transition === 'hash')
      await page.evaluate(() => {
        location.hash = '#/collection';
      });
    else if (transition === 'account') await signInAs(page, 'bob');
    else await disposeShell(page);

    await expect.poll(() => notes(page)).toContain('late-release-called');
    const log = await notes(page);
    expect(log.slice(0, 4)).toEqual([
      'device-released',
      'abort-release-called',
      'device-released',
      'dispose-release-called',
    ]);
    // Account change and disposal also run shell-owned cleanup; the delayed page call adds none.
    expect(log.filter((note) => note === 'device-released')).toHaveLength(
      transition === 'account' || transition === 'dispose' ? 3 : 2,
    );
    if (transition !== 'account' && transition !== 'dispose') {
      await expect(page.locator('#collection-marker')).toBeVisible();
    }
  });
}

for (const outcome of ['complete', 'reject', 'throw'] as const) {
  test(`active page observes device release ${outcome}`, async ({ page }) => {
    const errors = await openShell(page, '#/import', {
      deviceRelease: outcome === 'throw' ? 'throw' : 'deferred',
    });
    await page.getByRole('button', { name: 'Release device', exact: true }).click();
    if (outcome !== 'throw') {
      await expect(page.getByText('Releasing', { exact: true })).toBeVisible();
      await settleDeviceRelease(page, outcome === 'reject' ? 'Device unavailable' : undefined);
    }
    await expect(
      page.getByText(outcome === 'complete' ? 'Released' : 'Release failed', { exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const transition of ['account', 'sign-out', 'dispose'] as const) {
  for (const outcome of ['reject', 'throw'] as const) {
    test(`shell handles device ${outcome} during ${transition}`, async ({ page }) => {
      const errors = await openShell(page, '#/', {
        deviceRelease: outcome === 'throw' ? 'throw' : 'deferred',
      });
      if (transition === 'account') await signInAs(page, 'bob');
      else if (transition === 'sign-out')
        await page.getByRole('button', { name: 'Sign out' }).click();
      else await disposeShell(page);
      if (outcome === 'reject') await settleDeviceRelease(page, 'Device unavailable');

      // Cross an event-loop turn so an unhandled rejection has reached pageerror.
      await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      expect((await notes(page)).filter((note) => note === 'device-released')).toHaveLength(1);
      if (transition === 'account') expect(await accountId(page)).toBe('bob');
      else if (transition === 'sign-out')
        await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
      else await expect(page.locator('#ui-root')).toBeEmpty();
      expect(errors).toEqual([]);
    });
  }
}

test('one indexing notice persists across pages until the changes are incorporated', async ({
  page,
}) => {
  const errors = await openShell(page, '#/');
  const notice = page.locator('[data-ui-notice="navigation:indexing"]');
  await expect(notice).toHaveCount(0);

  await publishIndexing(page, 'alice', 'indexing', ['5']);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'progress');
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice.locator('.ui-notice-spinner')).toBeVisible();
  await expect(notice).toContainText('Indexing your cards…');

  // The notice stays across page changes, and concurrent changes combine into the same one.
  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();
  await expect(notice).toBeVisible();
  await publishIndexing(page, 'alice', 'indexing', ['5', '6']);
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('Indexing your cards…');

  await publishIndexing(page, 'alice', 'incorporated');
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the indexing notice reports delayed and failed progress with a status-only retry', async ({
  page,
}) => {
  const errors = await openShell(page, '#/');
  await publishIndexing(page, 'alice', 'indexing', ['5']);
  await publishIndexing(page, 'alice', 'delayed', ['5']);

  const notice = page.locator('[data-ui-notice="navigation:indexing"]');
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'status');
  await expect(notice).toContainText('Indexing is delayed');
  await expect(notice.locator('.ui-notice-spinner')).toBeHidden();

  // The retry checks progress and repeats no write, and a keyboard user reaches it.
  const requests = (await notes(page)).filter((note) => note.startsWith('request:'));
  const retry = notice.getByRole('button', { name: 'Check indexing status' });
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => indexingChecks(page, 'alice')).toBe(1);
  expect(await indexingChecks(page, 'alice')).toBe(1);
  expect((await notes(page)).filter((note) => note.startsWith('request:'))).toEqual(requests);

  await publishIndexing(page, 'alice', 'failed', ['5']);
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice.locator('.ui-notice-mark')).toHaveText('Error:');
  await expect(notice).toContainText('Indexing failed');
  await expect(notice.locator('.ui-notice-spinner')).toBeHidden();
  expect(errors).toEqual([]);
});

test('an account change clears the indexing notice and fences the departed progress', async ({
  page,
}) => {
  const errors = await openShell(page, '#/');
  await publishIndexing(page, 'alice', 'indexing', ['5']);
  const notice = page.locator('[data-ui-notice="navigation:indexing"]');
  await expect(notice).toBeVisible();

  await signInAs(page, 'bob');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(notice).toHaveCount(0);
  expect(await indexingListeners(page, 'alice')).toBe(0);

  // A status the account the shell left publishes later reaches no notice of the new account.
  await publishIndexing(page, 'alice', 'indexing', ['6']);
  await expect(notice).toHaveCount(0);

  // The presented account's own progress is presented again.
  await publishIndexing(page, 'bob', 'indexing', ['7']);
  await expect(notice).toBeVisible();
  expect(errors).toEqual([]);
});

test('a page reports an operation failure as a floating error notice it updates and dismisses', async ({
  page,
}) => {
  const errors = await openShell(page, '#/collection', { pageNotices: true });
  await expect(page.locator('#notices-page')).toBeVisible();
  await expect(page.locator('[data-ui-notice]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Report failure' }).click();
  const notice = page.locator('[data-ui-notice="navigation:page:alice:operation-1"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'error');
  await expect(notice).toContainText('Saving could not be confirmed.');
  await expect(notice.locator('.ui-notice-mark')).toHaveText('Error:');
  await expect(notice.locator('.ui-notice-spinner')).toBeHidden();
  // Red styling with a textual indicator; color alone never carries the meaning.
  expect(await notice.evaluate((element) => getComputedStyle(element).color)).toBe(
    'rgb(185, 28, 28)',
  );

  // The recovery action belongs to the view that reported the operation.
  await notice.getByRole('button', { name: 'Check the saved state' }).click();
  expect(await notes(page)).toContain('notice-action');

  // A repeated report of the same operation replaces the notice instead of duplicating it.
  await page.getByRole('button', { name: 'Report progress' }).click();
  await expect(notice).toHaveCount(1);
  await expect(notice).toHaveAttribute('data-ui-notice-severity', 'progress');
  await expect(notice.locator('.ui-notice-spinner')).toBeVisible();
  await expect(notice).toContainText('Saving…');

  // The explicit dismiss control removes it.
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a reported failure survives navigation and a closed page reports no notice', async ({
  page,
}) => {
  const errors = await openShell(page, '#/collection', { pageNotices: true });
  await page.getByRole('button', { name: 'Report failure' }).click();
  const notice = page.locator('[data-ui-notice="navigation:page:alice:operation-1"]');
  await expect(notice).toBeVisible();

  // Leaving the reporting page keeps the failure visible with its dismiss control.
  await page.getByRole('link', { name: 'Open tags' }).click();
  await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toHaveCount(0);

  // A page the shell left reports late: its notice reaches neither this view nor the next.
  await expect.poll(() => notes(page)).toContain('late-notice-reported');
  await expect(page.locator('[data-ui-notice="navigation:page:alice:late-1"]')).toHaveCount(0);
  await expect(page.locator('[data-ui-notice]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a page factory that resolves after the shell left its view mounts nothing', async ({
  page,
}) => {
  const errors = await openShell(page, '#/tags', { deferredPages: true });
  await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();
  await expect(page.locator('[data-ui-page-loading]')).toBeVisible();

  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();
  await resolveDeferredPage(page);
  await expect(page.locator('#deferred-marker')).toHaveCount(0);

  // The resolved factory still presents its page on the next visit.
  await page.getByRole('link', { name: 'Tags', exact: true }).click();
  await expect(page.locator('#deferred-marker')).toBeVisible();
  expect(await notes(page)).toContain('deferred-mounted');
  expect(errors).toEqual([]);
});

test('a page factory that cannot load presents recoverable feedback and keeps the shell usable', async ({
  page,
}) => {
  const errors = await openShell(page, '#/tags', { deferredPages: true });
  await expect(page.locator('[data-ui-page-loading]')).toBeVisible();
  await rejectDeferredPage(page);

  await expect(page.locator('[data-ui-page-unavailable]')).toHaveText(
    'The tags page could not be loaded.',
  );
  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#collection-marker')).toBeVisible();
  expect(errors).toEqual([]);
});

async function settleDeviceRelease(page: Page, message?: string): Promise<void> {
  await page.evaluate((failure) => {
    (
      globalThis as unknown as { keeperUiControl: UiShellControl }
    ).keeperUiControl.completeDeviceRelease(failure);
  }, message);
}

for (const redirect of ['navigate', 'replace'] as const) {
  test(`a rejected presentation after ${redirect} stays contained in the departed page`, async ({
    page,
  }) => {
    const errors = await openShell(page, '#/', {
      asyncResults: true,
      presentedRedirect: redirect,
      rejectRedirect: true,
    });
    await completeAsyncResults(page, 100);
    await page.locator('#async-result-100').click();
    await page.goBack();
    await expect(page.locator('#collection-marker')).toBeVisible();
    await page.locator('#collection-open').focus();
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await expect(page.locator('#collection-open')).toBeFocused();
    expect(errors).toEqual([]);
  });
}

for (const identity of ['identified', 'anonymous'] as const) {
  for (const control of ['selection', 'fragment'] as const) {
    test(`shell preserves list-restored ${control} focus in an ${identity} container`, async ({
      page,
    }) => {
      const errors = await openShell(page, '#/', { listResults: identity });
      const focus = page.locator(
        control === 'fragment'
          ? '[data-ui-entry="card:1"] [data-ui-fragment-retry]'
          : '[data-ui-entry="card:1"] input[type="checkbox"]',
      );
      await focus.focus();
      await expect(focus).toBeFocused();
      await page.evaluate(() => {
        (globalThis as unknown as { keeperUiControl: UiShellControl }).keeperUiControl.navigate({
          page: 'collection',
          query: '',
          level: 'card',
        });
      });
      await expect(page.locator('#collection-marker')).toBeVisible();
      await page.goBack();
      await expect(focus).toBeFocused();
      // A second traversal exercises capture after the shell completed the first restoration.
      await page.goForward();
      await expect(page.locator('#collection-marker')).toBeVisible();
      await page.goBack();
      await expect(focus).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}
