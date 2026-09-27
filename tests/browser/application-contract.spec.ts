/**
 * Browser journey: the public Application browser contract (docs/application.md#interface). The
 * case builds the artifact a deployment builds — esbuild bundles the browser entry point
 * (docs/tech-stack.md) — loads it in Chromium and checks the capabilities UserInterface receives.
 * A Node builtin, the backend composition or a provider failure-translation dependency that
 * reaches the browser bundle fails the build or the page instead of a deployed browser.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The public settings a test deployment publishes; no private setting crosses into the browser. */
const publicSettings = {
  environment: 'test',
  apiBaseUrl: 'https://api.test.keeper.example',
  authentication: { region: 'us-east-1', appClientId: 'keeper-test-client' },
  recognition: { cloudEnabled: false, computeBaseUrl: null },
  capabilities: { sourceImports: false },
} as const;

/** Bundles one consumer of the public browser contract for the browser platform. */
async function bundleBrowserConsumer(): Promise<string> {
  const result = await build({
    stdin: {
      contents: [
        `import { createBrowserApplication } from ${JSON.stringify(
          path.join(repoRoot, 'src', 'application', 'index.ts'),
        )};`,
        'const application = createBrowserApplication({',
        `  settings: ${JSON.stringify(publicSettings)},`,
        "  token: () => 'id-token-value',",
        '});',
        'globalThis.keeperBrowserContract = {',
        '  environment: application.settings.environment,',
        '  request: typeof application.request,',
        '  recognition: Object.keys(application.createRecognition()).sort(),',
        '  userInterface: application.userInterface ?? null,',
        '};',
      ].join('\n'),
      resolveDir: repoRoot,
      sourcefile: 'browser-consumer.ts',
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
}

test('a consumer of the public browser contract loads in Chromium', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  const bundle = await bundleBrowserConsumer();
  await page.setContent('<!doctype html><html><body><main id="keeper"></main></body></html>');
  await page.addScriptTag({ content: bundle, type: 'module' });

  await expect
    .poll(() => page.evaluate(() => Reflect.get(globalThis, 'keeperBrowserContract') ?? null))
    .toEqual({
      environment: 'test',
      request: 'function',
      recognition: ['dispose', 'prepare', 'recognize'],
      userInterface: null,
    });
  expect(pageErrors).toEqual([]);
});
