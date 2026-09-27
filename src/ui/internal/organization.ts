/**
 * Organization pages of the UserInterface (docs/user-interface.md#pages-and-navigation,
 * docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations).
 *
 * The tags page presents the account's tags in a bounded window and creates and renames them. The
 * tag view presents one tag's associations as a bounded CardList: a card or printing association
 * is presented with its intended quantity and can be given another quantity or refined between the
 * card and printing levels, an association can be removed, and a copy's single physical location
 * can be moved. Beside it, a search over the Catalog and the account's own copies offers the
 * entries to add to the tag, so a wishlist can name a card or one exact printing and a location can
 * take a copy. Every change quotes the revision the page read, unsaved input stays in the form
 * after a conflict or a failed edit, and a saved outcome is presented only after the operation
 * reported it committed (docs/user-interface.md#browsing-and-organization). Every provider value
 * renders as text.
 */

import type { SearchClient } from '../../application/index.js';
import type { CardRecord, Catalog, PrintingRecord } from '../../catalog/index.js';
import type { SearchRequestInput } from '../../search/index.js';
import type {
  Association,
  AssociationTargetLevel,
  PhysicalCopy,
  Tag,
} from '../../usercards/index.js';

import { cardListBasicContent, createCardList, type UiCardList } from './card-list.js';
import { UI_LIMITS } from './limits.js';
import type { UiEntryTarget, UiFragmentReader, UiListEntry, UiListSource } from './list.js';
import { controlLabel, readListState, readPageState } from './page-support.js';
import type { UiPageDefinition } from './pages.js';
import { readUiCollectionLevel, uiHref } from './routes.js';
import { searchListEntry } from './search-source.js';
import {
  addToTagTool,
  createTag,
  createTagAccess,
  moveCopyById,
  removeAssociation,
  renameTag,
  saveAssociation,
  uiAssociationLevelsByTagKind,
  uiAssociationLevelLabel,
  uiMaxAssociationQuantity,
  uiTagKindLabel,
  uiTagKinds,
  type UiChangeOutcome,
  type UiTagAccess,
  type UiTagKind,
} from './tag-edits.js';

/** The organization views: the account's tags and one tag's deck, wishlist, location or grouping. */
export function createOrganizationPages(): readonly UiPageDefinition[] {
  return [tagsPage(), tagViewPage()];
}

/**
 * Tags page of the account: a bounded window of tags, the form that creates one and the rename
 * control of every presented tag (docs/user-interface.md#browsing-and-organization).
 */
function tagsPage(): UiPageDefinition {
  return {
    page: 'tags',
    mount(container, context) {
      const document = container.ownerDocument;
      const restored = readPageState(context.restored?.state);
      const access = createTagAccess(context.capabilities.userCards);
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
      container.append(heading, createForm, createStatus, listStatus, list, more, retry);

      /** Tags the page presents now, in stable identity order within the retained bound. */
      let tags: readonly Tag[] = readRetainedTags(restored?.tags) ?? [];
      let continuation = readContinuation(restored?.continuation);
      let complete = restored?.complete === true;
      let loading = false;
      let error: string | null = null;
      let closed = false;
      /** Unsaved rename input per tag, kept across paging and with the history entry. */
      const drafts = readDrafts(restored?.drafts);
      const rows = new Map<string, UiTagRow>();
      context.signal.addEventListener(
        'abort',
        () => {
          closed = true;
        },
        { once: true },
      );

      paint();
      // The retained window is re-read from the provider until it is covered again; the retained
      // tags stay presented while that read is unavailable
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
        capture: () => ({
          tags,
          continuation,
          complete,
          drafts: Object.fromEntries(drafts),
          kind: kind.value,
          label: label.value,
        }),
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
          context.signal,
        );
        if (closed) {
          return;
        }
        if (outcome.record !== null) {
          keep(outcome.record);
          label.value = '';
        } else if (outcome.status === 'unknown') {
          // A lost create response: the list is read again, so a tag the service committed appears
          // for review while the unsaved label stays in the form.
          void readWindow(tags.length);
        }
        createStatus.textContent =
          outcome.status === 'unknown'
            ? 'The outcome is unknown. Check whether the tag appears in the list before retrying.'
            : (outcome.message ?? `Created “${wanted}”.`);
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
          context.signal,
        );
        if (closed) {
          return;
        }
        if (outcome.record !== null) {
          keep(outcome.record);
          row.input.value = outcome.record.label;
        }
        row.status.textContent = outcome.message ?? 'Renamed the tag.';
        if (outcome.status === 'conflict') {
          // The tag changed meanwhile: its saved state is offered for review while the unsaved
          // label stays in the row for the retry.
          const current = await readTag(access, tag.tagId, context.signal);
          if (!closed && current !== null) {
            keep(current);
          }
        }
        paint();
      }

      /**
       * Reads the tags from the start of the account's list until the requested number is covered
       * or the list ends, and presents that fresh window. A failure keeps the retained tags and
       * reports the retry.
       */
      async function readWindow(cover: number): Promise<void> {
        if (closed) {
          return;
        }
        loading = true;
        error = null;
        paint();
        const read: Tag[] = [];
        let next: string | null = null;
        try {
          do {
            const page = await access.list(
              {
                pageSize: UI_LIMITS.tagPage,
                ...(next === null ? {} : { continuation: next }),
              },
              context.signal,
            );
            read.push(...page.tags.filter((candidate) => !candidate.system));
            next = page.continuation;
          } while (next !== null && read.length < Math.min(cover, UI_LIMITS.listWindow));
        } catch (cause) {
          if (closed) {
            return;
          }
          error = readMessage(cause, 'The tags could not be loaded.');
          loading = false;
          paint();
          return;
        }
        if (closed) {
          return;
        }
        tags = read.slice(0, UI_LIMITS.listWindow);
        continuation = next;
        complete = next === null;
        loading = false;
        paint();
      }

      /** Appends the next page of tags, retiring the oldest beyond the retained window. */
      async function loadMore(): Promise<void> {
        if (closed || loading || continuation === null) {
          return;
        }
        loading = true;
        error = null;
        paint();
        try {
          const page = await access.list(
            { pageSize: UI_LIMITS.tagPage, continuation },
            context.signal,
          );
          if (closed) {
            return;
          }
          const seen = new Set(tags.map((tag) => tag.tagId));
          tags = [
            ...tags,
            ...page.tags.filter((candidate) => !candidate.system && !seen.has(candidate.tagId)),
          ].slice(-UI_LIMITS.listWindow);
          continuation = page.continuation;
          complete = continuation === null;
        } catch (cause) {
          if (closed) {
            return;
          }
          error = readMessage(cause, 'The tags could not be loaded.');
        }
        loading = false;
        paint();
      }

      /** Keeps one provider-published tag in the window, ordered by stable identity. */
      function keep(tag: Tag): void {
        const kept = tags.filter((candidate) => candidate.tagId !== tag.tagId);
        const at = kept.findIndex((candidate) => candidate.tagId > tag.tagId);
        tags = (at === -1 ? [...kept, tag] : [...kept.slice(0, at), tag, ...kept.slice(at)]).slice(
          -UI_LIMITS.listWindow,
        );
        paint();
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
            row = tagRow(document, tag, draftOf(tag.tagId, tag.label), drafts, (edited) => {
              void submitRename(edited);
            });
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
        if (
          nodes.length !== current.length ||
          nodes.some((node, index) => node !== current[index])
        ) {
          list.replaceChildren(...nodes);
        }
        more.hidden = complete;
        more.disabled = loading;
        retry.hidden = error === null;
        listStatus.textContent =
          error ??
          (loading ? 'Loading tags…' : tags.length === 0 ? 'No tags yet. Create one above.' : '');
      }
    },
  };
}

/** One presented tag row: its link to the tag view, its saved label and its rename control. */
interface UiTagRow {
  readonly element: HTMLLIElement;
  readonly tagId: string;
  readonly input: HTMLInputElement;
  readonly status: HTMLParagraphElement;
  paint(tag: Tag): void;
}

function tagRow(
  document: Document,
  tag: Tag,
  label: string,
  drafts: Map<string, string>,
  rename: (row: UiTagRow) => void,
): UiTagRow {
  const element = document.createElement('li');
  element.dataset.uiTag = tag.tagId;
  const open = document.createElement('a');
  open.id = `tag-link-${encodeURIComponent(tag.tagId)}`;
  open.href = uiHref({ page: 'tag', tagId: tag.tagId });
  const kind = document.createElement('span');
  kind.dataset.uiTagKind = '';
  const form = document.createElement('form');
  const input = textInput(document, `tag-label-${encodeURIComponent(tag.tagId)}`, label);
  input.addEventListener('input', () => {
    drafts.set(tag.tagId, input.value);
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

/** The tag view: one tag's associations, its editable label and the search that adds members. */
function tagViewPage(): UiPageDefinition {
  return {
    page: 'tag',
    mount(container, context) {
      const view = context.view;
      if (view.page !== 'tag') {
        return;
      }
      const tagId = view.tagId;
      const document = container.ownerDocument;
      const restored = readPageState(context.restored?.state);
      const access = createTagAccess(context.capabilities.userCards);
      const presented = Promise.withResolvers<void>();
      // A page whose presentation the shell never awaits must still not surface a rejection.
      presented.promise.catch(() => {});
      let closed = false;
      context.signal.addEventListener(
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
      // The unsaved label the entry kept stands until it is saved or the tag is read again; an
      // entry that kept none presents the label the account stores.
      const restoredLabel = typeof restored?.label === 'string' ? restored.label : null;
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
      quantity.max = String(uiMaxAssociationQuantity);
      const addSubmit = submitButton(document, 'tag-add-submit', 'Search');
      const addHost = document.createElement('div');
      addHost.id = 'tag-add-results';
      const restoredAdd = readAddDraft(restored?.add);
      query.value = restoredAdd?.text ?? '';
      quantity.value = restoredAdd?.quantity ?? '1';
      container.append(
        heading,
        kindLine,
        renameForm,
        renameStatus,
        associationsHeading,
        associationsStatus,
        associationsHost,
        addHeading,
        addForm,
        addHost,
      );

      /** Tag the page presents; null until it is read or after a failed read. */
      let tag: Tag | null = null;
      /** Associations the presented rows interpret, keyed by their entry key. */
      const records = new Map<string, Association>();
      /** Editors of the presented association rows, rebuilt when a move's choices arrive. */
      const editors = new Map<string, UiAssociationEditor>();
      /** Printings offered to refine a card-level association, keyed by card identity. */
      const printings = new Map<string, readonly PrintingRecord[]>();
      const printingRequests = new Set<string>();
      /** Location tags the page offers for a move; the presented tag is always offered. */
      let locations: readonly Tag[] = [];
      let associations: UiCardList<string> | null = null;
      let addList: UiCardList<UiTagAddQuery> | null = null;
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
      void open();

      return {
        capture: captureState,
        presented: () => presented.promise,
        dispose: () => {
          associations?.dispose();
          addList?.dispose();
        },
      };

      function captureState(): unknown {
        return {
          label: labelInput.value,
          add: { text: query.value, level: level.value, quantity: quantity.value },
          // A list not composed yet keeps the state its entry handed back instead of overwriting
          // it with a partially presented view
          // (docs/user-interface.md#state-ownership-and-restoration).
          associations:
            associations === null ? retainedAssociations : { list: associations.capture() },
          results: addList === null ? retainedResults : { list: addList.capture() },
        };
      }

      /** Reads the presented tag and composes the view around it. */
      async function open(): Promise<void> {
        let read: Tag | null;
        let failure: string | null = null;
        try {
          read = await readTag(access, tagId, context.signal);
        } catch (cause) {
          read = null;
          failure = readMessage(cause, 'The tag could not be loaded.');
        }
        if (closed) {
          return;
        }
        if (read === null || read.system) {
          presentMissing(
            read === null
              ? failure
              : 'System tags are managed through their own lifecycle operations.',
          );
          presented.resolve();
          return;
        }
        tag = read;
        heading.textContent = read.label;
        kindLine.textContent = `Kind: ${uiTagKindLabel(kindOf(read.kind))}`;
        if (restoredLabel === null) {
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
        addForm.append(
          controlLabel(document, 'Find', query),
          controlLabel(document, 'Level', level),
        );
        if (!location) {
          addForm.append(controlLabel(document, 'Intended quantity', quantity));
        }
        addForm.append(addSubmit);
        if (location) {
          void readLocations();
        }
        const list = createCardList<string>({
          container: associationsHost,
          source: associationSource(access, context.capabilities.catalog, records),
          context: tagId,
          pageSize: UI_LIMITS.associationPage,
          restored: readListState<string>(retainedAssociations),
          fragments: { tags: associationReader() },
          presentation: {
            renderEntry: (entry) => associationEntry(document, entry),
            renderFragment: (kind, entry) => (kind === 'tags' ? associationEditor(entry) : null),
          },
          signal: context.signal,
        });
        associations = list;
        const restorations: (Promise<void> | null)[] = [list.restoration?.presented ?? null];
        if (retainedResults !== null) {
          // A restored search is composed again, so the entry's result window keeps its context.
          ensureAddList({ text: query.value, level: readUiCollectionLevel(level.value) });
          restorations.push(addList?.restoration?.presented ?? null);
        }
        reportPresentation(restorations);
      }

      /** Presents a tag that could not be read; the view owns no list then. */
      function presentMissing(failure: string | null): void {
        kindLine.textContent = failure ?? 'This account has no tag with that identity.';
        const back = document.createElement('a');
        back.id = 'tag-back';
        back.href = uiHref({ page: 'tags' });
        back.textContent = 'All tags';
        container.append(back);
        for (const element of [
          renameForm,
          renameStatus,
          associationsHeading,
          associationsStatus,
          associationsHost,
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
          context.signal,
        );
        if (closed) {
          return;
        }
        if (outcome.record !== null) {
          presentTag(outcome.record);
          if (outcome.status === 'committed') {
            labelInput.value = outcome.record.label;
          }
        }
        renameStatus.textContent = outcome.message ?? 'Renamed the tag.';
        if (outcome.status === 'conflict') {
          const reread = await readTag(access, current.tagId, context.signal);
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

      /** Reads the account's location tags, so a copy can move between the known locations. */
      async function readLocations(): Promise<void> {
        try {
          const page = await access.list({ pageSize: UI_LIMITS.tagPage }, context.signal);
          if (closed) {
            return;
          }
          locations = page.tags.filter((candidate) => kindOf(candidate.kind) === 'location');
        } catch (cause) {
          if (!closed) {
            associationsStatus.textContent = readMessage(
              cause,
              'The other locations could not be loaded.',
            );
          }
        }
        repaintEditors();
      }

      /**
       * Starts or restarts the add list for the query and level the form presents. The list is
       * created with the first search, so a tag view without a search reads no catalog page.
       */
      function search(): void {
        const next: UiTagAddQuery = {
          text: query.value,
          level: readUiCollectionLevel(level.value),
        };
        if (addList === null) {
          // The new list evaluates the presented query itself; refining it at once would withdraw
          // the result it just started.
          ensureAddList(next);
          return;
        }
        addList.refine(next);
      }

      function ensureAddList(next: UiTagAddQuery): void {
        if (addList !== null) {
          return;
        }
        addList = createCardList<UiTagAddQuery>({
          container: addHost,
          source: addSource(context.capabilities.search),
          context: next,
          pageSize: UI_LIMITS.catalogPage,
          restored: readListState<UiTagAddQuery>(retainedResults),
          fragments: { tools: addToolsReader() },
          tools: [
            {
              id: 'add-to-tag',
              label: 'Add to this tag',
              tool: {
                async invoke(request) {
                  const base = addToTagTool({
                    id: 'add-to-tag',
                    label: 'Add to this tag',
                    access,
                    tag: () => tag,
                    quantity: () => readQuantity(quantity),
                    guidance:
                      'Choose an intended quantity from 1 to ' +
                      `${uiMaxAssociationQuantity} before adding.`,
                  });
                  const outcome = await base.tool.invoke(request);
                  if (outcome.status === 'committed') {
                    // The tag's associations changed: the association list reads them again.
                    associations?.refresh();
                  }
                  return outcome;
                },
              },
            },
          ],
          signal: context.signal,
        });
        reportPresentation([addList.restoration?.presented ?? null]);
      }

      /** One entry's basic information beside the association level the row presents. */
      function associationEntry(document: Document, entry: UiListEntry): Node {
        const content = document.createElement('span');
        content.append(cardListBasicContent(document, entry));
        const association = records.get(entry.key);
        if (association !== undefined) {
          const level = document.createElement('span');
          level.dataset.uiAssociationLevel = association.targetLevel;
          level.textContent = ` ${uiAssociationLevelLabel(association.targetLevel)}`;
          content.append(level);
        }
        return content;
      }

      /** The fragment reader that carries one row's association to its own editor. */
      function associationReader(): UiFragmentReader<readonly { tagId: string; name: string }[]> {
        return {
          read(request) {
            return Promise.resolve(
              request.keys.map((key) => {
                const association = records.get(key);
                return association === undefined
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
      function associationEditor(entry: UiListEntry): Node | null {
        if (!records.has(entry.key) || tag === null) {
          return null;
        }
        const controls = document.createElement('span');
        controls.dataset.uiAssociation = entry.key;
        const association = records.get(entry.key);
        const status = statusLine(
          document,
          `tag-association-status-${encodeURIComponent(association?.associationId ?? entry.key)}`,
        );
        controls.append(status);
        const editor: UiAssociationEditor = { controls, entry, status, refresh: () => {} };
        editor.refresh = () => paintEditor(editor);
        editors.set(entry.key, editor);
        paintEditor(editor);
        return controls;
      }

      /** Draws one association editor; the row's unsaved control values survive a redraw. */
      function paintEditor(editor: UiAssociationEditor): void {
        const association = records.get(editor.entry.key);
        const current = tag;
        if (association === undefined || current === null) {
          return;
        }
        const values = new Map<string, string>();
        for (const control of editor.controls.querySelectorAll<
          HTMLInputElement | HTMLSelectElement
        >('input,select')) {
          if (control.id.length > 0) {
            values.set(control.id, control.value);
          }
        }
        const kind = kindOf(current.kind);
        const controls: (Node | string)[] = [];
        if (association.targetLevel !== 'copy') {
          const wanted = numberInput(
            document,
            `tag-quantity-${encodeURIComponent(association.associationId)}`,
            values.get(`tag-quantity-${encodeURIComponent(association.associationId)}`) ??
              String(association.quantity ?? 1),
          );
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
          const loaded = printings.get(association.targetId);
          if (loaded === undefined) {
            // The card's printings are read when the owner refines this association, so a long
            // wishlist issues no catalog request for every presented card.
            const choose = button(
              document,
              `tag-refine-choose-${encodeURIComponent(association.associationId)}`,
              'Choose printing…',
            );
            choose.addEventListener('click', () => {
              choose.disabled = true;
              void loadPrintings(association.targetId, editor);
            });
            controls.push(choose, ' ');
          } else {
            const chosen = document.createElement('select');
            chosen.id = `tag-refine-${encodeURIComponent(association.associationId)}`;
            paintPrintings(chosen, loaded, values.get(chosen.id));
            const refine = button(
              document,
              `tag-refine-save-${encodeURIComponent(association.associationId)}`,
              'Refine to printing',
            );
            refine.addEventListener('click', () => {
              if (chosen.value.length === 0) {
                editor.status.textContent = 'Choose the printing to refine the association to.';
                return;
              }
              void saveAssociationChange(
                association,
                'printing',
                chosen.value,
                association.quantity,
                editor.status,
              );
            });
            controls.push(controlLabel(document, 'Printing', chosen), refine, ' ');
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
            ...locations.filter((candidate) => candidate.tagId !== current.tagId),
          ];
          for (const location of offered) {
            const option = document.createElement('option');
            option.value = location.tagId;
            option.textContent = location.label;
            chosen.append(option);
          }
          chosen.value = values.get(chosen.id) ?? current.tagId;
          const move = button(
            document,
            `tag-move-save-${encodeURIComponent(association.associationId)}`,
            'Move',
          );
          move.addEventListener('click', () => {
            void moveCopy(association.targetId, chosen.value, editor.status);
          });
          controls.push(controlLabel(document, 'Move to', chosen), move);
        }
        editor.controls.replaceChildren(editor.status, ...controls);
      }

      /** Saves the intended quantity the row presents, quoting the revision it read. */
      async function saveQuantity(
        association: Association,
        wanted: HTMLInputElement,
      ): Promise<void> {
        const quantity = readQuantity(wanted);
        const editor = editors.get(associationKey(association));
        if (quantity === null) {
          if (editor !== undefined) {
            editor.status.textContent = `Choose an intended quantity from 1 to ${uiMaxAssociationQuantity}.`;
          }
          return;
        }
        await saveAssociationChange(
          association,
          association.targetLevel,
          association.targetId,
          quantity,
          editor?.status ?? null,
        );
      }

      /** Applies one revision-guarded association change and presents its outcome. */
      async function saveAssociationChange(
        association: Association,
        targetLevel: AssociationTargetLevel,
        targetId: string,
        quantity: number | null,
        status: HTMLParagraphElement | null,
      ): Promise<void> {
        const outcome = await saveAssociation(
          access,
          {
            associationId: association.associationId,
            expectedRevision: association.revision,
            targetLevel,
            targetId,
            quantity,
          },
          context.signal,
        );
        presentAssociationOutcome(outcome, status);
      }

      /** Removes one association after a brief confirmation. */
      async function removeEditorAssociation(
        association: Association,
        control: HTMLButtonElement,
        status: HTMLParagraphElement,
      ): Promise<void> {
        control.disabled = true;
        const confirmed = await context.dialogs.confirm({
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
          context.signal,
        );
        presentAssociationOutcome(outcome, status);
      }

      /** Moves one copy to the location the row presents, or clears its location. */
      async function moveCopy(
        copyId: string,
        locationTagId: string,
        status: HTMLParagraphElement,
      ): Promise<void> {
        const outcome = await moveCopyById(
          access,
          copyId,
          locationTagId.length === 0 ? null : locationTagId,
          context.signal,
        );
        presentAssociationOutcome(outcome, status);
      }

      /**
       * Presents one change's outcome: only a committed change is reported as saved and the
       * association list reads the tag's associations again; a conflict or a definite failure
       * keeps the row's unsaved input for review
       * (docs/user-interface.md#browsing-and-organization).
       */
      function presentAssociationOutcome(
        outcome: UiChangeOutcome<unknown>,
        status: HTMLParagraphElement | null,
      ): void {
        if (closed) {
          return;
        }
        if (status !== null) {
          status.textContent = outcome.message ?? 'Saved.';
        }
        if (
          outcome.status === 'committed' ||
          (outcome.status === 'unknown' && outcome.record !== null)
        ) {
          associations?.refresh();
        }
      }

      /**
       * Reads the printings of one card the owner asked to refine an association to, on demand:
       * a presented card association issues no catalog request until the owner refines it. A
       * failure stays visible beside the control instead of presenting curated choices as the
       * whole list.
       */
      async function loadPrintings(cardId: string, editor: UiAssociationEditor): Promise<void> {
        if (printingRequests.has(cardId)) {
          return;
        }
        printingRequests.add(cardId);
        editor.status.textContent = 'Loading printings…';
        try {
          const page = await context.capabilities.catalog.listCardPrintings(cardId, {
            pageSize: UI_LIMITS.printingPage,
          });
          if (closed) {
            return;
          }
          if (printings.size >= UI_LIMITS.listWindow) {
            const oldest = printings.keys().next().value;
            if (oldest !== undefined) {
              printings.delete(oldest);
            }
          }
          printings.set(cardId, page.printings);
          editor.status.textContent = '';
        } catch (cause) {
          if (closed) {
            return;
          }
          editor.status.textContent = readMessage(cause, 'The printings could not be loaded.');
        } finally {
          printingRequests.delete(cardId);
        }
        if (editor.controls.isConnected) {
          editor.refresh();
        }
      }

      /** Fills one refinement control with the printings the catalog published. */
      function paintPrintings(
        chosen: HTMLSelectElement,
        known: readonly PrintingRecord[],
        wanted?: string,
      ): void {
        chosen.replaceChildren(
          ...known.map((printing) => {
            const option = document.createElement('option');
            option.value = printing.printingId;
            option.textContent = `${printing.edition} ${printing.collectorNumber} · ${printing.language}`;
            return option;
          }),
        );
        chosen.disabled = known.length === 0;
        if (wanted !== undefined && known.some((printing) => printing.printingId === wanted)) {
          chosen.value = wanted;
        }
      }

      /** Whether each presented entry offers the add tool for the presented tag. */
      function addToolsReader(): UiFragmentReader<readonly string[]> {
        return {
          read(request) {
            const current = tag;
            const levels =
              current === null ? [] : uiAssociationLevelsByTagKind[kindOf(current.kind)];
            return Promise.resolve(
              request.keys.map((key) => {
                const target = targetOfKey(key);
                return {
                  key,
                  status: 'ready' as const,
                  values: target !== null && levels.includes(target.kind) ? ['add-to-tag'] : [],
                };
              }),
            );
          },
        };
      }

      /** Redraws the presented association editors, so they follow the choices now known. */
      function repaintEditors(): void {
        for (const [key, editor] of editors) {
          if (!editor.controls.isConnected) {
            editors.delete(key);
            continue;
          }
          editor.refresh();
        }
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
    },
  };
}

/** One presented association editor and the row it belongs to. */
interface UiAssociationEditor {
  readonly controls: HTMLSpanElement;
  readonly entry: UiListEntry;
  readonly status: HTMLParagraphElement;
  refresh(): void;
}

/** One add search: the text expression and the result level the tag view presents. */
interface UiTagAddQuery {
  readonly text: string;
  readonly level: 'card' | 'printing' | 'copy';
}

/** The source of one tag view's association list: the tag's associations with resolved basics. */
function associationSource(
  access: UiTagAccess,
  catalog: Catalog,
  records: Map<string, Association>,
): UiListSource<string> {
  return {
    async load(request) {
      const page = await access.associations(
        request.context,
        {
          pageSize: request.pageSize,
          ...(request.continuation === null ? {} : { continuation: request.continuation }),
        },
        request.signal,
      );
      const entries = await associationEntries(
        page.associations,
        access,
        catalog,
        records,
        request.signal,
      );
      return { entries, continuation: page.continuation };
    },
  };
}

/**
 * Adapts one page of associations to the list boundary and records each association under its entry
 * key, so the row that presents it edits the identity and revision a read observed. The records of
 * entries the list no longer presents are retired under the bound the list renders.
 */
async function associationEntries(
  associations: readonly Association[],
  access: UiTagAccess,
  catalog: Catalog,
  records: Map<string, Association>,
  signal: AbortSignal,
): Promise<readonly UiListEntry[]> {
  const copies = await readAssociationCopies(associations, access, signal);
  const printingIds = new Set<string>();
  for (const association of associations) {
    if (association.targetLevel === 'printing') {
      printingIds.add(association.targetId);
    }
    const copy = copies.get(association.targetId);
    if (association.targetLevel === 'copy' && copy !== undefined) {
      printingIds.add(copy.printingId);
    }
  }
  const printings = await resolvePrintings(catalog, [...printingIds]);
  const cardIds = new Set<string>();
  for (const association of associations) {
    if (association.targetLevel === 'card') {
      cardIds.add(association.targetId);
    }
  }
  for (const printing of printings.values()) {
    cardIds.add(printing.cardId);
  }
  const cards = await resolveCards(catalog, [...cardIds]);
  const entries: UiListEntry[] = [];
  for (const association of associations) {
    const key = associationKey(association);
    records.set(key, association);
    entries.push(associationListEntry(key, association, copies, printings, cards));
  }
  const presented = new Set(entries.map((entry) => entry.key));
  while (records.size > UI_LIMITS.listWindow + UI_LIMITS.listPage) {
    const oldest = records.keys().next().value;
    if (oldest === undefined || presented.has(oldest)) {
      break;
    }
    records.delete(oldest);
  }
  return entries;
}

/** One association as the list boundary presents it: its typed target and resolved basics. */
function associationListEntry(
  key: string,
  association: Association,
  copies: ReadonlyMap<string, PhysicalCopy>,
  printings: ReadonlyMap<string, PrintingRecord>,
  cards: ReadonlyMap<string, CardRecord>,
): UiListEntry {
  const target: UiEntryTarget =
    association.targetLevel === 'card'
      ? { kind: 'card', cardId: association.targetId }
      : association.targetLevel === 'printing'
        ? { kind: 'printing', printingId: association.targetId }
        : { kind: 'copy', copyId: association.targetId };
  const copy =
    association.targetLevel === 'copy' ? (copies.get(association.targetId) ?? null) : null;
  const printing =
    association.targetLevel === 'printing'
      ? (printings.get(association.targetId) ?? null)
      : copy === null
        ? null
        : (printings.get(copy.printingId) ?? null);
  const cardId = association.targetLevel === 'card' ? association.targetId : printing?.cardId;
  const card = cardId === undefined ? null : (cards.get(cardId) ?? null);
  const resolved = card !== null && (association.targetLevel === 'card' || printing !== null);
  return {
    key,
    target,
    basic: resolved
      ? {
          card: {
            cardId: (card as CardRecord).cardId,
            name: (card as CardRecord).name,
            matchedName: null,
          },
          printing:
            printing === null
              ? null
              : {
                  printingId: printing.printingId,
                  edition: printing.edition,
                  collectorNumber: printing.collectorNumber,
                  language: printing.language,
                },
        }
      : null,
    quantity: { copies: null, intended: association.quantity },
  };
}

/** Stable key of one association entry; the row's editor looks the record up under it. */
function associationKey(association: Association): string {
  return `association:${association.associationId}`;
}

/** Copies the copy-targeted associations name, read in the bounded batches a private read accepts. */
async function readAssociationCopies(
  associations: readonly Association[],
  access: UiTagAccess,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, PhysicalCopy>> {
  const ids = [
    ...new Set(
      associations
        .filter((association) => association.targetLevel === 'copy')
        .map((association) => association.targetId),
    ),
  ];
  const copies = new Map<string, PhysicalCopy>();
  for (let index = 0; index < ids.length; index += UI_LIMITS.copyBatch) {
    const batch = ids.slice(index, index + UI_LIMITS.copyBatch);
    const read = await access.readCopies(batch, signal);
    for (const copy of read.copies.values()) {
      copies.set(copy.copyId, copy);
    }
  }
  return copies;
}

/** Printings the associations name, resolved through Catalog in bounded batches. */
async function resolvePrintings(
  catalog: Catalog,
  printingIds: readonly string[],
): Promise<ReadonlyMap<string, PrintingRecord>> {
  const printings = new Map<string, PrintingRecord>();
  for (let index = 0; index < printingIds.length; index += UI_LIMITS.copyBatch) {
    const batch = printingIds.slice(index, index + UI_LIMITS.copyBatch);
    const resolution = await catalog.resolve(
      batch.map((printingId) => ({ kind: 'printing' as const, printingId })),
    );
    for (const printing of resolution.printings.values()) {
      printings.set(printing.printingId, printing);
    }
  }
  return printings;
}

/** Cards the associations reach, resolved through Catalog in bounded batches. */
async function resolveCards(
  catalog: Catalog,
  cardIds: readonly string[],
): Promise<ReadonlyMap<string, CardRecord>> {
  const cards = new Map<string, CardRecord>();
  for (let index = 0; index < cardIds.length; index += UI_LIMITS.copyBatch) {
    const batch = cardIds.slice(index, index + UI_LIMITS.copyBatch);
    const resolution = await catalog.resolve(
      batch.map((cardId) => ({ kind: 'card' as const, cardId })),
    );
    for (const card of resolution.cards.values()) {
      cards.set(card.cardId, card);
    }
  }
  return cards;
}

/** The source of one add search: the Search contract over the presented query. */
function addSource(search: SearchClient): UiListSource<UiTagAddQuery> {
  return {
    async load(request) {
      const page = await search.execute(
        addSearchRequest(request.context, request.pageSize, request.continuation),
        request.signal,
      );
      return {
        entries: page.entries.map((entry) => searchListEntry(entry)),
        continuation: page.continuation,
      };
    },
  };
}

/** One add search as the Search contract receives it; a copy level reads the owned copies. */
function addSearchRequest(
  query: UiTagAddQuery,
  pageSize: number,
  continuation: string | null,
): SearchRequestInput {
  const text = query.text.trim();
  return {
    resultLevel: query.level,
    ...(text.length === 0 ? {} : { query: text }),
    ...(query.level === 'copy' ? { criteria: [{ kind: 'owned' as const }] } : {}),
    pageSize,
    ...(continuation === null ? {} : { continuation }),
  };
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
function readAddLevel(value: unknown): UiTagAddQuery['level'] | null {
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
  return drafts;
}

/** The intended quantity one control names, or null when it is not a bounded positive number. */
function readQuantity(input: HTMLInputElement): number | null {
  const value = Number(input.value);
  return Number.isSafeInteger(value) && value >= 1 && value <= uiMaxAssociationQuantity
    ? value
    : null;
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

function numberInput(document: Document, id: string, value: string): HTMLInputElement {
  const element = document.createElement('input');
  element.id = id;
  element.type = 'number';
  element.min = '1';
  element.max = String(uiMaxAssociationQuantity);
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
