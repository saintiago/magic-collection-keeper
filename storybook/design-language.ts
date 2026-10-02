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
  const figure = document.createElement('figure');
  figure.className = 'card-sample';
  const image = document.createElement('img');
  image.src = './card-back.svg';
  image.alt = 'Local fixture for Lightning Bolt';
  const caption = document.createElement('figcaption');
  caption.textContent = 'Lightning Bolt — M11 · 149 · EN';
  figure.append(image, caption);
  article.append(figure);
  return article;
}

function notices(document: Document): HTMLElement {
  const article = panel(document, 'Success and error notices');
  const success = statusLine(document, 'design-success');
  success.textContent = 'Created “Cube”.';
  const failure = document.createElement('p');
  failure.className = 'error-notice';
  failure.setAttribute('role', 'alert');
  failure.textContent = 'Error: the mock operation could not be completed.';
  article.append(success, failure);
  return article;
}

function dialog(document: Document): HTMLElement {
  const article = panel(document, 'Dialog');
  const open = button(document, 'design-dialog-open', 'Open confirmation');
  const modal = document.createElement('dialog');
  modal.append(
    text(document, 'h3', '', 'Discard pending entry?'),
    note(document, 'This local example changes no application data.'),
  );
  const cancel = button(document, 'design-dialog-cancel', 'Cancel');
  const confirm = button(document, 'design-dialog-confirm', 'Discard');
  modal.append(cancel, confirm);
  open.addEventListener('click', () => modal.showModal());
  cancel.addEventListener('click', () => modal.close());
  confirm.addEventListener('click', () => modal.close());
  article.append(open, modal);
  return article;
}
