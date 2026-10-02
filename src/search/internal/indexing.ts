/**
 * Background indexing over the provider publications (docs/search.md#internal-design,
 * docs/data-architecture.md#asynchronous-synchronization).
 *
 * Indexing consumes the Catalog and UserCards publication contracts and maintains Search's own
 * projection; it never joins a provider table and never mutates a provider record. A generation
 * is bootstrapped from consistent snapshots and then caught up through the durable change streams
 * of the sources in its scope. Changes are applied in the order the provider published them,
 * through the earliest resolvable complete publication prefix, and each source checkpoint commits
 * in the same transaction as the rows it describes: a batch that fails leaves the projection and
 * its checkpoint exactly as they were, and repeated delivery of an applied page changes nothing.
 *
 * A replacement generation is built beside the published one and becomes queryable only once
 * every source in its scope is caught up and the projection carries no unresolved reference, so
 * reads continue over the complete previous generation during a rebuild
 * (docs/data-architecture.md#bootstrap-and-rebuild). The generation queries read never keeps a
 * reference it cannot resolve: a publication that would introduce one stays pending at the
 * position the generation already holds, and a later run applies it once the catalog fact it
 * needs has been indexed.
 *
 * An expired change position is never resumed or skipped
 * (docs/data-architecture.md#bootstrap-and-rebuild). A generation that is not queryable is
 * snapshotted again in place, which keeps the checkpoints that carry the account scope of a
 * resumable rebuild; the generation queries read is rebuilt beside itself from fresh snapshots
 * instead. Overlapping runs cannot regress the projection or its checkpoints: every write locks
 * the generation it works on and is rejected when that generation was retired or published under
 * it, and a batch advances a checkpoint only while the checkpoint still holds the position the
 * batch started from (docs/data-architecture.md#asynchronous-synchronization).
 */

import {
  CatalogError,
  type CatalogChange,
  type CatalogRecordChange,
  type CatalogPublication,
} from '../../catalog/index.js';
import {
  UserCardsError,
  type UserCardsChange,
  type UserCardsRecordChange,
  type UserCardsPublication,
} from '../../usercards/index.js';
import { z } from 'zod';

import {
  applyCatalogRecordChanges,
  applyUserCardsRecordChanges,
  writeCatalogRecords,
  writeUserCardsRecords,
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
  /** Batches of complete publications one source applies before the run returns. */
  minBatches: 1,
  defaultBatches: 4,
  maxBatches: 32,
  /** Accounts one request may name; the scope of a rebuild also carries its known accounts. */
  maxRequestedAccounts: 100,
  /** Restarts of a run whose position expired or whose generation another run replaced. */
  maxAttempts: 3,
  /**
   * Pages one batch reads without its resume position advancing before it treats the delivery as
   * stalled. A valid publication advances on every page however many it spans, so this bounds a
   * provider that only repeats a page; it is not a limit on the size of a publication.
   */
  maxStalledPagesPerBatch: 3,
  maxIdentifierLength: 200,
  maxPositionLength: 20,
  maxRevisionLength: 200,
  /** Projection rows one transaction may carry, independently of provider page size. */
  maxBatchRecords: 100,
  /** UTF-8 bytes of encoded provider records one transaction may carry. */
  maxBatchPayloadBytes: 64 * 1024,
} as const;

/** One indexing request as Application receives it. */
export interface SearchIndexingRequest {
  /**
   * Private accounts this run indexes besides the ones it already covers: the accounts the
   * generation holds and the accounts the provider's register reports. An account without a
   * checkpoint is bootstrapped from its consistent snapshot.
   */
  readonly accounts?: readonly string[];
  /** Build a replacement generation from fresh snapshots instead of catching up in place. */
  readonly rebuild?: boolean;
  /** Records one publication page carries, from 1 to {@link SEARCH_INDEXING_LIMITS}.maxPageSize. */
  readonly pageSize?: number;
  /** Batches of complete publications one source applies in this run, from 1 to maxBatches. */
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
  /**
   * Account-scoped publication position the generation applied through. A run that could not
   * apply the account reports the position it already holds, or "0" when the generation holds no
   * checkpoint for it yet.
   */
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
   * a replacement generation from being published as an apparently complete one; a publication
   * that would introduce an unresolved reference into the generation queries read is left pending
   * instead, so it does not appear here.
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
  | {
      readonly kind: 'marker';
      readonly position: string;
      readonly revisionId: string | null;
      readonly write: (sql: SearchSqlExecutor) => Promise<void>;
    }
  | {
      readonly kind: 'record';
      readonly position: string;
      readonly payload: unknown;
    };

interface ChangeCheckpoint {
  readonly position: string;
  readonly revisionId: string | null;
}

interface ChangeSource {
  /** The checkpoint this generation holds for the source, or null when it is not bootstrapped. */
  readCheckpoint(sql: SearchSqlExecutor): Promise<ChangeCheckpoint | null>;
  /** Resumes bounded snapshot batches and writes the checkpoint only at the complete boundary. */
  writeSnapshot(
    sql: SearchSqlTransactor,
    budget: RunBudget,
  ): Promise<(ChangeCheckpoint & { readonly complete: boolean }) | null>;
  /** Clears only the source state this run observed; a concurrent boundary wins. */
  discardSnapshot(
    sql: SearchSqlTransactor,
    budget: RunBudget,
    expectedCheckpoint: ChangeCheckpoint | null,
    expectedProgress: SnapshotProgress | null,
  ): Promise<void>;
  /** Reads the changes the provider published after a position. */
  read(position: string): Promise<readonly PendingChange[]>;
  writeRecords(
    sql: SearchSqlExecutor,
    changes: readonly Extract<PendingChange, { readonly kind: 'record' }>[],
  ): Promise<void>;
  /** Advances the checkpoint a completed publication ends at, guarded by the position it held. */
  advance(
    statements: SearchSqlExecutor,
    applied: ChangeCheckpoint,
    start: ChangeCheckpoint | null,
  ): Promise<void>;
}

interface RunBudget {
  remaining: number;
}

interface SnapshotProgress {
  readonly continuation: string | null;
  readonly recordOffset: number;
  readonly pageSize: number | null;
  readonly position: string;
  readonly revisionId: string | null;
}

interface GenerationState {
  readonly published: string | null;
  readonly building: string | null;
}

/**
 * The generation one run writes to: the queryable one, or a replacement being built beside it. A
 * run that writes to the queryable generation never weakens it: a publication it cannot resolve
 * stays pending and a checkpoint it does not own stays put.
 */
interface GenerationTarget {
  readonly generation: string;
  readonly queryable: boolean;
  /**
   * The generation that was queryable when this run read the state, which is the one a replacement
   * is built to succeed. A run whose scope was drawn from a generation another run has already
   * replaced must not publish over it.
   */
  readonly replaces: string | null;
  /** Served checkpoints captured before scope and source reads; publication rechecks them. */
  readonly replacedCheckpoints: string | null;
}

/** Why a write transaction rolled back instead of applying. */
type AbandonedReason = 'stale-checkpoint' | 'obsolete-generation' | 'unresolved-references';

/**
 * Signals that a write transaction rolled back because the work it carried is no longer current:
 * another run moved the checkpoint or generation it started from, or the publication it would
 * apply cannot be resolved yet. The caller decides whether to resume, restart or report it.
 */
class AbandonedWrite extends Error {
  readonly reason: AbandonedReason;

  constructor(reason: AbandonedReason, message: string) {
    super(message);
    this.name = 'AbandonedWrite';
    this.reason = reason;
  }
}

class StagingRequired extends Error {
  constructor() {
    super('The publication exceeds one bounded indexing transaction.');
    this.name = 'StagingRequired';
  }
}

/** The exact staged snapshot boundary that became stale while it was being read. */
class StaleSnapshot extends Error {
  readonly progress: SnapshotProgress | null;

  constructor(progress: SnapshotProgress | null, options?: ErrorOptions) {
    super('The staged provider snapshot became stale.', options);
    this.name = 'StaleSnapshot';
    this.progress = progress;
  }
}

function isAbandoned(cause: unknown, reason: AbandonedReason): boolean {
  return cause instanceof AbandonedWrite && cause.reason === reason;
}

/** Whether a failed run can start over: its position expired or its generation moved on. */
function isRestartable(cause: unknown): boolean {
  return isStaleContinuation(cause) || isAbandoned(cause, 'obsolete-generation');
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
    typeof userCards.readChanges !== 'function' ||
    typeof userCards.readAccounts !== 'function'
  ) {
    throw new TypeError('createSearchIndexer requires the UserCards publication contract.');
  }
  const projection: SearchSqlTransactor = sql;
  const catalogPublication: CatalogPublication = catalog;
  const userCardsPublication: UserCardsPublication = userCards;

  /** One pass over the generation's sources; an expired position escapes to the retry loop. */
  async function indexGeneration(
    options: IndexingOptions,
    rebuild: boolean,
  ): Promise<SearchIndexingResult> {
    const state = await readGenerationState(projection);
    const startBuild = state.building === null && (state.published === null || rebuild);
    const started = startBuild ? await createGeneration(projection) : null;
    if (startBuild && started === null) {
      // Another run opened the replacement generation first: take that one up on the next attempt.
      throw new AbandonedWrite(
        'obsolete-generation',
        'Another run started the replacement generation first.',
      );
    }
    const generation = started ?? state.building ?? state.published;
    if (generation === null) {
      throw new SearchError('unavailable', 'The search projection could not be opened.');
    }
    const target: GenerationTarget = {
      generation,
      queryable: started === null && state.building === null,
      replaces: state.published,
      replacedCheckpoints:
        state.published === null || (started === null && state.building === null)
          ? null
          : await readGenerationCheckpoints(projection, state.published),
    };
    const accounts = await indexingScope(
      projection,
      userCardsPublication,
      target,
      state.published,
      options,
    );

    const catalogProgress = await alignCatalog(projection, catalogPublication, target, options, {
      remaining: options.maxBatches,
    });
    const accountProgress: SearchAccountProgress[] = [];
    for (const accountId of accounts) {
      accountProgress.push(
        await alignAccount(projection, userCardsPublication, target, accountId, options, {
          remaining: options.maxBatches,
        }),
      );
    }
    const unresolvedReferences = await countUnresolvedReferences(projection, generation);
    if (!target.queryable) {
      const refreshedAccounts = await indexingScope(
        projection,
        userCardsPublication,
        target,
        state.published,
        options,
      );
      if (
        refreshedAccounts.length !== accounts.length ||
        refreshedAccounts.some((account, index) => account !== accounts[index])
      ) {
        throw new AbandonedWrite(
          'obsolete-generation',
          'The replacement account scope changed while it was being built.',
        );
      }
    }
    const caughtUp =
      catalogProgress.caughtUp && accountProgress.every((progress) => progress.caughtUp);
    const publish = !target.queryable && caughtUp && unresolvedReferences === 0;
    return {
      generation,
      published:
        target.queryable ||
        (publish &&
          (await publishGeneration(
            projection,
            target,
            accounts,
            catalogProgress,
            accountProgress,
          ))),
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
          if (cause instanceof StagingRequired && attempt < SEARCH_INDEXING_LIMITS.maxAttempts) {
            rebuild = true;
            continue;
          }
          if (!isRestartable(cause) || attempt >= SEARCH_INDEXING_LIMITS.maxAttempts) {
            throw translateIndexingFailure(cause);
          }
          // An expired position requires a new snapshot, never a skipped region, and a generation
          // retired under this run requires the one that replaced it
          // (docs/data-architecture.md#bootstrap-and-rebuild). Both are taken up on the next
          // attempt: a serving generation is replaced from fresh snapshots beside itself, while a
          // generation that is not queryable is snapshotted again in place.
          if (isStaleContinuation(cause)) {
            rebuild = true;
          }
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

/**
 * The accounts one run covers. Every pass includes the accounts the generation already holds —
 * their published changes are what the run exists to apply — the accounts this request names, and
 * the accounts the provider's register reports, so a routine run without operator input catches up
 * accounts that saved after an earlier pass and accounts that published for the first time
 * (docs/data-architecture.md#asynchronous-synchronization). A generation that is not queryable
 * also carries the accounts the serving generation knows, because a replaced generation is
 * recovered in place or rebuilt only after being published: that scope survives both an expired
 * position and a restart (docs/data-architecture.md#bootstrap-and-rebuild).
 */
async function indexingScope(
  sql: SearchSqlTransactor,
  userCards: UserCardsPublication,
  target: GenerationTarget,
  published: string | null,
  options: IndexingOptions,
): Promise<readonly string[]> {
  const known = await readCheckpointAccounts(sql, target.generation);
  const carried =
    target.queryable || published === null ? [] : await readCheckpointAccounts(sql, published);
  return uniqueAccounts([
    ...carried,
    ...known,
    ...(await readPublishedAccounts(userCards, options)),
    ...options.accounts,
  ]);
}

/**
 * The accounts the provider's register reports as holding published private data, read page by
 * page until the register ends. The register is provider state: it names identities only, so the
 * run learns which accounts to cover without reading private tables and without an operator
 * listing them.
 */
async function readPublishedAccounts(
  userCards: UserCardsPublication,
  options: IndexingOptions,
): Promise<readonly string[]> {
  const accounts: string[] = [];
  let continuation: string | null = null;
  for (;;) {
    const page = await userCards.readAccounts({
      pageSize: options.pageSize,
      ...(continuation === null ? {} : { continuation }),
    });
    accounts.push(...page.accounts);
    if (page.continuation === null) {
      return accounts;
    }
    continuation = page.continuation;
  }
}

async function alignCatalog(
  sql: SearchSqlTransactor,
  catalog: CatalogPublication,
  target: GenerationTarget,
  options: IndexingOptions,
  budget: RunBudget,
): Promise<SearchCatalogProgress> {
  const source: ChangeSource = {
    readCheckpoint: (statements) => readCatalogCheckpoint(statements, target.generation),
    writeSnapshot: (projection, runBudget) =>
      writeCatalogSnapshot(catalog, projection, target, options, runBudget),
    discardSnapshot: (projection, runBudget, expectedCheckpoint, expectedProgress) =>
      discardCatalogSnapshot(projection, target, runBudget, expectedCheckpoint, expectedProgress),
    read: (position) => readCatalogChanges(catalog, target.generation, position, options),
    writeRecords: (statements, changes) =>
      applyCatalogRecordChanges(
        statements,
        target.generation,
        changes.map((change) => change.payload as CatalogChange) as CatalogRecordChange[],
      ),
    advance: (statements, applied, start) =>
      advanceCatalogCheckpoint(statements, target.generation, applied, start),
  };
  const aligned = await alignSource(sql, target, source, budget);
  if (aligned.revisionId === null) {
    throw unreadableProjection();
  }
  return {
    position: aligned.position,
    revisionId: aligned.revisionId,
    caughtUp: aligned.caughtUp,
  };
}

async function alignAccount(
  sql: SearchSqlTransactor,
  userCards: UserCardsPublication,
  target: GenerationTarget,
  accountId: string,
  options: IndexingOptions,
  budget: RunBudget,
): Promise<SearchAccountProgress> {
  const source: ChangeSource = {
    readCheckpoint: (statements) => readAccountCheckpoint(statements, target.generation, accountId),
    writeSnapshot: (projection, runBudget) =>
      writeAccountSnapshot(userCards, projection, target, accountId, options, runBudget),
    discardSnapshot: (projection, runBudget, expectedCheckpoint, expectedProgress) =>
      discardAccountSnapshot(
        projection,
        target,
        accountId,
        runBudget,
        expectedCheckpoint,
        expectedProgress,
      ),
    read: (position) =>
      readAccountChanges(userCards, target.generation, accountId, position, options),
    writeRecords: (statements, changes) =>
      applyUserCardsRecordChanges(
        statements,
        target.generation,
        accountId,
        changes.map((change) => change.payload as UserCardsChange) as UserCardsRecordChange[],
      ),
    advance: (statements, applied, start) =>
      advanceAccountCheckpoint(statements, target.generation, accountId, applied, start),
  };
  const aligned = await alignSource(sql, target, source, budget);
  return {
    accountId,
    position: aligned.position,
    caughtUp: aligned.caughtUp,
  };
}

/**
 * Aligns one source with the run's generation: resume from the checkpoint the generation holds,
 * or bootstrap the source from its provider's consistent snapshot, and then apply its complete
 * publications up to the run's budget.
 *
 * An expired position requires a fresh snapshot rather than a skipped region
 * (docs/data-architecture.md#bootstrap-and-rebuild). A generation that is not queryable is
 * snapshotted again in place — the generation, and with it the checkpoints that carry the account
 * scope of a resumable rebuild, survives — while an expired position of the queryable generation
 * escapes to the run, which rebuilds beside it. A publication the run cannot resolve yet keeps
 * the position and state the generation already holds.
 */
async function alignSource(
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  source: ChangeSource,
  budget: RunBudget,
): Promise<ChangeCheckpoint & { readonly caughtUp: boolean }> {
  for (let attempt = 1; ; attempt += 1) {
    let observedCheckpoint: ChangeCheckpoint | null = null;
    try {
      const existing = await source.readCheckpoint(sql);
      observedCheckpoint = existing;
      const bootstrap = existing === null ? await bootstrapSource(sql, source, budget) : null;
      const checkpoint = existing ?? bootstrap;
      if (checkpoint === null) {
        throw unreadableProjection();
      }
      if ('complete' in checkpoint && !checkpoint.complete) {
        return { ...checkpoint, caughtUp: false };
      }
      observedCheckpoint = checkpoint;
      return await drainSource(sql, target, source, checkpoint, budget);
    } catch (cause) {
      if (cause instanceof StagingRequired && !target.queryable) {
        try {
          await source.discardSnapshot(sql, budget, observedCheckpoint, null);
        } catch (discardCause) {
          if (isAbandoned(discardCause, 'stale-checkpoint')) continue;
          throw discardCause;
        }
        continue;
      }
      if (isAbandoned(cause, 'unresolved-references')) {
        // The change stream published something this generation cannot resolve yet. Nothing was
        // applied: the usable previous state and its position stand until the reference resolves
        // (docs/search.md#internal-design).
        const held = await source.readCheckpoint(sql);
        return {
          position: held?.position ?? unindexedPosition,
          revisionId: held?.revisionId ?? null,
          caughtUp: false,
        };
      }
      if (attempt >= SEARCH_INDEXING_LIMITS.maxAttempts) {
        throw cause;
      }
      if (isStaleContinuation(cause) && !target.queryable) {
        try {
          await source.discardSnapshot(sql, budget, observedCheckpoint, null);
        } catch (discardCause) {
          if (isAbandoned(discardCause, 'stale-checkpoint')) continue;
          throw discardCause;
        }
        await bootstrapSource(sql, source, budget);
        continue;
      }
      if (isAbandoned(cause, 'stale-checkpoint')) {
        // Another run advanced this checkpoint while this one was reading: resume from the
        // position that run applied.
        continue;
      }
      throw cause;
    }
  }
}

/**
 * Bootstraps one source from its consistent snapshot in durable bounded batches. A snapshot page
 * the provider published a new revision over is obsolete, so its incomplete projection and resume
 * state are discarded before starting from the first page again.
 */
async function bootstrapSource(
  sql: SearchSqlTransactor,
  source: ChangeSource,
  budget: RunBudget,
): Promise<(ChangeCheckpoint & { readonly complete: boolean }) | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await source.writeSnapshot(sql, budget);
    } catch (cause) {
      if (!(cause instanceof StaleSnapshot) || attempt >= SEARCH_INDEXING_LIMITS.maxAttempts) {
        throw cause;
      }
      await source.discardSnapshot(sql, budget, null, cause.progress);
    }
  }
}

async function writeCatalogSnapshot(
  catalog: CatalogPublication,
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  options: IndexingOptions,
  budget: RunBudget,
): Promise<ChangeCheckpoint & { readonly complete: boolean }> {
  const generation = target.generation;
  for (;;) {
    const progress = await readSnapshotProgress(sql, generation, 'catalog', '');
    if (budget.remaining === 0 && progress !== null) {
      return { position: progress.position, revisionId: progress.revisionId, complete: false };
    }
    if (progress !== null && progress.recordOffset > 0 && progress.pageSize === null) {
      throw new StaleSnapshot(progress);
    }
    const pageSize =
      progress !== null && progress.recordOffset > 0
        ? (progress.pageSize ?? options.pageSize)
        : options.pageSize;
    const page = await catalog
      .readSnapshot({
        pageSize,
        ...(progress?.continuation === null || progress === null
          ? {}
          : { continuation: progress.continuation }),
      })
      .catch((cause: unknown) => {
        if (isStaleContinuation(cause)) throw new StaleSnapshot(progress, { cause });
        throw cause;
      });
    const checkpoint = { position: page.position, revisionId: page.revision.revisionId };
    assertSnapshotBoundary(progress, checkpoint);
    if (budget.remaining === 0) return { ...checkpoint, complete: false };
    const slice = boundedRecords(page.records, progress?.recordOffset ?? 0);
    if (target.queryable && (!slice.pageComplete || page.continuation !== null)) {
      throw new StagingRequired();
    }
    await writeTransaction(sql, target, async (statements) => {
      await assertSnapshotProgress(statements, generation, 'catalog', '', progress);
      await assertCheckpoint(await readCatalogCheckpoint(statements, generation), null);
      if (progress === null) await clearCatalogProjection(statements, generation);
      await writeCatalogRecords(statements, generation, slice.records);
      if (!slice.pageComplete) {
        await saveSnapshotProgress(statements, generation, 'catalog', '', {
          continuation: progress?.continuation ?? null,
          recordOffset: slice.nextOffset,
          pageSize,
          position: checkpoint.position,
          revisionId: checkpoint.revisionId,
        });
        return;
      }
      if (page.continuation !== null) {
        await saveSnapshotProgress(statements, generation, 'catalog', '', {
          continuation: page.continuation,
          recordOffset: 0,
          pageSize: null,
          position: checkpoint.position,
          revisionId: checkpoint.revisionId,
        });
        return;
      }
      for (const revision of new Set([checkpoint.revisionId, ...page.incorporatedRevisions])) {
        await recordCatalogProgress(statements, generation, revision);
      }
      if (target.queryable) await assertResolved(statements, generation);
      await advanceCatalogCheckpoint(statements, generation, checkpoint, null);
      await deleteSnapshotProgress(statements, generation, 'catalog', '');
    });
    budget.remaining -= 1;
    if (slice.pageComplete && page.continuation === null) {
      return { ...checkpoint, complete: true };
    }
  }
}

async function writeAccountSnapshot(
  userCards: UserCardsPublication,
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  accountId: string,
  options: IndexingOptions,
  budget: RunBudget,
): Promise<ChangeCheckpoint & { readonly complete: boolean }> {
  const generation = target.generation;
  for (;;) {
    const progress = await readSnapshotProgress(sql, generation, 'account', accountId);
    if (budget.remaining === 0 && progress !== null) {
      return { position: progress.position, revisionId: null, complete: false };
    }
    if (progress !== null && progress.recordOffset > 0 && progress.pageSize === null) {
      throw new StaleSnapshot(progress);
    }
    const pageSize =
      progress !== null && progress.recordOffset > 0
        ? (progress.pageSize ?? options.pageSize)
        : options.pageSize;
    const page = await userCards
      .readSnapshot({
        accountId,
        pageSize,
        ...(progress?.continuation === null || progress === null
          ? {}
          : { continuation: progress.continuation }),
      })
      .catch((cause: unknown) => {
        if (isStaleContinuation(cause)) throw new StaleSnapshot(progress, { cause });
        throw cause;
      });
    const checkpoint = { position: page.position, revisionId: null };
    assertSnapshotBoundary(progress, checkpoint);
    if (budget.remaining === 0) return { ...checkpoint, complete: false };
    const slice = boundedRecords(page.records, progress?.recordOffset ?? 0);
    if (target.queryable && (!slice.pageComplete || page.continuation !== null)) {
      throw new StagingRequired();
    }
    await writeTransaction(sql, target, async (statements) => {
      await assertSnapshotProgress(statements, generation, 'account', accountId, progress);
      await assertCheckpoint(await readAccountCheckpoint(statements, generation, accountId), null);
      if (progress === null) await clearAccountProjection(statements, generation, accountId);
      await writeUserCardsRecords(statements, generation, accountId, slice.records);
      if (!slice.pageComplete) {
        await saveSnapshotProgress(statements, generation, 'account', accountId, {
          continuation: progress?.continuation ?? null,
          recordOffset: slice.nextOffset,
          pageSize,
          position: checkpoint.position,
          revisionId: null,
        });
        return;
      }
      if (page.continuation !== null) {
        await saveSnapshotProgress(statements, generation, 'account', accountId, {
          continuation: page.continuation,
          recordOffset: 0,
          pageSize: null,
          position: checkpoint.position,
          revisionId: null,
        });
        return;
      }
      for (const position of new Set([checkpoint.position, ...page.incorporatedPositions])) {
        await recordAccountProgress(statements, generation, accountId, position);
      }
      if (target.queryable) await assertResolved(statements, generation);
      await advanceAccountCheckpoint(statements, generation, accountId, checkpoint, null);
      await deleteSnapshotProgress(statements, generation, 'account', accountId);
    });
    budget.remaining -= 1;
    if (slice.pageComplete && page.continuation === null) {
      return { ...checkpoint, complete: true };
    }
  }
}

function boundedRecords<T>(
  records: readonly T[],
  offset: number,
): { readonly records: readonly T[]; readonly nextOffset: number; readonly pageComplete: boolean } {
  if (offset > records.length) throw unreadableProjection();
  const selected: T[] = [];
  let bytes = 2;
  for (let index = offset; index < records.length; index += 1) {
    const record = records[index] as T;
    const recordBytes = new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
    if (recordBytes > SEARCH_INDEXING_LIMITS.maxBatchPayloadBytes) {
      throw new SearchError(
        'unavailable',
        'A published record exceeds the Search indexing payload bound.',
      );
    }
    if (
      selected.length >= SEARCH_INDEXING_LIMITS.maxBatchRecords ||
      bytes + recordBytes > SEARCH_INDEXING_LIMITS.maxBatchPayloadBytes
    ) {
      break;
    }
    selected.push(record);
    bytes += recordBytes;
  }
  const nextOffset = offset + selected.length;
  return { records: selected, nextOffset, pageComplete: nextOffset === records.length };
}

function assertSnapshotBoundary(
  progress: SnapshotProgress | null,
  checkpoint: ChangeCheckpoint,
): void {
  if (
    progress !== null &&
    (progress.position !== checkpoint.position || progress.revisionId !== checkpoint.revisionId)
  ) {
    throw new StaleSnapshot(progress);
  }
}

async function readSnapshotProgress(
  sql: SearchSqlExecutor,
  generation: string,
  source: 'catalog' | 'account',
  accountId: string,
): Promise<SnapshotProgress | null> {
  const rows = await readRows(
    sql,
    `select continuation, record_offset, page_size, source_position, revision_id
       from ${searchPrivateSchema}.snapshot_progress
      where generation_id = cast(:generation_id as bigint)
        and source = :source and account_id = :account_id`,
    { generation_id: generation, source, account_id: accountId },
  );
  if (rows.length === 0) return null;
  const parsed = z
    .object({
      continuation: z.string().nullable(),
      record_offset: z.number().int().min(0),
      page_size: z
        .number()
        .int()
        .min(SEARCH_INDEXING_LIMITS.minPageSize)
        .max(SEARCH_INDEXING_LIMITS.maxPageSize)
        .nullable(),
      source_position: positionSchema,
      revision_id: revisionSchema.nullable(),
    })
    .safeParse(rows[0]);
  if (!parsed.success) throw unreadableProjection();
  return {
    continuation: parsed.data.continuation,
    recordOffset: parsed.data.record_offset,
    pageSize: parsed.data.page_size,
    position: parsed.data.source_position,
    revisionId: parsed.data.revision_id,
  };
}

function assertCheckpoint(
  actual: ChangeCheckpoint | null,
  expected: ChangeCheckpoint | null,
): void {
  if (!sameCheckpoint(actual, expected)) {
    throw new AbandonedWrite(
      'stale-checkpoint',
      'Another run advanced this source boundary; this write is obsolete.',
    );
  }
}

function sameCheckpoint(
  actual: ChangeCheckpoint | null,
  expected: ChangeCheckpoint | null,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function assertSnapshotProgress(
  sql: SearchSqlExecutor,
  generation: string,
  source: 'catalog' | 'account',
  accountId: string,
  expected: SnapshotProgress | null,
): Promise<void> {
  const actual = await readSnapshotProgress(sql, generation, source, accountId);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new AbandonedWrite(
      'stale-checkpoint',
      'Another run advanced this snapshot staging progress.',
    );
  }
}

async function saveSnapshotProgress(
  sql: SearchSqlExecutor,
  generation: string,
  source: 'catalog' | 'account',
  accountId: string,
  progress: SnapshotProgress,
): Promise<void> {
  await statementsQuery(
    sql,
    `insert into ${searchPrivateSchema}.snapshot_progress (
       generation_id, source, account_id, continuation, record_offset, page_size,
       source_position, revision_id
     ) values (
       cast(:generation_id as bigint), :source, :account_id, :continuation,
       :record_offset, :page_size, :source_position, :revision_id
     )
     on conflict (generation_id, source, account_id) do update set
       continuation = excluded.continuation, record_offset = excluded.record_offset,
       page_size = excluded.page_size,
       source_position = excluded.source_position, revision_id = excluded.revision_id`,
    {
      generation_id: generation,
      source,
      account_id: accountId,
      continuation: progress.continuation,
      record_offset: progress.recordOffset,
      page_size: progress.pageSize,
      source_position: progress.position,
      revision_id: progress.revisionId,
    },
  );
}

async function deleteSnapshotProgress(
  sql: SearchSqlExecutor,
  generation: string,
  source: 'catalog' | 'account',
  accountId: string,
): Promise<void> {
  await statementsQuery(
    sql,
    `delete from ${searchPrivateSchema}.snapshot_progress
      where generation_id = cast(:generation_id as bigint)
        and source = :source and account_id = :account_id`,
    { generation_id: generation, source, account_id: accountId },
  );
}

async function discardCatalogSnapshot(
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  budget: RunBudget,
  expectedCheckpoint: ChangeCheckpoint | null,
  expectedProgress: SnapshotProgress | null,
): Promise<void> {
  if (budget.remaining === 0)
    throw new SearchError('unavailable', 'The indexing run budget ended.');
  await writeTransaction(sql, target, async (statements) => {
    await assertCheckpoint(
      await readCatalogCheckpoint(statements, target.generation),
      expectedCheckpoint,
    );
    await assertSnapshotProgress(statements, target.generation, 'catalog', '', expectedProgress);
    await clearCatalogProjection(statements, target.generation);
    await deleteSnapshotProgress(statements, target.generation, 'catalog', '');
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.catalog_checkpoint
        where generation_id = cast(:generation_id as bigint)`,
      { generation_id: target.generation },
    );
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.catalog_progress
        where generation_id = cast(:generation_id as bigint)`,
      { generation_id: target.generation },
    );
  });
  budget.remaining -= 1;
}

async function discardAccountSnapshot(
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  accountId: string,
  budget: RunBudget,
  expectedCheckpoint: ChangeCheckpoint | null,
  expectedProgress: SnapshotProgress | null,
): Promise<void> {
  if (budget.remaining === 0)
    throw new SearchError('unavailable', 'The indexing run budget ended.');
  await writeTransaction(sql, target, async (statements) => {
    await assertCheckpoint(
      await readAccountCheckpoint(statements, target.generation, accountId),
      expectedCheckpoint,
    );
    await assertSnapshotProgress(
      statements,
      target.generation,
      'account',
      accountId,
      expectedProgress,
    );
    await clearAccountProjection(statements, target.generation, accountId);
    await deleteSnapshotProgress(statements, target.generation, 'account', accountId);
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.account_checkpoint
        where generation_id = cast(:generation_id as bigint) and account_id = :account_id`,
      { generation_id: target.generation, account_id: accountId },
    );
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.account_progress
        where generation_id = cast(:generation_id as bigint) and account_id = :account_id`,
      { generation_id: target.generation, account_id: accountId },
    );
  });
  budget.remaining -= 1;
}

/**
 * Applies complete publications from one source until its stream ends or the run's batch budget is
 * spent. A batch commits the rows of every publication it covers together with the checkpoint of
 * the last change it applied, so a restart never observes half a publication.
 */
async function drainSource(
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  source: ChangeSource,
  start: ChangeCheckpoint,
  budget: RunBudget,
): Promise<ChangeCheckpoint & { readonly caughtUp: boolean }> {
  let checkpoint = start;
  while (budget.remaining > 0) {
    const applied = await applyChangeBatch(sql, target, source, checkpoint);
    if (!applied.exhausted) budget.remaining -= 1;
    checkpoint = { position: applied.position, revisionId: applied.revisionId };
    if (applied.exhausted) {
      return { ...checkpoint, caughtUp: true };
    }
  }
  return { ...checkpoint, caughtUp: false };
}

async function applyChangeBatch(
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  source: ChangeSource,
  start: ChangeCheckpoint,
): Promise<ChangeCheckpoint & { readonly exhausted: boolean }> {
  // Assemble only one complete publication before taking the writer lock. If it cannot fit one
  // bounded transaction, the caller switches to a replacement snapshot instead of holding an
  // unbounded transaction or exposing a partial atomic publication.
  let position = start.position;
  let stalled = 0;
  type RecordChange = Extract<PendingChange, { readonly kind: 'record' }>;
  type MarkerChange = Extract<PendingChange, { readonly kind: 'marker' }>;
  const publications: {
    readonly records: readonly RecordChange[];
    readonly marker: MarkerChange;
  }[] = [];
  let records: RecordChange[] = [];
  let recordCount = 0;
  let bytes = 2;
  let truncated = false;
  const seenChanges = new Map<string, string>();
  publicationRead: for (;;) {
    const changes = await source.read(position);
    if (changes.length === 0) {
      if (records.length === 0 && publications.length === 0) return { ...start, exhausted: true };
      if (publications.length > 0) break;
      throw new SearchError(
        'unavailable',
        'A publication ended without its completion marker; the projection was not advanced.',
      );
    }
    const resumedAt = position;
    for (const change of changes) {
      position = change.position;
      const fingerprint =
        change.kind === 'marker'
          ? `marker:${change.revisionId ?? ''}`
          : `record:${JSON.stringify(change.payload)}`;
      const seen = seenChanges.get(change.position);
      if (seen !== undefined) {
        if (seen !== fingerprint) {
          throw new SearchError(
            'unavailable',
            'The provider changed the meaning of a repeated publication identity.',
          );
        }
        continue;
      }
      seenChanges.set(change.position, fingerprint);
      if (change.kind === 'marker') {
        publications.push({ records, marker: change });
        records = [];
        continue;
      }
      const changeBytes = new TextEncoder().encode(JSON.stringify(change.payload)).byteLength + 1;
      if (
        changeBytes > SEARCH_INDEXING_LIMITS.maxBatchPayloadBytes ||
        recordCount >= SEARCH_INDEXING_LIMITS.maxBatchRecords ||
        bytes + changeBytes > SEARCH_INDEXING_LIMITS.maxBatchPayloadBytes
      ) {
        if (publications.length > 0) {
          truncated = true;
          break publicationRead;
        }
        throw new StagingRequired();
      }
      records.push(change);
      recordCount += 1;
      bytes += changeBytes;
    }
    stalled = position === resumedAt ? stalled + 1 : 0;
    if (stalled > SEARCH_INDEXING_LIMITS.maxStalledPagesPerBatch) {
      throw new SearchError(
        'unavailable',
        'The provider repeated a change page without publishing the completion of its change.',
      );
    }
  }

  return await writeTransaction(sql, target, async (statements) => {
    for (const publication of publications) {
      await source.writeRecords(statements, publication.records);
      await publication.marker.write(statements);
      const checkpoint = {
        position: publication.marker.position,
        revisionId: publication.marker.revisionId ?? start.revisionId,
      };
      if (
        !target.queryable ||
        (await countUnresolvedReferences(statements, target.generation)) === 0
      ) {
        await source.advance(statements, checkpoint, start);
        return { ...checkpoint, exhausted: false };
      }
    }
    if (truncated) throw new StagingRequired();
    throw new AbandonedWrite(
      'unresolved-references',
      'A publication references a catalog fact the projection does not hold yet.',
    );
  });
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
      write: (sql) => recordCatalogProgress(sql, generation, change.revision.revisionId),
    };
  }
  return {
    kind: 'record',
    position: change.position,
    payload: change,
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
    return {
      kind: 'marker',
      position: change.position,
      revisionId: null,
      write: (sql) => recordAccountProgress(sql, generation, change.accountId, change.position),
    };
  }
  return {
    kind: 'record',
    position: change.position,
    payload: change,
  };
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

/**
 * Opens a replacement generation, or reports that another run opened one first: the building
 * generation is unique, so a lost race is the caller's cue to take up the winner's generation.
 */
async function createGeneration(sql: SearchSqlTransactor): Promise<string | null> {
  const rows = await statementsQuery(
    sql,
    `insert into ${searchPrivateSchema}.generation default values
     on conflict (state) where state = 'building' do nothing
     returning generation_id::text as generation_id`,
  );
  if (rows.length === 0) {
    return null;
  }
  const parsed = z.object({ generation_id: identifierSchema }).safeParse(rows[0]);
  if (!parsed.success) {
    throw unreadableProjection();
  }
  return parsed.data.generation_id;
}

/**
 * Writes one transaction over the run's generation. The generation is locked for the duration, so
 * reference validation remains true through commit, including across independent sources. The
 * same lock fences retirement/publication, and rejects a generation whose state already changed.
 */
async function writeTransaction<T>(
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  work: (statements: SearchSqlExecutor) => Promise<T>,
): Promise<T> {
  return await sql.transaction(async (statements) => {
    await lockGeneration(statements, target);
    return await work(statements);
  });
}

async function lockGeneration(sql: SearchSqlExecutor, target: GenerationTarget): Promise<void> {
  const rows = await statementsQuery(
    sql,
    `select generation_id::text as generation_id
       from ${searchPrivateSchema}.generation
      where generation_id = cast(:generation_id as bigint)
        and state = :state
        for update`,
    { generation_id: target.generation, state: target.queryable ? 'published' : 'building' },
  );
  if (rows.length !== 1) {
    throw new AbandonedWrite(
      'obsolete-generation',
      'The generation this run was writing to is no longer current.',
    );
  }
}

/**
 * Makes a caught-up replacement generation queryable and retires the generation it replaces. Both
 * generations are locked, so a concurrent batch either finished before this validation or waits
 * for the publication: a generation is never published with a reference it cannot resolve, and a
 * run never publishes a generation built for a scope another run already replaced.
 */
async function publishGeneration(
  sql: SearchSqlTransactor,
  target: GenerationTarget,
  accounts: readonly string[],
  catalogProgress: SearchCatalogProgress,
  accountProgress: readonly SearchAccountProgress[],
): Promise<boolean> {
  return await sql.transaction(async (statements) => {
    await lockGeneration(statements, target);
    const published = await statementsQuery(
      statements,
      `select generation_id::text as generation_id
         from ${searchPrivateSchema}.generation
        where state = 'published'
          for update`,
    );
    let served: string | null = null;
    if (published.length === 1) {
      const parsed = z.object({ generation_id: identifierSchema }).safeParse(published[0]);
      if (!parsed.success) {
        throw unreadableProjection();
      }
      served = parsed.data.generation_id;
    }
    if (served !== target.replaces) {
      throw new AbandonedWrite(
        'obsolete-generation',
        'The generation this replacement was built for was replaced.',
      );
    }
    // Positions are provider-owned opaque values. Equality with the state captured before
    // catch-up is sufficient: if any served progress or account scope changed, retry source
    // alignment and scope discovery before replacing it. Both generation locks remain held
    // through commit, so a served write cannot pass this fence afterwards.
    if (
      served !== null &&
      (await readGenerationCheckpoints(statements, served)) !== target.replacedCheckpoints
    ) {
      throw new AbandonedWrite(
        'obsolete-generation',
        'The served projection advanced while its replacement was catching up.',
      );
    }
    if (
      !sameCheckpoint(await readCatalogCheckpoint(statements, target.generation), {
        position: catalogProgress.position,
        revisionId: catalogProgress.revisionId,
      })
    ) {
      throw new AbandonedWrite(
        'obsolete-generation',
        'The replacement catalog boundary changed before publication.',
      );
    }
    const indexedAccounts = await readCheckpointAccounts(statements, target.generation);
    const scopedAccounts = new Set(accounts);
    if (
      indexedAccounts.length !== accounts.length ||
      indexedAccounts.some((account) => !scopedAccounts.has(account))
    ) {
      throw new AbandonedWrite(
        'obsolete-generation',
        'The replacement gained an account outside this run’s catch-up scope.',
      );
    }
    for (const progress of accountProgress) {
      if (
        !sameCheckpoint(
          await readAccountCheckpoint(statements, target.generation, progress.accountId),
          { position: progress.position, revisionId: null },
        )
      ) {
        throw new AbandonedWrite(
          'obsolete-generation',
          'A replacement account boundary changed before publication.',
        );
      }
    }
    const staging = await readRows(
      statements,
      `select source, account_id
         from ${searchPrivateSchema}.snapshot_progress
        where generation_id = cast(:generation_id as bigint)
        limit 1`,
      { generation_id: target.generation },
    );
    if (staging.length !== 0) {
      throw new AbandonedWrite(
        'obsolete-generation',
        'The replacement still has incomplete snapshot staging.',
      );
    }
    if ((await countUnresolvedReferences(statements, target.generation)) !== 0) {
      return false;
    }
    // A complete replacement includes the previously served publications. Carry their exact
    // identities before retiring the old generation, including evidence beyond source retention.
    for (const [table, columns] of [
      ['catalog_progress', 'revision_id'],
      ['account_progress', 'account_id, position'],
    ]) {
      await statementsQuery(
        statements,
        `insert into ${searchPrivateSchema}.${table} (generation_id, ${columns})
         select cast(:generation_id as bigint), ${columns} from ${searchPrivateSchema}.${table}
         where generation_id = cast(:served as bigint) on conflict do nothing`,
        { generation_id: target.generation, served },
      );
    }
    await statementsQuery(
      statements,
      `delete from ${searchPrivateSchema}.generation
        where state = 'published' and generation_id <> cast(:generation_id as bigint)`,
      { generation_id: target.generation },
    );
    const rows = await statementsQuery(
      statements,
      `update ${searchPrivateSchema}.generation
          set state = 'published', published_at = now()
        where generation_id = cast(:generation_id as bigint) and state = 'building'
        returning generation_id::text as generation_id`,
      { generation_id: target.generation },
    );
    if (rows.length !== 1) {
      throw new AbandonedWrite(
        'obsolete-generation',
        'The replacement generation could not be published.',
      );
    }
    return true;
  });
}

/** One consistent, ordered snapshot of a generation's source positions and account scope. */
async function readGenerationCheckpoints(
  sql: SearchSqlExecutor,
  generation: string,
): Promise<string> {
  const rows = await readRows(
    sql,
    `select source, account_id, position, revision_id
       from (
         select 'catalog' as source, null::text as account_id, position, revision_id
           from ${searchPrivateSchema}.catalog_checkpoint
          where generation_id = cast(:generation_id as bigint)
         union all
         select 'account' as source, account_id, position, null::text as revision_id
           from ${searchPrivateSchema}.account_checkpoint
          where generation_id = cast(:generation_id as bigint)
       ) as checkpoint
      order by source, account_id`,
    { generation_id: generation },
  );
  const parsed = z
    .array(
      z.object({
        source: z.enum(['catalog', 'account']),
        account_id: identifierSchema.nullable(),
        position: positionSchema,
        revision_id: revisionSchema.nullable(),
      }),
    )
    .safeParse(rows);
  if (!parsed.success) {
    throw unreadableProjection();
  }
  return JSON.stringify(parsed.data);
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

/**
 * Advances a source's checkpoint only while it still holds the position the write started from: a
 * checkpoint never moves backwards, and a batch another run already superseded changes nothing
 * (docs/data-architecture.md#asynchronous-synchronization).
 */
async function advanceCheckpoint(
  sql: SearchSqlExecutor,
  statement: string,
  parameters: Readonly<Record<string, SearchSqlValue>>,
): Promise<void> {
  const rows = await statementsQuery(sql, statement, parameters);
  if (rows.length !== 1) {
    throw new AbandonedWrite(
      'stale-checkpoint',
      'Another run advanced this checkpoint; this write is obsolete.',
    );
  }
}

async function advanceCatalogCheckpoint(
  sql: SearchSqlExecutor,
  generation: string,
  applied: ChangeCheckpoint,
  start: ChangeCheckpoint | null,
): Promise<void> {
  const revisionId = applied.revisionId ?? start?.revisionId ?? null;
  if (revisionId === null) {
    throw unreadableProjection();
  }
  await advanceCheckpoint(
    sql,
    `insert into ${searchPrivateSchema}.catalog_checkpoint (generation_id, position, revision_id)
     values (cast(:generation_id as bigint), :position, :revision_id)
     on conflict (generation_id) do update set
       position = excluded.position,
       revision_id = excluded.revision_id
      where catalog_checkpoint.position = :start_position
     returning generation_id::text as generation_id`,
    {
      generation_id: generation,
      position: applied.position,
      revision_id: revisionId,
      start_position: start?.position ?? null,
    },
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

async function advanceAccountCheckpoint(
  sql: SearchSqlExecutor,
  generation: string,
  accountId: string,
  applied: ChangeCheckpoint,
  start: ChangeCheckpoint | null,
): Promise<void> {
  await advanceCheckpoint(
    sql,
    `insert into ${searchPrivateSchema}.account_checkpoint (generation_id, account_id, position)
     values (cast(:generation_id as bigint), :account_id, :position)
     on conflict (generation_id, account_id) do update set position = excluded.position
      where account_checkpoint.position = :start_position
     returning generation_id::text as generation_id`,
    {
      generation_id: generation,
      account_id: accountId,
      position: applied.position,
      start_position: start?.position ?? null,
    },
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
 * They are retained rather than dropped: a nonzero count keeps a replacement from becoming
 * queryable as an apparently complete generation, and a write that would introduce one into the
 * queryable generation is rolled back and left pending (docs/search.md#internal-design).
 */
async function assertResolved(sql: SearchSqlExecutor, generation: string): Promise<void> {
  if ((await countUnresolvedReferences(sql, generation)) !== 0) {
    throw new AbandonedWrite(
      'unresolved-references',
      'A publication references a catalog fact the projection does not hold yet.',
    );
  }
}

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

/**
 * Position a source reports while the generation holds no checkpoint for it: the UserCards
 * publication's "before everything this account published" position, which acknowledges no change
 * (docs/user-cards.md#query-surface). A queryable generation always holds a catalog checkpoint, so
 * this reports an account whose bootstrap could not be applied yet.
 */
const unindexedPosition = '0';

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
    (cause instanceof CatalogError ||
      cause instanceof UserCardsError ||
      cause instanceof SearchError) &&
    cause.code === 'stale-continuation'
  );
}

function translateIndexingFailure(cause: unknown): SearchError {
  return cause instanceof SearchError
    ? cause
    : new SearchError('unavailable', 'The search index could not be updated.', { cause });
}

async function recordCatalogProgress(
  sql: SearchSqlExecutor,
  generation: string,
  revision: string,
): Promise<void> {
  await statementsQuery(
    sql,
    `insert into ${searchPrivateSchema}.catalog_progress (generation_id, revision_id)
    values (cast(:generation as bigint), :revision) on conflict do nothing`,
    { generation, revision },
  );
}
async function recordAccountProgress(
  sql: SearchSqlExecutor,
  generation: string,
  account: string,
  position: string,
): Promise<void> {
  await statementsQuery(
    sql,
    `insert into ${searchPrivateSchema}.account_progress (generation_id, account_id, position)
    values (cast(:generation as bigint), :account, :position) on conflict do nothing`,
    { generation, account, position },
  );
}
