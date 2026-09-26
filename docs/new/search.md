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

## Query evaluation

Normalize and validate supported text and structured criteria. Reject unsupported criteria explicitly.
Resolve translated names to the same playable identity while preserving the matched name for display.

Apply membership filters and requested grouping before ordering and pagination. Include a stable
tie-breaker in ordering. Never retrieve one public page and then remove entries that fail private
filters; that changes the meaning and completeness of the result.

A result identifies whether its entry represents a card, printing or physical copy. Grouped copy
counts and intended quantities remain distinct. Multiple matching tags or printings must not
multiply the same entry or physical count.

## Consistency

Continuation belongs to the original query and user. Changed criteria start a new result sequence.
Handle invalid continuation or a changed underlying revision explicitly rather than implying a
complete, unchanged result.

Missing optional enrichment does not block basic results. Failure to evaluate membership cannot
be presented as an empty list. Search owns no authoritative card or user records and performs no
business mutations.
