import {
  CATALOG_LIMITS,
  type CatalogResolver,
  type PrintingRecord,
} from '../../catalog/contract.js';
import { resolveCatalog } from './catalog.js';
import { accountIdFrom } from './context.js';
import { UserCardsError } from './errors.js';
import type {
  UserCardsSqlExecutor,
  UserCardsSqlTransactor,
  UserCardsSqlValue,
} from './executor.js';
import { inTransaction, readRows } from './sql.js';
import type { TrustedUserContext } from './model.js';

export interface StablePrintingReference {
  readonly printingId: string;
  readonly cardId: string;
}

/**
 * Records provider-resolved stable relationships without overwriting an earlier relationship.
 * Catalog promises that a printing identity never changes its playable card; a disagreement is
 * unreadable state, not an update UserCards may silently accept.
 */
export async function storePrintingReferences(
  statements: UserCardsSqlExecutor,
  references: readonly StablePrintingReference[],
): Promise<void> {
  const distinct = new Map<string, StablePrintingReference>();
  for (const reference of references) {
    const earlier = distinct.get(reference.printingId);
    if (earlier !== undefined && earlier.cardId !== reference.cardId) {
      throw new UserCardsError(
        'unavailable',
        'The supplied printing references disagree about the playable card.',
      );
    }
    distinct.set(reference.printingId, reference);
  }
  if (distinct.size === 0) return;

  const parameters: Record<string, UserCardsSqlValue> = {};
  const values = [...distinct.values()]
    .map((reference, index) => {
      parameters[`printing_id_${index}`] = reference.printingId;
      parameters[`card_id_${index}`] = reference.cardId;
      return `(:printing_id_${index}, :card_id_${index})`;
    })
    .join(',\n       ');
  // Existing mappings are immutable: DO NOTHING avoids locking them until commit. Insert in
  // stable order for overlapping batches. Callers acquire domain locks before recording refs.
  await readRows(
    statements,
    `insert into usercards_private.printing_reference (printing_id, card_id)
  select printing_id, card_id from (values ${values}) as requested (printing_id, card_id)
  order by printing_id
  on conflict (printing_id) do nothing
  returning printing_id`,
    parameters,
    'The stable printing references could not be stored.',
  );
  // A separate READ COMMITTED statement sees a concurrent winner after the insert waits. A
  // SELECT in the insert's CTE would retain the older snapshot and falsely report a mismatch.
  const rows = await readRows(
    statements,
    `with requested (printing_id, card_id) as (values ${values})
select requested.printing_id
  from requested
  join usercards_private.printing_reference as stored
    on stored.printing_id = requested.printing_id and stored.card_id = requested.card_id`,
    parameters,
    'The stable printing references could not be verified.',
  );
  if (rows.length !== distinct.size) {
    throw new UserCardsError(
      'unavailable',
      'A stored printing reference does not agree with the catalog.',
    );
  }
}

function unresolvedStatement(accountId: string): {
  readonly statement: string;
  readonly parameters: Readonly<Record<string, UserCardsSqlValue>>;
} {
  return {
    statement: `select missing.printing_id
from (
  select copy.printing_id
    from usercards_private.copy as copy
   where copy.account_id = :account_id
  union
  select association.target_id as printing_id
    from usercards_private.association as association
   where association.account_id = :account_id and association.target_level = 'printing'
) as missing
left join usercards_private.printing_reference as prepared
  on prepared.printing_id = missing.printing_id
where prepared.printing_id is null
order by missing.printing_id
limit :reference_limit`,
    parameters: {
      account_id: accountId,
      reference_limit: CATALOG_LIMITS.maxResolutionReferences,
    },
  };
}

/**
 * Prepares one bounded batch of stable references used by one account. Interruption leaves earlier
 * batches intact, and repeating the call resumes with the first still-missing printing.
 */
async function preparePrintingReferenceBatch(
  sql: UserCardsSqlTransactor,
  catalog: CatalogResolver,
  accountId: string,
): Promise<UserCardsReferencePreparationResult> {
  const request = unresolvedStatement(accountId);
  const rows = await readRows(
    sql,
    request.statement,
    request.parameters,
    'The stable printing references could not be inspected.',
  );
  const printingIds = rows
    .map((row) => row.printing_id)
    .filter((value): value is string => typeof value === 'string');
  if (printingIds.length !== rows.length) {
    throw new UserCardsError('unavailable', 'UserCards reported an invalid printing reference.');
  }
  if (printingIds.length === 0) return { preparedReferences: 0, complete: true };

  const resolution = await resolveCatalog(
    catalog,
    printingIds.map((printingId) => ({ kind: 'printing', printingId }) as const),
  );
  const printings: PrintingRecord[] = [];
  for (const printingId of printingIds) {
    const printing = resolution.printings.get(printingId);
    if (printing === undefined) {
      throw new UserCardsError(
        'unavailable',
        'A saved printing reference is not available for private queries.',
      );
    }
    printings.push(printing);
  }
  await inTransaction(
    sql,
    (statements) =>
      storePrintingReferences(
        statements,
        printings.map((printing) => ({
          printingId: printing.printingId,
          cardId: printing.cardId,
        })),
      ),
    'The stable printing references could not be prepared.',
  );
  return {
    preparedReferences: printings.length,
    complete: printings.length < CATALOG_LIMITS.maxResolutionReferences,
  };
}

export interface UserCardsReferencePreparationResult {
  readonly preparedReferences: number;
  /** False means another bounded call is required before current reads are enabled. */
  readonly complete: boolean;
}

export interface UserCardsReferencePreparation {
  prepare(context: TrustedUserContext): Promise<UserCardsReferencePreparationResult>;
}

/** Explicit compatible-upgrade capability; ordinary queries never construct or invoke it. */
export function createUserCardsReferencePreparation(dependencies: {
  readonly sql: UserCardsSqlTransactor;
  readonly catalog: CatalogResolver;
}): UserCardsReferencePreparation {
  const sql = dependencies?.sql;
  const catalog = dependencies?.catalog;
  if (typeof sql?.query !== 'function' || typeof sql?.transaction !== 'function') {
    throw new TypeError(
      'createUserCardsReferencePreparation requires a transaction-capable SQL executor.',
    );
  }
  if (typeof catalog?.resolve !== 'function') {
    throw new TypeError(
      'createUserCardsReferencePreparation requires the CatalogResolver contract.',
    );
  }
  return {
    prepare(context) {
      return preparePrintingReferenceBatch(sql, catalog, accountIdFrom(context));
    },
  };
}
