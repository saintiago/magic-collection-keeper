/**
 * Finite catalog job entry point
 * (docs/application.md#configuration-and-lifecycle, docs/operations.md#packaging-and-deployment).
 *
 * The catalog artifact executes this module once per run: it ingests the configured provider
 * snapshot into one published revision and exits successfully, or reports why nothing was
 * published and exits with a failure code so the task run's outcome is inspectable. The job holds
 * only the Catalog writer credential; it never constructs the interactive request boundary.
 */

import { pathToFileURL } from 'node:url';

import { runCatalogJob } from './deployment.js';

/** Runs one synchronization and reports the process outcome: 0 published, 1 nothing published. */
export async function main(): Promise<number> {
  const outcome = await runCatalogJob({ environment: process.env });
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
