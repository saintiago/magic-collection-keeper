/**
 * Background indexing over the provider publications (docs/search.md#internal-design,
 * docs/data-architecture.md#asynchronous-synchronization).
 *
 * Indexing consumes the Catalog and UserCards publication contracts and maintains Search's own
 * projection; it never joins a provider table and never mutates a provider record. A generation
 * is bootstrapped from consistent snapshots and then caught up through the durable change streams
 * of the sources in its scope. Changes are applied in the order the provider published them,
 * through the last complete publication a page carries, and the checkpoint of each source commits
 * in the same transaction as the rows it describes: a batch that fails leaves the projection and
 * its checkpoint exactly as they were, and repeated delivery of an applied page changes nothing.
 *
 * A replacement generation is built beside the published one and becomes queryable only once
 * every source in its scope is caught up and the projection carries no unresolved reference, so
 * reads continue over the complete previous generation during a rebuild
 * (docs/data-architecture.md#bootstrap-and-rebuild). An expired change position is never resumed
 * or skipped: the run rebuilds from fresh snapshots instead. References a private record makes to
 * catalog facts are retained while they are unresolved, so a publication that is not yet
 * resolvable is reported rather than published as a complete generation.
 */

import {
  CatalogError,
  type CatalogChange,
  type CatalogPublication,
  type CatalogSnapshotPage,
} from '../../catalog/index.js';
import {
  UserCardsError,
  type UserCardsChange,
  type UserCardsPublication,
  type UserCardsSnapshotPage,
} from '../../usercards/index.js';
import { z } from 'zod';

import {
  applyCatalogRecordChange,
  applyUserCardsRecordChange,
  writeCatalogRecord,
  writeUserCardsRecord,
} from './bindings.js';
import { SearchError } from './errors.js';
import type {
  SearchSqlExecutor,
  SearchSqlRow,
  SearchSqlTransactor,
  SearchSqlValue,
} from './executor.js';
import { searchPrivateSchema } from './schema.js';

/**
 * Bounds of one indexing run. A caller runs further passes instead of raising them: every batch
 * commits its own checkpoint, so an interrupted or budget-limited run resumes exactly where it
 * stopped. Page bounds match the providers' own publication bounds.
 */
export const SEARCH_INDEXING_LIMITS = {
  minPageSize: 1,
  defaultPageSize: 500,
  maxPageSize: 1000,
  /** Complete publications one source applies before the run returns for its next invocation. */
  minBatches: 1,
  defaultBatches: 4,
  maxBatches: 32,
  /** Accounts one request may name; the scope of a rebuild also carries its known accounts. */
  maxRequestedAccounts: 100,
  /** Snapshot reads or rebuild attempts that may restart after a position expired. */
  maxAttempts: 3,
  /**
   * Safety bound on pages one batch reads while it waits for a publication to complete. A page
   * always advances or ends the stream, so this only stops a provider that repeats a page forever.
   */
  maxPagesPerBatch: 1000,
  maxIdentifierLength: 200,
  maxPositionLength: 20,
  maxRevisionLength: 200,
} as const;

/** One indexing request as Application receives it. */
export interface SearchIndexingRequest {
  /**
   * Private accounts this run indexes, besides the accounts the generation already knows. An
   * account without a checkpoint is bootstrapped from its consistent snapshot.
   */
  readonly accounts?: readonly string[];
  /** Build a replacement generation from fresh snapshots instead of catching up in place. */
  readonly rebuild?: boolean;
  /** Records one publication page carries, from 1 to {@link SEARCH_INDEXING_LIMITS}.maxPageSize. */
  readonly pageSize?: number;
  /** Complete publications one source applies in this run, from 1 to maxBatches. */
  readonly maxBatches?: number;
}

/** Catalog progress of one indexing run. */
export interface SearchCatalogProgress {
  /** Catalog publication position the generation applied through. */
  readonly position: string;
  /** Catalog revision the generation holds every published record of. */
  readonly revisionId: string;
  /** Whether the run applied the complete catalog change stream. */
  readonly caughtUp: boolean;
}

/** Private progress of one account's projection in one indexing run. */
export interface SearchAccountProgress {
  readonly accountId: string;
  /** Account-scoped publication position the generation applied through. */
  readonly position: string;
  /** Whether the run applied the complete private change stream of the account. */
  readonly caughtUp: boolean;
}

/** What one indexing run left behind. */
export interface SearchIndexingResult {
  /** Generation this run worked on. */
  readonly generation: string;
  /** Whether that generation is the queryable one after this run. */
  readonly published: boolean;
  /** Whether this run started a replacement generation from fresh snapshots. */
  readonly rebuilt: boolean;
  /** Whether every source in the run's scope applied its complete change stream. */
  readonly caughtUp: boolean;
  /**
   * References the projection could not resolve to a catalog fact it holds. A nonzero count keeps
   * a replacement generation from being published as an apparently complete one.
   */
  readonly unresolvedReferences: number;
  readonly catalog: SearchCatalogProgress;
  readonly accounts: readonly SearchAccountProgress[];
}

/** The Search indexing job entry point Application exposes as background work. */
export interface SearchIndexer {
  /** Applies one bounded pass over the sources in scope; repeated calls resume where it stopped. */
  index(request?: SearchIndexingRequest): Promise<SearchIndexingResult>;
}

export interface SearchIndexerDependencies {
  /**
   * Transaction-capable executor supplied by Application with the indexing role: Search's own
   * projection, never a provider's relations.
   */
  readonly sql: SearchSqlTransactor;
  /** Trusted read access to Catalog's snapshot and change publication. */
  readonly catalog: CatalogPublication;
  /** Trusted indexing access to UserCards' account-scoped publication. */
  readonly userCards: UserCardsPublication;
}

const requestSchema = z
  .object({
    accounts: z
      .array(z.string().min(1).max(SEARCH_INDEXING_LIMITS.maxIdentifierLength))
      .max(SEARCH_INDEXING_LIMITS.maxRequestedAccounts)
      .optional(),
    rebuild: z.boolean().optional(),
    pageSize: z
      .number()
      .int()
      .min(SEARCH_INDEXING_LIMITS.minPageSize)
      .max(SEARCH_INDEXING_LIMITS.maxPageSize)
      .optional(),
    maxBatches: z
      .number()
      .int()
      .min(SEARCH_INDEXING_LIMITS.minBatches)
      .max(SEARCH_INDEXING_LIMITS.maxBatches)
      .optional(),
  })
  .strict();

interface IndexingOptions {
  readonly accounts: readonly string[];
  readonly rebuild: boolean;
  readonly pageSize: number;
  readonly maxBatches: number;
}

/**
 * One change of a provider page in the form indexing applies it: its resume position, and either
 * the projection write a record change performs or the publication a marker completes. A marker
 * carries the catalog revision it publishes; private markers carry none, because Search's private
 * freshness state is the position the provider acknowledged.
 */
type PendingChange =
  | { readonly kind: 'marker'; readonly position: string; readonly revisionId: string | null }
  | {
      readonly kind: 'record';
      readonly position: string;
      readonly write: (sql: SearchSqlExecutor) => Promise<void>;
    };

interface ChangeCheckpoint {
  readonly position: string;
  readonly revisionId: string | null;
}

interface ChangeSource {
  /** Reads the changes the provider published after a position. */
  read(position: string): Promise<readonly PendingChange[]>;
  /** Persists what one batch applied; only called when at least one change was applied. */
  checkpoint(sql: SearchSqlExecutor, checkpoint: ChangeCheckpoint): Promise<void>;
}

interface GenerationState {
  readonly published: string | null;
  readonly building: string | null;
}

/**
 * Creates the Search indexing job over the provider publications. Application supplies the
 * projection writer credential and separate trusted access to each provider's publication; query
 * entry points never reach this composition (docs/application.md#interface).
 */
export function createSearchIndexer(dependencies: SearchIndexerDependencies): SearchIndexer {
  const sql: SearchSqlTransactor | undefined = dependencies?.sql;
  if (
    sql === undefined ||
    typeof sql.query !== 'function' ||
    typeof sql.transaction !== 'function'
  ) {
    throw new TypeError('createSearchIndexer requires a transaction-capable SQL executor.');
  }
  const catalog: CatalogPublication | undefined = dependencies?.catalog;
  if (
    catalog === undefined ||
    typeof catalog.readSnapshot !== 'function' ||
    typeof catalog.readChanges !== 'function'
  ) {
    throw new TypeError('createSearchIndexer requires the Catalog publication contract.');
  }
  const userCards: UserCardsPublication | undefined = dependencies?.userCards;
  if (
    userCards === undefined ||
    typeof userCards.readSnapshot !== 'function' ||
    typeof userCards.readChanges !== 'function'
  ) {
    throw new TypeError('createSearchIndexer requires the UserCards publication contract.');
  }
  const projection: SearchSqlTransactor = sql;
  const catalogPublication: CatalogPublication = catalog;
  const userCardsPublication: UserCardsPublication = userCards;

  /** One pass over the generation's sources; a stale position escapes to the retry loop. */
  async function indexGeneration(
    options: IndexingOptions,
    rebuild: boolean,
  ): Promise<SearchIndexingResult> {
    const state = await readGenerationState(projection);
    const startBuild = state.building === null && (state.published === null || rebuild);
    const started = startBuild ? await createGeneration(projection) : null;
    const generation = started ?? state.building ?? state.published;
    if (generation === null) {
      throw new SearchError('unavailable', 'The search projection could not be opened.');
    }
    const building = started !== null || state.building !== null;
    const accounts = building
      ? await rebuildScope(projection, generation, state.published, options.accounts)
      : uniqueAccounts(options.accounts);

    const catalogProgress = await alignCatalog(projection, catalogPublication, generation, options);
    const accountProgress: SearchAccountProgress[] = [];
    for (const accountId of accounts) {
      accountProgress.push(
        await alignAccount(projection, userCardsPublication, generation, accountId, options),
      );
    }
    const unresolvedReferences = await countUnresolvedReferences(projection, generation);
    const caughtUp =
      catalogProgress.caughtUp && accountProgress.every((progress) => progress.caughtUp);
    const publish = building && caughtUp && unresolvedReferences === 0;
    if (publish) {
      await publishGeneration(projection, generation);
    }
    return {
      generation,
      published: !building || publish,
      rebuilt: started !== null,
      caughtUp,
      unresolvedReferences,
      catalog: catalogProgress,
      accounts: accountProgress,
    };
  }

  return {
    async index(request: SearchIndexingRequest = {}): Promise<SearchIndexingResult> {
      const options = readIndexingRequest(request);
      let rebuild = options.rebuild;
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await indexGeneration(options, rebuild);
        } catch (cause) {
          if (!isStaleContinuation(cause) || attempt >= SEARCH_INDEXING_LIMITS.maxAttempts) {
            throw translateIndexingFailure(cause);
          }
          // An expired position requires a new snapshot, never a skipped region: discard the
          // unfinished replacement and build one from fresh snapshots on the next attempt.
          await discardBuildingGeneration(projection);
          rebuild = true;
        }
      }
    },
  };
}

function readIndexingRequest(request: SearchIndexingRequest): IndexingOptions {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SearchError(
      'invalid-request',
      'An indexing request names at most ' +
        `${SEARCH_INDEXING_LIMITS.maxRequestedAccounts} accounts of up to ` +
        `${SEARCH_INDEXING_LIMITS.maxIdentifierLength} characters each, no account twice, and a ` +
        `page size and batch budget within the documented bounds.`,
    );
  }
  const accounts = parsed.data.accounts ?? [];
  if (new Set(accounts).size !== accounts.length) {
    throw new SearchError(
      'invalid-request',
      'An indexing request names each account at most once.',
    );
  }
  return {
    accounts: uniqueAccounts(accounts),
    rebuild: parsed.data.rebuild ?? false,
    pageSize: parsed.data.pageSize ?? SEARCH_INDEXING_LIMITS.defaultPageSize,
    maxBatches: parsed.data.maxBatches ?? SEARCH_INDEXING_LIMITS.defaultBatches,
  };
}

function uniqueAccounts(accounts: readonly string[]): readonly string[] {
  return [...new Set(accounts)].sort();
}

/** The accounts a rebuild covers: the ones it already knows plus the ones this request names. */
async function rebuildScope(
  sql: SearchSqlTransactor,
  generation: string,
  published: string | null,
  requested: readonly string[],
): Promise<readonly string[]> {
  const known = await readCheckpointAccounts(sql, generation);
  const carried = published === null ? [] : await readCheckpointAccounts(sql, published);
  return uniqueAccounts([...carried, ...known, ...requested]);
}

async function alignCatalog(
  sql: SearchSqlTransactor,
  catalog: CatalogPublication,
  generation: string,
  options: IndexingOptions,
): Promise<SearchCatalogProgress> {
  const checkpoint =
    (await readCatalogCheckpoint(sql, generation)) ??
    (await applySnapshot(sql, (statements) =>
      readCatalogSnapshot(catalog, statements, generation, options),
    ));
  if (checkpoint.revisionId === null) {
    throw unreadableProjection();
  }
  const revisionId = checkpoint.revisionId;
  const source: ChangeSource = {
    read: (position) => readCatalogChanges(catalog, generation, position, options),
    checkpoint: (statements, applied) =>
      writeCatalogCheckpoint(
        statements,
        generation,
        applied.position,
        applied.revisionId ?? revisionId,
      ),
  };
  const drained = await drainChanges(sql, source, checkpoint, options.maxBatches);
  return {
    position: drained.position,
    revisionId: drained.revisionId ?? revisionId,
    caughtUp: drained.caughtUp,
  };
}

async function alignAccount(
  sql: SearchSqlTransactor,
  userCards: UserCardsPublication,
  generation: string,
  accountId: string,
  options: IndexingOptions,
): Promise<SearchAccountProgress> {
  const checkpoint =
    (await readAccountCheckpoint(sql, generation, accountId)) ??
    (await applySnapshot(sql, (statements) =>
      readAccountSnapshot(userCards, statements, generation, accountId, options),
    ));
  const source: ChangeSource = {
    read: (position) => readAccountChanges(userCards, generation, accountId, position, options),
    checkpoint: (statements, applied) =>
      writeAccountCheckpoint(statements, generation, accountId, applied.position),
  };
  const drained = await drainChanges(sql, source, checkpoint, options.maxBatches);
  return {
    accountId,
    position: drained.position,
    caughtUp: drained.caughtUp,
  };
}

/**
 * Bootstraps one source from its consistent snapshot inside one transaction: the snapshot's
 * records replace whatever this generation held for the source, and the checkpoint commits with
 * them, so an interrupted bootstrap leaves neither. A snapshot page the provider published a new
 * revision over is obsolete, so the snapshot restarts from its first page instead of mixing
 * revisions.
 */
async function applySnapshot(
  sql: SearchSqlTransactor,
  read: (statements: SearchSqlExecutor) => Promise<ChangeCheckpoint>,
): Promise<ChangeCheckpoint> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await sql.transaction(read);
    } catch (cause) {
      if (!isStaleContinuation(cause) || attempt >= SEARCH_INDEXING_LIMITS.maxAttempts) {
        throw cause;
      }
    }
  }
}

async function readCatalogSnapshot(
  catalog: CatalogPublication,
  statements: SearchSqlExecutor,
  generation: string,
  options: IndexingOptions,
): Promise<ChangeCheckpoint> {
  let page = await catalog.readSnapshot({ pageSize: options.pageSize });
  const revisionId = page.revision.revisionId;
  const checkpoint: ChangeCheckpoint = {
    position: page.position,
    revisionId,
  };
  await clearCatalogProjection(statements, generation);
  for (;;) {
    await writeCatalogPage(statements, generation, page);
    if (page.continuation === null) {
      break;
    }
    page = await catalog.readSnapshot({
      pageSize: options.pageSize,
      continuation: page.continuation,
    });
  }
  await writeCatalogCheckpoint(statements, generation, checkpoint.position, revisionId);
  return checkpoint;
}

async function readAccountSnapshot(
  userCards: UserCardsPublication,
  statements: SearchSqlExecutor,
  generation: string,
  accountId: string,
  options: IndexingOptions,
): Promise<ChangeCheckpoint> {
  let page = await userCards.readSnapshot({ accountId, pageSize: options.pageSize });
  const checkpoint: ChangeCheckpoint = { position: page.position, revisionId: null };
  await clearAccountProjection(statements, generation, accountId);
  for (;;) {
    await writeAccountPage(statements, generation, accountId, page);
    if (page.continuation === null) {
      break;
    }
    page = await userCards.readSnapshot({
      accountId,
      pageSize: options.pageSize,
      continuation: page.continuation,
    });
  }
  await writeAccountCheckpoint(statements, generation, accountId, checkpoint.position);
  return checkpoint;
}

/**
 * Applies complete publications from one source until its stream ends or the run's batch budget is
 * spent. A batch commits the rows of every publication it covers together with the checkpoint of
 * the last change it applied, so a restart never observes half a publication.
 */
async function drainChanges(
  sql: SearchSqlTransactor,
  source: ChangeSource,
  start: ChangeCheckpoint,
  maxBatches: number,
): Promise<ChangeCheckpoint & { readonly caughtUp: boolean }> {
  let checkpoint = start;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const applied = await applyChangeBatch(sql, source, checkpoint);
    checkpoint = { position: applied.position, revisionId: applied.revisionId };
    if (applied.exhausted) {
      return { ...checkpoint, caughtUp: true };
    }
  }
  // The budget may have run out exactly at the end of the stream; one more read decides without
  // applying anything, and the changes it returns are the next run's first batch.
  const remaining = await source.read(checkpoint.position);
  return { ...checkpoint, caughtUp: remaining.length === 0 };
}

async function applyChangeBatch(
  sql: SearchSqlTransactor,
  source: ChangeSource,
  start: ChangeCheckpoint,
): Promise<ChangeCheckpoint & { readonly exhausted: boolean }> {
  return await sql.transaction(async (statements) => {
    let checkpoint = start;
    let applied = false;
    let complete = false;
    let exhausted = false;
    for (let page = 0; page < SEARCH_INDEXING_LIMITS.maxPagesPerBatch; page += 1) {
      const changes = await source.read(checkpoint.position);
      if (changes.length === 0) {
        exhausted = true;
        break;
      }
      const marker = lastMarkerIndex(changes);
      // Without a marker the page ends inside a publication: its records are applied inside this
      // batch's transaction and the next page is read until the publication completes.
      const through = marker === -1 ? changes : changes.slice(0, marker + 1);
      for (const change of through) {
        if (change.kind === 'record') {
          await change.write(statements);
        } else {
          complete = true;
          if (change.revisionId !== null) {
            checkpoint = { ...checkpoint, revisionId: change.revisionId };
          }
        }
        checkpoint = { ...checkpoint, position: change.position };
        applied = true;
      }
      if (marker >= 0) {
        break;
      }
    }
    if (applied && !complete) {
      // A provider always publishes a completion marker after a change's records; a stream that
      // stops inside a publication must not advance an apparently complete checkpoint.
      throw new SearchError(
        'unavailable',
        'A publication ended without its completion marker; the projection was not advanced.',
      );
    }
    if (applied) {
      await source.checkpoint(statements, checkpoint);
    }
    return { ...checkpoint, exhausted };
  });
}

/** Index of the last change that completes a publication, or -1 when the page carries none. */
function lastMarkerIndex(changes: readonly PendingChange[]): number {
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    if (changes[index]?.kind === 'marker') {
      return index;
    }
  }
  return -1;
}

async function readCatalogChanges(
  catalog: CatalogPublication,
  generation: string,
  position: string,
  options: IndexingOptions,
): Promise<readonly PendingChange[]> {
  const page = await catalog.readChanges({ position, pageSize: options.pageSize });
  return page.changes.map((change) => catalogChange(generation, change));
}

function catalogChange(generation: string, change: CatalogChange): PendingChange {
  if (change.kind === 'revision') {
    return {
      kind: 'marker',
      position: change.position,
      revisionId: change.revision.revisionId,
    };
  }
  return {
    kind: 'record',
    position: change.position,
    write: (sql) => applyCatalogRecordChange(sql, generation, change),
  };
}

async function readAccountChanges(
  userCards: UserCardsPublication,
  generation: string,
  accountId: string,
  position: string,
  options: IndexingOptions,
): Promise<readonly PendingChange[]> {
  const page = await userCards.readChanges({
    accountId,
    position,
    pageSize: options.pageSize,
  });
  return page.changes.map((change) => userCardsChange(generation, change));
}

function userCardsChange(generation: string, change: UserCardsChange): PendingChange {
  if (change.kind === 'revision') {
    return { kind: 'marker', position: change.position, revisionId: null };
  }
  return {
    kind: 'record',
    position: change.position,
    write: (sql) => applyUserCardsRecordChange(sql, generation, change),
  };
}

async function writeCatalogPage(
  statements: SearchSqlExecutor,
  generation: string,
  page: CatalogSnapshotPage,
): Promise<void> {
  for (const record of page.records) {
    await writeCatalogRecord(statements, generation, record);
  }
}

async function writeAccountPage(
  statements: SearchSqlExecutor,
  generation: string,
  accountId: string,
  page: UserCardsSnapshotPage,
): Promise<void> {
  for (const record of page.records) {
    await writeUserCardsRecord(statements, generation, accountId, record);
  }
}

async function readGenerationState(sql: SearchSqlTransactor): Promise<GenerationState> {
  const rows = await readRows(
    sql,
    `select generation_id::text as generation_id, state
       from ${searchPrivateSchema}.generation`,
  );
  let published: string | null = null;
  let building: string | null = null;
  for (const row of rows) {
    const parsed = generationRowSchema.safeParse(row);
    if (!parsed.success) {
      throw unreadableProjection();
    }
    if (parsed.data.state === 'published') {
      published = parsed.data.generation_id;
    } else {
      building = parsed.data.generation_id;
    }
  }
  return { published, building };
}

async function createGeneration(sql: SearchSqlTransactor): Promise<string> {
  const rows = await statementsQuery(
    sql,
    `insert into ${searchPrivateSchema}.generation default values
     returning generation_id::text as generation_id`,
  );
  const parsed = z.object({ generation_id: identifierSchema }).safeParse(rows[0]);
  if (!parsed.success) {
    throw unreadableProjection();
  }
  return parsed.data.generation_id;
}

async function discardBuildingGeneration(sql: SearchSqlTransactor): Promise<void> {
  await statementsQuery(
    sql,
    `delete from ${searchPrivateSchema}.generation where state = 'building'`,
  );
}

/** Makes a caught-up replacement generation queryable and retires the generation it replaces. */
async function publishGeneration(sql: SearchSqlTransactor, generation: string): Promise<void> {
  await sql.transaction(async (statements) => {
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.generation
        where state = 'published' and generation_id <> cast(:generation_id as bigint)`,
      { generation_id: generation },
    );
    const rows = await statementsQuery(
      statements,
      `update ${searchPrivateSchema}.generation
          set state = 'published', published_at = now()
        where generation_id = cast(:generation_id as bigint) and state = 'building'
        returning generation_id::text as generation_id`,
      { generation_id: generation },
    );
    if (rows.length !== 1) {
      throw new SearchError('unavailable', 'The replacement generation could not be published.');
    }
  });
}

async function readCatalogCheckpoint(
  sql: SearchSqlExecutor,
  generation: string,
): Promise<ChangeCheckpoint | null> {
  const rows = await readRows(
    sql,
    `select position, revision_id
       from ${searchPrivateSchema}.catalog_checkpoint
      where generation_id = cast(:generation_id as bigint)`,
    { generation_id: generation },
  );
  if (rows.length === 0) {
    return null;
  }
  const parsed = z
    .object({ position: positionSchema, revision_id: revisionSchema })
    .safeParse(rows[0]);
  if (!parsed.success) {
    throw unreadableProjection();
  }
  return { position: parsed.data.position, revisionId: parsed.data.revision_id };
}

async function writeCatalogCheckpoint(
  sql: SearchSqlExecutor,
  generation: string,
  position: string,
  revisionId: string,
): Promise<void> {
  await statementsQuery(
    sql,
    `insert into ${searchPrivateSchema}.catalog_checkpoint (generation_id, position, revision_id)
     values (cast(:generation_id as bigint), :position, :revision_id)
     on conflict (generation_id) do update set
       position = excluded.position,
       revision_id = excluded.revision_id`,
    { generation_id: generation, position, revision_id: revisionId },
  );
}

async function readAccountCheckpoint(
  sql: SearchSqlExecutor,
  generation: string,
  accountId: string,
): Promise<ChangeCheckpoint | null> {
  const rows = await readRows(
    sql,
    `select position
       from ${searchPrivateSchema}.account_checkpoint
      where generation_id = cast(:generation_id as bigint) and account_id = :account_id`,
    { generation_id: generation, account_id: accountId },
  );
  if (rows.length === 0) {
    return null;
  }
  const parsed = z.object({ position: positionSchema }).safeParse(rows[0]);
  if (!parsed.success) {
    throw unreadableProjection();
  }
  return { position: parsed.data.position, revisionId: null };
}

async function writeAccountCheckpoint(
  sql: SearchSqlExecutor,
  generation: string,
  accountId: string,
  position: string,
): Promise<void> {
  await statementsQuery(
    sql,
    `insert into ${searchPrivateSchema}.account_checkpoint (generation_id, account_id, position)
     values (cast(:generation_id as bigint), :account_id, :position)
     on conflict (generation_id, account_id) do update set position = excluded.position`,
    { generation_id: generation, account_id: accountId, position },
  );
}

async function readCheckpointAccounts(
  sql: SearchSqlExecutor,
  generation: string,
): Promise<readonly string[]> {
  const rows = await readRows(
    sql,
    `select account_id
       from ${searchPrivateSchema}.account_checkpoint
      where generation_id = cast(:generation_id as bigint)
      order by account_id`,
    { generation_id: generation },
  );
  return rows.map((row) => {
    const parsed = accountRowSchema.safeParse(row);
    if (!parsed.success) {
      throw unreadableProjection();
    }
    return parsed.data.account_id;
  });
}

async function clearCatalogProjection(
  statements: SearchSqlExecutor,
  generation: string,
): Promise<void> {
  for (const relation of ['card', 'card_name', 'printing'] as const) {
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.${relation}
        where generation_id = cast(:generation_id as bigint)`,
      { generation_id: generation },
    );
  }
}

async function clearAccountProjection(
  statements: SearchSqlExecutor,
  generation: string,
  accountId: string,
): Promise<void> {
  for (const relation of ['copy', 'tag', 'association'] as const) {
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.${relation}
        where generation_id = cast(:generation_id as bigint) and account_id = :account_id`,
      { generation_id: generation, account_id: accountId },
    );
  }
}

/**
 * References the generation cannot resolve to a catalog fact it holds: a printing or name without
 * its card, a copy without its printing or location tag, an association without its tag or target.
 * They are retained rather than dropped, and a nonzero count keeps a replacement from becoming
 * queryable as an apparently complete generation (docs/search.md#internal-design).
 */
async function countUnresolvedReferences(
  sql: SearchSqlExecutor,
  generation: string,
): Promise<number> {
  const projection = searchPrivateSchema;
  const rows = await readRows(
    sql,
    `select (
       (select count(*) from ${projection}.card_name as name
         where name.generation_id = cast(:generation_id as bigint)
           and not exists (select 1 from ${projection}.card as card
                            where card.generation_id = name.generation_id
                              and card.card_id = name.card_id))
     + (select count(*) from ${projection}.printing as printing
         where printing.generation_id = cast(:generation_id as bigint)
           and not exists (select 1 from ${projection}.card as card
                            where card.generation_id = printing.generation_id
                              and card.card_id = printing.card_id))
     + (select count(*) from ${projection}.copy as copy
         where copy.generation_id = cast(:generation_id as bigint)
           and not exists (select 1 from ${projection}.printing as printing
                            where printing.generation_id = copy.generation_id
                              and printing.printing_id = copy.printing_id))
     + (select count(*) from ${projection}.copy as copy
         where copy.generation_id = cast(:generation_id as bigint)
           and copy.location_id is not null
           and not exists (select 1 from ${projection}.tag as tag
                            where tag.generation_id = copy.generation_id
                              and tag.account_id = copy.account_id
                              and tag.tag_id = copy.location_id))
     + (select count(*) from ${projection}.association as association
         where association.generation_id = cast(:generation_id as bigint)
           and (not exists (select 1 from ${projection}.tag as tag
                             where tag.generation_id = association.generation_id
                               and tag.account_id = association.account_id
                               and tag.tag_id = association.tag_id)
             or not ((association.target_level = 'card' and exists (
                        select 1 from ${projection}.card as card
                         where card.generation_id = association.generation_id
                           and card.card_id = association.target_id))
                  or (association.target_level = 'printing' and exists (
                        select 1 from ${projection}.printing as printing
                         where printing.generation_id = association.generation_id
                           and printing.printing_id = association.target_id))
                  or (association.target_level = 'copy' and exists (
                        select 1 from ${projection}.copy as copy
                         where copy.generation_id = association.generation_id
                           and copy.account_id = association.account_id
                           and copy.copy_id = association.target_id)))))
     )::int as unresolved`,
    { generation_id: generation },
  );
  const parsed = z.object({ unresolved: z.number().int().min(0) }).safeParse(rows[0]);
  if (!parsed.success) {
    throw unreadableProjection();
  }
  return parsed.data.unresolved;
}

const identifierSchema = z.string().min(1).max(SEARCH_INDEXING_LIMITS.maxIdentifierLength);
const positionSchema = z.string().min(1).max(SEARCH_INDEXING_LIMITS.maxPositionLength);
const revisionSchema = z.string().min(1).max(SEARCH_INDEXING_LIMITS.maxRevisionLength);

const generationRowSchema = z.object({
  generation_id: identifierSchema,
  state: z.enum(['building', 'published']),
});

const accountRowSchema = z.object({ account_id: identifierSchema });

async function readRows(
  sql: SearchSqlExecutor,
  statement: string,
  parameters: Readonly<Record<string, SearchSqlValue>> = {},
): Promise<readonly SearchSqlRow[]> {
  try {
    return await sql.query(statement, parameters);
  } catch (cause) {
    throw new SearchError('unavailable', 'The search projection could not be read.', { cause });
  }
}

async function statementsQuery(
  sql: SearchSqlExecutor,
  statement: string,
  parameters: Readonly<Record<string, SearchSqlValue>> = {},
): Promise<readonly SearchSqlRow[]> {
  try {
    return await sql.query(statement, parameters);
  } catch (cause) {
    throw new SearchError('unavailable', 'The search projection could not be updated.', { cause });
  }
}

function unreadableProjection(): SearchError {
  return new SearchError(
    'unavailable',
    'The search projection does not match its declared storage contract.',
  );
}

/** Whether a provider refused a position that its retained history no longer carries. */
function isStaleContinuation(cause: unknown): boolean {
  return (
    (cause instanceof CatalogError || cause instanceof UserCardsError) &&
    cause.code === 'stale-continuation'
  );
}

function translateIndexingFailure(cause: unknown): SearchError {
  return cause instanceof SearchError
    ? cause
    : new SearchError('unavailable', 'The search index could not be updated.', { cause });
}
