/**
 * System-journey harness of the integrated acceptance scenarios
 * (docs/testing.md#integrated-acceptance, docs/testing.md#component-acceptance-scenarios).
 *
 * One journey runs the assembled Application over real PostgreSQL (PGlite carries PostgreSQL
 * semantics in-process, as every database case does) and serves the real browser deployment
 * against it: the page boots the public settings this environment publishes, its authenticated
 * transport reaches a local HTTP origin, and that origin hands every invocation to
 * `Application.handle` with the claims the deployed authorizer would have verified. The browser
 * therefore drives the real pages, the real transports and the real Catalog, UserCards and Search
 * components; the substituted boundary is only the AWS service around them — the API Gateway JWT
 * authorizer and the Data API — exactly as docs/testing.md#live-boundaries-and-performance keeps
 * separate live evidence.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { createPostgresApplication, type Application } from '../../src/application/backend.js';
import type { PublicApplicationSettings } from '../../src/application/index.js';
import { catalogSchemaSql } from '../../src/catalog/index.js';
import { usercardsSchemaSql } from '../../src/usercards/index.js';
import {
  claimsFor,
  testAccount,
  testConfiguration,
  testIdentityVerifier,
} from '../support/application.js';
import { createSnapshotSource } from '../support/catalog-snapshot.js';
import { createTestDatabase } from '../support/postgres-database.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const sourceVersion = '2026-09-01T00:00:00.000Z';

/** The catalog of every journey: the card the journeys act on and one other released card. */
const systemCatalogRecords: readonly Record<string, unknown>[] = [
  {
    object: 'card',
    id: 'printing-m11-149-en',
    oracle_id: 'oracle-lightning-bolt',
    name: 'Lightning Bolt',
    lang: 'en',
    set: 'm11',
    collector_number: '149',
    finishes: ['nonfoil', 'foil'],
    nonfoil: true,
    foil: true,
    etched: false,
    digital: false,
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    type_line: 'Instant',
    colors: ['R'],
    color_identity: ['R'],
    cmc: 1,
    image_uris: {
      small: 'https://images.example.test/m11-149-small.jpg',
      normal: 'https://images.example.test/m11-149-normal.jpg',
      large: 'https://images.example.test/m11-149-large.jpg',
      art_crop: 'https://images.example.test/m11-149-art.jpg',
    },
  },
  {
    object: 'card',
    id: 'printing-tle-33-en',
    oracle_id: 'oracle-counterspell',
    name: 'Counterspell',
    lang: 'en',
    set: 'tle',
    collector_number: '33',
    finishes: ['nonfoil'],
    nonfoil: true,
    foil: false,
    etched: false,
    digital: false,
    oracle_text: 'Counter target spell.',
    type_line: 'Instant',
    colors: ['U'],
    color_identity: ['U'],
    cmc: 2,
    image_uris: null,
  },
];

/** One interactive invocation the page made, kept as the journey's own evidence. */
export interface SystemJourneyCall {
  readonly method: string;
  readonly path: string;
  readonly accountId: string | null;
  readonly status: number;
}

export interface SystemJourneyCallInput {
  readonly method: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Verified account of the caller; an anonymous invocation carries none. */
  readonly accountId?: string;
  readonly body?: unknown;
}

export interface SystemJourneyResult {
  readonly status: number;
  readonly payload: unknown;
}

export interface SystemJourney {
  /** Origin that serves the browser artifact and the interactive boundary of the environment. */
  readonly origin: string;
  /** Interactive invocations the page made, oldest first. */
  readonly calls: readonly SystemJourneyCall[];
  /** One stored browser session of an account, as Application's sign-in writes it. */
  sessionFor(accountId?: string, displayName?: string): string;
  /** One identity token of an account, as the environment's user pool would issue it. */
  tokenFor(accountId: string, displayName?: string): string;
  /** Runs one invocation through the real interactive boundary, as the page's transport does. */
  call(input: SystemJourneyCallInput): Promise<SystemJourneyResult>;
  /**
   * Runs the next invocation of one path to completion but loses its response in transit, as a
   * dropped connection does: the operation commits and its caller has to recover the outcome.
   */
  loseNextResponse(path: string): void;
  close(): Promise<void>;
}

/**
 * Starts one isolated journey: a fresh database with the published catalog, the assembled
 * Application and the HTTP origin the browser deployment loads from.
 */
export async function startSystemJourney(): Promise<SystemJourney> {
  const database = await createTestDatabase(`${catalogSchemaSql}\n\n${usercardsSchemaSql}`);
  const calls: SystemJourneyCall[] = [];
  const lostResponses: string[] = [];
  /** Assembled once the origin it publishes to the browser is known; no request arrives before. */
  let serving: Application | null = null;
  const server = createServer((request, response) => {
    void serveJourneyRequest(request, response);
  });
  await listen(server);
  const origin = readOrigin(server);
  const configuration = testConfiguration();
  configuration.browser.apiBaseUrl = origin;
  const assembled = createPostgresApplication({
    configuration,
    identity: testIdentityVerifier(),
    resources: {
      readSql: database.sql,
      writeSql: database.sql,
      catalogSynchronization: {
        sql: database.sql,
        snapshots: createSnapshotSource({
          default_cards: { sourceVersion, records: systemCatalogRecords },
        }),
      },
      searchIndexing: null,
      deckSource: null,
    },
  });
  await assembled.synchronizeCatalog({ dataset: 'default_cards' });
  serving = assembled;
  const settings = assembled.settings;

  async function serveJourneyRequest(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    try {
      await answerJourneyRequest(incoming, outgoing);
    } catch (cause) {
      // A request the journey cannot answer is a failed journey, never a hung page.
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { 'content-type': 'application/json' });
      }
      outgoing.end(JSON.stringify({ error: { code: 'unavailable', message: String(cause) } }));
    }
  }

  async function answerJourneyRequest(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
  ): Promise<void> {
    const url = new URL(incoming.url ?? '/', origin);
    if (url.pathname === '/') {
      outgoing.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      outgoing.end(journeyPage(settings));
      return;
    }
    if (url.pathname === '/keeper.js') {
      outgoing.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      outgoing.end(await journeyBundle());
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('Not found');
      return;
    }
    const accountId = readAuthorizedAccount(incoming.headers.authorization);
    const body = await readRequestBody(incoming);
    const result = await invoke({
      method: incoming.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      ...(accountId === null ? {} : { claims: claimsFor(accountId) }),
      ...(body.length === 0 ? {} : { body }),
    });
    const lost = lostResponses.indexOf(url.pathname);
    if (lost !== -1) {
      lostResponses.splice(lost, 1);
      // The response begins and then dies mid-body: the caller observes a connection that failed
      // after the operation was accepted, never an unanswered request it may transparently retry.
      outgoing.writeHead(result.status, { ...result.headers });
      outgoing.write(result.body.slice(0, Math.max(1, Math.floor(result.body.length / 2))));
      await new Promise((resolve) => setTimeout(resolve, 100));
      outgoing.destroy();
      return;
    }
    outgoing.writeHead(result.status, result.headers);
    outgoing.end(result.body);
  }

  async function invoke(request: {
    readonly method: string;
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly claims?: Readonly<Record<string, unknown>>;
    readonly body?: string | null;
  }) {
    const application = serving;
    if (application === null) {
      throw new Error('The system journey received a request before it was serving.');
    }
    const response = await application.handle({
      method: request.method,
      path: request.path,
      ...(request.query === undefined ? {} : { query: request.query }),
      ...(request.claims === undefined ? {} : { authentication: { claims: request.claims } }),
      ...(request.body === undefined ? {} : { body: request.body }),
      requestId: 'system-journey',
    });
    calls.push({
      method: request.method,
      path: request.path,
      accountId: typeof request.claims?.sub === 'string' ? request.claims.sub : null,
      status: response.status,
    });
    return response;
  }

  return {
    origin,
    calls,
    sessionFor(accountId = testAccount, displayName = 'Alice') {
      return JSON.stringify({
        idToken: jwtFor(accountId, displayName),
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3_600_000,
        accountId,
        displayName,
      });
    },
    tokenFor(accountId, displayName) {
      return jwtFor(accountId, displayName);
    },
    async call(input) {
      const response = await invoke({
        method: input.method,
        path: input.path,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.accountId === undefined ? {} : { claims: claimsFor(input.accountId) }),
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      return { status: response.status, payload: JSON.parse(response.body) as unknown };
    },
    loseNextResponse(path) {
      lostResponses.push(path);
    },
    async close() {
      assembled.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.close();
    },
  };
}

/** The browser artifact's page: the shell root, the environment's public settings, the bundle. */
function journeyPage(settings: PublicApplicationSettings): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Keeper</title>
  </head>
  <body>
    <div id="keeper-root"></div>
    <script type="application/json" id="keeper-public-settings">${JSON.stringify(settings)}</script>
    <script type="module" src="/keeper.js"></script>
  </body>
</html>
`;
}

let bundle: Promise<string> | null = null;

/**
 * Bundles the browser deployment of this build, as the packaged artifact bundles it: validated
 * public settings, the environment's sign-in, the device and the pages behind one shell.
 */
function journeyBundle(): Promise<string> {
  bundle ??= (async () => {
    const deploymentPath = path.join(repoRoot, 'src', 'ui', 'deployment.ts');
    const result = await build({
      stdin: {
        contents: [
          `import { createBrowserDeployment } from ${JSON.stringify(deploymentPath)};`,
          "const settings = JSON.parse(document.getElementById('keeper-public-settings').textContent);",
          'globalThis.keeperDeployment = createBrowserDeployment({',
          "  root: document.getElementById('keeper-root'),",
          '  settings,',
          '});',
        ].join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'keeper-deployment.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
    });
    const [output] = result.outputFiles ?? [];
    if (output === undefined) {
      throw new Error('esbuild produced no browser deployment bundle.');
    }
    return output.text;
  })();
  return bundle;
}

/** One identity token of the test environment, in the shape the browser stores and presents. */
function jwtFor(accountId: string, displayName?: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = claimsFor(accountId, displayName === undefined ? {} : { name: displayName });
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`;
}

/**
 * The account the deployed authorizer verified: the one every interactive route derives its
 * trusted context from (docs/application.md#construction-and-request-boundary).
 */
function readAuthorizedAccount(authorization: string | undefined): string | null {
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  const encoded = match?.[1]?.split('.')[1];
  if (encoded === undefined) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      readonly sub?: unknown;
    };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function readOrigin(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The system journey server did not bind a TCP port.');
  }
  return `http://127.0.0.1:${address.port}`;
}
