# Search

## Responsibility

Answer queries combining public card information and private associations. Own query meaning,
result membership, ordering, grouping and pagination.

## Interface

- Accept UserInterface queries with a requested card level, filters, ordering and page boundary.
  Return bounded entries with stable identity, basic information, result context and continuation.
- Use provider-owned read contracts from Catalog and UserCards. These contracts support combined
  database evaluation without exposing private storage structures.
- Receive trusted user context from Application for private queries. UserCards' access rules apply
  before private results, counts or summaries are produced.

### Request and result

A query specifies result level (card, printing or physical copy), supported criteria, ordering,
page size and optional continuation. Account scope comes from trusted context, not a query field.
Private criteria require authenticated context even when the result level is a public card.

A page returns stable entry keys, typed target references, basic information, relevant quantity
context and an opaque continuation or explicit end. Counts are exact when supplied; an unavailable
count is not zero. Continuation is bound to normalized criteria, ordering, user and the revisions
used by the query. A stale continuation returns a restart-required result.

Invalid criteria, unauthorized access, stale continuation and temporary failure are distinct
outcomes. Only successful evaluation can return an empty page.

### Required query contracts

Catalog owns the public card, name and printing views. UserCards owns the account-scoped private
views. Search owns the combined query, using only these published relations. Application wires a
read-only executor for their common PostgreSQL query surface and binds the authenticated scope.

Search never imports provider repositories, reads private tables or accepts arbitrary SQL from a
caller. A replacement provider must preserve its published query surface as well as its lookup or
mutation interface. Search itself can be tested with minimal implementations of these views, without
running either provider's business logic.

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
Handle invalid continuation or a changed underlying revision explicitly rather than implying a
complete, unchanged result.

Missing optional enrichment does not block basic results. Failure to evaluate membership cannot
be presented as an empty list. Search owns no authoritative card or user records and performs no
business mutations.
