/**
 * Component scope: the tags page and tag view boundaries of the UserInterface
 * (docs/user-interface.md#browsing-and-organization, docs/user-cards.md#records-and-associations).
 *
 * The tag control vocabulary, the private access the organization views build over the UserCards
 * contract and the outcomes of renaming a tag, changing an association and moving a copy are
 * asserted here; the pages themselves are exercised as observable browser behavior in
 * tests/browser/tags.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest';

import { ApplicationError } from '../../../src/application/index.js';
import type { Association, PhysicalCopy, Tag } from '../../../src/usercards/index.js';
import {
  addAssociation,
  addToTagTool,
  createTagAccess,
  moveCopyById,
  removeAssociation,
  renameTag,
  saveAssociation,
  uiAssociationLevelLabel,
  uiAssociationLevelsByTagKind,
  uiTagKindLabel,
  uiTagKinds,
  type UiTagAccess,
  type UiTagClient,
} from '../../../src/ui/index.js';

function tag(overrides: Partial<Tag> = {}): Tag {
  return {
    tagId: 'tag-burn',
    kind: 'deck',
    label: 'Burn',
    system: false,
    revision: 1,
    ...overrides,
  };
}

function association(overrides: Partial<Association> = {}): Association {
  return {
    associationId: 'association-1',
    tagId: 'tag-to-buy',
    targetLevel: 'card',
    targetId: 'card-bolt',
    quantity: 2,
    revision: 3,
    ...overrides,
  };
}

function copy(overrides: Partial<PhysicalCopy> = {}): PhysicalCopy {
  return {
    copyId: 'copy-1',
    printingId: 'printing-1',
    finish: 'nonfoil',
    condition: 'NM',
    revision: 5,
    ...overrides,
  };
}

/** One private client whose operations the case scripts; unscripted calls fail loudly. */
function client(overrides: Partial<UiTagClient> = {}): UiTagClient {
  const unused = () => Promise.reject(new Error('The case did not script this operation.'));
  return {
    readCopies: unused,
    listTags: unused,
    readTags: unused,
    createTag: unused,
    renameTag: unused,
    listAssociations: unused,
    readAssociations: unused,
    createAssociation: unused,
    changeAssociation: unused,
    removeAssociation: unused,
    setCopyLocation: unused,
    ...overrides,
  };
}

/** One access whose operations the case scripts; unscripted calls fail loudly. */
function access(overrides: Partial<UiTagAccess> = {}): UiTagAccess {
  const unused = () => Promise.reject(new Error('The case did not script this operation.'));
  return {
    list: unused,
    read: unused,
    associations: unused,
    readAssociations: unused,
    readCopies: unused,
    createTag: unused,
    renameTag: unused,
    createAssociation: unused,
    changeAssociation: unused,
    removeAssociation: unused,
    setCopyLocation: unused,
    ...overrides,
  };
}

describe('tag vocabulary', () => {
  it('presents the kinds the account creates and edits', () => {
    expect([...uiTagKinds]).toEqual(['deck', 'wishlist', 'location', 'other']);
    expect(uiTagKindLabel('wishlist')).toBe('Wishlist');
    expect(uiTagKindLabel('location')).toBe('Location');
  });

  it('keeps a wishlist to card and printing intent and a location to physical copies', () => {
    expect(uiAssociationLevelsByTagKind.wishlist).toEqual(['card', 'printing']);
    expect(uiAssociationLevelsByTagKind.location).toEqual(['copy']);
    expect(uiAssociationLevelsByTagKind.deck).toEqual(['card', 'printing', 'copy']);
    expect(uiAssociationLevelLabel('copy')).toBe('Physical copy');
  });
});

describe('tag access', () => {
  it('reads and changes tags through the UserCards contract', async () => {
    const listTags = vi.fn(async () => ({
      privateRevision: 'r1',
      tags: [tag()],
      continuation: null,
    }));
    const listAssociations = vi.fn(async () => ({
      privateRevision: 'r1',
      associations: [association()],
      continuation: null,
    }));
    const built = createTagAccess(client({ listTags, listAssociations }));

    await expect(built.list({ pageSize: 2 })).resolves.toEqual({
      privateRevision: 'r1',
      tags: [tag()],
      continuation: null,
    });
    await expect(built.associations('tag-to-buy', { pageSize: 50 })).resolves.toEqual({
      privateRevision: 'r1',
      associations: [association()],
      continuation: null,
    });
    expect(listTags).toHaveBeenCalledWith({ pageSize: 2 }, undefined);
    expect(listAssociations).toHaveBeenCalledWith('tag-to-buy', { pageSize: 50 }, undefined);
  });

  it('requires every operation the organization views present', () => {
    expect(() => createTagAccess({} as unknown as UiTagClient)).toThrow(TypeError);
    expect(() =>
      createTagAccess({
        readCopies: () => Promise.reject(new Error('no')),
      } as unknown as UiTagClient),
    ).toThrow(TypeError);
  });
});

describe('tag changes', () => {
  it('reports a committed rename and a conflict that keeps the caller’s input', async () => {
    const renamed = tag({ label: 'Burn deck', revision: 2 });
    const committed = await renameTag(
      access({
        renameTag: async () => ({
          privateRevision: 'r2',
          publicationPosition: '2',
          tag: renamed,
        }),
      }),
      { tagId: 'tag-burn', expectedRevision: 1, label: 'Burn deck' },
    );
    expect(committed).toEqual({ status: 'committed', message: null, record: renamed });

    const conflict = await renameTag(
      access({
        renameTag: () =>
          Promise.reject(
            new ApplicationError(
              'conflict',
              'The tag changed after this revision; reload it before renaming it.',
            ),
          ),
      }),
      { tagId: 'tag-burn', expectedRevision: 1, label: 'Burn deck' },
    );
    expect(conflict.status).toBe('conflict');
    expect(conflict.message).toContain('changed after this revision');
    expect(conflict.record).toBeNull();
  });

  it('reports a definite failure without recovering and an unknown outcome with the record read back', async () => {
    const failed = await renameTag(
      access({
        renameTag: () =>
          Promise.reject(new ApplicationError('invalid-request', 'A label is needed.')),
      }),
      { tagId: 'tag-burn', expectedRevision: 1, label: 'x' },
    );
    expect(failed).toEqual({ status: 'failed', message: 'A label is needed.', record: null });

    const observed = tag({ label: 'Burn deck', revision: 2 });
    const unknown = await renameTag(
      access({
        renameTag: () =>
          Promise.reject(new ApplicationError('unavailable', 'The service is down.')),
        read: async () => ({
          privateRevision: 'r2',
          tags: new Map([[observed.tagId, observed]]),
          missing: [],
        }),
      }),
      { tagId: 'tag-burn', expectedRevision: 1, label: 'Burn deck' },
    );
    expect(unknown.status).toBe('unknown');
    expect(unknown.record).toEqual(observed);
  });

  it('changes an association’s intended quantity and recovers a lost response by reading it', async () => {
    const changed = association({ quantity: 4, revision: 4 });
    const committed = await saveAssociation(
      access({
        changeAssociation: async () => ({
          privateRevision: 'r4',
          publicationPosition: '4',
          association: changed,
        }),
      }),
      {
        associationId: 'association-1',
        expectedRevision: 3,
        targetLevel: 'card',
        targetId: 'card-bolt',
        quantity: 4,
      },
    );
    expect(committed.record).toEqual(changed);

    const conflict = await saveAssociation(
      access({
        changeAssociation: () =>
          Promise.reject(new ApplicationError('conflict', 'The association changed.')),
      }),
      {
        associationId: 'association-1',
        expectedRevision: 3,
        targetLevel: 'card',
        targetId: 'card-bolt',
        quantity: 4,
      },
    );
    expect(conflict.status).toBe('conflict');

    const unknown = await saveAssociation(
      access({
        changeAssociation: () =>
          Promise.reject(new ApplicationError('unavailable', 'The service is down.')),
        readAssociations: async () => ({
          privateRevision: 'r4',
          associations: new Map([[changed.associationId, changed]]),
          missing: [],
        }),
      }),
      {
        associationId: 'association-1',
        expectedRevision: 3,
        targetLevel: 'card',
        targetId: 'card-bolt',
        quantity: 4,
      },
    );
    expect(unknown.status).toBe('unknown');
    expect(unknown.record).toEqual(changed);
  });

  it('adds and removes associations through the private contract', async () => {
    const added = association({ revision: 1 });
    await expect(
      addAssociation(
        access({
          createAssociation: async () => ({
            privateRevision: 'r1',
            publicationPosition: '1',
            association: added,
          }),
        }),
        { tagId: 'tag-to-buy', targetLevel: 'printing', targetId: 'printing-1', quantity: 2 },
      ),
    ).resolves.toEqual({ status: 'committed', message: null, record: added });

    await expect(
      removeAssociation(
        access({
          removeAssociation: async () => ({
            privateRevision: 'r2',
            publicationPosition: '2',
            associationId: 'association-1',
          }),
        }),
        { associationId: 'association-1', expectedRevision: 3 },
      ),
    ).resolves.toEqual({
      status: 'committed',
      message: null,
      record: 'association-1',
    });
  });
});

describe('copy locations', () => {
  it('quotes the revision one private read observed when a copy moves', async () => {
    const moves: unknown[] = [];
    const observed = copy();
    const outcome = await moveCopyById(
      access({
        readCopies: async () => ({
          privateRevision: 'r5',
          copies: new Map([[observed.copyId, observed]]),
          missing: [],
        }),
        setCopyLocation: async (input) => {
          moves.push(input);
          return {
            privateRevision: 'r6',
            publicationPosition: '6',
            copy: { ...observed, revision: 6 },
            location: association({
              associationId: 'association-location',
              targetLevel: 'copy',
              targetId: observed.copyId,
              quantity: null,
              revision: 1,
            }),
          };
        },
      }),
      'copy-1',
      'tag-binder',
    );

    expect(outcome.status).toBe('committed');
    expect(moves).toEqual([{ copyId: 'copy-1', locationTagId: 'tag-binder', expectedRevision: 5 }]);
  });

  it('does not move a copy this account no longer holds', async () => {
    const outcome = await moveCopyById(
      access({
        readCopies: async () => ({
          privateRevision: 'r5',
          copies: new Map(),
          missing: ['copy-1'],
        }),
      }),
      'copy-1',
      null,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.record).toBeNull();
  });
});

describe('adding selected entries to a tag', () => {
  const request = (target: { kind: 'card' | 'printing' | 'copy'; id: string }) => ({
    targets: [
      target.kind === 'card'
        ? { kind: 'card' as const, cardId: target.id }
        : target.kind === 'printing'
          ? { kind: 'printing' as const, printingId: target.id }
          : { kind: 'copy' as const, copyId: target.id },
    ],
    selection: { keys: ['key-1'], targets: [] },
    signal: new AbortController().signal,
  });

  it('adds a card with the intended quantity the page presents', async () => {
    const created: unknown[] = [];
    const tool = addToTagTool({
      id: 'add-to-tag',
      label: 'Add to this tag',
      access: access({
        createAssociation: async (input) => {
          created.push(input);
          return {
            privateRevision: 'r1',
            publicationPosition: '1',
            association: association({ revision: 1 }),
          };
        },
      }),
      tag: () => tag({ kind: 'wishlist', tagId: 'tag-to-buy' }),
      quantity: () => 2,
      guidance: 'Choose an intended quantity.',
    });

    const outcome = await tool.tool.invoke(request({ kind: 'card', id: 'card-bolt' }));

    expect(outcome.status).toBe('committed');
    expect(created).toEqual([
      { tagId: 'tag-to-buy', targetLevel: 'card', targetId: 'card-bolt', quantity: 2 },
    ]);
  });

  it('adds a printing-specific wishlist entry and reports an existing association as a conflict', async () => {
    const created: unknown[] = [];
    const tool = addToTagTool({
      id: 'add-to-tag',
      label: 'Add to this tag',
      access: access({
        createAssociation: async (input) => {
          created.push(input);
          throw new ApplicationError(
            'conflict',
            'This tag already associates that target; change the existing association instead.',
          );
        },
      }),
      tag: () => tag({ kind: 'wishlist', tagId: 'tag-to-buy' }),
      quantity: () => 1,
      guidance: 'Choose an intended quantity.',
    });

    const outcome = await tool.tool.invoke(request({ kind: 'printing', id: 'printing-1' }));

    expect(created).toEqual([
      { tagId: 'tag-to-buy', targetLevel: 'printing', targetId: 'printing-1', quantity: 1 },
    ]);
    expect(outcome.status).toBe('conflict');
  });

  it('reports the committed part of a selection beside the failures that did not commit', async () => {
    const committed: unknown[] = [];
    const tool = addToTagTool({
      id: 'add-to-tag',
      label: 'Add to this tag',
      access: access({
        createAssociation: async (input) => {
          if (input.targetId === 'card-bolt') {
            committed.push(input);
            return {
              privateRevision: 'r1',
              publicationPosition: '1',
              association: association({ revision: 1 }),
            };
          }
          throw new ApplicationError(
            'conflict',
            'The copy changed after this revision; reload it before moving it.',
          );
        },
      }),
      tag: () => tag({ kind: 'deck', tagId: 'tag-burn' }),
      quantity: () => 2,
      guidance: 'Choose an intended quantity.',
    });

    const outcome = await tool.tool.invoke({
      targets: [
        { kind: 'card', cardId: 'card-bolt' },
        { kind: 'printing', printingId: 'printing-2' },
      ],
      selection: { keys: ['key-1', 'key-2'], targets: [] },
      signal: new AbortController().signal,
    });

    expect(committed).toHaveLength(1);
    expect(outcome.status).toBe('conflict');
    expect(outcome.committed).toBe(1);
    expect(outcome.unknown).toBe(0);
    // The committed portion is reported, and the conflict keeps its own meaning instead of being
    // presented as duplicate membership.
    expect(outcome.message).toBe(
      '1 of 2 entries were added; 1 were not. The copy changed after this revision; reload it ' +
        'before moving it.',
    );
  });

  it('keeps an unknown outcome distinct and reports what committed before it', async () => {
    let calls = 0;
    const tool = addToTagTool({
      id: 'add-to-tag',
      label: 'Add to this tag',
      access: access({
        createAssociation: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              privateRevision: 'r1',
              publicationPosition: '1',
              association: association({ revision: 1 }),
            };
          }
          throw new ApplicationError('unavailable', 'The service is down.');
        },
      }),
      tag: () => tag({ kind: 'deck', tagId: 'tag-burn' }),
      quantity: () => 2,
      guidance: 'Choose an intended quantity.',
    });

    const outcome = await tool.tool.invoke({
      targets: [
        { kind: 'card', cardId: 'card-bolt' },
        { kind: 'printing', printingId: 'printing-2' },
      ],
      selection: { keys: ['key-1', 'key-2'], targets: [] },
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe('unknown');
    expect(outcome.committed).toBe(1);
    expect(outcome.unknown).toBe(1);
    expect(outcome.message).toContain('1 of 2 entries were added; 0 were not.');
    expect(outcome.message).toContain('1 of 2 entries have an unknown outcome.');
  });

  it('keeps definite rejection details beside committed and uncertain bulk additions', async () => {
    let calls = 0;
    const tool = addToTagTool({
      id: 'add-to-tag',
      label: 'Add',
      access: access({
        createAssociation: async () => {
          calls += 1;
          if (calls === 1)
            return {
              privateRevision: 'r1',
              publicationPosition: '1',
              association: association(),
            };
          if (calls === 2) throw new ApplicationError('conflict', 'Already associated.');
          throw new ApplicationError('unavailable', 'Lost response.');
        },
      }),
      tag: () => tag({ kind: 'deck' }),
      quantity: () => 2,
      guidance: 'Choose quantity.',
    });
    const outcome = await tool.tool.invoke({
      targets: ['one', 'two', 'three'].map((cardId) => ({ kind: 'card' as const, cardId })),
      selection: { keys: [], targets: [] },
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe('unknown');
    expect(outcome.message).toContain('1 of 3 entries were added; 1 were not.');
    expect(outcome.message).toContain('1 of 3 entries have an unknown outcome.');
    expect(outcome.message).toContain('Already associated.');
  });

  it('moves a selected copy into a location and associates it with a deck', async () => {
    const moves: unknown[] = [];
    const observed = copy();
    const location = addToTagTool({
      id: 'add-to-tag',
      label: 'Add to this tag',
      access: access({
        readCopies: async () => ({
          privateRevision: 'r5',
          copies: new Map([[observed.copyId, observed]]),
          missing: [],
        }),
        setCopyLocation: async (input) => {
          moves.push(input);
          return {
            privateRevision: 'r6',
            publicationPosition: '6',
            copy: observed,
            location: null,
          };
        },
      }),
      tag: () => tag({ kind: 'location', tagId: 'tag-binder' }),
      quantity: () => null,
      guidance: 'Choose an intended quantity.',
    });
    expect((await location.tool.invoke(request({ kind: 'copy', id: 'copy-1' }))).status).toBe(
      'committed',
    );
    expect(moves).toEqual([{ copyId: 'copy-1', locationTagId: 'tag-binder', expectedRevision: 5 }]);

    const memberships: unknown[] = [];
    const deck = addToTagTool({
      id: 'add-to-tag',
      label: 'Add to this tag',
      access: access({
        createAssociation: async (input) => {
          memberships.push(input);
          return {
            privateRevision: 'r1',
            publicationPosition: '1',
            association: association({ revision: 1 }),
          };
        },
      }),
      tag: () => tag({ kind: 'deck', tagId: 'tag-burn' }),
      quantity: () => 1,
      guidance: 'Choose an intended quantity.',
    });
    expect((await deck.tool.invoke(request({ kind: 'copy', id: 'copy-1' }))).status).toBe(
      'committed',
    );
    expect(memberships).toEqual([{ tagId: 'tag-burn', targetLevel: 'copy', targetId: 'copy-1' }]);
  });
});
