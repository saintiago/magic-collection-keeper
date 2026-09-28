# Search

## Responsibility

Answer queries combining public card information and private associations. Own rebuildable search
data, asynchronous indexing, query meaning, membership, ordering, grouping and pagination.

## Interface

- Accept CardList queries with a requested card level, filters, ordering and page boundary.
  Return bounded entries with stable identity, basic information, result context and continuation.
- Answer bounded private count reads for explicit card, printing or copy references: the account's
  owned copies, the distinct physical locations holding them and one tag's intended quantity. A
  count read enriches the entries a consumer presents without changing any query's membership, so
  an entry the account does not own keeps its place with an exact zero.
- Consume Catalog and UserCards snapshots and durable changes through their provider-owned
  publication contracts. Maintain a private projection rather than querying their storage.
- Receive trusted user context from Application for private queries. UserCards' access rules apply
  before private results, counts or summaries are produced.

### Request and result

A query specifies result level (card, printing or physical copy), supported criteria, ordering,
page size and optional continuation. Account scope comes from trusted context, not a query field.
Private criteria require authenticated context even when the result level is a public card.

A page returns stable entry keys, typed target references, basic information, relevant quantity
context, indexed source revisions and an opaque continuation or explicit end. Counts are exact for
that indexed state; they do not imply that every latest write is indexed. An unavailable count is
not zero. Continuation is bound to normalized criteria, ordering, account and the indexed generation
used by the query. A stale continuation returns a restart-required result.

Invalid criteria, unauthorized access, stale continuation and temporary failure are distinct
outcomes. Only successful evaluation can return an empty page.

### Required query contracts

Use [Catalog's publication](catalog.md#query-surface) for public card/name/printing facts and
[UserCards' publication](user-cards.md#query-surface) for account-scoped searchable facts. Providers
own record meaning, snapshot boundaries, revisions, change identity and deletion semantics. Bindings
translate these public records into the projection's private schema. Search neither imports provider
repositories nor accepts arbitrary SQL from callers. Replacing a provider preserves its publication
behavior; it does not require reproducing its database technology or views.

Application supplies trusted service access for indexing, authenticated query context and separate
storage capabilities for projection updates and reads. Indexing runs through a resumable background
job entry point. Queries never start a rebuild or synchronously join live provider reads. The
[data architecture](data-architecture.md) defines storage composition and delivery strategy.

### Freshness

Accept an optional required publication position from a known committed change, scoped to the
authenticated account, or a required public catalog revision. Report whether that position is
incorporated. Provide a cancellable bounded wait/status capability for incorporation so CardList can
refresh without a page-owned polling loop. This capability creates no indexing work itself.

When the required position is not incorporated, return updating with the last usable indexed result
when available; otherwise return updating without results. Indexing failure/unavailability remains
distinct. Report indexed positions even when no minimum was requested, without claiming the index
contains all current source writes. Never interpret an unknown position or incomplete generation as
ready. A wait timeout does not turn an acknowledged UserCards commit into failure.

Provide an account-scoped browser progress capability: accept known committed publication positions,
observe whether they are indexing, incorporated, delayed or failed, and dispose observation. Application
connects UserCards commit/recovery notifications to it. UserInterface's shell observes the status for
its indexing notice; it does not query records, compare positions or poll. Track outstanding positions
across page changes, suppress stale account results and release private state on account disposal.
An unavailable progress check cannot report completion. Rechecking status never resubmits a mutation.
If bounded observation expires before incorporation, expose delayed status. An unavailable status
read also reports delayed/unavailable progress; report failed indexing only when that failure is
known. A later successful observation can resume progress or establish completion.

## Internal design

| Unit                 | Owns                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| Syntax parsing       | Supported text grammar and explicit unsupported-expression errors.                               |
| Normalization        | One validated query model for text and structured criteria.                                      |
| Publication bindings | Snapshot/change decoding and mapping from supplied contracts.                                    |
| Indexing             | Idempotent application, complete generation publication, source/account checkpoints and rebuild. |
| Evaluation           | Complete membership, grouping, basic-information projection and deterministic ordering.          |
| Continuation         | Query/account/revision binding and restart-required failures.                                    |
| Service              | Request validation, authorized evaluation and bounded result construction.                       |
| Freshness            | Indexed-position reporting and bounded observation of requested progress.                        |

Evaluation reads only the local projection. Pagination applies only after membership and grouping;
post-filtering a fetched page is not a substitute. The evaluator receives read access, not a writer.
Its SQL implementation can change without changing the public query or result contract. There is no
second query model inside a transport endpoint or a page.

Freshness retains exact incorporated publication identities with each generation, learned from
snapshot evidence and completed change markers. That evidence commits with the projection and is
carried into complete replacement generations, including identities no longer in source retention.
Both query and observation check membership in this evidence at the indexed state they return;
identities never learned from a publication remain unknown. Browser progress checks explicit
positions in bounded batches within one observation deadline and releases only confirmed batches.

Indexing and queries have independent lifetimes and resource bounds. Apply complete changes and
their checkpoints atomically, or publish a staged complete generation. Keep a consistent relationship
between public and private facts: retain unresolved references for later indexing rather than dropping
them and advancing an apparently complete result. Rebuilds preserve the previous usable generation.

## Query evaluation

### Scryfall compatibility

Support a defined subset of Scryfall's public search syntax and semantics. Initial public filters
cover names, rules text, colors, types, mana value, set, language and finish. UI controls and supported
text expressions normalize to the same query model. Preserve the distinction between card color
and color identity, and between card-level and printing-level criteria.

For supported expressions, preserve operator, comparison and combination meaning. Unsupported
operators or combinations return an explicit unsupported-query error identifying the expression;
never ignore them, reinterpret them as name text or silently forward the query to an external provider.
Extend the supported subset without changing the meaning of existing queries.

Owned status, tags, decks, wishlists and locations are separate structured private criteria. They
combine with the public query without redefining Scryfall operators or sending private data upstream.
Compatibility covers supported query meaning, not identical provider ranking or catalog freshness.

### Evaluation and grouping

Normalize and validate supported text and structured criteria.
Resolve translated names to the same playable identity while preserving the matched name for display.

Apply membership filters and requested grouping before ordering and pagination. Include a stable
tie-breaker in ordering. Never retrieve one public page and then remove entries that fail private
filters; that changes the meaning and completeness of the result.

A result identifies whether its entry represents a card, printing or physical copy. Grouped copy
counts and intended quantities remain distinct. Multiple matching tags or printings must not
multiply the same entry or physical count.

Printing and copy criteria must match the same related printing or copy. Owning one printing and
having another printing in the requested set does not satisfy an owned-copy query for that set.
Use existence checks or equivalent grouping when associations have multiple matches.

## Consistency

Continuation belongs to the original query and user. Changed criteria start a new result sequence.
Handle invalid continuation or a changed indexed generation explicitly rather than implying a
complete, unchanged result. Private progress is account-scoped; unrelated accounts' writes do not
invalidate pagination. Source writes become visible only after their publication is indexed.

Missing optional enrichment does not block basic results. Failure to evaluate membership cannot
be presented as an empty list. Search owns no authoritative card or user records and performs no
business mutations.
