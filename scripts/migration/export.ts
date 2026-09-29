/** Offline extraction: the caller must supply a restored local backup, not a live-store path. */
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { account, bundle, legacyRevision, type LegacyAccount } from './legacy.js';

export function sqliteAccount(
  restoredFile: string,
  owner: string,
  accountId: string,
): LegacyAccount {
  const db = new DatabaseSync(restoredFile, { readOnly: true });
  try {
    db.exec('pragma query_only=on; begin');
    // Native SQLite inventory has no owner column. Refuse evidence of mixed local profiles.
    const foreign = db.prepare('select owner from documents where owner <> ? limit 1').get(owner);
    if (foreign)
      throw new Error('SQLite profile contains another owner. Verify the profile mapping.');
    return account.parse({
      owner,
      accountId,
      inventory: db.prepare('select * from inventory order by id').all(),
      documents: db
        .prepare('select space,id,version,value from documents where owner=? order by space,id')
        .all(owner)
        .map((d) => ({ ...d, value: JSON.parse(String(d.value)) })),
      operations: db.prepare('select * from operations order by id').all(),
    });
  } finally {
    db.close();
  }
}

/** Input is decoded DynamoDB items from a restored snapshot, not an eventually consistent live scan. */
export function dynamoAccount(raw: unknown, owner: string, accountId: string): LegacyAccount {
  const items = z.array(z.record(z.string(), z.unknown())).parse(raw);
  const inventory: unknown[] = [],
    documents: unknown[] = [],
    operations: unknown[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const { PK, SK } = item;
    if (typeof PK !== 'string' || typeof SK !== 'string')
      throw new Error('Expected decoded DynamoDB PK/SK items.');
    const identity = JSON.stringify([PK, SK]);
    if (seen.has(identity)) throw new Error('Duplicate export key.');
    seen.add(identity);
    if (PK === `USER#${owner}`) {
      if (item.id !== SK) throw new Error('Inventory identity differs from its storage key.');
      inventory.push(item);
    } else if (PK.startsWith(`META#${owner}#`)) {
      const space = PK.slice(`META#${owner}#`.length);
      if (space === 'locks')
        throw new Error(
          'Backup contains an inventory lock; resolve snapshot consistency before conversion.',
        );
      if (item.id !== SK) throw new Error('Document identity differs from its storage key.');
      documents.push({ space, id: SK, version: item.version, value: item.value });
    } else if (PK === `OPERATIONS#${owner}` || PK === `REVIEWBATCH#${owner}`) operations.push(item);
  }
  return account.parse({ owner, accountId, inventory, documents, operations });
}

/** Adds the independently exported target catalog and an immutable snapshot identity. */
export function migrationExport(
  snapshotId: string,
  accounts: readonly LegacyAccount[],
  catalog: unknown,
) {
  return bundle.parse({
    format: 'keeper-legacy-export-v1',
    legacyRevision,
    snapshotId,
    accounts,
    catalog,
  });
}
