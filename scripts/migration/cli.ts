/** Local file conversion only. No cloud client, credentials, database connection or apply mode. */
import { readFile, writeFile } from 'node:fs/promises';
import { prepareMigration, verifyPlan } from './prepare.js';

async function main(): Promise<void> {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) {
    throw new Error('Usage: npm run migration:prepare -- <export.json> <new-plan.json>');
  }
  const plan = prepareMigration(JSON.parse(await readFile(input, 'utf8')));
  if (plan.state === 'prepared') verifyPlan(plan);
  // Exclusive creation protects both the source and any previous private result.
  await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      state: plan.state,
      accounts: plan.accounts.length,
      blockers: plan.issues.length,
    }),
  );
  if (plan.state === 'blocked') process.exitCode = 2;
}

main().catch(() => {
  // Input validation can contain private source values. Inspect the file locally, not a shared log.
  console.error(
    'Preparation failed. Check the private input format and that the output does not exist.',
  );
  process.exitCode = 1;
});
