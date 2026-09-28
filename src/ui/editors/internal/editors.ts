/**
 * Editors implementation (docs/ui/editors.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * One Editors module provides the independently mountable editors of the UserInterface over a
 * supplied CardViews module: query/filter input, copy attributes, tags, associations and
 * location, import source input, pending review and confirmation. An editor owns its unsaved draft
 * and its operation presentation; business validation, import identity, replay, ownership and
 * location rules stay with the provider-owned operations.
 */

import type { CardViews } from '../../card-views/index.js';

import {
  createCatalogQueryEditor,
  createCollectionQueryEditor,
  createSearchEntryEditor,
  type UiCatalogQueryEditorOptions,
  type UiCollectionQueryEditorOptions,
  type UiQueryEditor,
  type UiSearchEntryEditor,
  type UiSearchEntryEditorOptions,
  type UiCatalogQueryDraft,
  type UiCollectionQueryDraft,
} from './query.js';
import {
  createCopyBulkEditor,
  createCopyEditor,
  type UiCopyEditor,
  type UiCopyEditorOptions,
  type UiCopyBulkEditor,
  type UiCopyBulkEditorOptions,
} from './copy.js';
import type { CardListCatalogQuery, CardListCollectionQuery } from '../../../card-list/index.js';
import {
  createImportReviewEditor,
  createManualImportEditor,
  createSourceImportEditor,
  type UiImportReviewEditor,
  type UiImportReviewEditorOptions,
  type UiManualImportEditor,
  type UiManualImportEditorOptions,
  type UiSourceImportEditor,
  type UiSourceImportEditorOptions,
} from './imports.js';

export interface EditorsOptions {
  /**
   * CardViews factory the editors use for card and printing choices; the editors never select a
   * concrete renderer themselves (docs/ui/architecture.md#modules-and-composition).
   */
  readonly cardViews: CardViews;
}

/** The presentation module of the UI composition. */
export interface Editors {
  readonly cardViews: CardViews;
  /** Home's single-field search entry. */
  searchEntry(options: UiSearchEntryEditorOptions): UiSearchEntryEditor;
  /** The catalog query criteria editor. */
  catalogQuery(
    options: UiCatalogQueryEditorOptions,
  ): UiQueryEditor<CardListCatalogQuery, UiCatalogQueryDraft>;
  /** The collection query criteria editor. */
  collectionQuery(
    options: UiCollectionQueryEditorOptions,
  ): UiQueryEditor<CardListCollectionQuery, UiCollectionQueryDraft>;
  /** The collection's bulk copy change editor. */
  copyBulk(options: UiCopyBulkEditorOptions): UiCopyBulkEditor;
  /** The attribute editor of one physical copy. */
  copy(options: UiCopyEditorOptions): UiCopyEditor;
  /** The manual entry editor of the Import activity. */
  importManual(options: UiManualImportEditorOptions): UiManualImportEditor;
  /** The source import editor of the Import activity. */
  importSource(options: UiSourceImportEditorOptions): UiSourceImportEditor;
  /** The pending review and confirmation editor of the Import activity. */
  importReview(options: UiImportReviewEditorOptions): UiImportReviewEditor;
}

/** The default Editors module of the browser application. */
export function createEditors(options: EditorsOptions): Editors {
  if (options?.cardViews === undefined) {
    throw new TypeError('The editors render card choices through the supplied CardViews module.');
  }
  return {
    cardViews: options.cardViews,
    searchEntry: (editorOptions) => createSearchEntryEditor(editorOptions),
    catalogQuery: (editorOptions) => createCatalogQueryEditor(editorOptions),
    collectionQuery: (editorOptions) => createCollectionQueryEditor(editorOptions),
    copyBulk: (editorOptions) => createCopyBulkEditor(editorOptions),
    copy: (editorOptions) => createCopyEditor(editorOptions),
    importManual: (editorOptions) => createManualImportEditor(editorOptions),
    importSource: (editorOptions) => createSourceImportEditor(editorOptions),
    importReview: (editorOptions) => createImportReviewEditor(editorOptions),
  };
}
