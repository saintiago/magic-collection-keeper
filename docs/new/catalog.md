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
