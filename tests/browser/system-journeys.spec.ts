/**
 * System journeys of the integrated acceptance scenarios (docs/testing.md#integrated-acceptance).
 *
 * Each case connects the implemented workflows of the browser deployment with the assembled
 * Application over real storage: the page runs the real pages, transports, Catalog, UserCards and
 * Search, and the journeys follow what a visitor could do — find a card and put it on a wishlist,
 * review an import and keep the copies its confirmation created, move a copy into a location and
 * read the resulting count, sign out and sign in as another account, and recover a confirmation
 * whose response was lost. Setup that is not the subject of a journey is written directly through
 * the interactive boundary of the same assembled application.
 */

import { expect, test, type Page } from '@playwright/test';

import { startSystemJourney, type SystemJourney } from './system.harness.js';

const alice = 'cognito-alice';

/** Opens the deployed page with one stored session, as the environment's sign-in left it. */
async function openJourney(page: Page, journey: SystemJourney, accountId = alice): Promise<void> {
  await page.addInitScript((session) => {
    window.sessionStorage.setItem('keeper-session', session);
  }, journey.sessionFor(accountId));
  await page.goto(`${journey.origin}/`);
  await expect(page.getByRole('heading', { name: 'Recent cards' })).toBeVisible();
}

/** Stages one manual line of the fixture printing through the Import page. */
async function stageManualLine(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await expect(page.locator('#import-manual-heading')).toBeVisible();
  await page.fill('#import-manual-query', 'Lightning Bolt');
  await page.fill('#import-manual-quantity', '2');
  await page.selectOption('#import-manual-finish', 'foil');
  await page.selectOption('#import-manual-condition', 'NM');
  await page.click('#import-manual-submit');
  const printing = page.locator('#import-results [data-ui-entry="printing:printing-m11-149-en"]');
  await expect(printing).toContainText('Lightning Bolt');
  await printing.locator('[data-ui-select]').check();
  await page.click('#import-results [data-ui-tool="add-to-review"]');
  await expect(page.locator('#import-results [data-ui-outcome]')).toHaveText(
    '1 line is in review. Confirmation creates the physical copies.',
  );
}

test('a search finds a card and the account’s wishlist keeps it', async ({ page }) => {
  const journey = await startSystemJourney();
  try {
    await openJourney(page, journey);

    // Home searches the published catalog through the interactive boundary; Enter submits the
    // form the way a keyboard user does.
    await page.getByLabel('Search cards').fill('Lightning Bolt');
    await page.getByLabel('Search cards').press('Enter');
    await expect(page.getByRole('heading', { name: 'Catalog and search' })).toBeVisible();
    const found = page.locator('[data-ui-entry="card:oracle-lightning-bolt"]');
    await expect(found).toContainText('Lightning Bolt');
    await expect(found.locator('[data-ui-matched-name]')).toHaveCount(0);

    // The wishlist is created on the tags page and opened as its own view.
    await page.getByRole('link', { name: 'Tags', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your tags' })).toBeVisible();
    await page.selectOption('#tag-create-kind', 'wishlist');
    await page.fill('#tag-create-label', 'Wanted');
    await page.click('#tag-create-submit');
    await expect(page.locator('#tag-create-status')).toHaveText('Created “Wanted”.');
    await page.locator('#tags-list [data-ui-tag] a', { hasText: 'Wanted' }).click();
    await expect(page.locator('#tag-heading')).toHaveText('Wanted');

    // Searching the tag's own view adds the found card with the intended quantity.
    await page.fill('#tag-add-query', 'Lightning Bolt');
    await page.selectOption('#tag-add-level', 'card');
    await page.fill('#tag-add-quantity', '2');
    await page.click('#tag-add-submit');
    const candidate = page.locator('#tag-add-results [data-ui-entry="card:oracle-lightning-bolt"]');
    await expect(candidate).toContainText('Lightning Bolt');
    await candidate.locator('[data-ui-select]').check();
    await page.click('#tag-add-results [data-ui-tool="add-to-tag"]');
    await expect(page.locator('#tag-add-results [data-ui-outcome]')).toHaveText(
      'Added 1 entry to the tag.',
    );

    // The association the backend stored is what the view presents after a reload.
    await page.reload();
    await expect(page.locator('#tag-heading')).toHaveText('Wanted');
    const association = page.locator('#tag-associations [data-ui-entry^="association:"]');
    await expect(association).toContainText('Lightning Bolt');
    await expect(association.locator('[data-ui-intended]')).toHaveText(' Intended: 2');
    await expect(association.locator('[data-ui-copies]')).toHaveText(' Copies: 0');
  } finally {
    await journey.close();
  }
});

test('a reviewed import creates the physical copies the collection keeps', async ({ page }) => {
  const journey = await startSystemJourney();
  try {
    await openJourney(page, journey);

    // Manual entry searches printings of the published catalog and stages one line.
    await stageManualLine(page);

    // Review presents the stored line; only its confirmation creates copies.
    const pending = page.locator('#import-pending [data-ui-entry^="pending:"]');
    await expect(pending).toContainText('Finish: foil');
    await expect(pending).toContainText('Condition: NM');
    await expect(pending).toContainText('Quantity: 2');
    await pending.locator('[data-ui-select]').check();
    await page.click('#import-pending [data-ui-tool="confirm-import"]');
    await expect(page.locator('#import-review-status')).toHaveText(
      'Confirmed: 2 physical copies created.',
    );

    // The collection reads the copies the confirmation stored, also after a reload.
    await page.getByRole('link', { name: 'Collection', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your collection' })).toBeVisible();
    const owned = page.locator('[data-ui-entry="card:oracle-lightning-bolt"]');
    await expect(owned.locator('[data-ui-copies]')).toHaveText(' Copies: 2');
    await page.reload();
    await expect(
      page.locator('[data-ui-entry="card:oracle-lightning-bolt"] [data-ui-copies]'),
    ).toHaveText(' Copies: 2');
  } finally {
    await journey.close();
  }
});

test('a confirmation whose response is lost recovers its recorded copies', async ({ page }) => {
  const journey = await startSystemJourney();
  try {
    await openJourney(page, journey);
    await stageManualLine(page);

    // The confirmation commits, but its response never reaches the page.
    journey.loseNextResponse('/api/collection/imports/manual/confirmation');
    const pending = page.locator('#import-pending [data-ui-entry^="pending:"]');
    await pending.locator('[data-ui-select]').check();
    await page.click('#import-pending [data-ui-tool="confirm-import"]');

    // The page recovers the operation's recorded outcome instead of guessing it, and the
    // collection holds exactly the copies that outcome names.
    await expect(page.locator('#import-review-status')).toHaveText(
      'Confirmed: 2 physical copies created. This confirmation had already been recorded; the ' +
        'records it reported are listed.',
    );
    expect(
      journey.calls.filter((call) => call.path.startsWith('/api/collection/imports/operations/')),
    ).toHaveLength(1);
    await page.getByRole('link', { name: 'Collection', exact: true }).click();
    await expect(
      page.locator('[data-ui-entry="card:oracle-lightning-bolt"] [data-ui-copies]'),
    ).toHaveText(' Copies: 2');
    expect(
      journey.calls.filter((call) => call.path === '/api/collection/imports/manual/confirmation'),
    ).toHaveLength(1);
  } finally {
    await journey.close();
  }
});

test('moving a copy into a location changes the collection’s location count', async ({ page }) => {
  const journey = await startSystemJourney();
  try {
    // A copy of the published printing exists before the journey starts.
    const created = await journey.call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: alice,
      body: {
        printingId: 'printing-m11-149-en',
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 1,
      },
    });
    expect(created.status).toBe(200);
    const copyId = (created.payload as { readonly copies: readonly { copyId: string }[] }).copies[0]
      ?.copyId;
    if (copyId === undefined) {
      throw new Error('The journey could not create its copy.');
    }

    await openJourney(page, journey);

    // The location tag is created and opened, then fed the account's own copy.
    await page.getByRole('link', { name: 'Tags', exact: true }).click();
    await page.selectOption('#tag-create-kind', 'location');
    await page.fill('#tag-create-label', 'Binder');
    await page.click('#tag-create-submit');
    await expect(page.locator('#tag-create-status')).toHaveText('Created “Binder”.');
    await page.locator('#tags-list [data-ui-tag] a', { hasText: 'Binder' }).click();
    await expect(page.locator('#tag-add-heading')).toHaveText('Move copies into this location');
    await page.fill('#tag-add-query', 'Lightning Bolt');
    await page.click('#tag-add-submit');
    const copy = page.locator(`#tag-add-results [data-ui-entry="copy:${copyId}"]`);
    await expect(copy).toContainText('Lightning Bolt');
    await copy.locator('[data-ui-select]').check();
    await page.click('#tag-add-results [data-ui-tool="add-to-tag"]');
    await expect(page.locator('#tag-add-results [data-ui-outcome]')).toHaveText(
      'Added 1 entry to the tag.',
    );
    await expect(
      page.locator('#tag-associations [data-ui-entry^="association:"] [data-ui-association-level]'),
    ).toHaveText('Physical copy');

    // The stored move shows up in the counts the account reads: the association lists the location
    // holding its copy, and the collection presents the card's copies.
    const association = page.locator('#tag-associations [data-ui-entry^="association:"]');
    await expect(association.locator('[data-ui-copies]')).toHaveText(' Copies: 1');
    await expect(association.locator('[data-ui-locations]')).toHaveText(' Locations: 1');
    await page.getByRole('link', { name: 'Collection', exact: true }).click();
    const owned = page.locator('[data-ui-entry="card:oracle-lightning-bolt"]');
    await expect(owned.locator('[data-ui-copies]')).toHaveText(' Copies: 1');
  } finally {
    await journey.close();
  }
});

test('a sign-out and sign-in ends the private work of the account it leaves', async ({ page }) => {
  const journey = await startSystemJourney();
  try {
    const created = await journey.call({
      method: 'POST',
      path: '/api/collection/copies',
      accountId: alice,
      body: {
        printingId: 'printing-m11-149-en',
        finish: 'nonfoil',
        condition: 'NM',
        quantity: 1,
      },
    });
    expect(created.status).toBe(200);
    await openJourney(page, journey);
    await page.getByRole('link', { name: 'Collection', exact: true }).click();
    await expect(
      page.locator('[data-ui-entry="card:oracle-lightning-bolt"] [data-ui-copies]'),
    ).toHaveText(' Copies: 1');

    // A label the account typed is presented as text, whatever it contains.
    const markup = '<img src=x onerror="window.keeperMarkup=1">';
    await page.getByRole('link', { name: 'Tags', exact: true }).click();
    await page.selectOption('#tag-create-kind', 'other');
    await page.fill('#tag-create-label', markup);
    await page.click('#tag-create-submit');
    await expect(page.locator('#tags-list [data-ui-tag] a')).toHaveText(markup);
    await expect(page.locator('#tags-list img')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'keeperMarkup'))).toBeUndefined();

    // Signing out leaves the account's work behind and offers this environment's sign-in.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // The user pool is the substituted boundary: the page signs in against the real prompt and
    // transport, while the identity provider answers with this environment's token.
    await page.route('https://cognito-idp.us-east-1.amazonaws.com/**', (route) =>
      route.fulfill({
        contentType: 'application/x-amz-json-1.1',
        body: JSON.stringify({
          AuthenticationResult: {
            IdToken: journey.tokenFor('cognito-bob', 'Bob'),
            AccessToken: 'bob-access',
            RefreshToken: 'bob-refresh',
            ExpiresIn: 3600,
          },
        }),
      }),
    );
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByLabel('Username').fill('bob@example.test');
    await page.getByLabel('Password').fill('correct horse battery staple');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Your tags' })).toBeVisible();

    // Bob sees his own empty views, never the collection or the tag Alice left behind.
    await expect(page.locator('#tags-status')).toHaveText('No tags yet. Create one above.');
    await expect(page.locator('#tags-list [data-ui-tag]')).toHaveCount(0);
    await page.getByRole('link', { name: 'Collection', exact: true }).click();
    await expect(page.locator('#collection-results [data-ui-status]')).toHaveText('No entries');
  } finally {
    await journey.close();
  }
});
