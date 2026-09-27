/**
 * Path templates of the Application transport contract (docs/application.md#interface).
 *
 * The backend routes, the browser client and the preserved recognition engines all name one
 * operation through this record, so a changed path is changed in one place. `:name` segments are
 * call parameters; `applicationPath` in ./transport.ts expands and encodes them.
 */

export const applicationRoutes = {
  catalogResolve: '/api/catalog/resolve',
  catalogCardPrintings: '/api/catalog/cards/:cardId/printings',
  /** Preserved engine envelope: hydrate one candidate printing (docs/recognition.md#interface). */
  preservedCard: '/api/card',
  /** New query model (`POST`) and the preserved lookup subset (`GET`) share one path. */
  search: '/api/search',
  copies: '/api/collection/copies',
  copiesRead: '/api/collection/copies/read',
  copyCorrections: '/api/collection/copies/:copyId/corrections',
  copyLocation: '/api/collection/copies/:copyId/location',
  tags: '/api/collection/tags',
  tagsRead: '/api/collection/tags/read',
  tagRename: '/api/collection/tags/:tagId/rename',
  /** Bounded page of one tag's associations, ordered by stable association identity. */
  tagAssociations: '/api/collection/tags/:tagId/associations',
  associations: '/api/collection/associations',
  associationsRead: '/api/collection/associations/read',
  associationChanges: '/api/collection/associations/:associationId/changes',
  associationRemoval: '/api/collection/associations/:associationId/removal',
  imports: '/api/collection/imports',
  importSources: '/api/collection/imports/sources',
  importOperation: '/api/collection/imports/operations/:operationId',
  importEntries: '/api/collection/imports/:sessionId/entries',
  importCaptures: '/api/collection/imports/:sessionId/captures',
  importDiscard: '/api/collection/imports/:sessionId/discard',
  importConfirmation: '/api/collection/imports/:sessionId/confirmation',
  importEntryReview: '/api/collection/imports/entries/:entryId/review',
  importEntryCandidates: '/api/collection/imports/entries/:entryId/candidates',
  importEntryDiscard: '/api/collection/imports/entries/:entryId/discard',
  /** Recognition inference of the preserved runtime; a separate compute deployment target. */
  recognition: '/api/recognize',
  recognitionIndependent: '/api/recognize-independent',
} as const;

export type ApplicationRouteName = keyof typeof applicationRoutes;
