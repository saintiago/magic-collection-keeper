/** Local-only watched server for the design workspace (docs/ui/storybook.md). */

import { context } from 'esbuild';
import path from 'node:path';

const root = process.cwd();
const storybook = path.join(root, 'storybook');
const rawPort = process.env['STORYBOOK_PORT'] ?? '4173';
const port = Number(rawPort);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`STORYBOOK_PORT must be an integer from 1 to 65535, received ${rawPort}.`);
}

const build = await context({
  entryPoints: [path.join(storybook, 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: path.join(storybook, 'app.js'),
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: root,
});

await build.watch();
const server = await build.serve({
  servedir: storybook,
  host: '127.0.0.1',
  port,
});

console.log(`Magic Collection Keeper storybook: http://127.0.0.1:${String(server.port)}`);

async function stop(): Promise<void> {
  await build.dispose();
  process.exitCode = 0;
}

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
