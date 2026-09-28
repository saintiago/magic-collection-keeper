/**
 * Shared field and control presentation of the UserInterface modules
 * (docs/ui/architecture.md#modules-and-composition).
 *
 * Ordinary buttons, field controls and status lines are shared presentation code, not another
 * workflow component: the pages and editors compose them, and they own no workflow state of their
 * own.
 */

import { UI_LIMITS } from './limits.js';

/** One option of a select control the views present. */
export interface UiSelectOption {
  readonly value: string;
  readonly label: string;
}

/** One select control with the supplied options and an initial value. */
export function selectControl(
  document: Document,
  options: readonly UiSelectOption[],
  value: string,
): HTMLSelectElement {
  const select = document.createElement('select');
  for (const option of options) {
    select.append(optionElement(document, option.value, option.label));
  }
  select.value = value;
  return select;
}

/** One option element. */
export function optionElement(document: Document, value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

/** One control beside its caption; the label names the control it contains. */
export function controlLabel(
  document: Document,
  text: string,
  control: HTMLElement,
): HTMLLabelElement {
  const label = document.createElement('label');
  const caption = document.createElement('span');
  caption.textContent = text;
  label.append(caption, control);
  return label;
}

/** One element of the given heading or paragraph tag with an id and its text. */
export function text<K extends 'h2' | 'h3' | 'p'>(
  document: Document,
  tag: K,
  id: string,
  content: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.id = id;
  element.textContent = content;
  return element;
}

/** One note the views present when they hold no list for an action. */
export function note(document: Document, content: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.textContent = content;
  return element;
}

/** One accessible status line the views report asynchronous progress through. */
export function statusLine(document: Document, id: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.id = id;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  return element;
}

/** One button of the given kind. */
export function button(
  document: Document,
  id: string,
  label: string,
  kind: 'button' | 'submit' = 'button',
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = kind;
  element.id = id;
  element.textContent = label;
  return element;
}

/** One button that submits the form it belongs to. */
export function submitButton(document: Document, id: string, label: string): HTMLButtonElement {
  return button(document, id, label, 'submit');
}

/** One text input with the value the view retained. */
export function textInput(document: Document, id: string, value: string): HTMLInputElement {
  const element = document.createElement('input');
  element.id = id;
  element.type = 'text';
  element.value = value;
  return element;
}

/** One bounded textarea control with the value the view retained. */
export function textArea(
  document: Document,
  id: string,
  value: string,
  bound: number,
): HTMLTextAreaElement {
  const element = document.createElement('textarea');
  element.id = id;
  element.maxLength = bound;
  element.rows = 6;
  element.value = value;
  return element;
}

/** One bounded number input with the value the view retained. */
export function numberInput(
  document: Document,
  id: string,
  value: string,
  bound: number,
): HTMLInputElement {
  const element = document.createElement('input');
  element.id = id;
  element.type = 'number';
  element.min = '1';
  element.max = String(bound);
  element.value = value;
  return element;
}

/** One select control over the given options with a value the caller presented. */
export function select(
  document: Document,
  options: readonly UiSelectOption[],
  value: string,
): HTMLSelectElement {
  return selectControl(document, options, value);
}

/** Message of one rejected operation, or the fallback when the cause carries none. */
export function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

/**
 * The search expression field the browsing and collection pages present. The field carries an id,
 * so the shell restores this page's focus to it when the user returns to the view
 * (docs/ui/architecture.md#state-ownership-and-restoration).
 */
export function searchInput(document: Document, id: string): HTMLInputElement {
  const input = document.createElement('input');
  input.id = id;
  input.type = 'search';
  input.name = 'query';
  // The page bounds the draft it keeps and the URL of a query it links, so the captured input
  // always fits the state the page retains.
  input.maxLength = UI_LIMITS.catalogQuery;
  return input;
}

/** One search form: the expression, the query controls and the control that submits them. */
export function searchForm(
  document: Document,
  input: HTMLInputElement,
  controls: readonly HTMLElement[] = [],
  caption = 'Search cards',
): HTMLFormElement {
  const form = document.createElement('form');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Search';
  form.append(controlLabel(document, caption, input), ...controls, submit);
  return form;
}
