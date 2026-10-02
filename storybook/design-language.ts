/** Design-language half of the local workspace, composed from the shared UI controls. */

import {
  button,
  controlLabel,
  note,
  searchForm,
  searchInput,
  selectControl,
  statusLine,
  submitButton,
  text,
  textArea,
  textInput,
} from '../src/ui/shared/controls.js';
import { createCardViews, createDialogs, createNoticeHost } from '../src/ui/index.js';
import type { ManualProgression } from './progression.js';

export interface DesignLanguage {
  dispose(): void;
}

export function mountDesignLanguage(
  container: HTMLElement,
  progression: ManualProgression,
): DesignLanguage {
  const document = container.ownerDocument;
  const controller = new AbortController();
  const hero = document.createElement('section');
  hero.className = 'design-hero';
  const eyebrow = note(document, 'Reality Fracture · local exploration');
  eyebrow.className = 'design-eyebrow';
  const heading = text(document, 'h2', 'design-heading', 'Design language');
  const intro = note(
    document,
    'A calm collection interface shaped by midnight stone, icy magic and fractured reflections.',
  );
  const guide = document.createElement('a');
  guide.href = '#design-controls';
  guide.textContent = 'Explore the interactive states';
  hero.append(eyebrow, heading, intro, guide);

  const grid = document.createElement('section');
  grid.className = 'design-grid';
  grid.setAttribute('aria-label', 'Reality Fracture presentation examples');
  const noticeExample = notices(document);
  const dialogExample = dialog(document);
  grid.append(
    typography(document),
    colors(document),
    controls(document, progression, controller.signal),
    states(document),
    selection(document),
    card(document),
    noticeExample.element,
    dialogExample.element,
  );
  container.replaceChildren(hero, grid);

  return {
    dispose() {
      controller.abort();
      dialogExample.dispose();
      noticeExample.dispose();
    },
  };
}

function panel(document: Document, title: string, className = ''): HTMLElement {
  const article = document.createElement('article');
  article.className = className;
  article.append(text(document, 'h3', '', title));
  return article;
}

function typography(document: Document): HTMLElement {
  const article = panel(document, 'Typography and spacing', 'design-type');
  const display = text(document, 'h2', '', 'Build a collection across realities');
  const section = text(document, 'h3', '', 'A precise view of every printing');
  const body = note(
    document,
    'Quiet body copy keeps dense collection details readable while expressive headings establish place.',
  );
  const labels = document.createElement('div');
  labels.className = 'spacing-sample';
  for (const [name, size] of [
    ['4px', 'space-1'],
    ['8px', 'space-2'],
    ['16px', 'space-4'],
    ['32px', 'space-8'],
  ] as const) {
    const sample = document.createElement('span');
    sample.className = size;
    sample.textContent = name;
    labels.append(sample);
  }
  article.append(display, section, body, labels);
  return article;
}

function colors(document: Document): HTMLElement {
  const article = panel(document, 'Semantic color', 'design-colors');
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  for (const [name, className] of [
    ['Canvas', 'canvas'],
    ['Surface', 'surface'],
    ['Raised', 'raised'],
    ['Primary text', 'text'],
    ['Secondary text', 'muted'],
    ['Primary accent', 'accent'],
    ['Echo accent', 'echo'],
    ['Success', 'success'],
    ['Warning', 'warning'],
    ['Error', 'error'],
  ] as const) {
    const swatch = document.createElement('div');
    swatch.className = `swatch swatch-${className}`;
    const chip = document.createElement('span');
    chip.setAttribute('aria-hidden', 'true');
    const label = document.createElement('strong');
    label.textContent = name;
    swatch.append(chip, label);
    swatches.append(swatch);
  }
  article.append(swatches);
  return article;
}

function controls(
  document: Document,
  progression: ManualProgression,
  signal: AbortSignal,
): HTMLElement {
  const article = panel(document, 'Controls', 'design-controls');
  article.id = 'design-controls';
  const query = searchInput(document, 'design-search');
  query.placeholder = 'Search by name or oracle text';
  const level = selectControl(
    document,
    [
      { value: 'card', label: 'Cards' },
      { value: 'printing', label: 'Printings' },
    ],
    'card',
  );
  level.id = 'design-level';
  const form = searchForm(document, query, [controlLabel(document, 'Result level', level)]);
  form.className = 'design-search-form';
  const searchResult = statusLine(document, 'design-search-result');
  searchResult.textContent = 'Search examples stay isolated from the mocked collection.';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const phrase = query.value.trim();
    searchResult.textContent =
      phrase.length === 0
        ? 'Enter a card name or expression to search the example.'
        : `Showing ${level.value}-level examples for “${phrase}”.`;
    searchResult.dataset.feedback = phrase.length === 0 ? 'error' : 'success';
  });

  const name = textInput(document, 'design-name', 'Fractured favorites');
  name.required = true;
  name.setAttribute('aria-describedby', 'design-validation');
  const details = textArea(document, 'design-details', 'Cards to revisit across formats', 200);
  const validation = statusLine(document, 'design-validation');
  validation.className = 'field-feedback';
  const secondary = button(document, 'design-secondary', 'Preview details');
  const save = submitButton(document, 'design-submit', 'Save example');
  save.className = 'primary-action';
  const retry = button(document, 'design-retry', 'Retry save');
  retry.hidden = true;
  const saveStatus = statusLine(document, 'design-save-status');
  const editor = document.createElement('form');
  editor.className = 'design-editor';
  editor.noValidate = true;
  editor.append(
    controlLabel(document, 'Collection name', name),
    controlLabel(document, 'Description', details),
    validation,
    secondary,
    save,
    retry,
    saveStatus,
  );

  let generation = 0;
  const beginSave = (): void => {
    const value = name.value.trim();
    if (value.length === 0) {
      name.setAttribute('aria-invalid', 'true');
      validation.textContent = 'Enter a collection name before saving.';
      validation.dataset.feedback = 'error';
      name.focus();
      return;
    }
    name.removeAttribute('aria-invalid');
    validation.textContent = '';
    delete validation.dataset.feedback;
    generation += 1;
    const current = generation;
    save.disabled = true;
    retry.hidden = true;
    saveStatus.textContent = `Saving “${value}”…`;
    saveStatus.dataset.feedback = 'loading';
    saveStatus.setAttribute('aria-busy', 'true');
    void progression
      .wait('Saving gallery example', () => value, signal)
      .then(
        (saved) => {
          if (current !== generation || signal.aborted) return;
          save.disabled = false;
          saveStatus.removeAttribute('aria-busy');
          saveStatus.dataset.feedback = 'success';
          saveStatus.textContent = `Saved “${saved}” in this local example.`;
        },
        (cause: unknown) => {
          if (current !== generation || isAbort(cause)) return;
          save.disabled = false;
          retry.hidden = false;
          saveStatus.removeAttribute('aria-busy');
          saveStatus.dataset.feedback = 'error';
          saveStatus.textContent = 'Save failed in the local example. Retry when ready.';
        },
      );
  };
  editor.addEventListener('submit', (event) => {
    event.preventDefault();
    beginSave();
  });
  retry.addEventListener('click', beginSave);
  secondary.addEventListener('click', () => {
    saveStatus.textContent = `Preview ready: ${details.value.length} description characters.`;
    saveStatus.dataset.feedback = 'success';
  });
  article.append(form, searchResult, editor);
  return article;
}

function states(document: Document): HTMLElement {
  const article = panel(document, 'Loading, disabled, empty and validation', 'design-states');
  const pending = statusLine(document, 'design-pending');
  pending.className = 'state-example state-loading';
  pending.setAttribute('aria-busy', 'true');
  pending.textContent = 'Loading cards';
  const disabled = button(document, 'design-disabled', 'Import unavailable');
  disabled.disabled = true;
  disabled.setAttribute('aria-describedby', 'design-disabled-reason');
  const disabledReason = note(
    document,
    'Import is unavailable while another source is being reviewed.',
  );
  disabledReason.id = 'design-disabled-reason';
  const validation = note(document, 'Error: A tag label is required.');
  validation.className = 'state-example state-error';
  const empty = note(document, 'No cards match this view. Clear a filter to see the collection.');
  empty.className = 'state-example state-empty';
  article.append(pending, disabled, disabledReason, validation, empty);
  return article;
}

function selection(document: Document): HTMLElement {
  const article = panel(document, 'Selection and links');
  const group = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = 'Card density';
  const status = statusLine(document, 'design-selection-status');
  for (const [value, label, checked] of [
    ['calm', 'Calm', true],
    ['compact', 'Compact', false],
  ] as const) {
    const control = document.createElement('input');
    control.type = 'radio';
    control.name = 'design-density';
    control.value = value;
    control.checked = checked;
    control.addEventListener('change', () => {
      status.textContent = `${label} card density selected.`;
      status.dataset.feedback = 'success';
    });
    const option = document.createElement('label');
    option.className = 'selection-option';
    option.append(control, label);
    group.append(option);
  }
  group.prepend(legend);
  const link = document.createElement('a');
  link.href = '#design-controls';
  link.textContent = 'Return to controls';
  article.append(group, status, link);
  return article;
}

function card(document: Document): HTMLElement {
  const article = panel(document, 'Card view', 'design-card-view');
  const example = document.createElement('label');
  example.className = 'card-example';
  const selected = document.createElement('input');
  selected.type = 'checkbox';
  selected.checked = true;
  selected.setAttribute('aria-label', 'Select Lightning Bolt');
  example.append(
    selected,
    createCardViews().basicContent(document, {
      key: 'printing:m11-149',
      target: { kind: 'printing', printingId: 'm11-149' },
      basic: {
        card: { cardId: 'lightning-bolt', name: 'Lightning Bolt', matchedName: null },
        printing: {
          printingId: 'm11-149',
          edition: 'M11',
          collectorNumber: '149',
          language: 'en',
        },
      },
      quantity: { copies: 1, intended: 4 },
    }),
  );
  const noteText = note(document, 'Selected state remains visible after the press feedback ends.');
  article.append(example, noteText);
  return article;
}

function notices(document: Document): { element: HTMLElement; dispose(): void } {
  const article = panel(document, 'Success and error notices');
  const noticeHost = createNoticeHost(article);
  noticeHost.show({
    id: 'design-success',
    severity: 'status',
    message: 'Created “Cube” in the local example.',
  });
  noticeHost.show({
    id: 'design-error',
    severity: 'error',
    message: 'The mock operation could not be completed.',
    action: {
      label: 'Try again',
      run: () => {
        noticeHost.show({
          id: 'design-error',
          severity: 'status',
          message: 'Retry completed in the local example.',
        });
      },
    },
  });
  return { element: article, dispose: () => noticeHost.dispose() };
}

function dialog(document: Document): { element: HTMLElement; dispose(): void } {
  const article = panel(document, 'Confirmation dialog');
  const open = button(document, 'design-dialog-open', 'Open confirmation');
  const outcome = statusLine(document, 'design-dialog-status');
  const dialogs = createDialogs(article);
  open.addEventListener('click', () => {
    void dialogs
      .confirm({
        title: 'Discard pending entry?',
        message: 'This local example changes no application data.',
        cancelLabel: 'Cancel',
        confirmLabel: 'Discard entry',
      })
      .then((confirmed) => {
        outcome.textContent = confirmed
          ? 'Discarded the local example entry.'
          : 'Kept the local example entry.';
        outcome.dataset.feedback = confirmed ? 'success' : 'warning';
        open.focus();
      });
  });
  article.append(open, outcome);
  return { element: article, dispose: () => dialogs.closeAll() };
}

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}
