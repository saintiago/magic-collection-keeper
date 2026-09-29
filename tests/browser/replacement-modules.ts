/**
 * A replacement presentation of the UserInterface for the module-substitution journeys
 * (docs/ui/architecture.md#replacement-check, docs/ui/card-views.md#replacement-evidence).
 *
 * The replacement wraps the default CardViews and marks what the composed pages and editors ask
 * of it: the detail presentation it returns, the basic information it renders and the picker it
 * mounts. A page or editor that kept its own rendering would leave these marks absent, so the
 * journeys prove that replacing the module needs no consumer change.
 */

import {
  createCaptureControls,
  createCardViews,
  createEditors,
  type CardViews,
} from '../../src/ui/index.js';

/** One marked element of the replacement presentation. */
function mark(document: Document, dataset: string, text: string): HTMLElement {
  const element = document.createElement('span');
  element.dataset[dataset] = '';
  element.textContent = text;
  return element;
}

/** The replaceable presentation modules with a marked CardViews. */
export function replacementModules() {
  const base = createCardViews();
  const cardViews: CardViews = {
    basicContent(document, entry) {
      const content = mark(document, 'uiReplacementBasic', `REPLACEMENT ${entry.key} `);
      content.append(base.basicContent(document, entry));
      return content;
    },
    detail(options) {
      const detail = base.detail(options);
      const line = mark(options.document, 'uiReplacementDetail', 'REPLACEMENT DETAIL');
      return { nodes: [line, ...detail.nodes] };
    },
    list(options) {
      return base.list(options);
    },
    picker(options) {
      const list = base.picker(options);
      options.container.append(
        mark(options.container.ownerDocument, 'uiReplacementPicker', 'REPLACEMENT PICKER'),
      );
      return list;
    },
    openEntries(options) {
      return base.openEntries(options);
    },
  };
  return {
    cardViews,
    editors: createEditors({ cardViews }),
    captureControls: createCaptureControls,
  };
}
