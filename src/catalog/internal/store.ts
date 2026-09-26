import type { CardRecord, CatalogRevision, PrintingRecord } from './model.js';

/** The published relations a read observed, always one mutually consistent revision. */
export interface ResolvedCatalogData {
  readonly revision: CatalogRevision;
  readonly cards: readonly CardRecord[];
  readonly printings: readonly PrintingRecord[];
}

export interface CardPrintingsData {
  readonly revision: CatalogRevision;
  readonly cardExists: boolean;
  readonly printings: readonly PrintingRecord[];
}

/**
 * Reads the published catalog relations only. A replacement storage implements the same published
 * views and passes the same contract tests; consumers never see this interface.
 */
export interface CatalogReadStore {
  resolve(cardIds: readonly string[], printingIds: readonly string[]): Promise<ResolvedCatalogData>;
  listPrintings(cardId: string, offset: number, limit: number): Promise<CardPrintingsData>;
}
