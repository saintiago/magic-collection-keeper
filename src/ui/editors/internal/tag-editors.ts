/**
 * Tag editors of the UserInterface (docs/ui/editors.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * The tags editor presents the account's tags in a bounded window and creates and renames them.
 * The tag view editor presents one tag's associations as a bounded CardList: a card or printing
 * association is presented with its intended quantity and can be given another quantity or
 * refined between the card and printing levels, an association can be removed, and a copy's single
 * physical location can be moved. Beside it, a search over the Catalog and the account's own
 * copies offers the entries to add to the tag, so a wishlist can name a card or one exact printing
 * and a location can take a copy. Every change quotes the revision the editor read, unsaved input
 * stays in the form after a conflict or a failed edit, and a saved outcome is presented only after
 * the operation reported it committed. Every provider value renders as text.
 */

import type { Association, AssociationTargetLevel, Tag } from '../../../usercards/index.js';
import {
  associationKey,
  cardListEntryKey,
  isInvalidatedContinuation,
  referenceOfAssociation,
  type CardListBrowser,
  type CardListEntry,
  type CardListFragmentReader,
  type CardListPickerQuery,
  type CardListRetained,
  type CardListTagAssociations,
  type CardListToolSelection,
} from '../../../card-list/index.js';

import type { CardViews, UiCardList, UiEntryOwnership } from '../../card-views/index.js';
import { UI_LIMITS } from '../../shared/limits.js';
import { controlLabel, replaceChildrenKeepingFocus } from '../../shared/controls.js';
import type { UiDialogs } from '../../shared/dialogs.js';
import { reportUiFailure, type UiNotices } from '../../shared/notices.js';
import { readRetainedList, readState } from '../../shared/state.js';
import type { UiActionIntent } from '../../shared/actions.js';
import { readUiCollectionLevel } from '../../shared/vocabulary.js';
import {
  addToTagTool,
  createTag,
  moveCopyById,
  removeAssociation,
  renameTag,
  saveAssociation,
  uiAssociationLevelsByTagKind,
  uiAssociationLevelLabel,
  uiTagKindLabel,
  uiTagKinds,
  type UiChangeOutcome,
  type UiTagAccess,
  type UiTagKind,
} from './tag-edits.js';
import {
  applyAction,
  outcomeText,
  reportUiOperation,
  type UiOperationOutcome,
} from './operations.js';
import { printingChoiceGuidance, singlePrintingChoice } from './printing-choice.js';

/** Notice identities of the organization operations, one per operation a view presents. */
const tagListReadNotice = 'tags:list';
const tagCreateNotice = 'tags:create';
const tagViewReadNotice = 'tag:read';
const tagViewRenameNotice = 'tag:rename';
const tagViewAddNotice = 'tag:add';
const tagViewLocationsNotice = 'tag:locations';

/** The reported presentation of one list's retention, or null when this visit restored none. */
function presentedOf<Context>(list: UiCardList<Context>): Promise<void> | null {
  return list.restoration === null ? null : list.restoration.presented.then(() => undefined);
}

/** The page state a previous visit retained, or null when it kept none. */
function readPageState(value: unknown): Readonly<Record<string, unknown>> | null {
  return readState(value);
}

/** The list state one retained owner kept, or undefined when this visit restored none. */
function readListState<Context>(
  value: Readonly<Record<string, unknown>> | null,
): CardListRetained<Context> | undefined {
  return readRetainedList<Context>(value);
}

/** What every organization editor receives from the page that composes it. */
export interface UiTagEditorContext {
  readonly document: Document;
  /** Private tag, association and location access over the supplied UserCards contract. */
  readonly access: UiTagAccess;
  /** CardList capability the editors describe their lists to. */
  readonly cardList: CardListBrowser;
  /** CardViews module the editors render their lists with. */
  readonly cardViews: CardViews;
  /** Verified account the editors present. */
  readonly accountId: string;
  /** Brief confirmation dialogs the shell supplies for removals. */
  readonly dialogs: UiDialogs;
  /** Aborted when the view closes; late results must not change a replacement view. */
  readonly signal: AbortSignal;
  /**
   * Floating notices of the shell: the editors report the operation and service failures they
   * present, so a failure stays visible after the view is left
   * (docs/ui/navigation.md#error-notices).
   */
  readonly notices?: UiNotices;
}

export interface UiTagListEditorOptions extends UiTagEditorContext {
  /** Page state a previous visit retained; the editor reads only its own fields. */
  readonly restored?: Readonly<Record<string, unknown>> | null;
  /** Location one presented tag's view is reached at; the page owns the route vocabulary. */
  tagHref(tag: Tag): string;
}

/**
 * The tags editor: the account's tags in a bounded window, the form that creates one and the
 * rename control of every presented tag (docs/ui/editors.md#internal-design).
 */
export interface UiTagListEditor {
  /** The editor's content, in presentation order. */
  readonly nodes: readonly Node[];
  capture(): unknown;
  dispose(): void;
}

export function createTagListEditor(options: UiTagListEditorOptions): UiTagListEditor {
  const document = options.document;
  const restored = readPageState(options.restored ?? null);
  const access = options.access;
  const heading = text(document, 'h2', 'tags-heading', 'Your tags');
  const createForm = document.createElement('form');
  createForm.id = 'tag-create';
  const kind = select(
    document,
    uiTagKinds.map((value) => ({ value, label: uiTagKindLabel(value) })),
    readUiTagKind(restored?.kind) ?? 'deck',
  );
  kind.id = 'tag-create-kind';
  const label = textInput(document, 'tag-create-label', '');
  label.maxLength = UI_LIMITS.entryKey;
  if (typeof restored?.label === 'string') {
    label.value = restored.label;
  }
  const create = submitButton(document, 'tag-create-submit', 'Create tag');
  createForm.append(
    controlLabel(document, 'Kind', kind),
    controlLabel(document, 'Label', label),
    create,
  );
  const createStatus = statusLine(document, 'tag-create-status');
  const listStatus = statusLine(document, 'tags-status');
  const list = document.createElement('ul');
  list.id = 'tags-list';
  const more = button(document, 'tags-more', 'More tags');
  const retry = button(document, 'tags-retry', 'Retry');
  retry.hidden = true;
  const nodes: readonly Node[] = [heading, createForm, createStatus, listStatus, list, more, retry];

  /** Tags the page presents now, in stable identity order within the retained bound. */
  let tags: readonly Tag[] = readRetainedTags(restored?.tags) ?? [];
  let continuation = readContinuation(restored?.continuation);
  let complete = restored?.complete === true;
  /**
   * Source position of the first presented tag, kept with the history entry so returning to
   * this page re-acquires the window the user browsed instead of the account's first tags
   * (docs/user-interface.md#pages-and-navigation).
   */
  let start = readTagPosition(restored?.position);
  let loading = false;
  let error: string | null = null;
  let closed = options.signal.aborted;
  /**
   * Version of the presented window. A read captures it and only publishes its answer while it
   * is still current, so a late response never replaces a newer window and a change the user
   * just committed is never wiped out by a read that started before it
   * (docs/user-interface.md#state-ownership-and-restoration).
   */
  let version = 0;
  /** Unsaved rename input per tag, kept across paging and with the history entry. */
  const drafts = readDrafts(restored?.drafts);
  const rows = new Map<string, UiTagRow>();
  /** Source position of every presented tag, so the window can be read again from its start. */
  const positions = new Map<string, UiTagPosition>();
  options.signal.addEventListener(
    'abort',
    () => {
      closed = true;
    },
    { once: true },
  );

  paint();
  // The retained window is re-read from the provider from the position it held until it is
  // covered again; the retained tags stay presented while that read is unavailable
  // (docs/user-interface.md#state-ownership-and-restoration).
  void readWindow(tags.length);

  createForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCreate();
  });
  more.addEventListener('click', () => {
    void loadMore();
  });
  retry.addEventListener('click', () => {
    void readWindow(tags.length);
  });

  return {
    nodes,
    capture: () => ({
      tags,
      continuation,
      complete,
      position: start,
      drafts: Object.fromEntries(drafts),
      kind: kind.value,
      label: label.value,
    }),
    dispose: () => {
      closed = true;
    },
  };

  /** Creates one tag; a conflict or a failure keeps the unsaved label for the retry. */
  async function submitCreate(): Promise<void> {
    const wanted = label.value.trim();
    if (wanted.length === 0) {
      createStatus.textContent = 'A tag label is required.';
      return;
    }
    createStatus.textContent = 'Creating…';
    const outcome = await createTag(
      access,
      { kind: readUiTagKind(kind.value) ?? 'other', label: wanted },
      options.signal,
    );
    if (closed) {
      return;
    }
    if (outcome.record !== null) {
      publish(outcome.record);
      if (outcome.status === 'committed' && label.value.trim() === wanted) {
        label.value = '';
      }
    } else if (outcome.status === 'unknown') {
      // A lost create response: the list is read again, so a tag the service committed appears
      // for review while the unsaved label stays in the form.
      void readWindow(tags.length);
    }
    const message =
      outcome.status === 'unknown'
        ? 'The outcome is unknown. Check whether the tag appears in the list before retrying.'
        : (outcome.message ?? `Created “${wanted}”.`);
    createStatus.textContent = message;
    // The unsaved label stays beside the field; the failure stays visible as the shell's notice
    // with the recovery read that checks what the account actually holds
    // (docs/ui/navigation.md#error-notices).
    reportUiOperation(
      options.notices,
      tagCreateNotice,
      { status: outcome.status, message },
      {
        label: 'Check the tags',
        run: () => {
          void readWindow(tags.length);
        },
      },
    );
    paint();
  }

  /** Renames one presented tag through the row that owns the unsaved input. */
  async function submitRename(row: UiTagRow): Promise<void> {
    const wanted = row.input.value.trim();
    if (wanted.length === 0) {
      row.status.textContent = 'A tag label is required.';
      return;
    }
    const tag = find(row.tagId);
    if (tag === null) {
      row.status.textContent = 'This tag is no longer in the list.';
      return;
    }
    row.status.textContent = 'Saving…';
    const outcome = await renameTag(
      access,
      { tagId: tag.tagId, expectedRevision: tag.revision, label: wanted },
      options.signal,
    );
    if (closed) {
      return;
    }
    if (outcome.record !== null) {
      publish(outcome.record);
      if (outcome.status === 'committed' && row.input.value.trim() === wanted) {
        // Only a committed rename replaces the unsaved label the row kept; a state a lost
        // response recovered stays beside the user's own input for review
        // (docs/user-interface.md#browsing-and-organization).
        drafts.delete(outcome.record.tagId);
        row.input.value = outcome.record.label;
      }
    }
    row.status.textContent = outcome.message ?? 'Renamed the tag.';
    // The row keeps the unsaved label for the retry; the notice keeps the failure visible when
    // the view is left (docs/ui/navigation.md#error-notices).
    reportUiOperation(options.notices, `tags:rename:${tag.tagId}`, outcome);
    if (outcome.status === 'conflict') {
      // The tag changed meanwhile: its saved state is offered for review while the unsaved
      // label stays in the row for the retry.
      const current = await readTag(access, tag.tagId, options.signal).catch(() => null);
      if (!closed && current !== null) {
        publish(current);
      }
    }
    paint();
  }

  /**
   * Reads the account's tags from the position the presented window starts at until the
   * requested number of tags is covered or the list ends, and presents that fresh window. A
   * failure keeps the retained tags and reports the retry; a response a newer read or change
   * superseded never replaces the active window.
   */
  async function readWindow(cover: number, preserved: readonly Tag[] = []): Promise<void> {
    if (closed) {
      return;
    }
    const current = beginRead();
    const read: Tag[] = [];
    const readPositions = new Map<string, UiTagPosition>();
    let next: string | null = start?.continuation ?? null;
    let offset = start?.offset ?? 0;
    try {
      for (;;) {
        const page = await access.list(
          {
            pageSize: access.constraints.pages.tags.default,
            ...(next === null ? {} : { continuation: next }),
          },
          options.signal,
        );
        if (closed || current !== version) {
          return;
        }
        page.tags.forEach((candidate, index) => {
          if (index < offset || candidate.system) {
            return;
          }
          const known = find(candidate.tagId);
          read.push(known !== null && known.revision > candidate.revision ? known : candidate);
          readPositions.set(candidate.tagId, { continuation: next, offset: index });
        });
        next = page.continuation;
        offset = 0;
        if (next === null || read.length >= Math.min(cover, UI_LIMITS.listWindow)) {
          break;
        }
      }
    } catch (cause) {
      if (closed || current !== version) {
        return;
      }
      if (next !== null && isInvalidatedContinuation(cause)) {
        // The private records changed since this page was read: the window is read again from
        // the account's list instead of repeating a continuation the change invalidated.
        start = null;
        void readWindow(cover, preserved);
        return;
      }
      error = readMessage(cause, 'The tags could not be loaded.');
      loading = false;
      paint();
      reportUiFailure(options.notices, tagListReadNotice, error, {
        label: 'Load the tags again',
        run: () => {
          void readWindow(cover, preserved);
        },
      });
      return;
    }
    if (closed || current !== version) {
      return;
    }
    const acquired = new Map(read.map((candidate) => [candidate.tagId, candidate]));
    for (const candidate of preserved) {
      if ((acquired.get(candidate.tagId)?.revision ?? 0) < candidate.revision) {
        acquired.set(candidate.tagId, candidate);
      }
    }
    tags = [...acquired.values()]
      .sort((left, right) => (left.tagId < right.tagId ? -1 : left.tagId > right.tagId ? 1 : 0))
      .slice(-UI_LIMITS.listWindow);
    positions.clear();
    for (const [tagId, position] of readPositions) positions.set(tagId, position);
    continuation = next;
    complete = next === null;
    retirePositions();
    start = windowStart();
    loading = false;
    error = null;
    paint();
    options.notices?.dismiss(tagListReadNotice);
  }

  /** Appends the next page of tags, retiring the oldest beyond the retained window. */
  async function loadMore(): Promise<void> {
    const requested = continuation;
    if (closed || loading || requested === null) {
      return;
    }
    const current = beginRead();
    try {
      const page = await access.list(
        { pageSize: access.constraints.pages.tags.default, continuation: requested },
        options.signal,
      );
      if (closed || current !== version) {
        return;
      }
      const seen = new Set(tags.map((tag) => tag.tagId));
      const added: Tag[] = [];
      page.tags.forEach((candidate, index) => {
        if (candidate.system || seen.has(candidate.tagId)) {
          return;
        }
        added.push(candidate);
        positions.set(candidate.tagId, { continuation: requested, offset: index });
      });
      tags = [...tags, ...added].slice(-UI_LIMITS.listWindow);
      continuation = page.continuation;
      complete = continuation === null;
      retirePositions();
      start = windowStart();
    } catch (cause) {
      if (closed || current !== version) {
        return;
      }
      if (isInvalidatedContinuation(cause)) {
        // The further page belongs to a superseded revision: the retained window is read from
        // its own position again instead of repeating the unusable cursor.
        start = null;
        void readWindow(tags.length);
        return;
      }
      error = readMessage(cause, 'The tags could not be loaded.');
    }
    loading = false;
    paint();
    if (error !== null) {
      reportUiFailure(options.notices, tagListReadNotice, error, {
        label: 'Load the tags again',
        run: () => {
          void readWindow(tags.length);
        },
      });
    } else {
      options.notices?.dismiss(tagListReadNotice);
    }
  }

  /** Starts one window-changing read: it supersedes every read the page started earlier. */
  function beginRead(): number {
    version += 1;
    loading = true;
    error = null;
    paint();
    return version;
  }

  /**
   * Publishes one tag the account just changed: it enters the window and supersedes the reads
   * that started before the change, so no late answer replaces the committed state.
   */
  function publish(tag: Tag): void {
    if ((find(tag.tagId)?.revision ?? 0) > tag.revision) return;
    const interrupted = loading;
    version += 1;
    loading = false;
    error = null;
    keep(tag);
    if (interrupted) {
      void readWindow(tags.length, tags);
    }
  }

  /** Keeps one provider-published tag in the window, ordered by stable identity. */
  function keep(tag: Tag): void {
    if ((find(tag.tagId)?.revision ?? 0) > tag.revision) {
      return;
    }
    const kept = tags.filter((candidate) => candidate.tagId !== tag.tagId);
    const at = kept.findIndex((candidate) => candidate.tagId > tag.tagId);
    tags = (at === -1 ? [...kept, tag] : [...kept.slice(0, at), tag, ...kept.slice(at)]).slice(
      -UI_LIMITS.listWindow,
    );
    retirePositions();
    start = windowStart();
    paint();
  }

  /** Source position of the first presented tag; the retained position when it is unknown. */
  function windowStart(): UiTagPosition | null {
    const first = tags[0];
    return first === undefined ? null : (positions.get(first.tagId) ?? start);
  }

  /** Drops the source positions of tags the presented window no longer holds. */
  function retirePositions(): void {
    const presented = new Set(tags.map((tag) => tag.tagId));
    for (const tagId of positions.keys()) {
      if (!presented.has(tagId)) {
        positions.delete(tagId);
      }
    }
  }

  function find(tagId: string): Tag | null {
    return tags.find((tag) => tag.tagId === tagId) ?? null;
  }

  function draftOf(tagId: string, fallback: string): string {
    return drafts.get(tagId) ?? fallback;
  }

  /** Presents the window: one row per tag, the paging controls and the reported failure. */
  function paint(): void {
    const presented = new Set<string>();
    const nodes: Node[] = [];
    for (const tag of tags) {
      presented.add(tag.tagId);
      let row = rows.get(tag.tagId);
      if (row === undefined) {
        row = tagRow(
          document,
          tag,
          options.tagHref(tag),
          draftOf(tag.tagId, tag.label),
          drafts,
          (edited) => {
            void submitRename(edited);
          },
        );
        rows.set(tag.tagId, row);
      }
      row.paint(tag);
      nodes.push(row.element);
    }
    for (const [tagId, row] of rows) {
      if (!presented.has(tagId)) {
        row.element.remove();
        rows.delete(tagId);
      }
    }
    const current = [...list.children];
    if (nodes.length !== current.length || nodes.some((node, index) => node !== current[index])) {
      list.replaceChildren(...nodes);
    }
    more.hidden = complete;
    more.disabled = loading;
    retry.hidden = error === null;
    listStatus.textContent =
      error ??
      (loading ? 'Loading tags…' : tags.length === 0 ? 'No tags yet. Create one above.' : '');
  }
}

/** One presented tag row: its link to the tag view, its saved label and its rename control. */
interface UiTagRow {
  readonly element: HTMLLIElement;
  readonly tagId: string;
  readonly input: HTMLInputElement;
  readonly status: HTMLParagraphElement;
  paint(tag: Tag): void;
}

/** Source position of one tag inside the account's tag list: the page that supplied it and its offset. */
interface UiTagPosition {
  readonly continuation: string | null;
  readonly offset: number;
}

function tagRow(
  document: Document,
  tag: Tag,
  href: string,
  label: string,
  drafts: Map<string, string>,
  rename: (row: UiTagRow) => void,
): UiTagRow {
  const element = document.createElement('li');
  element.dataset.uiTag = tag.tagId;
  const open = document.createElement('a');
  open.id = `tag-link-${encodeURIComponent(tag.tagId)}`;
  open.href = href;
  const kind = document.createElement('span');
  kind.dataset.uiTagKind = '';
  const form = document.createElement('form');
  const input = textInput(document, `tag-label-${encodeURIComponent(tag.tagId)}`, label);
  input.maxLength = UI_LIMITS.entryKey;
  input.addEventListener('input', () => {
    drafts.delete(tag.tagId);
    drafts.set(tag.tagId, input.value);
    boundDrafts(drafts);
  });
  const save = submitButton(document, `tag-rename-${encodeURIComponent(tag.tagId)}`, 'Save label');
  form.append(controlLabel(document, 'Label', input), save);
  const status = statusLine(document, `tag-row-status-${encodeURIComponent(tag.tagId)}`);
  element.append(open, kind, form, status);
  const row: UiTagRow = {
    element,
    tagId: tag.tagId,
    input,
    status,
    paint(saved) {
      open.textContent = saved.label;
      kind.textContent = ` ${uiTagKindLabel(kindOf(saved.kind))}`;
    },
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    rename(row);
  });
  return row;
}

export interface UiTagViewEditorOptions extends UiTagEditorContext {
  /** Identity of the tag this view presents. */
  readonly tagId: string;
  /** Page state a previous visit retained; the editor reads only its own fields. */
  readonly restored?: Readonly<Record<string, unknown>> | null;
  /** Location of the tags list, presented when this tag cannot be read. */
  readonly backHref: string;
}

/**
 * The tag view editor: one tag's associations, its editable label and the search that adds
 * members, with the intended quantity, the card/printing refinement, the removal and the single
 * physical location of a copy (docs/ui/editors.md#internal-design).
 */
export interface UiTagViewEditor {
  /** The editor's content, in presentation order. */
  readonly nodes: readonly Node[];
  capture(): unknown;
  /** Resolves once the editor presented the retained content of its history entry. */
  presentation(): Promise<void>;
  dispose(): void;
}

export function createTagViewEditor(options: UiTagViewEditorOptions): UiTagViewEditor {
  const tagId = options.tagId;
  const document = options.document;
  const restored = readPageState(options.restored ?? null);
  const access = options.access;
  const presented = Promise.withResolvers<void>();
  // A page whose presentation the shell never awaits must still not surface a rejection.
  presented.promise.catch(() => {});
  let closed = options.signal.aborted;
  options.signal.addEventListener(
    'abort',
    () => {
      closed = true;
    },
    { once: true },
  );

  const heading = text(document, 'h2', 'tag-heading', 'Tag');
  const kindLine = text(document, 'p', 'tag-kind', '');
  const renameForm = document.createElement('form');
  renameForm.id = 'tag-rename';
  const labelInput = textInput(document, 'tag-label', '');
  labelInput.maxLength = UI_LIMITS.entryKey;
  // Initialize from the saved label only until restoration or user input owns the field.
  const restoredLabel = typeof restored?.label === 'string' ? restored.label : null;
  let labelTouched = restoredLabel !== null;
  labelInput.addEventListener('input', () => {
    labelTouched = true;
  });
  if (restoredLabel !== null) {
    labelInput.value = restoredLabel;
  }
  const renameSubmit = submitButton(document, 'tag-rename-submit', 'Save label');
  renameForm.append(controlLabel(document, 'Label', labelInput), renameSubmit);
  const renameStatus = statusLine(document, 'tag-rename-status');
  const associationsHeading = text(document, 'h3', 'tag-associations-heading', 'Associations');
  const associationsStatus = statusLine(document, 'tag-associations-status');
  const associationsHost = document.createElement('div');
  associationsHost.id = 'tag-associations';
  const locationsStatus = statusLine(document, 'tag-locations-status');
  const locationsMore = button(document, 'tag-locations-more', 'More locations');
  locationsMore.hidden = true;
  const addHeading = text(document, 'h3', 'tag-add-heading', 'Add to this tag');
  const addForm = document.createElement('form');
  addForm.id = 'tag-add';
  const query = textInput(document, 'tag-add-query', '');
  query.type = 'search';
  query.maxLength = UI_LIMITS.catalogQuery;
  const level = document.createElement('select');
  level.id = 'tag-add-level';
  const quantity = document.createElement('input');
  quantity.type = 'number';
  quantity.id = 'tag-add-quantity';
  quantity.min = '1';
  quantity.max = String(access.constraints.quantity.association);
  const addSubmit = submitButton(document, 'tag-add-submit', 'Search');
  // The region keeps the results list beside the editor's own presentation of the action it
  // offers: the list reports the intent, the editor runs it and presents what the provider
  // established (docs/ui/editors.md#interface).
  const addRegion = document.createElement('div');
  addRegion.id = 'tag-add-results';
  const addHost = document.createElement('div');
  const addStatus = statusLine(document, 'tag-add-status');
  addStatus.dataset.uiOutcome = '';
  addRegion.append(addHost, addStatus);
  const restoredAdd = readAddDraft(restored?.add);
  query.value = restoredAdd?.text ?? '';
  quantity.value = restoredAdd?.quantity ?? '1';
  const nodes: readonly Node[] = [
    heading,
    kindLine,
    renameForm,
    renameStatus,
    associationsHeading,
    associationsStatus,
    associationsHost,
    locationsStatus,
    locationsMore,
    addHeading,
    addForm,
    addRegion,
  ];

  /** Tag the page presents; null until it is read or after a failed read. */
  let tag: Tag | null = null;
  /**
   * CardList binding of the presented tag: it owns the association read, its translation and
   * the provider records the editors review under an association's own key
   * (docs/card-list.md#required-interfaces-and-source-bindings).
   */
  let associationRecords: CardListTagAssociations | null = null;
  /** Editors of the presented association rows, redrawn as their choices or records change. */
  const editors = new Map<string, UiAssociationEditor>();
  /**
   * Printing pickers of the card-level associations whose owner asked to refine them, keyed by
   * the association's entry key. Each picker is one CardViews list over the card's published
   * printings, so acquiring them, their continuation and the recovery of a failed page stay with
   * CardList (docs/card-list.md#interface, docs/ui/editors.md#interface).
   */
  const printingPickers = new Map<string, UiPrintingPicker>();
  /** Location tags the page offers for a move; the presented tag is always offered. */
  let locations: UiLocationOffer = {
    tags: [],
    continuation: null,
    loading: false,
    error: null,
  };
  /** Supersedes an outstanding location read when a newer one starts. */
  let locationVersion = 0;
  /** Unsaved association input per association, kept across redraws and with the history entry. */
  const drafts = readAssociationDrafts(restored?.drafts);
  let associations: UiCardList<string> | null = null;
  let addList: UiCardList<CardListPickerQuery> | null = null;
  /** Whether one add action is in flight; a further intent is ignored instead of run twice. */
  let adding = false;
  /** The retained list states, kept while the lists are not composed yet. */
  const retainedAssociations = readPageState(restored?.associations);
  const retainedResults = readPageState(restored?.results);

  renameForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitRename();
  });
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    search();
  });
  locationsMore.addEventListener('click', () => {
    void readLocations(locations.continuation);
  });
  void open();

  return {
    nodes,
    capture: captureState,
    presentation: () => presented.promise,
    dispose: () => {
      closed = true;
      associations?.dispose();
      addList?.dispose();
      for (const key of [...printingPickers.keys()]) {
        releasePrintingPicker(key);
      }
    },
  };

  function captureState(): unknown {
    return {
      label: labelInput.value,
      add: { text: query.value, level: level.value, quantity: quantity.value },
      // Unsaved association input stays with the entry, so leaving the view and returning to it
      // keeps the edits the user was asked to review
      // (docs/user-interface.md#state-ownership-and-restoration).
      drafts: Object.fromEntries([...drafts].map(([id, draft]) => [id, { ...draft }])),
      // A list not composed yet keeps the state its entry handed back instead of overwriting
      // it with a partially presented view
      // (docs/user-interface.md#state-ownership-and-restoration).
      associations: associations === null ? retainedAssociations : { list: associations.capture() },
      results: addList === null ? retainedResults : { list: addList.capture() },
    };
  }

  /** Reads the presented tag and composes the view around it. */
  async function open(): Promise<void> {
    let read: Tag | null;
    let failure: string | null = null;
    try {
      read = await readTag(access, tagId, options.signal);
    } catch (cause) {
      read = null;
      failure = readMessage(cause, 'The tag could not be loaded.');
    }
    if (closed) {
      return;
    }
    if (failure === null) {
      options.notices?.dismiss(tagViewReadNotice);
    }
    if (read === null || read.system) {
      const problem =
        read === null ? failure : 'System tags are managed through their own lifecycle operations.';
      presentMissing(problem);
      if (read === null && failure !== null) {
        // A tag the account could not read is a service failure: the view presents the back
        // destination beside it and the notice keeps the failure visible
        // (docs/ui/navigation.md#error-notices).
        reportUiFailure(options.notices, tagViewReadNotice, failure);
      }
      presented.resolve();
      return;
    }
    tag = read;
    heading.textContent = read.label;
    kindLine.textContent = `Kind: ${uiTagKindLabel(kindOf(read.kind))}`;
    if (!labelTouched) {
      labelInput.value = read.label;
    }
    const levels = uiAssociationLevelsByTagKind[kindOf(read.kind)];
    for (const value of levels) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = uiAssociationLevelLabel(value);
      level.append(option);
    }
    level.value = readAddLevel(restoredAdd?.level) ?? levels[0] ?? 'card';
    const location = kindOf(read.kind) === 'location';
    addHeading.textContent = location ? 'Move copies into this location' : 'Add to this tag';
    addForm.append(controlLabel(document, 'Find', query), controlLabel(document, 'Level', level));
    if (!location) {
      addForm.append(controlLabel(document, 'Intended quantity', quantity));
    }
    addForm.append(addSubmit);
    const bindings = options.cardList.account(options.accountId);
    const associationBinding = bindings.tagAssociations(tagId);
    associationRecords = associationBinding;
    const list = options.cardViews.list({
      container: associationsHost,
      create: options.cardList.create,
      source: associationBinding.source,
      context: tagId,
      accountId: options.accountId,
      pageSize: access.constraints.pages.associations.default,
      restored: readListState<string>(retainedAssociations),
      fragments: {
        ownership: associationBinding.ownership,
        tags: associationReader(),
      },
      // A committed change of the account's associations, tags or copies reacquires the
      // presented records through the binding; the page never patches a row after an
      // operation it drove.
      changes: bindings.changes(),
      presentation: {
        renderEntry: (entry) => associationEntry(document, entry),
        renderFragment: (kind, entry, values) => {
          if (kind === 'tags') {
            return associationEditor(entry);
          }
          return kind === 'ownership'
            ? ownershipContent(values as UiEntryOwnership, associationRecord(entry.key)?.quantity)
            : null;
        },
      },
      signal: options.signal,
    });
    associations = list;
    observeAssociations(list);
    if (location) {
      // A location view offers every destination the account has, so the move control reads
      // the account's location tags page by page
      // (docs/user-interface.md#browsing-and-organization).
      void readLocations(null);
    }
    const restorations: (Promise<void> | null)[] = [presentedOf(list)];
    if (retainedResults !== null) {
      // A restored search is composed again, so the entry's result window keeps its context.
      ensureAddList({ text: query.value, level: readUiCollectionLevel(level.value) });
      restorations.push(addList === null ? null : presentedOf(addList));
    }
    reportPresentation(restorations);
  }

  /** Presents a tag that could not be read; the view owns no list then. */
  function presentMissing(failure: string | null): void {
    kindLine.textContent = failure ?? 'This account has no tag with that identity.';
    const back = document.createElement('a');
    back.id = 'tag-back';
    back.href = options.backHref;
    back.textContent = 'All tags';
    kindLine.after(back);
    for (const element of [
      renameForm,
      renameStatus,
      associationsHeading,
      associationsStatus,
      associationsHost,
      locationsStatus,
      locationsMore,
      addHeading,
      addForm,
      addHost,
    ]) {
      element.remove();
    }
  }

  /** Renames the presented tag, keeping the unsaved label after a conflict or a failure. */
  async function submitRename(): Promise<void> {
    const current = tag;
    if (current === null) {
      return;
    }
    const wanted = labelInput.value.trim();
    if (wanted.length === 0) {
      renameStatus.textContent = 'A tag label is required.';
      return;
    }
    renameStatus.textContent = 'Saving…';
    const outcome = await renameTag(
      access,
      { tagId: current.tagId, expectedRevision: current.revision, label: wanted },
      options.signal,
    );
    if (closed) {
      return;
    }
    if (outcome.record !== null) {
      presentTag(outcome.record);
      if (outcome.status === 'committed' && labelInput.value.trim() === wanted) {
        labelInput.value = outcome.record.label;
      }
    }
    renameStatus.textContent = outcome.message ?? 'Renamed the tag.';
    // The unsaved label stays beside the field; the notice keeps the failure visible after the
    // view is left (docs/ui/navigation.md#error-notices).
    reportUiOperation(options.notices, tagViewRenameNotice, outcome);
    // A committed rename reacquires the association sequence through CardList's own change
    // invalidation; the page owns no repair read of its lists.
    if (outcome.status === 'conflict') {
      const reread = await readTag(access, current.tagId, options.signal).catch(() => null);
      if (!closed && reread !== null) {
        presentTag(reread);
      }
    }
  }

  /** Presents one tag state the page read; a newer revision never regresses to an older one. */
  function presentTag(next: Tag): void {
    if (tag !== null && next.revision < tag.revision) {
      return;
    }
    tag = next;
    heading.textContent = next.label;
    kindLine.textContent = `Kind: ${uiTagKindLabel(kindOf(next.kind))}`;
  }

  /**
   * Reads one page of the account's location tags, so a copy can move between every destination
   * the account has instead of only the tags of the first page of every kind
   * (docs/user-interface.md#browsing-and-organization). A failure stays beside the control that
   * reads further locations and keeps the known ones usable.
   */
  async function readLocations(continuation: string | null): Promise<void> {
    if (closed || locations.loading) {
      return;
    }
    const current = ++locationVersion;
    locations = { ...locations, loading: true, error: null };
    paintLocations();
    try {
      const page = await access.list(
        {
          pageSize: access.constraints.pages.tags.default,
          ...(continuation === null ? {} : { continuation }),
        },
        options.signal,
      );
      if (closed || current !== locationVersion) {
        return;
      }
      const known = new Set(
        (continuation === null ? [] : locations.tags).map((candidate) => candidate.tagId),
      );
      locations = {
        // The offered destinations slide forward under the retained window's bound, so a long
        // location list never grows the page without limit.
        tags: [
          ...(continuation === null ? [] : locations.tags),
          ...locationTagsOf(page.tags).filter((candidate) => !known.has(candidate.tagId)),
        ].slice(-UI_LIMITS.listWindow),
        continuation: page.continuation,
        loading: false,
        error: null,
      };
      options.notices?.dismiss(tagViewLocationsNotice);
    } catch (cause) {
      if (closed || current !== locationVersion) {
        return;
      }
      if (continuation !== null && isInvalidatedContinuation(cause)) {
        locations = { ...locations, loading: false, continuation: null };
        void readLocations(null);
        return;
      }
      const problem = readMessage(cause, 'The other locations could not be loaded.');
      locations = {
        ...locations,
        loading: false,
        error: problem,
      };
      // The next page of destinations is a service read of this view: its failure stays visible
      // beside the control and as the shell's notice with the same retry
      // (docs/ui/navigation.md#error-notices).
      reportUiFailure(options.notices, tagViewLocationsNotice, problem, {
        label: 'Load the locations again',
        run: () => {
          void readLocations(locations.continuation);
        },
      });
    }
    paintLocations();
  }

  /** Presents the location choice set's progress and its next page's control. */
  function paintLocations(): void {
    locationsMore.hidden = locations.continuation === null && locations.error === null;
    locationsMore.textContent = locations.error === null ? 'More locations' : 'Retry locations';
    locationsMore.disabled = locations.loading;
    locationsStatus.textContent =
      locations.error ?? (locations.loading ? 'Loading locations…' : '');
    repaintEditors();
  }

  /**
   * Starts or restarts the add list for the query and level the form presents. The list is
   * created with the first search, so a tag view without a search reads no catalog page.
   */
  function search(): void {
    const next: CardListPickerQuery = {
      text: query.value,
      level: readUiCollectionLevel(level.value),
    };
    if (addList === null) {
      // The new list evaluates the presented query itself; refining it at once would withdraw
      // the result it just started.
      ensureAddList(next);
      return;
    }
    // A search the owner submits re-reads the private counts of its result: the account's
    // ownership and intentions may have moved since the result was presented, and the counts
    // are not part of the query generation that decides membership
    // (docs/user-interface.md#browsing-and-organization).
    addList.refine(next);
  }

  function ensureAddList(next: CardListPickerQuery): void {
    if (addList !== null) {
      return;
    }
    addList = options.cardViews.list<CardListPickerQuery>({
      container: addHost,
      create: options.cardList.create,
      source: options.cardList.account(options.accountId).pickerQuery(),
      context: next,
      accountId: options.accountId,
      pageSize: UI_LIMITS.catalogPage,
      restored: readListState<CardListPickerQuery>(retainedResults),
      fragments: {
        ownership: options.cardList.account(options.accountId).ownership(tagId),
        tools: addToolsReader(),
      },
      // A committed association or copy change may alter the intended quantity or membership
      // this picker presents; the list reacquires it through its own bindings.
      changes: options.cardList.account(options.accountId).changes(),
      presentation: {
        renderFragment: (kind, _entry, values) =>
          kind === 'ownership' ? ownershipContent(values as UiEntryOwnership) : null,
      },
      tools: [{ id: 'add-to-tag', label: 'Add to this tag' }],
      onAction: (intent) => {
        void applyAddToTag(intent);
      },
      signal: options.signal,
    });
    reportPresentation([presentedOf(addList)]);
  }

  /**
   * Runs the add action over the explicit selection the list reported and presents its pending
   * state and authoritative outcome. Only a committed change is reported as saved; a committed or
   * uncertain change reacquires the presented counts through the list's own bindings
   * (docs/ui/editors.md#drafts-and-asynchronous-outcomes).
   */
  async function applyAddToTag(intent: UiActionIntent): Promise<void> {
    if (closed || adding) {
      return;
    }
    adding = true;
    addStatus.removeAttribute('data-ui-outcome-status');
    addStatus.textContent = 'Adding to the tag…';
    const action = addToTagTool({
      id: 'add-to-tag',
      label: 'Add to this tag',
      access,
      tag: () => tag,
      quantity: () => readQuantity(quantity, access.constraints.quantity.association),
      guidance:
        'Choose an intended quantity from 1 to ' +
        `${access.constraints.quantity.association} before adding.`,
    });
    const outcome = await applyAction(action, {
      selection: intent.selection,
      signal: options.signal,
    });
    if (closed) {
      return;
    }
    adding = false;
    presentAddOutcome(outcome);
    // The picker keeps the failure beside its own controls; the notice keeps it visible after the
    // view is left (docs/ui/navigation.md#error-notices).
    reportUiOperation(options.notices, tagViewAddNotice, outcome);
    if (outcome.unknown > 0) {
      // Earlier committed notifications cannot establish a later uncertain write. Reconcile after
      // every unknown aggregate outcome; known commits already reacquire the list through the
      // binding's change notifications.
      associations?.refresh();
    }
  }

  /** Presents one add outcome; the editor reports success only for a committed change. */
  function presentAddOutcome(outcome: UiOperationOutcome): void {
    addStatus.dataset.uiOutcomeStatus = outcome.status;
    addStatus.textContent = outcome.message ?? outcomeText(outcome.status);
  }

  /** One entry's basic information beside the association level the row presents. */
  function associationEntry(document: Document, entry: CardListEntry): Node {
    const content = document.createElement('span');
    content.append(options.cardViews.basicContent(document, entry));
    const association = associationRecord(entry.key);
    if (association !== null) {
      const level = document.createElement('span');
      level.dataset.uiAssociationLevel = association.targetLevel;
      level.textContent = ` ${uiAssociationLevelLabel(association.targetLevel)}`;
      content.append(level);
    }
    return content;
  }

  /**
   * Presents all private comparisons in one independently recoverable fragment. An association's
   * own saved intention takes precedence over a count read that may have begun before an edit.
   * Owned, intended and physical-location counts stay distinct
   * (docs/user-interface.md#browsing-and-organization).
   */
  function ownershipContent(ownership: UiEntryOwnership, quantity?: number | null): Node {
    const content = document.createElement('span');
    const intended = quantity ?? ownership.intended;
    const copies = document.createElement('span');
    copies.dataset.uiCopies = '';
    copies.textContent = ` Copies: ${ownership.owned}`;
    content.append(copies);
    if (intended != null) {
      const intent = document.createElement('span');
      intent.dataset.uiIntended = '';
      intent.textContent = ` Intended: ${intended}`;
      content.append(intent);
    }
    const locations = document.createElement('span');
    locations.dataset.uiLocations = '';
    locations.textContent = ` Locations: ${ownership.locations}`;
    content.append(locations);
    return content;
  }

  /** The fragment reader that carries one row's association to its own editor. */
  function associationReader(): CardListFragmentReader<readonly { tagId: string; name: string }[]> {
    return {
      read(request) {
        return Promise.resolve(
          request.keys.map((key) => {
            const association = associationRecord(key);
            return association === null
              ? {
                  key,
                  status: 'failed' as const,
                  message: 'The association is no longer available.',
                }
              : {
                  key,
                  status: 'ready' as const,
                  values: [{ tagId: association.tagId, name: tag?.label ?? 'Tag' }],
                };
          }),
        );
      },
    };
  }

  /**
   * The editor of one association: its intended quantity (a card or printing target), the
   * refinement between the card and printing levels, the removal of the association, or the
   * single physical location of the copy the tag holds
   * (docs/user-interface.md#browsing-and-organization).
   */
  function associationEditor(entry: CardListEntry): Node | null {
    const current = associationRecord(entry.key);
    if (current === null || tag === null) {
      return null;
    }
    const controls = document.createElement('span');
    controls.dataset.uiAssociation = entry.key;
    const status = statusLine(
      document,
      `tag-association-status-${encodeURIComponent(current.associationId)}`,
    );
    controls.append(status);
    const editor: UiAssociationEditor = { controls, entry, status, refresh: () => {} };
    editor.refresh = () => paintEditor(editor);
    editors.set(entry.key, editor);
    paintEditor(editor);
    return controls;
  }

  /**
   * Draws one association editor. The unsaved input of a row lives in the page's drafts rather
   * than in the rendered controls, so paging, a redraw after another change or leaving and
   * returning to the view keeps what the user must review and retry; only a committed change
   * clears its own draft (docs/user-interface.md#browsing-and-organization,
   * docs/user-interface.md#state-ownership-and-restoration).
   */
  function paintEditor(editor: UiAssociationEditor): void {
    const association = associationRecord(editor.entry.key);
    const current = tag;
    if (association === null || current === null) {
      return;
    }
    if (association.targetLevel !== 'card') {
      releasePrintingPicker(editor.entry.key);
    }
    if (
      cardListEntryKey(editor.entry.target) !==
      cardListEntryKey(referenceOfAssociation(association))
    ) {
      editor.controls.replaceChildren(editor.status);
      return;
    }
    const previousPicker = printingPickers.get(editor.entry.key);
    if (previousPicker !== undefined && previousPicker.cardId !== association.targetId) {
      // A picker is bound to one card, even when the association keeps its own identity.
      releasePrintingPicker(editor.entry.key);
      const draft = drafts.get(association.associationId);
      if (draft !== undefined) draft.printingId = null;
      openPrintingPicker(editor, association);
      return;
    }
    const draft = drafts.get(association.associationId) ?? null;
    const kind = kindOf(current.kind);
    const controls: (Node | string)[] = [];
    if (association.targetLevel !== 'copy') {
      const wanted = numberInput(
        document,
        `tag-quantity-${encodeURIComponent(association.associationId)}`,
        draft?.quantity ?? String(association.quantity ?? 1),
        access.constraints.quantity.association,
      );
      wanted.addEventListener('input', () => {
        draftFor(association.associationId).quantity = wanted.value;
      });
      const save = button(
        document,
        `tag-quantity-save-${encodeURIComponent(association.associationId)}`,
        'Save quantity',
      );
      save.addEventListener('click', () => {
        void saveQuantity(association, wanted);
      });
      controls.push(controlLabel(document, 'Intended', wanted), save, ' ');
    }
    if (association.targetLevel === 'card') {
      const picker = printingPickers.get(editor.entry.key);
      if (picker === undefined) {
        // The card's printings are read when the owner refines this association, so a long
        // wishlist issues no catalog request for every presented card.
        const choose = button(
          document,
          `tag-refine-choose-${encodeURIComponent(association.associationId)}`,
          'Choose printing…',
        );
        choose.addEventListener('click', () => {
          openPrintingPicker(editor, association);
        });
        controls.push(choose, ' ');
      } else {
        controls.push(picker.host, ' ');
      }
    }
    if (association.targetLevel === 'printing') {
      const broaden = button(
        document,
        `tag-broaden-${encodeURIComponent(association.associationId)}`,
        'Broaden to card',
      );
      broaden.addEventListener('click', () => {
        const cardId = editor.entry.basic?.card.cardId ?? '';
        if (cardId.length === 0) {
          editor.status.textContent = 'The card of this printing is not available.';
          return;
        }
        void saveAssociationChange(
          association,
          'card',
          cardId,
          association.quantity,
          editor.status,
        );
      });
      controls.push(broaden, ' ');
    }
    if (kind !== 'location') {
      const remove = button(
        document,
        `tag-remove-${encodeURIComponent(association.associationId)}`,
        'Remove',
      );
      remove.addEventListener('click', () => {
        void removeEditorAssociation(association, remove, editor.status);
      });
      controls.push(remove);
    } else if (association.targetLevel === 'copy') {
      const chosen = document.createElement('select');
      chosen.id = `tag-move-${encodeURIComponent(association.associationId)}`;
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'No location';
      chosen.append(none);
      const offered = [
        ...(current.kind === 'location' ? [current] : []),
        ...locations.tags.filter((candidate) => candidate.tagId !== current.tagId),
      ];
      for (const location of offered) {
        const option = document.createElement('option');
        option.value = location.tagId;
        option.textContent = location.label;
        chosen.append(option);
      }
      const wantedLocation = draft?.locationId ?? current.tagId;
      retainChoice(chosen, wantedLocation, 'Selected location (not loaded)');
      chosen.addEventListener('change', () => {
        draftFor(association.associationId).locationId = chosen.value;
      });
      const move = button(
        document,
        `tag-move-save-${encodeURIComponent(association.associationId)}`,
        'Move',
      );
      move.disabled = chosen.selectedOptions[0]?.disabled === true;
      chosen.addEventListener('change', () => {
        move.disabled = chosen.selectedOptions[0]?.disabled === true;
      });
      move.addEventListener('click', () => {
        draftFor(association.associationId).locationId = chosen.value;
        void moveCopy(association, chosen.value, editor.status);
      });
      controls.push(controlLabel(document, 'Move to', chosen), move);
    }
    replaceChildrenKeepingFocus(editor.controls, editor.status, ...controls);
  }

  /** The unsaved input of one association, created when the user first edits it. */
  function draftFor(associationId: string): UiAssociationDraft {
    const existing = drafts.get(associationId);
    if (existing !== undefined) {
      drafts.delete(associationId);
      drafts.set(associationId, existing);
      return existing;
    }
    const created: UiAssociationDraft = {
      quantity: null,
      printingId: null,
      locationId: null,
    };
    drafts.set(associationId, created);
    boundDrafts(drafts);
    return created;
  }

  /** Saves the intended quantity the row presents, quoting the revision it read. */
  async function saveQuantity(association: Association, wanted: HTMLInputElement): Promise<void> {
    const quantity = readQuantity(wanted, access.constraints.quantity.association);
    const editor = editors.get(associationKey(association));
    if (quantity === null) {
      if (editor !== undefined) {
        editor.status.textContent =
          'Choose an intended quantity from 1 to ' + `${access.constraints.quantity.association}.`;
      }
      return;
    }
    await saveAssociationChange(
      association,
      association.targetLevel,
      association.targetId,
      quantity,
      editor?.status ?? null,
      'quantity',
    );
  }

  /** Applies one revision-guarded association change and presents its outcome. */
  async function saveAssociationChange(
    association: Association,
    targetLevel: AssociationTargetLevel,
    targetId: string,
    quantity: number | null,
    status: HTMLParagraphElement | null,
    field: keyof UiAssociationDraft = 'printingId',
  ): Promise<void> {
    const submitted =
      field === 'printingId' && targetLevel !== 'printing'
        ? undefined
        : drafts.get(association.associationId)?.[field];
    const outcome = await saveAssociation(
      access,
      {
        associationId: association.associationId,
        expectedRevision: association.revision,
        targetLevel,
        targetId,
        quantity,
      },
      options.signal,
    );
    await presentAssociationOutcome(outcome, association, status, true, field, submitted);
  }

  /** Removes one association after a brief confirmation. */
  async function removeEditorAssociation(
    association: Association,
    control: HTMLButtonElement,
    status: HTMLParagraphElement,
  ): Promise<void> {
    control.disabled = true;
    const confirmed = await options.dialogs.confirm({
      title: 'Remove association',
      message: 'Remove this association from the tag?',
      confirmLabel: 'Remove',
      cancelLabel: 'Cancel',
    });
    if (closed || !confirmed) {
      control.disabled = false;
      return;
    }
    const outcome = await removeAssociation(
      access,
      {
        associationId: association.associationId,
        expectedRevision: association.revision,
      },
      options.signal,
    );
    if (!closed && control.isConnected && outcome.status !== 'committed') {
      // The association is still presented, so the user can retry the removal from this view
      // after a conflict or a failed request.
      control.disabled = false;
    }
    await presentAssociationOutcome(outcome, association, status);
  }

  /** Moves one copy to the location the row presents, or clears its location. */
  async function moveCopy(
    association: Association,
    locationTagId: string,
    status: HTMLParagraphElement,
  ): Promise<void> {
    const submitted = drafts.get(association.associationId)?.locationId;
    const outcome = await moveCopyById(
      access,
      association.targetId,
      locationTagId.length === 0 ? null : locationTagId,
      options.signal,
    );
    // A move quotes the copy's own revision, which every attempt reads again: a conflict here
    // names the copy, not the association the row edits.
    await presentAssociationOutcome(outcome, association, status, false, 'locationId', submitted);
  }

  /**
   * Presents one change's outcome. Only a committed change is reported as saved: its draft is
   * cleared only for the submitted field, and the association list reads the tag's associations again. A conflict reads the
   * association's recorded state and presents it beside the unsaved input, so a deliberate
   * retry quotes the revision the page reviewed instead of the obsolete one it held
   * (docs/user-cards.md#persistence-and-recovery,
   * docs/user-interface.md#browsing-and-organization). A definite failure keeps the unsaved
   * input for the retry.
   */
  async function presentAssociationOutcome(
    outcome: UiChangeOutcome<unknown>,
    association: Association,
    status: HTMLParagraphElement | null,
    review = true,
    field?: keyof UiAssociationDraft,
    submitted?: string | null,
  ): Promise<void> {
    if (closed) {
      return;
    }
    // The association row keeps its unsaved input and its own message; the notice keeps the
    // failure visible when the view is left (docs/ui/navigation.md#error-notices).
    reportUiOperation(options.notices, `tag:association:${association.associationId}`, outcome);
    if (outcome.status === 'committed') {
      const draft = drafts.get(association.associationId);
      if (field === undefined) {
        drafts.delete(association.associationId);
      } else if (draft !== undefined && draft[field] === submitted) {
        draft[field] = null;
      }
      if (review && typeof outcome.record === 'object' && outcome.record !== null) {
        keepAssociation(outcome.record as Association);
      }
      report(outcome.message ?? 'Saved.');
      return;
    }
    if (!review) {
      report(outcome.message ?? 'Saved.');
      if (outcome.status === 'unknown') {
        // The move may have committed: the list reads the tag's copies again for review.
        associations?.refresh();
      }
      return;
    }
    if (outcome.status === 'conflict') {
      const reread = await readRecord(association.associationId);
      if (closed) {
        return;
      }
      const reviewed = reread === null ? null : adoptAssociation(reread);
      report(
        reviewed === null
          ? (outcome.message ?? 'The association changed. Reload the view before retrying.')
          : `${outcome.message ?? 'The association changed after this revision.'} Its saved ` +
              `state is now ${describeAssociation(reviewed)}. Your input stays for the retry.`,
      );
      return;
    }
    if (outcome.status === 'unknown' && outcome.record !== null) {
      // A lost response is reviewed through the record it recovered; its revision becomes the
      // one a deliberate retry quotes, while the unsaved input stays untouched.
      const reviewed = adoptAssociation(outcome.record as Association);
      report(
        `${outcome.message ?? 'The outcome is unknown.'} Its recorded state is now ${describeAssociation(reviewed)}.`,
      );
    } else {
      report(outcome.message ?? 'Saved.');
    }
    if (outcome.status === 'unknown' && outcome.record === null) {
      associations?.refresh();
    }

    // Paging may have replaced the initiating editor. Keep the outcome in the live row and
    // at page level, so an uncertain result remains visible through reconciliation.
    function report(message: string): void {
      associationsStatus.textContent = message;
      const current = editors.get(associationKey(association))?.status ?? status;
      if (current !== null) current.textContent = message;
    }
  }

  /** Reads one association record the page presents, or null when the read did not answer. */
  async function readRecord(associationId: string): Promise<Association | null> {
    try {
      const read = await access.readAssociations([associationId], options.signal);
      return read.associations.get(associationId) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Presents one association state the page read; an older revision never regresses to an
   * earlier one and the row's editor is redrawn around it, so its controls quote the revision
   * the page presents.
   */
  function adoptAssociation(next: Association): Association {
    const key = associationKey(next);
    const current = associationRecord(key);
    if (current !== null && next.revision < current.revision) {
      return current;
    }
    keepAssociation(next);
    if (current?.targetLevel !== next.targetLevel || current.targetId !== next.targetId) {
      // The list owns the entry and selected target. Reacquire its basics before retrying.
      const editor = editors.get(key);
      editor?.controls.querySelectorAll('button, input, select').forEach((control) => {
        (control as HTMLButtonElement).disabled = true;
      });
      associations?.refresh();
    } else {
      editors.get(key)?.refresh();
    }
    return next;
  }

  function keepAssociation(next: Association): void {
    const key = associationKey(next);
    const current = associationRecords?.record(key);
    if ((current?.revision ?? 0) <= next.revision) {
      associationRecords?.adopt(next);
    }
  }

  /** One association state in words, for the review a conflict or a lost response presents. */
  function describeAssociation(association: Association): string {
    const level = uiAssociationLevelLabel(association.targetLevel).toLowerCase();
    return association.quantity === null
      ? `${level} membership`
      : `${level} intention of ${association.quantity}`;
  }

  /**
   * Mounts the picker of one card-level association on demand: a presented card association
   * issues no catalog request until the owner asks to refine it. The picker is one CardViews list
   * over the card's published printings; acquiring them, their continuation, paging and the
   * recovery of a failed page belong to CardList, and the row only presents its choice
   * (docs/ui/editors.md#interface, docs/card-list.md#interface).
   */
  function openPrintingPicker(editor: UiAssociationEditor, association: Association): void {
    if (closed || association.targetLevel !== 'card') {
      return;
    }
    const card = editor.entry.basic?.card ?? null;
    if (card === null) {
      editor.status.textContent = 'The card of this association is not available.';
      return;
    }
    const entryKey = editor.entry.key;
    const host = document.createElement('div');
    host.dataset.uiPrintingPicker = association.associationId;
    const list = options.cardViews.picker<string>({
      container: host,
      create: options.cardList.create,
      source: options.cardList.account(options.accountId).cardPrintings(card),
      context: card.cardId,
      accountId: options.accountId,
      pageSize: UI_LIMITS.printingPage,
      fragments: { tools: printingChoicesReader() },
      choice: { id: 'refine-printing', label: 'Refine to this printing' },
      onChoose: (selection) => {
        const current = associationRecord(entryKey);
        if (current?.targetLevel === 'card' && current.targetId === card.cardId) {
          void refineFromPicker(entryKey, selection);
        }
      },
      signal: options.signal,
    });
    printingPickers.set(entryKey, { host, list, cardId: card.cardId });
    // The draft keeps the printing the owner chose to refine to: once the row's window presents
    // that printing again, the picker presents it as the selection for review
    // (docs/ui/editors.md#drafts-and-asynchronous-outcomes).
    let presented = false;
    list.subscribe((snapshot) => {
      if (presented) {
        return;
      }
      const wanted = drafts.get(association.associationId)?.printingId ?? null;
      const key = wanted === null ? null : `printing:${wanted}`;
      if (key === null || !snapshot.entries.some((entry) => entry.entry.key === key)) {
        return;
      }
      presented = true;
      list.setSelected(key, true);
    });
    editor.refresh();
  }

  /** Availability of the refine choice for the printings of the card the picker presents. */
  function printingChoicesReader(): CardListFragmentReader<readonly string[]> {
    return {
      read(request) {
        return Promise.resolve(
          request.keys.map((key) => ({
            key,
            status: 'ready' as const,
            values: key.startsWith('printing:') ? ['refine-printing'] : [],
          })),
        );
      },
    };
  }

  /** Refines one association to the printing the picker's explicit selection names. */
  async function refineFromPicker(
    entryKey: string,
    selection: CardListToolSelection,
  ): Promise<void> {
    const association = associationRecord(entryKey);
    if (association === null) {
      return;
    }
    const target = singlePrintingChoice(selection);
    if (target === null) {
      const editor = editors.get(entryKey);
      if (editor !== undefined) editor.status.textContent = printingChoiceGuidance;
      return;
    }
    draftFor(association.associationId).printingId = target.printingId;
    await saveAssociationChange(
      association,
      'printing',
      target.printingId,
      association.quantity,
      editors.get(entryKey)?.status ?? null,
    );
  }

  /** Releases the printing picker of one association, if it is mounted. */
  function releasePrintingPicker(entryKey: string): void {
    const picker = printingPickers.get(entryKey);
    if (picker === undefined) {
      return;
    }
    printingPickers.delete(entryKey);
    picker.list.dispose();
    picker.host.remove();
  }

  /** Whether each presented entry offers the add tool for the presented tag. */
  function addToolsReader(): CardListFragmentReader<readonly string[]> {
    const copies = options.cardList.account(options.accountId).copyTools(['add-to-tag']);
    return {
      async read(request) {
        const current = tag;
        const levels = current === null ? [] : uiAssociationLevelsByTagKind[kindOf(current.kind)];
        const available = new Map(
          (await copies.read(request)).map((result) => [result.key, result]),
        );
        return request.keys.map((key) => {
          const target = targetOfKey(key);
          if (target?.kind === 'copy' && levels.includes('copy')) return available.get(key)!;
          return {
            key,
            status: 'ready' as const,
            values: target !== null && levels.includes(target.kind) ? ['add-to-tag'] : [],
          };
        });
      },
    };
  }

  /** Redraws the presented association editors, so they follow the choices now known. */
  function repaintEditors(cardId?: string): void {
    for (const editor of editors.values()) {
      const association = associationRecord(editor.entry.key);
      if (
        cardId === undefined ||
        (association?.targetLevel === 'card' && association.targetId === cardId)
      ) {
        editor.refresh();
      }
    }
  }

  /**
   * Follows the window of association keys the list presents: rows the window no longer holds
   * release their editors. The unsaved drafts stay under their own bound, so an edit a retired
   * row held survives paging — and a restart of the sequence — without retaining every visited
   * association (docs/user-interface.md#state-ownership-and-restoration).
   */
  function observeAssociations(list: UiCardList<string>): void {
    list.subscribe((snapshot) => {
      const presented = new Set(snapshot.entries.map((entry) => entry.entry.key));
      for (const key of [...editors.keys()]) {
        if (!presented.has(key)) {
          editors.delete(key);
          releasePrintingPicker(key);
        }
      }
      boundDrafts(drafts);
    });
  }

  /** The provider record of one presented association key this visit's binding read, or null. */
  function associationRecord(key: string): Association | null {
    return associationRecords?.record(key) ?? null;
  }

  /**
   * Reports the presentation of the lists this view composes: the shell restores the entry's
   * scroll, focus and visible anchor over the presented content once they settled
   * (docs/user-interface.md#state-ownership-and-restoration).
   */
  function reportPresentation(restorations: readonly (Promise<void> | null)[]): void {
    const pending = restorations.filter(
      (restoration): restoration is Promise<void> => restoration !== null,
    );
    if (pending.length === 0) {
      presented.resolve();
      return;
    }
    void Promise.all(pending).then(
      () => presented.resolve(),
      (cause) => presented.reject(cause),
    );
  }
}

/** One presented association editor and the row it belongs to. */
interface UiAssociationEditor {
  readonly controls: HTMLSpanElement;
  readonly entry: CardListEntry;
  readonly status: HTMLParagraphElement;
  refresh(): void;
}

/** Unsaved association input the page keeps independently of the rendered row. */
interface UiAssociationDraft {
  /** Intended quantity the user typed, or null while the saved one stands. */
  quantity: string | null;
  /** Printing the user chose to refine the association to, or null while the saved one stands. */
  printingId: string | null;
  /** Location the user chose to move the copy to, or null while the saved one stands. */
  locationId: string | null;
}

/** One mounted printing picker of a card-level association and the region it presents in. */
interface UiPrintingPicker {
  readonly cardId: string;
  readonly host: HTMLElement;
  readonly list: UiCardList<string>;
}

/** The account's offered location tags: the known ones, their continuation and its state. */
interface UiLocationOffer {
  readonly tags: readonly Tag[];
  readonly continuation: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}
/** Location tags of one page of the account's tags; other kinds are not move destinations. */
function locationTagsOf(tags: readonly Tag[]): readonly Tag[] {
  return tags.filter((candidate) => kindOf(candidate.kind) === 'location');
}

/** Target level one add-list entry key names, or null when the key is not readable. */
function targetOfKey(key: string): { readonly kind: AssociationTargetLevel } | null {
  if (key.startsWith('card:')) {
    return { kind: 'card' };
  }
  if (key.startsWith('printing:')) {
    return { kind: 'printing' };
  }
  if (key.startsWith('copy:')) {
    return { kind: 'copy' };
  }
  return null;
}

/** Tag kind the organization views present; the system owned tag is not one of them. */
function kindOf(kind: Tag['kind']): UiTagKind {
  return readUiTagKind(kind) ?? 'other';
}

/** Tag kind one control value names, or null when it is outside the presented vocabulary. */
function readUiTagKind(value: unknown): UiTagKind | null {
  return typeof value === 'string' && (uiTagKinds as readonly string[]).includes(value)
    ? (value as UiTagKind)
    : null;
}

/** One add level a history entry kept, or null when it names none. */
function readAddLevel(value: unknown): CardListPickerQuery['level'] | null {
  return value === 'card' || value === 'printing' || value === 'copy' ? value : null;
}

/** The add form state one history entry kept, or null when it kept none. */
function readAddDraft(
  value: unknown,
): { readonly text: string; readonly level: string; readonly quantity: string } | null {
  const record = readPageState(value);
  if (record === null) {
    return null;
  }
  return {
    text: typeof record.text === 'string' ? record.text : '',
    level: typeof record.level === 'string' ? record.level : '',
    quantity: typeof record.quantity === 'string' ? record.quantity : '1',
  };
}

/** Tags one history entry kept, or null when it kept none the page can present. */
function readRetainedTags(value: unknown): readonly Tag[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tags: Tag[] = [];
  for (const candidate of value) {
    const tag = candidate as Tag | null;
    if (
      typeof tag !== 'object' ||
      tag === null ||
      typeof tag.tagId !== 'string' ||
      typeof tag.label !== 'string' ||
      typeof tag.revision !== 'number' ||
      readUiTagKind(tag.kind) === null
    ) {
      return null;
    }
    tags.push(tag);
  }
  return tags;
}

/** The continuation one history entry kept, or null when it kept none. */
function readContinuation(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The source position one history entry kept, or null when it kept none the page can use. */
function readTagPosition(value: unknown): UiTagPosition | null {
  const record = readPageState(value);
  if (record === null) {
    return null;
  }
  const continuation = record.continuation === null ? null : readContinuation(record.continuation);
  const offset = record.offset;
  if (
    (record.continuation !== null && continuation === null) ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    return null;
  }
  return { continuation, offset };
}

/** The unsaved rename labels one history entry kept, keyed by tag identity. */
function readDrafts(value: unknown): Map<string, string> {
  const drafts = new Map<string, string>();
  const record = readPageState(value);
  if (record === null) {
    return drafts;
  }
  for (const [tagId, label] of Object.entries(record)) {
    if (typeof label === 'string' && tagId.length > 0 && tagId.length <= UI_LIMITS.routeSegment) {
      drafts.set(tagId, label.slice(0, UI_LIMITS.entryKey));
    }
  }
  boundDrafts(drafts);
  return drafts;
}

/** The unsaved association input one history entry kept, keyed by association identity. */
function readAssociationDrafts(value: unknown): Map<string, UiAssociationDraft> {
  const drafts = new Map<string, UiAssociationDraft>();
  const record = readPageState(value);
  if (record === null) {
    return drafts;
  }
  for (const [associationId, entry] of Object.entries(record)) {
    const draft = readPageState(entry);
    if (
      draft === null ||
      associationId.length === 0 ||
      associationId.length > UI_LIMITS.routeSegment
    ) {
      continue;
    }
    drafts.set(associationId, {
      quantity: readDraftValue(draft.quantity, UI_LIMITS.entryKey),
      printingId: readDraftValue(draft.printingId, UI_LIMITS.routeSegment),
      locationId: readDraftValue(draft.locationId, UI_LIMITS.routeSegment),
    });
  }
  boundDrafts(drafts);
  return drafts;
}

/** One retained draft value, bounded like the control that produced it. */
function readDraftValue(value: unknown, bound: number): string | null {
  return typeof value === 'string' ? value.slice(0, bound) : null;
}

/** The intended quantity one control names, or null when it is not a bounded positive number. */
function readQuantity(input: HTMLInputElement, bound: number): number | null {
  const value = Number(input.value);
  return Number.isSafeInteger(value) && value >= 1 && value <= bound ? value : null;
}

/** Reads one tag, or null when this account has none with that identity. */
async function readTag(
  access: UiTagAccess,
  tagId: string,
  signal: AbortSignal,
): Promise<Tag | null> {
  const read = await access.read([tagId], signal);
  return read.tags.get(tagId) ?? null;
}

function text<K extends 'h2' | 'h3' | 'p'>(
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

function statusLine(document: Document, id: string): HTMLParagraphElement {
  const element = document.createElement('p');
  element.id = id;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  return element;
}

function button(document: Document, id: string, label: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = id;
  element.textContent = label;
  return element;
}

function submitButton(document: Document, id: string, label: string): HTMLButtonElement {
  const element = button(document, id, label);
  element.type = 'submit';
  return element;
}

function textInput(document: Document, id: string, value: string): HTMLInputElement {
  const element = document.createElement('input');
  element.id = id;
  element.type = 'text';
  element.value = value;
  return element;
}

function numberInput(
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

function select(
  document: Document,
  options: readonly { readonly value: string; readonly label: string }[],
  value: string,
): HTMLSelectElement {
  const element = document.createElement('select');
  for (const option of options) {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = option.label;
    element.append(item);
  }
  element.value = value;
  return element;
}

function readMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

/** Keep selected identities explicit while their page of choices is unavailable. */
function retainChoice(chosen: HTMLSelectElement, wanted: string, label: string): void {
  if (![...chosen.options].some((option) => option.value === wanted)) {
    const pending = chosen.ownerDocument.createElement('option');
    pending.value = wanted;
    pending.textContent = label;
    pending.disabled = true;
    chosen.append(pending);
  }
  chosen.value = wanted;
}

/** Each page retains at most one window of most recently edited drafts, independently of rows. */
function boundDrafts<Value>(drafts: Map<string, Value>): void {
  while (drafts.size > UI_LIMITS.listWindow) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}
