/** Finite Catalog ingestion entry point; deploying its task definition never starts it. */

import { pathToFileURL } from 'node:url';

import { runCatalogJob } from '../deployment.js';

export async function main(): Promise<number> {
  const outcome = await runCatalogJob({ environment: process.env });
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
