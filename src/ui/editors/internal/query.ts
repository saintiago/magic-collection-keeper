/**
 * Query editors of the browsing and collection pages
 * (docs/ui/editors.md#internal-design, docs/ui/pages.md#page-map).
 *
 * A query editor owns the unsaved text expression and the criteria controls, keeps the typed
 * input distinct from the applied query, and submits explicit criteria to its page. Parsing and
 * normalization of the expression stay behind the list's Search binding; the editor presents the
 * controls and forwards the intent, and it neither filters loaded cards nor evaluates a route.
 */

import type { CardListCatalogQuery, CardListCollectionQuery } from '../../../card-list/index.js';

import { controlLabel, searchForm, searchInput, selectControl } from '../../shared/controls.js';
import {
  readUiCatalogFinish,
  readUiCatalogLevel,
  readUiCollectionLevel,
  uiCatalogFinishes,
  uiCatalogLevels,
  uiCollectionLevels,
  uiFinishLabel,
} from '../../shared/vocabulary.js';

/** One query or filter editor: unsaved criteria distinct from the applied query. */
export interface UiQueryEditor<Criteria, Draft = unknown> {
  /** The form this editor presents. */
  readonly element: HTMLFormElement;
  /** Criteria the controls currently name. */
  criteria(): Criteria;
  /** Draft the page retains for its history entry. */
  capture(): Draft;
  /** Applies the draft a previous visit retained, when it carries this editor's shape. */
  restore(draft: unknown): void;
}

/** Draft of the Home search entry: the expression the owner typed. */
export interface UiSearchEntryDraft {
  readonly query: string;
}

/** Draft of the catalog query controls. */
export interface UiCatalogQueryDraft {
  readonly query: string;
  readonly level: string;
  readonly owned: boolean;
  readonly finish: string | null;
}

/** Draft of the collection query controls. */
export interface UiCollectionQueryDraft {
  readonly query: string;
  readonly level: string;
}

export interface UiSearchEntryEditorOptions {
  readonly document: Document;
  /** Expression the page presents now. */
  readonly applied: string;
  /** Draft a previous visit retained, when it carried one. */
  readonly restored?: unknown;
  /** Reports the explicit expression of one submission. */
  readonly onSubmit: (query: string) => void;
}

/** The single-field search entry of Home; it opens the catalog with the expression it names. */
export interface UiSearchEntryEditor {
  readonly element: HTMLFormElement;
  capture(): UiSearchEntryDraft;
  restore(restored: Readonly<Record<string, unknown>> | null): void;
}

export function createSearchEntryEditor(options: UiSearchEntryEditorOptions): UiSearchEntryEditor {
  const document = options.document;
  const input = searchInput(document, 'home-search');
  input.value = options.applied;
  const form = searchForm(document, input);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    options.onSubmit(input.value.trim());
  });
  return {
    element: form,
    capture: () => ({ query: input.value }),
    restore(restored) {
      if (typeof restored?.query === 'string') {
        input.value = restored.query;
      }
    },
  };
}

export interface UiCatalogQueryEditorOptions {
  readonly document: Document;
  /** Query the page presents now, from its route context. */
  readonly applied: CardListCatalogQuery;
  readonly restored?: unknown;
  /** Reports the explicit criteria of one submission. */
  readonly onSubmit: (criteria: CardListCatalogQuery) => void;
}

/** The text expression and the result-level, owned-only and finish criteria of the catalog. */
export function createCatalogQueryEditor(
  options: UiCatalogQueryEditorOptions,
): UiQueryEditor<CardListCatalogQuery, UiCatalogQueryDraft> {
  const document = options.document;
  const input = searchInput(document, 'catalog-search');
  input.value = options.applied.text;
  const level = selectControl(
    document,
    uiCatalogLevels.map((value) => ({
      value,
      label: value === 'card' ? 'Cards' : 'Printings',
    })),
    'card',
  );
  level.id = 'catalog-level';
  level.value = options.applied.level;
  const owned = document.createElement('input');
  owned.type = 'checkbox';
  owned.id = 'catalog-owned';
  owned.checked = options.applied.owned;
  const finish = selectControl(document, finishOptions(), '');
  finish.id = 'catalog-finish';
  finish.value = options.applied.finish ?? '';
  const form = searchForm(document, input, [
    controlLabel(document, 'Result level', level),
    controlLabel(document, 'Owned only', owned),
    controlLabel(document, 'Finish', finish),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    options.onSubmit(criteria());
  });
  const editor: UiQueryEditor<CardListCatalogQuery, UiCatalogQueryDraft> = {
    element: form,
    criteria,
    capture: () => ({
      query: input.value,
      level: level.value,
      owned: owned.checked,
      finish: finish.value === '' ? null : finish.value,
    }),
    restore(draft) {
      const restored = readDraft(draft);
      if (restored === null) {
        return;
      }
      if (typeof restored.query === 'string') {
        input.value = restored.query;
      }
      if (typeof restored.level === 'string') {
        level.value = readUiCatalogLevel(restored.level);
      }
      if (typeof restored.owned === 'boolean') {
        owned.checked = restored.owned;
      }
      if ('finish' in restored) {
        finish.value = readUiCatalogFinish(restored.finish) ?? '';
      }
    },
  };
  editor.restore(options.restored);
  return editor;

  /** The criteria the presented controls name. */
  function criteria(): CardListCatalogQuery {
    return {
      text: input.value.trim(),
      level: readUiCatalogLevel(level.value),
      owned: owned.checked,
      finish: readUiCatalogFinish(finish.value),
    };
  }
}

export interface UiCollectionQueryEditorOptions {
  readonly document: Document;
  /** Query the page presents now, from its route context. */
  readonly applied: CardListCollectionQuery;
  readonly restored?: unknown;
  /** Reports the explicit criteria of one submission. */
  readonly onSubmit: (criteria: CardListCollectionQuery) => void;
}

/** The text expression and level criteria of the collection page. */
export function createCollectionQueryEditor(
  options: UiCollectionQueryEditorOptions,
): UiQueryEditor<CardListCollectionQuery, UiCollectionQueryDraft> {
  const document = options.document;
  const input = searchInput(document, 'collection-search');
  input.value = options.applied.text;
  const level = selectControl(
    document,
    uiCollectionLevels.map((value) => ({
      value,
      label: value === 'card' ? 'Cards' : value === 'printing' ? 'Printings' : 'Physical copies',
    })),
    'card',
  );
  level.id = 'collection-level';
  level.value = options.applied.level;
  const form = searchForm(
    document,
    input,
    [controlLabel(document, 'Level', level)],
    'Search collection',
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    options.onSubmit(criteria());
  });
  const editor: UiQueryEditor<CardListCollectionQuery, UiCollectionQueryDraft> = {
    element: form,
    criteria,
    capture: () => ({ query: input.value, level: level.value }),
    restore(draft) {
      const restored = readDraft(draft);
      if (restored === null) {
        return;
      }
      if (typeof restored.query === 'string') {
        input.value = restored.query;
      }
      if (typeof restored.level === 'string') {
        level.value = readUiCollectionLevel(restored.level);
      }
    },
  };
  editor.restore(options.restored);
  return editor;

  function criteria(): CardListCollectionQuery {
    return { text: input.value.trim(), level: readUiCollectionLevel(level.value) };
  }
}

/** One retained draft as a record of values, or null when it carries none. */
function readDraft(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

/** Finish options of the catalog query, with the empty value constraining no finish. */
function finishOptions(): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: '', label: 'Any finish' },
    ...uiCatalogFinishes.map((finish) => ({ value: finish, label: uiFinishLabel(finish) })),
  ];
}
