/** CardViews rendering and Pages lifecycle regressions (docs/ui/card-views.md, docs/ui/pages.md). */
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import type { DetailControl, DetailPageControl } from './card-detail.harness.js';
import type { UiCollectionControl } from './collection.harness.js';

declare global {
  var keeperDetail: DetailControl;
  var keeperDetailRefresh: DetailPageControl;
  var keeperDetailPage: UiCollectionControl;
  var keeperDetailLifetimes: {
    disposed: number;
    aborted: number;
    fail(): void;
    recompose(): void;
  }[];
  var keeperDetailChildren: { disposed: number; restoredCurrent: boolean }[];
}

async function bundle(contents: string): Promise<string> {
  const result = await build({
    stdin: { contents, resolveDir: fileURLToPath(new URL('../..', import.meta.url)), loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  return result.outputFiles[0]!.text;
}

for (const recoverFailure of [false, true]) {
  test(`printing image reconciles delayed ${recoverFailure ? 'failure and recovery' : 'success'} with bounded demand`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({
      type: 'module',
      content: await bundle(`
      import { installDetailHarness } from './tests/browser/card-detail.harness.ts';
      globalThis.keeperDetail = installDetailHarness();
    `),
    });
    await expect(page.getByRole('heading', { name: 'Lightning Bolt' })).toBeVisible();
    if (recoverFailure) {
      await expect.poll(() => page.evaluate(() => keeperDetail.state().reads)).toBe(1);
    } else {
      await expect
        .poll(() => page.evaluate(() => keeperDetail.state()))
        .toEqual({ demands: 1, compositions: 1, reads: 1 });
    }
    const draft = page.getByRole('textbox', { name: 'Composed draft' });
    await draft.fill('Keep my draft');
    await page.evaluate(() => {
      keeperDetail.publish();
      keeperDetail.finish(false);
    });
    await expect(page.locator('#printing-image')).toHaveAttribute('alt', 'Lightning Bolt image');
    if (recoverFailure) {
      await page.evaluate(() => keeperDetail.reload());
      await expect.poll(() => page.evaluate(() => keeperDetail.state().reads)).toBe(2);
      await page.evaluate(() => keeperDetail.finish(true));
      await expect(page.getByText('Image unavailable', { exact: true })).toBeVisible();
      await expect(page.locator('#printing-image')).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry printing image' }).click();
      await expect.poll(() => page.evaluate(() => keeperDetail.state().reads)).toBe(3);
      await expect(page.getByText('Loading printing image…')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Lightning Bolt' })).toBeVisible();
      await draft.focus();
      await page.evaluate(() => keeperDetail.finish(false));
      await expect(page.locator('#printing-image')).toBeAttached();
      await expect(page.getByText('Image unavailable', { exact: true })).toHaveCount(0);
    }
    await expect(draft).toHaveValue('Keep my draft');
    await expect(draft).toBeFocused();
    expect(await page.evaluate(() => keeperDetail.state())).toEqual({
      demands: 1,
      compositions: 1,
      reads: recoverFailure ? 3 : 1,
    });
    await page.evaluate(() => keeperDetail.dispose());
    expect(errors).toEqual([]);
  });
}

for (const level of ['card', 'copy'] as const) {
  test(`${level} detail refresh preserves current child state across repeated recomposition`, async ({
    page,
  }) => {
    await page.route('http://keeper-detail.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="root"></div></body></html>',
      }),
    );
    await page.goto('http://keeper-detail.test/');
    await page.addScriptTag({
      type: 'module',
      content: await bundle(`
        import { installDetailPageHarness } from './tests/browser/card-detail.harness.ts';
        globalThis.keeperDetailRefresh = installDetailPageHarness(${JSON.stringify(level)});
      `),
    });
    if (level === 'copy') {
      await expect(page.getByRole('combobox', { name: 'Condition', exact: true })).toHaveValue(
        'NM',
      );
      await page.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('DMG');
      await page.getByRole('combobox', { name: 'Finish', exact: true }).selectOption('foil');
    } else {
      await page.getByRole('checkbox').check();
    }
    for (let refresh = 1; refresh <= 2; refresh++) {
      await page.evaluate(() => keeperDetailRefresh.refresh());
      await expect.poll(() => page.evaluate(() => keeperDetailRefresh.loads())).toBe(refresh + 1);
      if (level === 'copy') {
        await expect(page.getByRole('combobox', { name: 'Condition', exact: true })).toHaveValue(
          refresh === 1 ? 'DMG' : 'LP',
        );
        await expect(page.getByRole('combobox', { name: 'Finish', exact: true })).toHaveValue(
          'foil',
        );
        await page.getByRole('combobox', { name: 'Condition', exact: true }).selectOption('LP');
      } else {
        if (refresh === 1) {
          await expect(page.getByRole('checkbox')).toBeChecked();
          await page.getByRole('checkbox').uncheck();
        } else {
          await expect(page.getByRole('checkbox')).not.toBeChecked();
        }
      }
    }
    if (level === 'copy') {
      await page.getByRole('button', { name: 'Save changes' }).click();
      await expect
        .poll(() => page.evaluate(() => keeperDetailRefresh.corrections()))
        .toEqual([
          expect.objectContaining({
            input: {
              copyId: 'copy',
              expectedRevision: 3,
              printingId: 'bolt',
              finish: 'foil',
              condition: 'LP',
            },
          }),
        ]);
    }
    await page.evaluate(() => keeperDetailRefresh.dispose());
  });
}

for (const [level, departure] of [
  ['printing', 'navigation'],
  ['printing', 'account'],
  ['printing', 'shell'],
  ['card', 'navigation'],
  ['copy', 'shell'],
] as const) {
  test(`${level} detail children are disposed once on retry and ${departure} departure`, async ({
    page,
  }) => {
    await page.route('http://keeper-detail.test/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><div id="root"></div></body></html>',
      }),
    );
    await page.goto('http://keeper-detail.test/');
    await page.addScriptTag({
      type: 'module',
      content: await bundle(`
      import { installCollectionHarness } from './tests/browser/collection.harness.ts';
      import { createCardViews, createEditors, createCaptureControls } from './src/ui/index.ts';
      globalThis.keeperDetailLifetimes = [];
      globalThis.keeperDetailChildren = [];
      const level = ${JSON.stringify(level)};
      const base = createCardViews();
      let lastCaptured;
      function child(restored) {
        const record = { disposed: 0, restoredCurrent: lastCaptured === undefined || restored === lastCaptured };
        const retained = { printingId: 'bolt', finish: 'foil', condition: 'DMG' };
        keeperDetailChildren.push(record);
        return { dispose() { record.disposed++; }, capture() { lastCaptured = retained; return retained; } };
      }
      const cardViews = { ...base,
        list(options) {
          if (options.container.id !== 'card-printings') return base.list(options);
          return { ...child(options.restored), restoration: null };
        },
        detail(options) {
        const presented = Promise.withResolvers();
        const record = { disposed: 0, aborted: 0, fail: () => presented.reject(new Error('Supplied detail failed')), recompose: () => compose() };
        keeperDetailLifetimes.push(record);
        options.signal.addEventListener('abort', () => record.aborted++, { once: true });
        const element = document.createElement('p');
        element.textContent = 'Independent detail';
        function compose() {
          const entry = {
            key: level + ':bolt', target: { kind: level, cardId: 'bolt', printingId: 'bolt', copyId: 'copy' },
            basic: { card: { cardId: 'bolt', name: 'Lightning Bolt', matchedName: null }, printing: null },
            detail: level === 'copy' ? { copy: { copyId: 'copy', printingId: 'bolt' } } : undefined,
          };
          element.replaceChildren('Independent detail', ...(options.content?.(entry) ?? []));
        }
        compose();
        return { nodes: [element], presented: presented.promise, dispose() { record.disposed++; } };
      } };
      globalThis.keeperDetailPage = installCollectionHarness(document.getElementById('root'), {
        cardViews, editors: { ...createEditors({ cardViews }), copy(options) {
          return { ...child(options.restored), element: document.createElement('input'), printingLink: document.createElement('a') };
        } }, captureControls: createCaptureControls,
      });
      keeperDetailPage.navigate({ page: 'card', cardId: 'bolt', printingId: level === 'card' ? null : 'bolt', copyId: level === 'copy' ? 'copy' : null });
    `),
    });
    await expect(page.getByText('Independent detail', { exact: false })).toBeVisible();
    if (level !== 'printing') {
      await page.evaluate(() => keeperDetailLifetimes.at(-1)!.recompose());
      expect(
        await page.evaluate(() => keeperDetailChildren.map(({ disposed }) => disposed)),
      ).toEqual([1, 0]);
    }
    await page.evaluate(() => keeperDetailLifetimes.at(-1)!.fail());
    await page
      .getByRole('button', {
        name: level === 'copy' ? 'Load the copy again' : 'Load the details again',
      })
      .first()
      .click();
    await expect(page.getByText('Independent detail', { exact: false })).toBeVisible();
    expect(
      await page.evaluate(() => keeperDetailChildren.every((child) => child.restoredCurrent)),
    ).toBe(true);
    expect(
      await page.evaluate(() => keeperDetailLifetimes.map((record) => record.disposed)),
    ).toEqual([1, 0]);
    await page.evaluate((departure) => {
      if (departure === 'navigation')
        keeperDetailPage.navigate({ page: 'collection', level: 'card', query: '' });
      if (departure === 'account') keeperDetailPage.signInAs('bob');
      if (departure === 'shell') keeperDetailPage.dispose();
    }, departure);
    await expect
      .poll(() =>
        page.evaluate(() =>
          keeperDetailLifetimes.slice(0, 2).map(({ disposed, aborted }) => ({ disposed, aborted })),
        ),
      )
      .toEqual([
        { disposed: 1, aborted: 1 },
        { disposed: 1, aborted: 1 },
      ]);
    await page.evaluate(() => {
      keeperDetailPage.dispose();
      keeperDetailPage.dispose();
    });
    expect(
      await page.evaluate(() => keeperDetailLifetimes.every((record) => record.disposed === 1)),
    ).toBe(true);
    expect(
      await page.evaluate(() => keeperDetailChildren.every(({ disposed }) => disposed === 1)),
    ).toBe(true);
  });
}
