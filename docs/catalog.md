# Catalog

## Responsibility

Own public card identities, printings, their relationships and a complete database of basic card
information. Keep provider synchronization independent of interactive reads.

## Interface

- Provide CardList, UserInterface editors and UserCards with card and printing lookup, including batched resolution,
  language, available finishes and physical-printing eligibility.
- Provide Search with consistent snapshots and durable changes for public card facts through the
  publication contract below. Consumers build their own searchable storage from those facts.
- Provide Recognition with canonical identity and printing resolution. Recognition's model-specific
  inference dataset remains its own versioned asset.
- Accept synchronization requests from Application and report the published data revision or a
  failure. External provider formats remain inside this boundary.

### Provided operations

| Operation                  | Input                                                                                          | Result                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Resolve cards or printings | A bounded set of typed references.                                                             | Basic records keyed by reference, explicit missing references and catalog revision. |
| List a card's printings    | Card ID and continuation.                                                                      | Bounded printing records and continuation for that card.                            |
| Synchronize                | Source configuration supplied at construction; an invocation identifies the requested refresh. | Published revision or failure, preserving the previous revision on failure.         |

A printing record includes its card ID, edition, collector number, language, finishes, physical
eligibility and image references. A card record includes canonical and translated names, rules
text, type information, colors, color identity and mana value. Missing fields remain explicit. Resolution preserves
requested identities; an unavailable lookup is not a successful missing result.

### Printing selection

The published `findCatalogPrinting` operation accepts a card identity and optional edition, collector
number and language constraints. Constraints match case-insensitively; unspecified fields do not
narrow the match. Return the first match in printing-list order and its card from the same revision,
or explicit absence after the complete list. A changed revision or failed/incomplete read is a
failure, never absence. This lookup can use any supplied implementation of the public Catalog contract.
Consumers that only resolve identities depend on the narrower `CatalogResolver` capability.

### Query surface

Publish card, name and printing records through a versioned data interface. Card and printing IDs
are stable and unique; names preserve their associated identity. Records include the basic attributes
above and printing-to-card relationships. The contract exposes no SQL, tables or database connections.

Provide a consistent, paginated snapshot of one published revision and a resumable change position.
Changes carry stable identity, revision and upsert/removal meaning. Publication of a bulk revision is
complete and atomic from the consumer's perspective. Repeated reads preserve meaning; an expired
position explicitly requires a new snapshot. Snapshot and change handoff must leave no gap. Snapshot
pages also identify the completed revisions within retained publication history that the snapshot
incorporates; this metadata is bounded by the provider's retention window. Revision identities are
opaque to consumers.

Durably record publication with the authoritative revision. Search can rebuild independently and
continue after interrupted delivery. A replacement preserves these records and lifecycle guarantees,
regardless of storage technology. Internal views remain private implementation choices.

## Internal design

| Unit              | Owns                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| Read service      | Bounded reference resolution, printing lists and revision-bound continuation.       |
| Printing lookup   | Matching edition, collector number and language within one card identity.           |
| Read storage      | Local queries and record decoding against the published revision.                   |
| Synchronization   | Source acquisition, normalization, candidate validation and atomic publication.     |
| Query publication | Consistent snapshots, durable revision publication, change positions and retention. |

The read service and synchronization have separate construction and execution lifecycles. Interactive
reads never start synchronization. Selection policy operates on the public read contract, so a storage
replacement does not duplicate it. Synchronization owns provider-specific parsing and candidate data;
only a validated complete revision becomes readable.

## Identities and information

Keep playable identity separate from printing identity. Preserve stable provider identifiers and
translated names. A lookup for a specific printing must not silently substitute another edition,
language or card. Missing and unavailable information are explicit outcomes.

Basic records contain the attributes needed to identify, render and filter cards without a live
provider request. Image references are separate from image loading. Physical eligibility and finish
options are printing facts; ownership is not catalog data.

## Synchronization

Ingest bulk source data into a candidate revision, validate identities and relationships, then
publish a consistent queryable revision. A failed refresh leaves the last valid revision available.
Retain references needed by existing records when provider data disappears or changes.

Keep source version and freshness visible. Public lookups and filtered reads are bounded and
support batch access. Synchronization owns provider limits and recovery; provider outages do not
turn successful local reads into failures.
