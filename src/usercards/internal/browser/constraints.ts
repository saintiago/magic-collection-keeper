/**
 * Input constraints and operation availability of the UserCards browser contract
 * (docs/user-cards.md#browser-operation-lifecycle).
 *
 * Consumers present these published bounds instead of repeating the provider's limits next to
 * their controls. A request batch bound says how many references or entries one request carries,
 * a product bound says how large one intended quantity may be, and the page bounds say which
 * bounded reads the provider accepts; a consumer that needs a larger selection asks further
 * bounded requests instead of inventing a limit of its own. Presentation bounds a consumer picks
 * for itself — how many entries a list window keeps, how many rows one page of its own asks for —
 * are not part of this contract. Every bound guides controls only and never replaces the
 * provider's own validation (docs/user-cards.md#interface).
 */

import { USERCARDS_LIMITS } from '../model.js';

/** Operations the browser contract publishes, named after the client operations it serves. */
export const usercardsBrowserOperations = [
  'readCopies',
  'correctCopy',
  'listTags',
  'readTags',
  'createTag',
  'renameTag',
  'listAssociations',
  'readAssociations',
  'createAssociation',
  'changeAssociation',
  'removeAssociation',
  'setCopyLocation',
  'listImportSessions',
  'listImportEntries',
  'stageImportEntries',
  'stageSourceImport',
  'stageCaptureObservation',
  'reviewImportEntry',
  'attachImportCandidates',
  'discardImportEntry',
  'discardImportSession',
  'confirmImport',
  'recoverImportOperation',
] as const;

export type UserCardsBrowserOperation = (typeof usercardsBrowserOperations)[number];

/** The page sizes one bounded provider read accepts, with the default it uses when none is named. */
export interface UserCardsPageBounds {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

/**
 * What one browser consumer may present as controls. Every value is derived from the provider's
 * published limits, so a consumer never duplicates a bound to match an incidental storage choice.
 */
export interface UserCardsConstraints {
  /** Operations the constructed client enables; a consumer presents only these. */
  readonly operations: readonly UserCardsBrowserOperation[];
  /**
   * Request batch bounds: the most one request of the named operation carries. A larger explicit
   * selection is decided through further bounded requests, never refused by a copied bound.
   */
  readonly batch: {
    /** References one copy, tag or association read or change carries. */
    readonly references: number;
    /** Lines one staging request stages. */
    readonly stageEntries: number;
    /** Reviewed entries one confirmation covers. */
    readonly confirmEntries: number;
    /** Lines one source import parses. */
    readonly sourceLines: number;
  };
  /**
   * Product bounds: how large one intended quantity may be. A copy or reviewed entry carries one,
   * and a card- or printing-level association carries its own; these are the product's own bounds
   * rather than a request batch size.
   */
  readonly quantity: {
    /** Physical copies one confirmed or corrected record declares. */
    readonly copy: number;
    /** Intended copies one card- or printing-level association requires. */
    readonly association: number;
  };
  /** Text bounds one operation accepts. */
  readonly text: {
    /** Account, copy, tag, association, entry, session and operation identities and labels. */
    readonly identifier: number;
    /** Characters one pasted or reviewed source list carries. */
    readonly sourceText: number;
    /** Characters one official source reference carries. */
    readonly sourceReference: number;
    /** Characters one parsed source line's problem carries. */
    readonly sourceProblem: number;
    /** Recognition alternatives one pending entry keeps. */
    readonly candidates: number;
  };
  /** Page bounds of the provider's bounded reads. */
  readonly pages: {
    readonly tags: UserCardsPageBounds;
    readonly associations: UserCardsPageBounds;
    readonly imports: UserCardsPageBounds;
  };
}

/** The constraints every deployment of this contract publishes, before operation availability. */
export const usercardsConstraints: Omit<UserCardsConstraints, 'operations'> = {
  batch: {
    references: USERCARDS_LIMITS.maxReadReferences,
    stageEntries: USERCARDS_LIMITS.maxStageEntries,
    confirmEntries: USERCARDS_LIMITS.maxConfirmEntries,
    sourceLines: USERCARDS_LIMITS.maxSourceLines,
  },
  quantity: {
    copy: USERCARDS_LIMITS.maxCreateQuantity,
    association: USERCARDS_LIMITS.maxAssociationQuantity,
  },
  text: {
    identifier: USERCARDS_LIMITS.maxIdentifierLength,
    sourceText: USERCARDS_LIMITS.maxSourceTextLength,
    sourceReference: USERCARDS_LIMITS.maxSourceReferenceLength,
    sourceProblem: USERCARDS_LIMITS.maxSourceProblemLength,
    candidates: USERCARDS_LIMITS.maxImportCandidates,
  },
  pages: {
    tags: {
      default: USERCARDS_LIMITS.defaultTagPageSize,
      min: USERCARDS_LIMITS.minTagPageSize,
      max: USERCARDS_LIMITS.maxTagPageSize,
    },
    associations: {
      default: USERCARDS_LIMITS.defaultAssociationPageSize,
      min: USERCARDS_LIMITS.minAssociationPageSize,
      max: USERCARDS_LIMITS.maxAssociationPageSize,
    },
    imports: {
      default: USERCARDS_LIMITS.defaultImportPageSize,
      min: USERCARDS_LIMITS.minImportPageSize,
      max: USERCARDS_LIMITS.maxImportPageSize,
    },
  },
};
