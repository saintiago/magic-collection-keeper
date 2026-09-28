/**
 * Component scope: the CaptureControls presentation of the UserInterface
 * (docs/ui/capture-controls.md, docs/capture.md#interface).
 *
 * The view presents one supplied Capture session: it renders the current provisional evidence,
 * forwards nothing by itself and detaches its preview when it is disposed. Device and staging
 * behavior stay in the session and are exercised in tests/component/capture; the rendered journeys
 * live in tests/browser/capture.spec.ts.
 */

import { describe, expect, it } from 'vitest';

import type {
  Capture,
  CaptureBrowser,
  CaptureBrowserDevice,
  CaptureReading,
  CaptureSnapshot,
} from '../../../src/capture/index.js';
import { createCaptureControls, type UiCaptureControls } from '../../../src/ui/index.js';

/** One element of the minimal document this presentation is asserted with. */
interface FakeElement {
  readonly tagName: string;
  readonly dataset: Record<string, string>;
  readonly attributes: Record<string, string>;
  readonly children: FakeElement[];
  readonly listeners: Map<string, ((event: unknown) => void)[]>;
  id: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  muted: boolean;
  playsInline: boolean;
  srcObject: MediaProvider | null;
  setAttribute(name: string, value: string): void;
  append(...nodes: (FakeElement | string)[]): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  play(): Promise<void>;
}

/** The document the view composes into, with the elements it created. */
interface FakeDocument {
  readonly element: Document;
  find(id: string): FakeElement;
}

function fakeDocument(): FakeDocument {
  const created: FakeElement[] = [];
  const element = (tagName: string): FakeElement => {
    const node: FakeElement = {
      tagName,
      dataset: {},
      attributes: {},
      children: [],
      listeners: new Map(),
      id: '',
      textContent: '',
      hidden: false,
      disabled: false,
      muted: false,
      playsInline: false,
      srcObject: null,
      setAttribute(name, value) {
        node.attributes[name] = value;
      },
      append(...nodes) {
        node.children.push(
          ...(nodes.filter((child) => typeof child !== 'string') as FakeElement[]),
        );
      },
      addEventListener(type, listener) {
        node.listeners.set(type, [...(node.listeners.get(type) ?? []), listener]);
      },
      removeEventListener(type, listener) {
        node.listeners.set(
          type,
          (node.listeners.get(type) ?? []).filter((registered) => registered !== listener),
        );
      },
      play: () => Promise.resolve(),
    };
    created.push(node);
    return node;
  };
  return {
    element: { createElement: (tagName: string) => element(tagName) } as unknown as Document,
    find(id) {
      const found = created.find((node) => node.id === id);
      if (found === undefined) {
        throw new Error(`The view presented no element with id ${id}.`);
      }
      return found;
    },
  };
}

function candidate(name: string): CaptureReading['candidates'][number] {
  return {
    cardId: `card-${name}`,
    printingId: `printing-${name}`,
    name,
    evidence: 'engine-ranking',
  };
}

function reading(overrides: Partial<CaptureReading> = {}): CaptureReading {
  return {
    captureId: 'capture-1',
    attempt: 1,
    revision: 1,
    status: 'possible',
    candidates: [candidate('Lightning Bolt')],
    suggestedPrintingId: 'printing-Lightning Bolt',
    presence: 'single',
    provisional: true,
    uncertain: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CaptureSnapshot> = {}): CaptureSnapshot {
  return {
    status: { kind: 'running', failure: null },
    preview: null,
    attempt: null,
    events: [],
    recoverable: false,
    busy: false,
    running: true,
    ...overrides,
  };
}

/** One supplied session the case publishes its snapshots through. */
interface SuppliedSession extends Capture {
  publish(next: CaptureSnapshot): void;
  readonly disposed: number;
}

function suppliedSession(initial: CaptureSnapshot): SuppliedSession {
  const listeners = new Set<(snapshot: CaptureSnapshot) => void>();
  let disposed = 0;
  return {
    importId: 'import-1',
    accountId: 'alice',
    prepare: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => {},
    retry: () => Promise.resolve(),
    observe(listener) {
      listeners.add(listener);
      listener(initial);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed += 1;
      listeners.clear();
    },
    publish(next) {
      for (const listener of [...listeners]) {
        listener(next);
      }
    },
    get disposed() {
      return disposed;
    },
  };
}

/** The device capability of a deployment whose camera only reports that it has none. */
function device(): CaptureBrowserDevice {
  return { release: () => {} };
}

function controlsFor(session: Capture, document: Document, signal: AbortSignal): UiCaptureControls {
  const capture: CaptureBrowser = {
    createImportId: () => 'import-1',
    create: () => session,
    endAccount: () => {},
  };
  return createCaptureControls({
    document,
    capture,
    accountId: 'alice',
    importId: 'import-1',
    device: device(),
    signal,
    reviewChanged: () => {},
  });
}

describe('capture controls presentation', () => {
  it('presents the current provisional reading and its uncertainty without a cue', () => {
    const session = suppliedSession(snapshot());
    const page = fakeDocument();
    controlsFor(session, page.element, new AbortController().signal);
    const status = page.find('import-camera-status');

    expect(status.textContent).toBe(
      'Scanner ready. Hold one card inside the frame until it is accepted.',
    );
    expect(status.dataset.uiCaptureCue).toBe('idle');

    session.publish(
      snapshot({
        attempt: {
          captureId: 'capture-1',
          attempt: 1,
          reading: reading({
            uncertain: true,
            candidates: [candidate('Lightning Bolt'), candidate('Sol Ring')],
          }),
        },
      }),
    );

    // The candidates the reading holds are presented as provisional evidence, with their
    // disagreement, and without a success cue or a certain suggestion
    // (docs/ui/capture-controls.md#presentation-and-lifetime).
    expect(status.textContent).toBe(
      'Reading one of Lightning Bolt, Sol Ring. Identification is uncertain.',
    );
    expect(status.dataset.uiCaptureCue).toBe('idle');
  });

  it('presents a newer reading of the same attempt in place of the earlier one', () => {
    const session = suppliedSession(snapshot());
    const page = fakeDocument();
    controlsFor(session, page.element, new AbortController().signal);
    const status = page.find('import-camera-status');

    session.publish(
      snapshot({
        attempt: { captureId: 'capture-1', attempt: 1, reading: reading() },
      }),
    );
    expect(status.textContent).toBe('Reading Lightning Bolt.');

    session.publish(
      snapshot({
        attempt: {
          captureId: 'capture-1',
          attempt: 1,
          reading: reading({ revision: 2, candidates: [candidate('Sol Ring')] }),
        },
      }),
    );
    expect(status.textContent).toBe('Reading Sol Ring.');
  });

  it('detaches its preview and disposes the session it owns, once', () => {
    const stream = {} as MediaStream;
    const session = suppliedSession(snapshot({ preview: { stream } }));
    const page = fakeDocument();
    const controls = controlsFor(session, page.element, new AbortController().signal);
    const preview = page.find('import-camera-preview');
    expect(preview.srcObject).toBe(stream);
    expect(preview.hidden).toBe(false);

    controls.dispose();

    // Disposal detaches what the view attached and releases the session it created
    // (docs/ui/capture-controls.md#presentation-and-lifetime).
    expect(preview.srcObject).toBeNull();
    expect(preview.hidden).toBe(true);
    expect(session.disposed).toBe(1);

    const status = page.find('import-camera-status');
    const presented = status.textContent;
    session.publish(
      snapshot({
        attempt: { captureId: 'capture-1', attempt: 1, reading: reading() },
      }),
    );
    expect(status.textContent).toBe(presented);

    controls.dispose();
    expect(session.disposed).toBe(1);
  });

  it('disposes with the view signal it observes', () => {
    const stream = {} as MediaStream;
    const session = suppliedSession(snapshot({ preview: { stream } }));
    const page = fakeDocument();
    const controller = new AbortController();
    controlsFor(session, page.element, controller.signal);

    controller.abort();

    expect(page.find('import-camera-preview').srcObject).toBeNull();
    expect(session.disposed).toBe(1);
    controller.abort();
    expect(session.disposed).toBe(1);
  });
});
