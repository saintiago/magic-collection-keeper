# Catalog

## Responsibility

Own public card identities, printings, their relationships and a complete database of basic card
information. Own public search, reference resolution and printing selection. Keep provider
synchronization independent of interactive reads.

## Interface

- Provide CardList with public card/printing queries and batched basic information/image references.
- Provide UserInterface editors and UserCards with lookup, including language, supported finishes,
  physical-printing eligibility and stable printing-to-card relationships.
- Provide Recognition with canonical identity and printing resolution. Its model-specific inference
  dataset remains its own versioned asset.
- Accept synchronization requests from Application and report the published revision or failure.
  External provider formats remain inside this boundary.

### Provided operations

| Operation                  | Input                                                                                 | Result                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Query cards or printings   | Public criteria, result level, ordering, bounded page size and optional continuation. | Stable typed entries, basic information, revision and continuation or explicit end. |
| Resolve cards or printings | A bounded set of typed references.                                                    | Basic records keyed by reference, explicit missing references and catalog revision. |
| List a card's printings    | Card ID and continuation.                                                             | Bounded printing records and continuation for that card.                            |
| Find a printing            | Card identity and optional edition, collector number and language.                    | First matching printing and its card from one revision, or explicit absence.        |
| Synchronize                | Source configuration supplied at construction and requested refresh.                  | Published revision or failure, preserving the previous revision on failure.         |

A printing record includes card ID, edition, collector number, language, finishes, physical
eligibility and image references. A card record includes canonical/translated names, rules text,
types, colors, color identity and mana value. Missing fields remain explicit. Resolution preserves
requested identities; unavailable lookup is not successful absence.

Query contracts expose no SQL, private tables, connections or presentation types. They include no
private ownership/tag criteria. Invalid criteria, missing records, unsupported expressions, stale
continuation and temporary failure are distinct outcomes; only successful evaluation returns an
empty result. Consumers needing reference resolution depend on the narrower CatalogResolver.

### Public query semantics

Support the defined Scryfall-compatible subset: names, rules text, colors, color identity, types,
mana value, set, language and finish. Text and equivalent structured criteria use one query model.
Preserve supported operators, comparisons, combination and negation. Explicitly reject unsupported
operators/combinations, identifying the expression; never silently ignore or forward them upstream.

Resolve translated names to their playable identity and preserve the matched display name. Printing
criteria must match the same related printing. Multiple matching names/printings must not duplicate
a card entry. Queries can return card or printing entries; quantities/ownership are not public facts.

Evaluate complete membership and grouping before deterministic ordering and pagination. Include an
identity tie breaker. Continuation is opaque and bound to normalized criteria, ordering, result level
and published revision. Changed criteria or revision require restarting an obsolete sequence.

### Printing selection

The published findCatalogPrinting operation matches optional constraints case-insensitively;
unspecified fields do not narrow the match. Return the first match in printing-list order and its
card from the same revision, or absence after the complete list. Changed revision or failed/incomplete
read is failure, never absence. This policy works with any public-contract implementation.

## Internal design

| Unit             | Owns                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Query model      | Supported text syntax, structured criteria and normalization.                            |
| Query evaluation | Owner-local membership, grouping, ordering and result construction.                      |
| Read service     | Bounded resolution, printing lists, continuation and failure semantics.                  |
| Printing lookup  | Selection within one card identity.                                                      |
| Read storage     | Local query execution, ordinary indexes and record decoding at the published revision.   |
| Synchronization  | Source acquisition, normalization, candidate validation and atomic revision publication. |

Read and synchronization lifetimes are separate. Interactive reads never start synchronization or
build a second copy of the data. Query evaluation stays behind the public facade and uses only this
component's storage. Selection policy uses the public read contract. A replacement preserves query,
identity, ordering, continuation and revision behavior rather than a database layout.

## Identities and information

Keep playable and printing identities separate and stable. A printing belongs to one card; preserve
that relationship during synchronization. Do not substitute a similar language or printing when a
reference is unavailable. Batch basic-information lookup; no live provider request is needed.

Images are independent references. Preserve nonphysical printings with an empty finish list without
inventing nonfoil or rejecting the bulk revision. Physical printings require a supported finish.
Verify through resolution and public queries; rejecting an invalid candidate preserves the published
revision. Compatible storage upgrades preserve existing records and revision history.

## Synchronization

Fetch and normalize a complete provider snapshot as separate finite background work. Validate
identities, printing relationships and physical eligibility before publication. Candidate data stays
unreadable until the entire revision is valid and atomically published. Failure preserves the prior
complete revision. Synchronization has an independent finite lifetime and never mutates private records.
