/**
 * Declared bounds of the Search component (docs/search.md#request-and-result,
 * docs/search.md#freshness).
 *
 * The bounds have their own module so every capability that enforces one imports the same value
 * without importing the query model: Search's browser progress capability must stay free of the
 * model's Catalog and UserCards bindings (docs/architecture.md, .dependency-cruiser.mjs).
 */

const maxIdentifierLength = 200;
/** JSON escaping can spend six bytes on one string unit of a bound revision or reference. */
const maxEscapedIdentifierBytes = maxIdentifierLength * 6;

/**
 * Bounds that keep a query, its criteria and a page request bounded. A caller that needs more
 * entries reads further pages; Search never silently truncates a page.
 */
export const SEARCH_LIMITS = {
  /** Longest accepted Scryfall-compatible text expression, counted in JavaScript string units. */
  maxQueryLength: 500,
  /** Longest accepted name, rules-text or type value. */
  maxTextLength: 300,
  /** Most structured criteria one request combines, before a text expression adds its own. */
  maxCriteria: 50,
  /** Most explicit references one private count request covers. */
  maxCountReferences: 200,
  /** Most known committed publication positions one request requires incorporated. */
  maxRequiredPositions: 50,
  /** Longest accepted publication position, matching the providers' durable positions. */
  maxPositionLength: 20,
  /** Longest accepted card, printing, copy or tag reference, matching the provider bounds. */
  maxIdentifierLength,
  /** Longest accepted edition (set) code, matching the catalog printing bound. */
  maxEditionLength: 32,
  /** Longest accepted continuation token (see continuation.ts). */
  maxContinuationLength: 4 * Math.ceil((64 + 4 * maxEscapedIdentifierBytes + 128) / 3),
  defaultPageSize: 50,
  minPageSize: 1,
  maxPageSize: 100,
  /**
   * Longest bounded observation of requested indexing progress. A caller observes further by
   * calling again; Search never keeps a wait open past this bound.
   */
  maxObservationTimeoutMs: 30_000,
  /** Interval between two reads of one bounded observation. */
  observationIntervalMs: 250,
} as const;
