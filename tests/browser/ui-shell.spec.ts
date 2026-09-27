/**
 * Browser journeys: the UserInterface shell (docs/user-interface.md#interface,
 * docs/user-interface.md#pages-and-navigation, docs/testing.md#component-acceptance-scenarios).
 *
 * The cases bundle the shell with the page, identity and device substitutes of
 * ui-shell.harness.ts and drive them in Chromium: deep links and reload, nested Back with
 * restored query, selection, focus and scroll, a late result of a closed page, sign-out and
 * account changes with private presentation state, and a brief dialog.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

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
interface ShellStart {
  readonly signedOut?: boolean;
}

/** Serves a fresh document for the shell, enters it at `hash` and loads the bundled UI. */
async function openShell(page: Page, hash: string, start: ShellStart = {}): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
  await page.route('http://keeper-ui.test/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: shellPage }),
  );
  await page.goto(`http://keeper-ui.test/${hash}`);
  if (start.signedOut === true) {
    await page.evaluate(() => {
      (globalThis as unknown as { keeperUiStartSignedOut: boolean }).keeperUiStartSignedOut = true;
    });
  }
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
