# Catalog

## Responsibility

Own public card identities, printings, their relationships and a complete database of basic card
information. Keep provider synchronization independent of interactive reads.

## Interface

- Provide UserInterface and UserCards with card and printing lookup, including batched resolution,
  language, available finishes and physical-printing eligibility.
- Provide Search with a public read contract for card attributes and printing relationships that
  can participate in complete database queries.
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

### Query surface

Publish read-only card, name and printing relations. Card and printing IDs are unique in their
respective relations; names are separate rows so aliases cannot multiply card counts. Printings
carry a card reference. The surface exposes the basic attributes above and the published revision.

In PostgreSQL these are versioned provider-owned views. Search depends on their declared columns
and meaning, never underlying table names. A replacement maps its storage to the same views and
passes the same contract tests. Publishing a revision exposes a mutually consistent set of relations.

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
