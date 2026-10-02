/** Browser evidence for the local design storybook (docs/testing.md#local-design-storybook). */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const storybookRoot = path.join(repoRoot, 'storybook');
let bundle: Promise<string> | null = null;

function storybookBundle(): Promise<string> {
  bundle ??= build({
    entryPoints: [path.join(storybookRoot, 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  }).then((result) => {
    const output = result.outputFiles?.[0];
    if (output === undefined) throw new Error('esbuild produced no storybook bundle.');
    return output.text;
  });
  return bundle;
}

async function openStorybook(page: Page, route = ''): Promise<string[]> {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const [html, css, card, javascript] = await Promise.all([
    readFile(path.join(storybookRoot, 'index.html'), 'utf8'),
    readFile(path.join(storybookRoot, 'storybook.css'), 'utf8'),
    readFile(path.join(storybookRoot, 'card-back.svg'), 'utf8'),
    storybookBundle(),
  ]);
  await page.route('http://keeper-storybook.test/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/app.js') {
      return route.fulfill({ contentType: 'text/javascript', body: javascript });
    }
    if (pathname === '/storybook.css') {
      return route.fulfill({ contentType: 'text/css', body: css });
    }
    if (pathname === '/card-back.svg') {
      return route.fulfill({ contentType: 'image/svg+xml', body: card });
    }
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto(`http://keeper-storybook.test/${route}`);
  return requests;
}

async function advance(page: Page): Promise<void> {
  const previous = await page.locator('#stage-status').textContent();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.press('Space');
  await expect(page.locator('#stage-status')).not.toHaveText(previous ?? '');
}

test('holds initial, partial, transient and failed states until one Space press each', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  const requests = await openStorybook(page);

  await expect(page.locator('#initial-loading')).toBeVisible();
  await page.waitForTimeout(50);
  await expect(page.locator('#initial-loading')).toBeVisible();
  await advance(page);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  await page.getByRole('link', { name: 'Catalog' }).click();
  await expect(page.locator('#stage-status')).toContainText('Loading catalog results');
  const query = page.locator('#catalog-search');
  await query.fill('bolt');
  await query.press('Space');
  await expect(query).toHaveValue('bolt ');
  await expect(page.locator('#stage-status')).toContainText('Loading catalog results');

  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', repeat: true, bubbles: true }),
    );
  });
  await expect(page.locator('#stage-status')).toContainText('Loading catalog results');

  await query.fill('Counterspell');
  await query.press('Enter');
  await expect(page.locator('#stage-status')).toContainText('Loading catalog results');
  await advance(page);
  await expect(page.getByText('Counterspell', { exact: true })).toBeVisible();
  await expect(page.getByText('Lightning Bolt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Loading ownership…').first()).toBeVisible();
  await expect(page.locator('#stage-status')).toContainText('Loading ownership and tags');
  await advance(page);
  await expect(page.locator('#stage-status')).toHaveText('No stage is waiting.');

  await page.getByRole('link', { name: 'Tags' }).click();
  await expect(page.locator('#stage-status')).toContainText('Loading tags');
  await advance(page);
  await expect(page.getByText('Friday deck', { exact: true })).toBeVisible();

  await page.locator('#tag-create-label').fill('Failure example');
  await page.locator('#tag-create').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator('#tag-create-status')).toHaveText('Creating…');
  await page.locator('#fail-next-stage').check();
  await page.keyboard.press('Space');
  await expect(page.locator('#tag-create-status')).toContainText('outcome is unknown');
  if ((await page.locator('#stage-status').textContent())?.includes('Loading tags')) {
    await advance(page);
  }

  await page.locator('#tag-create-label').fill('Success example');
  await page.locator('#tag-create').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.locator('#tag-create-status')).toHaveText('Creating…');
  await advance(page);
  await expect(page.getByText('Success example', { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Collection' }).click();
  await expect(page.locator('#stage-status')).toContainText('Loading collection results');
  await advance(page);
  await expect(page.getByRole('heading', { name: 'Your collection' })).toBeVisible();
  await expect(page.getByText('Lightning Bolt', { exact: true })).toBeVisible();
  await expect(page.locator('#stage-status')).toHaveText('No stage is waiting.');

  await page.getByRole('link', { name: 'Import' }).click();
  await advance(page);
  await expect(page.getByRole('heading', { name: 'Manual entry' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pending review' })).toBeVisible();
  await expect(page.getByText('Start the camera to capture cards hands-free.')).toBeVisible();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.getByText('Waiting for camera permission…')).toBeVisible();
  await advance(page);
  await expect(page.getByText('Reading Lightning Bolt.')).toBeVisible();
  await expect(page.locator('#stage-status')).toContainText('Adding captured card to review');
  await advance(page);
  await expect(page.locator('#import-camera-status')).toContainText(
    'Accepted Lightning Bolt into review.',
  );

  expect(errors).toEqual([]);
  expect(
    requests.every((request) => new URL(request).origin === 'http://keeper-storybook.test'),
  ).toBe(true);
});

test('restores initial loading after cancellation and failure', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await openStorybook(page);

  await page.getByRole('button', { name: 'Design language' }).click();
  await page.getByRole('button', { name: 'Mocked app' }).click();
  await expect(page.locator('#stage-status')).toContainText('Loading mocked app');
  await advance(page);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  await page.reload();
  await page.locator('#fail-next-stage').check();
  await page.keyboard.press('Space');
  await expect(page.locator('#initial-loading')).toContainText('loading failed');
  await expect(page.locator('#stage-status')).toContainText('Loading mocked app');
  await advance(page);
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('honors card-specific collection criteria and empty results', async ({ page }) => {
  await openStorybook(page, '#/collection?level=copy&cardId=counterspell');
  await advance(page);
  await expect(page.locator('#stage-status')).toContainText('Loading collection results');
  await advance(page);
  await expect(page.getByText('Lightning Bolt', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No entries')).toBeVisible();
});

test('stages and confirms a populated local import', async ({ page }) => {
  await openStorybook(page, '#/import');
  await advance(page);
  await expect(page.locator('#stage-status')).toContainText('Loading pending imports');
  await advance(page);

  await page.getByLabel('Card lines').fill('1 Lightning Bolt');
  await page.getByRole('button', { name: 'Add source to review' }).click();
  await expect(page.locator('#stage-status')).toContainText('Importing source cards');
  await advance(page);
  await expect(page.locator('#import-source-status')).toContainText('1');

  await expect(page.locator('#stage-status')).toContainText('Loading pending imports');
  await advance(page);
  await expect(page.locator('#stage-status')).toContainText('Loading pending entries');
  await advance(page);
  await expect(page.getByText('Lightning Bolt', { exact: true })).toBeVisible();

  await page.locator('[data-ui-select]').check();
  await page.getByRole('button', { name: 'Confirm selected' }).click();
  await expect(page.locator('#stage-status')).toContainText('Confirming import');
  await advance(page);
  await expect(page.locator('#import-pending-status')).toContainText('copy');
});

test('shows the design language through shared card, dialog and notice presenters', async ({
  page,
}) => {
  const requests = await openStorybook(page);
  await page.getByRole('button', { name: 'Design language' }).click();

  await expect(page.getByRole('heading', { name: 'Design language' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();
  await expect(page.getByText('Loading cards')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-ui-basic]')).toContainText('Lightning Bolt M11 149 · en');
  await expect(page.locator('[data-ui-notice="design-error"]')).toContainText(
    'Error:The mock operation could not be completed.',
  );
  await expect(page.locator('[data-ui-notice="design-error"]')).toContainText('Try again');
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();

  expect(
    requests.every((request) => new URL(request).origin === 'http://keeper-storybook.test'),
  ).toBe(true);
});

test('evaluates supported Catalog expressions and rejects unsupported syntax', async ({ page }) => {
  await openStorybook(page, '#/catalog');
  await advance(page);
  const query = page.locator('#catalog-search');
  for (const expression of ['c:r', '(c:r or c:u) -mv>1', 't:instant o:"3 damage" s:m11 lang:en']) {
    await query.fill(expression);
    await query.press('Enter');
    await advance(page);
    await expect(page.getByText('Lightning Bolt', { exact: true })).toBeVisible();
    await expect(page.getByText('Counterspell', { exact: true })).toHaveCount(0);
    await advance(page);
  }
  await query.fill('c:g');
  await query.press('Enter');
  await advance(page);
  await expect(page.getByText('No entries', { exact: true })).toBeVisible();
  await query.fill('unsupported:value');
  await query.press('Enter');
  await advance(page);
  await expect(page.getByText('No entries', { exact: true })).toHaveCount(0);
  await expect(page.locator('.mocked-app')).toContainText('unsupported');
});

test('keeps tag intentions out of Collection at every level', async ({ page }) => {
  await openStorybook(page, '#/import');
  await advance(page);
  await advance(page);
  await page.getByLabel('Card lines').fill('1 Counterspell');
  await page.getByRole('button', { name: 'Add source to review' }).click();
  await advance(page);
  await advance(page);
  await advance(page);
  await expect(page.getByText('Counterspell', { exact: true })).toBeVisible();
  await page.locator('#import-destination').selectOption('tag:tag-deck');
  await page.locator('[data-ui-select]').check();
  await page.getByRole('button', { name: 'Confirm selected' }).click();
  await advance(page);
  await expect(page.locator('#import-pending-status')).toContainText('association');
  await page.getByRole('link', { name: 'Tags', exact: true }).click();
  await advance(page);
  await page.getByText('Friday deck', { exact: true }).click();
  await advance(page);
  await expect(page.locator('#stage-status')).toContainText('Loading tag cards');
  await advance(page);
  await expect(page.getByText('Counterspell', { exact: true })).toBeVisible();
  for (const level of ['card', 'printing', 'copy']) {
    await page.evaluate((level) => {
      location.hash = `/collection?level=${level}`;
    }, level);
    await expect(page.locator('#stage-status')).toContainText('Loading collection results');
    await advance(page);
    await expect(page.getByText('Lightning Bolt', { exact: true })).toBeVisible();
    await expect(page.getByText('Counterspell', { exact: true })).toHaveCount(0);
  }
});

test('preserves Back navigation and cancels only disposed views', async ({ page }) => {
  await openStorybook(page, '#/catalog');
  await advance(page);
  await advance(page);
  await page.getByRole('link', { name: 'Tags', exact: true }).click();
  await page.goBack();
  await expect(page.locator('#stage-status')).toContainText('Loading catalog results');
  await advance(page);
  await expect(page.getByText('Lightning Bolt', { exact: true })).toBeVisible();
  await expect(page.locator('.mocked-app')).not.toContainText('The local view closed');
  await advance(page);
  await expect(page.locator('#stage-status')).toHaveText('No stage is waiting.');
});

test('coalesces repeated import refreshes and preserves concurrent camera work', async ({
  page,
}) => {
  await openStorybook(page, '#/import');
  await advance(page);
  await advance(page);
  await page.getByRole('button', { name: 'Refresh imports', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh imports', exact: true }).click();
  await expect(page.locator('#stage-status')).toContainText('Loading tags');
  await advance(page);
  await expect(page.locator('#stage-status')).toContainText('Loading pending imports');
  await advance(page);
  await expect(page.locator('#stage-status')).toHaveText('No stage is waiting.');

  await page.getByRole('button', { name: 'Start camera' }).click();
  await page.getByLabel('Card lines').fill('1 Counterspell');
  await page.getByRole('button', { name: 'Add source to review' }).click();
  await expect(page.locator('#stage-status')).toContainText('Starting local camera');
  await advance(page);
  await expect(page.getByText('Reading Lightning Bolt.')).toBeVisible();
  await expect(page.locator('#stage-status')).toContainText('Importing source cards');
  await advance(page);
  await expect(page.locator('#import-source-status')).toContainText('1');
  await expect(page.locator('#stage-status')).toContainText('Adding captured card to review');
  await advance(page);
  await expect(page.locator('#import-camera-status')).toContainText('Accepted Lightning Bolt');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('#stage-status')).toHaveText('No stage is waiting.');
});

for (const suffix of ['', '/m11-149', '/m11-149/copy-bolt-1']) {
  test(`holds and can fail independent detail loads: ${suffix || 'card'}`, async ({ page }) => {
    await openStorybook(page, `#/cards/lightning-bolt${suffix}`);
    await advance(page);
    await expect(page.locator('#stage-status')).toContainText('Loading card details');
    await expect(page.getByText('Lightning Bolt', { exact: true })).toHaveCount(0);
    await page.locator('#fail-next-stage').check();
    await advance(page);
    await expect(page.locator('#card-details-failure')).toContainText('Local mock failure');
    await page.locator('#card-details-retry').click();
    await expect(page.locator('#stage-status')).toContainText('Loading card details');
    await advance(page);
    await expect(page.locator('#card-details-content')).toContainText('Lightning Bolt');
    if (suffix === '') {
      await expect(page.locator('#stage-status')).toContainText('Loading published printings');
      await expect(page.locator('#card-printings')).toContainText('Loading');
      await advance(page);
      await expect(page.locator('#card-printings')).toContainText('M11');
    }
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.locator('#stage-status')).toHaveText('No stage is waiting.');
  });
}

test('presents capture completion after recovery and stop/start', async ({ page }) => {
  await openStorybook(page, '#/import');
  await advance(page);
  await advance(page);
  await page.getByRole('button', { name: 'Start camera' }).click();
  await advance(page);
  await page.locator('#fail-next-stage').check();
  await advance(page);
  await expect(page.getByRole('button', { name: 'Recover capture' })).toBeVisible();
  await page.getByRole('button', { name: 'Recover capture' }).click();
  await advance(page);
  await advance(page);
  await expect(page.locator('#import-camera-status')).toContainText('Accepted Lightning Bolt');
  await advance(page); // Pending imports now include the accepted capture.
  await advance(page); // Its pending entry becomes visible.
  await expect(page.getByText('Lightning Bolt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await page.getByRole('button', { name: 'Start camera' }).click();
  await advance(page);
  await expect(page.locator('#import-camera-status')).toContainText('Reading Lightning Bolt');
  await advance(page);
  await expect(page.locator('#import-camera-status')).toContainText('Accepted Lightning Bolt');
});

async function stageTwoCards(page: Page): Promise<void> {
  await openStorybook(page, '#/import');
  await advance(page);
  await advance(page);
  await page.getByLabel('Card lines').fill('1 Lightning Bolt\n1 Counterspell');
  await page.getByRole('button', { name: 'Add source to review' }).click();
  await advance(page);
  await expect(page.locator('#import-source-status')).toContainText('2');
  await advance(page);
  await advance(page);
  await expect(page.locator('#import-pending-list [data-ui-select]')).toHaveCount(2);
}

for (const action of ['confirm', 'discard'] as const) {
  test(`removes only the ${action}ed entry from pending review, including after reopening`, async ({
    page,
  }) => {
    await stageTwoCards(page);
    const sessionId = await page.locator('#import-session').inputValue();
    if (action === 'confirm') {
      await page.getByLabel('Select Lightning Bolt (M11 149)').check();
      await page.getByRole('button', { name: 'Confirm selected' }).click();
    } else {
      await page.locator('[id^="import-review-discard-"]').first().click();
      await page.getByRole('dialog').getByRole('button', { name: 'Discard entry' }).click();
    }
    await advance(page);
    await advance(page);
    await expect(page.locator('#import-pending-list')).not.toContainText('Lightning Bolt');
    await expect(page.locator('#import-pending-list')).toContainText('Counterspell');
    await expect(page.locator('#import-pending-list [data-ui-select]')).toHaveCount(1);
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await advance(page);
    await advance(page);
    await expect(page.locator('#import-pending-list')).not.toContainText('Lightning Bolt');
    await expect(page.locator('#import-pending-list')).toContainText('Counterspell');
    await page.locator('[id^="import-review-discard-"]').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard entry' }).click();
    await advance(page);
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await page.getByRole('link', { name: 'Import', exact: true }).click();
    await advance(page);
    await expect(page.locator(`#import-session option[value="${sessionId}"]`)).toHaveCount(0);
    await expect(page.locator('#import-pending-list [data-ui-select]')).toHaveCount(0);
  });
}

test('completes a multi-copy edit with one press and holds the next edit independently', async ({
  page,
}) => {
  await stageTwoCards(page);
  for (const checkbox of await page.locator('#import-pending-list [data-ui-select]').all())
    await checkbox.check();
  await page.getByRole('button', { name: 'Confirm selected' }).click();
  await advance(page);
  await page.evaluate(() => {
    location.hash = '/collection?level=copy';
  });
  await expect(page.locator('#stage-status')).toContainText('Loading collection results');
  await advance(page);
  await expect(page.locator('[data-ui-select]')).toHaveCount(3);
  for (const checkbox of await page.locator('[data-ui-select]').all()) await checkbox.check();
  await advance(page); // The independent selection-tools fragment.
  await page.getByLabel('Condition to apply').selectOption('NM');
  await page.getByRole('button', { name: 'Apply condition' }).click();
  await expect(page.locator('#collection-changes-status')).toHaveText('Applying…');
  await advance(page);
  await expect(page.locator('#collection-changes-status')).toHaveText('Saved 3 copies.');
  await expect(page.locator('#stage-status')).toContainText('Loading collection results');
  await advance(page);
  await expect(page.locator('[data-ui-select]')).toHaveCount(3);
  await expect(page.locator('#stage-status')).toContainText('Loading copy tools');
  await advance(page);
  // Repeating the editor action must create a fresh held completion.
  await page.getByLabel('Condition to apply').selectOption('LP');
  await page.getByRole('button', { name: 'Apply condition' }).click();
  await expect(page.locator('#collection-changes-status')).toHaveText('Applying…');
  await advance(page);
  await expect(page.locator('#collection-changes-status')).toHaveText('Saved 3 copies.');
});

test('moves a copy through its prerequisite read in one visible action', async ({ page }) => {
  await openStorybook(page, '#/tags/tag-binder');
  await advance(page);
  await advance(page);
  await advance(page);
  await page.locator('#tag-add-level').selectOption('copy');
  await page.locator('#tag-add-submit').click();
  await advance(page);
  await advance(page);
  await page.locator('#tag-add-results [data-ui-select]').check();
  await page.getByRole('button', { name: 'Add to this tag', exact: true }).click();
  await expect(page.locator('#tag-add-status')).toHaveText('Adding to the tag…');
  await advance(page);
  await expect(page.locator('#tag-add-status')).not.toHaveText('Adding to the tag…');
  await expect(page.locator('#tag-add-status')).toHaveAttribute(
    'data-ui-outcome-status',
    'committed',
  );
});

test('holds single-copy edits, failure and retry without losing independent editor loads', async ({
  page,
}) => {
  await openStorybook(page, '#/collection?level=copy');
  await advance(page);
  await advance(page);
  await page.locator('[data-ui-select]').check();
  await advance(page);
  await page.getByLabel('Condition to apply').selectOption('NM');
  await page.getByRole('button', { name: 'Apply condition' }).click();
  await expect(page.locator('#collection-changes-status')).toHaveText('Applying…');
  await page.locator('#fail-next-stage').check();
  await advance(page);
  await expect(page.locator('#collection-changes-status')).toContainText('could not be read');
  await page.getByRole('button', { name: 'Apply condition' }).click();
  await expect(page.locator('#collection-changes-status')).toHaveText('Applying…');
  await advance(page);
  await expect(page.locator('#collection-changes-status')).toHaveText('Saved 1 copy.');
  await page.evaluate(() => {
    location.hash = '/cards/lightning-bolt/m11-149/copy-bolt-1';
  });
  await expect(page.locator('#stage-status')).toContainText('Loading card details');
  await advance(page);
  await expect(page.locator('#copy-condition-choice')).toHaveValue('NM');
  await advance(page); // Published printing choices are independently visible.
  await page.getByRole('button', { name: 'Reload copy', exact: true }).click();
  await expect(page.locator('#copy-status')).toHaveText('Reloading…');
  await expect(page.locator('#stage-status')).toContainText('Loading physical copies');
  await advance(page);
  await expect(page.locator('#copy-status')).toHaveText('Reloaded the copy.');
});
