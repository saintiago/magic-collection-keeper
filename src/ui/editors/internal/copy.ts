/**
 * Copy attribute editors of the collection and card-details views
 * (docs/ui/editors.md#internal-design, docs/ui/editors.md#drafts-and-asynchronous-outcomes).
 *
 * The collection's bulk editor owns the values its controls apply to the explicit selection and
 * offers one tool per attribute through the private UserCards contract; the copy editor of one
 * physical copy owns its unsaved printing, language, finish and condition draft and presents the
 * provider's committed state separately. Neither editor decides a business rule: revisions,
 * conflicts, validation and committed values come from the provider-owned operations.
 */

import { controlLabel, selectControl } from '../../shared/controls.js';
import { readUiCatalogFinish, uiCatalogFinishes, uiFinishLabel } from '../../shared/vocabulary.js';
import {
  copyChangeTool,
  uiCopyConditions,
  type UiCopyAccess,
  type UiCopyChange,
} from './copy-edits.js';
import type { UiListAction } from '../../shared/actions.js';

/** Draft of the collection's bulk change controls. */
export interface UiCopyBulkDraft {
  readonly finish: string;
  readonly condition: string;
}

export interface UiCopyBulkEditorOptions {
  readonly document: Document;
  /** Private copy access the bulk tools act through. */
  readonly access: UiCopyAccess;
  /** Draft a previous visit retained, when it carried one. */
  readonly restored?: unknown;
}

/**
 * The bulk copy change editor: the values its controls apply beside the tools the list presents
 * for the explicit selection. Only a physical-copy selection carries the tools, so the page
 * presents availability for the `tools` fragment separately.
 */
export interface UiCopyBulkEditor {
  readonly element: HTMLFieldSetElement;
  /** Tools the page hands to the list for its explicit selection. */
  readonly tools: readonly UiListAction[];
  capture(): UiCopyBulkDraft;
  restore(draft: unknown): void;
}

export function createCopyBulkEditor(options: UiCopyBulkEditorOptions): UiCopyBulkEditor {
  const document = options.document;
  const fieldset = document.createElement('fieldset');
  fieldset.id = 'collection-changes';
  const legend = document.createElement('legend');
  legend.textContent = 'Bulk copy changes';
  const hint = document.createElement('p');
  hint.textContent =
    'Select physical copies in the list, choose a value and apply it to the whole selection.';
  const finish = selectControl(
    document,
    [
      { value: '', label: 'Choose finish' },
      ...uiCatalogFinishes.map((value) => ({ value, label: uiFinishLabel(value) })),
    ],
    '',
  );
  finish.id = 'collection-finish';
  const condition = selectControl(
    document,
    [
      { value: '', label: 'Choose condition' },
      { value: 'unknown', label: 'Unknown' },
      ...uiCopyConditions.map((code) => ({ value: code, label: conditionName(code) })),
    ],
    '',
  );
  condition.id = 'collection-condition';
  fieldset.append(
    legend,
    hint,
    controlLabel(document, 'Finish to apply', finish),
    controlLabel(document, 'Condition to apply', condition),
  );
  const editor: UiCopyBulkEditor = {
    element: fieldset,
    tools: [
      copyChangeTool({
        id: 'apply-finish',
        label: 'Apply finish',
        access: options.access,
        change: () => readFinishChange(finish.value),
        guidance: 'Choose the finish to apply to the selected copies.',
      }),
      copyChangeTool({
        id: 'apply-condition',
        label: 'Apply condition',
        access: options.access,
        change: () => readConditionChange(condition.value),
        guidance: 'Choose the condition to apply to the selected copies.',
      }),
    ],
    capture: () => ({ finish: finish.value, condition: condition.value }),
    restore(draft) {
      const restored = readDraft(draft);
      if (restored === null) {
        return;
      }
      if (typeof restored.finish === 'string') {
        finish.value = restored.finish;
      }
      if (typeof restored.condition === 'string') {
        condition.value = restored.condition;
      }
    },
  };
  editor.restore(options.restored);
  return editor;
}

/** The finish one bulk control names, or null while it names none. */
function readFinishChange(value: string): UiCopyChange | null {
  const finish = readUiCatalogFinish(value);
  return finish === null ? null : { finish };
}

/** The condition one bulk control names, or null while it names none. */
function readConditionChange(value: string): UiCopyChange | null {
  switch (value) {
    case '':
      return null;
    case 'unknown':
      return { condition: null };
    default:
      return uiCopyConditions.includes(value as (typeof uiCopyConditions)[number])
        ? { condition: value as (typeof uiCopyConditions)[number] }
        : null;
  }
}

/** Display name of one condition code. */
function conditionName(condition: (typeof uiCopyConditions)[number]): string {
  switch (condition) {
    case 'NM':
      return 'Near mint';
    case 'LP':
      return 'Lightly played';
    case 'MP':
      return 'Moderately played';
    case 'HP':
      return 'Heavily played';
    case 'DMG':
      return 'Damaged';
  }
}

/** One retained draft as a record of values, or null when it carries none. */
function readDraft(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}
