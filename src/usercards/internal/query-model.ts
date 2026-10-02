import type { Finish } from '../../catalog/contract.js';
import type { CopyCondition, TagId } from './model.js';

export const userCardsResultLevels = ['card', 'printing', 'copy'] as const;
export type UserCardsResultLevel = (typeof userCardsResultLevels)[number];

export type UserCardsQueryScope =
  { readonly kind: 'collection' } | { readonly kind: 'tag'; readonly tagId: TagId };

export type UserCardsQueryCriterion =
  | { readonly kind: 'owned'; readonly value: boolean }
  | { readonly kind: 'tag'; readonly tagId: TagId }
  | { readonly kind: 'location'; readonly tagId: TagId }
  | { readonly kind: 'finish'; readonly finish: Finish }
  | { readonly kind: 'condition'; readonly condition: CopyCondition | null }
  | {
      readonly kind: 'identity';
      readonly references: readonly UserCardsReference[];
    };

export const userCardsOrderingFields = [
  'identity',
  'ownedCopies',
  'intendedQuantity',
  'locations',
] as const;
export type UserCardsOrderingField = (typeof userCardsOrderingFields)[number];

export const userCardsSortDirections = ['ascending', 'descending'] as const;
export type UserCardsSortDirection = (typeof userCardsSortDirections)[number];

export interface UserCardsOrdering {
  readonly field: UserCardsOrderingField;
  readonly direction: UserCardsSortDirection;
}

export interface UserCardsQueryInput {
  readonly scope: UserCardsQueryScope;
  readonly resultLevel: UserCardsResultLevel;
  readonly criteria?: readonly UserCardsQueryCriterion[];
  readonly ordering?: UserCardsOrdering;
  readonly pageSize?: number;
  readonly continuation?: string;
}

export interface UserCardsQuery {
  readonly scope: UserCardsQueryScope;
  readonly resultLevel: UserCardsResultLevel;
  readonly criteria: readonly UserCardsQueryCriterion[];
  readonly ordering: UserCardsOrdering;
  readonly pageSize: number;
}

export type UserCardsReference =
  | { readonly kind: 'card'; readonly cardId: string }
  | { readonly kind: 'printing'; readonly printingId: string }
  | { readonly kind: 'copy'; readonly copyId: string };

export function userCardsReferenceKey(reference: UserCardsReference): string {
  switch (reference.kind) {
    case 'card':
      return `card:${reference.cardId}`;
    case 'printing':
      return `printing:${reference.printingId}`;
    case 'copy':
      return `copy:${reference.copyId}`;
  }
}

export interface UserCardsQueryEntry {
  readonly entryKey: string;
  readonly target: UserCardsReference;
  readonly ownedCopyCount: number;
  readonly intendedQuantity: number | null;
  readonly physicalLocationCount: number;
  readonly directAssociationCount: number;
  readonly derivedAssociationCount: number;
}

export interface UserCardsQueryPage {
  readonly entries: readonly UserCardsQueryEntry[];
  readonly totalCount: number;
  readonly privateRevision: string;
  readonly continuation: string | null;
}

export interface UserCardsFragment {
  readonly reference: UserCardsReference;
  readonly ownedCopyCount: number;
  readonly tagIds: readonly TagId[];
  readonly physicalLocationCount: number;
  /** Sum of matching card/printing intentions in the requested tag; null without tag context. */
  readonly intendedQuantity: number | null;
}

export interface ReadUserCardsFragmentsInput {
  readonly references: readonly UserCardsReference[];
  readonly tagId?: TagId;
}

export interface UserCardsFragmentsResult {
  readonly privateRevision: string;
  readonly fragments: ReadonlyMap<string, UserCardsFragment>;
  /** Missing authorized copy references. Card and printing references validly return zero facts. */
  readonly missing: readonly UserCardsReference[];
}

export interface UserCardsPhysicalDetail {
  readonly copy: import('./model.js').PhysicalCopy;
  readonly memberships: readonly import('./model.js').Association[];
  readonly privateRevision: string;
}

export const USERCARDS_QUERY_LIMITS = {
  defaultPageSize: 50,
  minPageSize: 1,
  maxPageSize: 100,
  maxCriteria: 20,
  maxIdentityReferences: 100,
  maxFragmentReferences: 100,
  maxContinuationLength: 4_096,
} as const;
