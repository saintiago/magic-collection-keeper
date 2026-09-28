/**
 * Browser journey: the packaged browser artifact (docs/operations.md#packaging-and-deployment,
 * docs/application.md#configuration-and-lifecycle).
 *
 * The case packages the browser artifact with one environment's public settings, serves it the way
 * CloudFront serves it and loads it in Chromium: the page reads `config.json`, signs in against the
 * environment's app client, presents the verified account, reaches the API with the session token
 * and returns to the sign-in prompt after signing out. The artifact's own boot code runs, so a page
 * that names a private setting, a missing file or a broken bundle fails here.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

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
  revisions: { catalogRevision: 'browse-revision', privateRevision: null },
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
          : extension === '.json'
            ? 'application/json'
            : 'application/octet-stream',
    body,
  });
}

test('the packaged browser artifact signs in and reaches the API with its session', async ({
  page,
}) => {
  const requests: {
    readonly url: string;
    readonly method: string;
    readonly authorization: string | null;
  }[] = [];
  const signIn: Record<string, unknown>[] = [];
  await installArtifactRoutes(page, requests, signIn);

  await page.goto(`${artifactOrigin}/`);

  // The published page boots from the artifact's own config.json and presents the sign-in prompt.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.locator('dialog');
  await dialog.getByLabel('Username').fill('alice@example.test');
  await dialog.getByLabel('Password').fill('correct horse battery staple');
  await dialog.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.locator('header')).toContainText('Alice');
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
  await page.getByRole('link', { name: 'Catalog' }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  expect(requests[0]?.url).toBe(`${apiOrigin}/api/search`);
  expect(requests[0]?.authorization).toBe(`Bearer ${sessionToken}`);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('header')).not.toContainText('Alice');
});

/** The environment boundary of the deployed page: sign-in, the API and the classified page. */
async function installArtifactRoutes(
  page: Page,
  requests: {
    readonly url: string;
    readonly method: string;
    readonly authorization: string | null;
  }[],
  signIn: Record<string, unknown>[],
): Promise<void> {
  await page.route(`${artifactOrigin}/**`, serveArtifact);
  await page.route(`${cognitoOrigin}/**`, async (route) => {
    if (await allowCrossOrigin(route, artifactOrigin)) {
      return;
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    signIn.push(body);
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
