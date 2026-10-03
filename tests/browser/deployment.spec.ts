/**
 * Browser journey: the packaged browser artifact (docs/operations.md#packaging-and-deployment,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The case packages the browser artifact with one environment's public settings, serves it the way
 * CloudFront serves it and loads it in Chromium: the page reads `config.json`, signs in against the
 * environment's app client through the sign-in page of this build, presents the verified account,
 * reaches the API with the session token, recovers from a refused sign-in and returns to the
 * signed-out page after signing out. The artifact's own boot code runs, so a page that names a
 * private setting, a missing file or a broken bundle fails here.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

import { build } from 'esbuild';
import type { createBrowserDeployment } from '../../src/ui/deployment.js';

import { packageArtifacts } from '../../scripts/package-artifacts.js';

const artifactOrigin = 'https://keeper.test';
const apiOrigin = 'https://api.test.keeper.example';
const cognitoOrigin = 'https://cognito-idp.us-east-1.amazonaws.com';
const appClientId = 'keeper-test-client';

/** The public settings the test environment publishes; no private setting belongs beside them. */
const publicSettings = {
  environment: 'test',
  apiBaseUrl: apiOrigin,
  authentication: { region: 'us-east-1', appClientId },
  recognition: { cloudEnabled: false, computeBaseUrl: null },
  capabilities: { sourceImports: true },
} as const;

function idToken(claims: Readonly<Record<string, unknown>>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

const sessionToken = idToken({ sub: 'cognito-alice', name: 'Alice' });

/** One empty catalog page as the interactive entry point reports it. */
const searchPage = {
  entries: [],
  totalCount: 0,
  continuation: null,
};

let artifactDirectory: string;
let workspace: string;

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'keeper-browser-artifact-'));
  await packageArtifacts({ outDir: path.join(workspace, 'artifacts'), publicSettings });
  artifactDirectory = path.join(workspace, 'artifacts', 'browser');
});

test.afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Answers one cross-origin preflight the browser sends before a non-simple request. */
async function allowCrossOrigin(route: Route, origin: string): Promise<boolean> {
  const request = route.request();
  if (request.method() !== 'OPTIONS') {
    return false;
  }
  await route.fulfill({
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization,content-type,x-amz-target',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-max-age': '600',
    },
  });
  return true;
}

/** Serves the packaged artifact the way CloudFront serves the private bucket. */
async function serveArtifact(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const target = path.resolve(artifactDirectory, requested);
  if (!target.startsWith(artifactDirectory)) {
    await route.fulfill({ status: 400, body: 'invalid path' });
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(target);
  } catch {
    // The distribution answers an unknown path with the application page.
    body = await readFile(path.join(artifactDirectory, 'index.html'));
  }
  const extension = path.extname(target);
  await route.fulfill({
    status: 200,
    contentType:
      extension === '.html'
        ? 'text/html; charset=utf-8'
        : extension === '.js'
          ? 'text/javascript; charset=utf-8'
          : extension === '.css'
            ? 'text/css; charset=utf-8'
            : extension === '.json'
              ? 'application/json'
              : 'application/octet-stream',
    body,
  });
}

test('the packaged browser artifact signs in on its page and reaches the API with its session', async ({
  page,
}) => {
  const requests: {
    readonly url: string;
    readonly method: string;
    readonly authorization: string | null;
  }[] = [];
  const signIn: Record<string, unknown>[] = [];
  await installArtifactRoutes(page, requests, signIn);

  // The visitor opens the view they want; the session starts over that destination.
  await page.goto(`${artifactOrigin}/#/catalog`);

  // The published page boots from the artifact's own config.json and offers the sign-in page.
  const signedOut = page.getByRole('main');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(7, 19, 31)');
  await expect(signedOut.getByRole('heading', { name: 'Sign in' })).toHaveCSS(
    'font-family',
    /Georgia/,
  );
  const signInButton = signedOut.getByRole('button', { name: 'Sign in' });
  await signInButton.hover();
  await expect(signInButton).toHaveCSS('border-color', 'rgb(119, 222, 237)');
  await page.keyboard.press('Tab');
  await expect(signInButton).toBeFocused();
  await expect(signInButton).toHaveCSS('outline-color', 'rgb(119, 222, 237)');
  await signInButton.click();
  await fillCredentials(page, 'correct horse battery staple');

  await expect(page.locator('header')).toContainText('Alice');
  await expect(page.locator('header')).toHaveCSS('background-color', 'rgb(16, 35, 50)');
  // The signed-in page is the destination the visitor opened.
  await expect(page.getByRole('main').getByRole('heading', { name: 'Catalog' })).toBeVisible();
  expect(signIn).toEqual([
    {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: appClientId,
      AuthParameters: {
        USERNAME: 'alice@example.test',
        PASSWORD: 'correct horse battery staple',
      },
    },
  ]);

  // A page read reaches the API with the session token the sign-in established.
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests[0]?.url).toBe(`${apiOrigin}/api/catalog/query`);
  expect(requests[0]?.authorization).toBe(`Bearer ${sessionToken}`);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('main').getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('header')).not.toContainText('Alice');
});

test('the packaged sign-in and application presentation reflow with reduced motion', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installArtifactRoutes(page, [], []);
  await page.goto(`${artifactOrigin}/#/catalog`);

  const signIn = page.getByRole('main').getByRole('button', { name: 'Sign in' });
  await expect(signIn).toHaveCSS('min-height', '44px');
  expect(
    await signIn.evaluate(
      (element) => Number.parseFloat(getComputedStyle(element).transitionDuration) * 1_000,
    ),
  ).toBe(0.01);
  expect(
    await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    })),
  ).toEqual({ documentWidth: 360, viewportWidth: 360 });

  await signIn.click();
  const region = page.getByRole('main');
  await expect(region.getByLabel('Username')).toHaveCSS('width', '328px');
  await fillCredentials(page, 'correct horse battery staple');
  await expect(page.locator('header')).toContainText('Alice');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(
    await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    })),
  ).toEqual({ documentWidth: 360, viewportWidth: 360 });
});

test('the sign-in page reports a refusal and offers the journey again', async ({ page }) => {
  await installArtifactRoutes(page, [], [], { refuseFirst: true });
  await page.goto(`${artifactOrigin}/`);

  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await fillCredentials(page, 'wrong horse battery staple');

  // The refusal leaves the visitor on the page they came from, with the reason reported.
  await expect(page.getByRole('status')).toContainText('Incorrect username or password.');
  await expect(page.getByRole('main').getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await fillCredentials(page, 'correct horse battery staple');

  await expect(page.locator('header')).toContainText('Alice');
});

test('the packaged browser artifact sets an invited password on its page', async ({ page }) => {
  await installArtifactRoutes(page, [], [], { invitation: true });
  await page.goto(`${artifactOrigin}/`);

  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  await fillCredentials(page, 'temporary-password');

  // The first sign-in chooses its password on a page of its own, never in a modal window.
  await expect(page.locator('dialog')).toHaveCount(0);
  const region = page.getByRole('main');
  await expect(region.getByRole('heading', { name: 'Choose a password' })).toBeVisible();
  await expect(region.getByLabel('Username')).toHaveValue('alice@example.test');
  await expect(region.getByLabel('Username')).not.toBeEditable();
  await region.getByLabel('New password').fill('chosen-password-1');
  await region.getByRole('button', { name: 'Set password and continue' }).click();

  await expect(page.locator('header')).toContainText('Alice');
});

/** Fills the credential page; the credentials are a page of the artifact, never a dialog. */
async function fillCredentials(page: Page, password: string): Promise<void> {
  await expect(page.locator('dialog')).toHaveCount(0);
  const region = page.getByRole('main');
  await expect(region.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await region.getByLabel('Username').fill('alice@example.test');
  await region.getByLabel('Password').fill(password);
  await region.getByRole('button', { name: 'Sign in' }).click();
}

/** The environment boundary of the deployed page: sign-in, the API and the classified page. */
async function installArtifactRoutes(
  page: Page,
  requests: {
    readonly url: string;
    readonly method: string;
    readonly authorization: string | null;
  }[],
  signIn: Record<string, unknown>[],
  options: { readonly refuseFirst?: boolean; readonly invitation?: boolean } = {},
): Promise<void> {
  await page.route(`${artifactOrigin}/**`, serveArtifact);
  let attempts = 0;
  await page.route(`${cognitoOrigin}/**`, async (route) => {
    if (await allowCrossOrigin(route, artifactOrigin)) {
      return;
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    signIn.push(body);
    attempts += 1;
    if (options.refuseFirst === true && attempts === 1) {
      await route.fulfill({
        status: 400,
        contentType: 'application/x-amz-json-1.1',
        headers: { 'access-control-allow-origin': artifactOrigin },
        body: JSON.stringify({
          __type: 'NotAuthorizedException',
          message: 'Incorrect username or password.',
        }),
      });
      return;
    }
    if (options.invitation === true && body['AuthFlow'] === 'USER_PASSWORD_AUTH') {
      await route.fulfill({
        status: 200,
        contentType: 'application/x-amz-json-1.1',
        headers: { 'access-control-allow-origin': artifactOrigin },
        body: JSON.stringify({
          ChallengeName: 'NEW_PASSWORD_REQUIRED',
          Session: 'challenge-session',
          ChallengeParameters: { USER_ID_FOR_SRP: 'cognito-alice' },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/x-amz-json-1.1',
      headers: { 'access-control-allow-origin': artifactOrigin },
      body: JSON.stringify({
        AuthenticationResult: {
          IdToken: sessionToken,
          AccessToken: idToken({ sub: 'cognito-alice' }),
          RefreshToken: 'refresh-token',
          ExpiresIn: 3600,
        },
      }),
    });
  });
  await page.route(`${apiOrigin}/**`, async (route) => {
    if (await allowCrossOrigin(route, artifactOrigin)) {
      return;
    }
    requests.push({
      url: route.request().url(),
      method: route.request().method(),
      authorization: route.request().headers()['authorization'] ?? null,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': artifactOrigin },
      body: JSON.stringify(searchPage),
    });
  });
}

test('disposing a browser deployment prevents pending sign-in from restoring credentials', async ({
  page,
}) => {
  const bundle = await build({
    stdin: {
      contents: `import { createBrowserDeployment } from './src/ui/deployment.ts';
        globalThis.createTestDeployment = createBrowserDeployment;`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outdir: path.join(workspace, 'pending-sign-in-bundle'),
    write: false,
  });
  const script = bundle.outputFiles?.find((output) => output.path.endsWith('.js'));
  if (script === undefined) throw new Error('esbuild produced no browser deployment script.');
  await page.route(`${artifactOrigin}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="keeper-root"></div>',
    }),
  );
  await page.goto(artifactOrigin);
  await page.addScriptTag({ content: script.text, type: 'module' });
  await page.waitForFunction(
    () => typeof Reflect.get(globalThis, 'createTestDeployment') === 'function',
  );
  const result = await page.evaluate(
    async ({ settings, token }) => {
      const create = Reflect.get(
        globalThis,
        'createTestDeployment',
      ) as typeof createBrowserDeployment;
      let answer: (response: Response) => void = () => undefined;
      let started: () => void = () => undefined;
      const response = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      let calls = 0;
      const deployment = create({
        root: document.getElementById('keeper-root'),
        settings,
        prompt: { request: async () => ({ username: 'alice', password: 'password' }) },
        fetch: async () => {
          calls += 1;
          started();
          return response;
        },
      });
      const signingIn = deployment.identity.signIn();
      await requested;
      deployment.dispose();
      answer(
        new Response(
          JSON.stringify({
            AuthenticationResult: {
              IdToken: token,
              AccessToken: 'access',
              RefreshToken: 'refresh',
              ExpiresIn: 3600,
            },
          }),
        ),
      );
      await signingIn;
      const failure = await deployment.application
        .request('/api/catalog/query')
        .catch((cause: unknown) => (cause as { code: string }).code);
      return {
        account: deployment.identity.current(),
        stored: sessionStorage.getItem('keeper-session'),
        root: document.getElementById('keeper-root')?.innerHTML,
        failure,
        calls,
      };
    },
    { settings: publicSettings, token: sessionToken },
  );
  expect(result).toEqual({
    account: null,
    stored: null,
    root: '',
    failure: 'unauthorized',
    calls: 1,
  });
});
