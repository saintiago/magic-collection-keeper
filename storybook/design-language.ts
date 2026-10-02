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

export function mountDesignLanguage(container: HTMLElement): void {
  const document = container.ownerDocument;
  const heading = text(document, 'h2', 'design-heading', 'Design language');
  const intro = note(
    document,
    'The controls below use the same presentation helpers and native semantics as the application.',
  );
  const grid = document.createElement('section');
  grid.className = 'design-grid';
  grid.append(
    typography(document),
    colors(document),
    controls(document),
    states(document),
    card(document),
    notices(document),
    dialog(document),
  );
  container.replaceChildren(heading, intro, grid);
}

function panel(document: Document, title: string): HTMLElement {
  const article = document.createElement('article');
  article.append(text(document, 'h3', '', title));
  return article;
}

function typography(document: Document): HTMLElement {
  const article = panel(document, 'Typography and spacing');
  article.append(
    text(document, 'h2', '', 'Screen heading'),
    text(document, 'h3', '', 'Section heading'),
    note(
      document,
      'Body copy presents provider values as text and keeps controls clearly labeled.',
    ),
    note(document, 'Spacing sample: compact · regular · separated'),
  );
  return article;
}

function colors(document: Document): HTMLElement {
  const article = panel(document, 'Colors');
  const swatches = document.createElement('div');
  swatches.className = 'swatches';
  for (const [name, className] of [
    ['Canvas', ''],
    ['Accent', 'swatch-accent'],
    ['Error', 'swatch-error'],
  ] as const) {
    const swatch = document.createElement('div');
    swatch.className = `swatch ${className}`;
    swatch.textContent = name;
    swatches.append(swatch);
  }
  article.append(swatches);
  return article;
}

function controls(document: Document): HTMLElement {
  const article = panel(document, 'Controls');
  const query = searchInput(document, 'design-search');
  query.placeholder = 'Black Lotus';
  const level = selectControl(
    document,
    [
      { value: 'card', label: 'Cards' },
      { value: 'printing', label: 'Printings' },
    ],
    'card',
  );
  const form = searchForm(document, query, [controlLabel(document, 'Level', level)]);
  const name = textInput(document, 'design-name', 'Commander deck');
  const details = textArea(document, 'design-details', 'One card per line', 200);
  form.append(
    controlLabel(document, 'Name', name),
    controlLabel(document, 'Details', details),
    button(document, 'design-secondary', 'Secondary action'),
    submitButton(document, 'design-submit', 'Save'),
  );
  article.append(form);
  return article;
}

function states(document: Document): HTMLElement {
  const article = panel(document, 'Loading, disabled, empty and validation');
  const pending = statusLine(document, 'design-pending');
  pending.setAttribute('aria-busy', 'true');
  pending.textContent = 'Loading cards';
  const disabled = button(document, 'design-disabled', 'Unavailable');
  disabled.disabled = true;
  const validation = note(document, 'A tag label is required.');
  const empty = note(document, 'No cards match this view.');
  article.append(pending, disabled, validation, empty);
  return article;
}

function card(document: Document): HTMLElement {
  const article = panel(document, 'Card view');
  article.append(
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
  return article;
}

function notices(document: Document): HTMLElement {
  const article = panel(document, 'Success and error notices');
  const notices = createNoticeHost(article);
  notices.show({ id: 'design-success', severity: 'status', message: 'Created “Cube”.' });
  notices.show({
    id: 'design-error',
    severity: 'error',
    message: 'The mock operation could not be completed.',
    action: { label: 'Try again', run: () => undefined },
  });
  return article;
}

function dialog(document: Document): HTMLElement {
  const article = panel(document, 'Dialog');
  const open = button(document, 'design-dialog-open', 'Open confirmation');
  const dialogs = createDialogs(article);
  open.addEventListener('click', () => {
    void dialogs.confirm({
      title: 'Discard pending entry?',
      message: 'This local example changes no application data.',
      cancelLabel: 'Cancel',
      confirmLabel: 'Discard',
    });
  });
  article.append(open);
  return article;
}
