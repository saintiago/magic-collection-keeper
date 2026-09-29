/**
 * Background indexing job entry point
 * (docs/application.md#interface, docs/operations.md#packaging-and-deployment).
 *
 * The indexing artifact executes this module once per explicit run: it applies the provider
 * publications in scope to Search's own projection through one bounded, resumable pass and exits
 * successfully, or reports why the pass did not complete and exits with a failure code so the task
 * run's outcome is inspectable. A successful run that did not catch up is resumed by starting
 * another run; it never waits for a schedule and never holds a provider's writer credential
 * (docs/data-architecture.md#asynchronous-synchronization).
 */

import { pathToFileURL } from 'node:url';

import { runIndexingJob } from './deployment.js';

/** Runs one indexing pass and reports the process outcome: 0 completed, 1 failed. */
export async function main(): Promise<number> {
  const outcome = await runIndexingJob({ environment: process.env });
  return outcome.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
