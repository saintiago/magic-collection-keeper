/**
 * Component scope: the operation presentation of the Editors module
 * (docs/ui/editors.md#drafts-and-asynchronous-outcomes,
 * docs/application.md#construction-and-request-boundary).
 *
 * An editor runs the action a list reported and presents what its provider established. A
 * rejection carries no receipt and an answer outside the operation vocabulary establishes
 * nothing, so both stay unknown instead of being presented as a saved change; the checked outcome
 * keeps the further fields a batch action reports.
 */

import { describe, expect, it } from 'vitest';

import { applyAction, outcomeText, type UiOperationOutcome } from '../../../src/ui/index.js';

/** One request over an explicit selection; the action under test decides what to do with it. */
function request() {
  return {
    selection: { keys: ['copy:copy-1'], targets: [{ kind: 'copy', copyId: 'copy-1' } as const] },
    signal: new AbortController().signal,
  };
}

describe('operation presentation', () => {
  it('presents the outcome the operation reported, keeping the fields it carried', async () => {
    const outcome = await applyAction(
      {
        id: 'add-to-tag',
        label: 'Add to this tag',
        apply: async () => ({ status: 'committed', message: 'Saved 2 entries.', committed: 2 }),
      },
      request(),
    );

    expect(outcome).toEqual({
      status: 'committed',
      message: 'Saved 2 entries.',
      committed: 2,
    });
  });

  it('reports a rejected dispatch as unknown, because it carried no receipt', async () => {
    const outcome = await applyAction(
      {
        id: 'add-to-tag',
        label: 'Add to this tag',
        apply: () => Promise.reject(new Error('Failed to fetch')),
      },
      request(),
    );

    expect(outcome).toEqual({ status: 'unknown', message: null });
  });

  it('reports an answer outside the operation vocabulary as unknown', async () => {
    const outcome = await applyAction(
      {
        id: 'add-to-tag',
        label: 'Add to this tag',
        apply: async () => ({ status: 'weird' }) as unknown as UiOperationOutcome,
      },
      request(),
    );

    expect(outcome).toEqual({ status: 'unknown', message: null });
  });

  it('explains an outcome that carries no message of its own', () => {
    expect(outcomeText('committed')).toBe('Saved.');
    expect(outcomeText('conflict')).toContain('conflicts');
    expect(outcomeText('failed')).toContain('retry');
    expect(outcomeText('unknown')).toContain('unknown');
  });
});
