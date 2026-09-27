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

async function settleDeviceRelease(page: Page, message?: string): Promise<void> {
  await page.evaluate((failure) => {
    (
      globalThis as unknown as { keeperUiControl: UiShellControl }
    ).keeperUiControl.completeDeviceRelease(failure);
  }, message);
}
