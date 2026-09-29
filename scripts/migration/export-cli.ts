import { readFile, writeFile } from 'node:fs/promises';
import { dynamoAccount, migrationExport, sqliteAccount } from './export.js';

async function main(): Promise<void> {
  const [kind, restored, owner, accountId, catalogPath, snapshotId, output, ...extra] =
    process.argv.slice(2);
  if (
    !restored ||
    !owner ||
    !accountId ||
    !catalogPath ||
    !snapshotId ||
    !output ||
    extra.length ||
    !['sqlite', 'dynamo-json'].includes(kind ?? '')
  ) {
    throw new Error('Invalid arguments.');
  }
  const source =
    kind === 'sqlite'
      ? sqliteAccount(restored, owner, accountId)
      : dynamoAccount(JSON.parse(await readFile(restored, 'utf8')), owner, accountId);
  const result = migrationExport(
    snapshotId,
    [source],
    JSON.parse(await readFile(catalogPath, 'utf8')),
  );
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Offline export prepared.');
}
main().catch(() => {
  console.error(
    'Export failed. Check restored input, explicit owner mapping, catalog and unused output path. See docs/migration.md.',
  );
  process.exitCode = 1;
});
