/**
 * Component scope: the retained recognition baseline. REBUILD-003 requires the preserved engine
 * files to match the pinned reference revision, so this check recomputes the recorded digests and
 * reports every relocated or harness-adapted file with its reason.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface BaselineManifest {
  baseline: { revision: string };
  files: Record<string, { source: string; sha256: string }>;
  adapted: Record<string, { source: string; reason: string }>;
}

const manifest = JSON.parse(
  readFileSync(path.join(root, 'src/recognition/baseline.json'), 'utf8'),
) as BaselineManifest;

describe('retained recognition baseline', () => {
  it('keeps every retained engine file identical to the pinned revision', () => {
    expect(manifest.baseline.revision).toBe('128c903ff109868acc854f0ff239c8c0f925d803');
    const entries = Object.entries(manifest.files);
    expect(entries.length).toBeGreaterThanOrEqual(59);
    for (const [target, entry] of entries) {
      const digest = createHash('sha256')
        .update(readFileSync(path.join(root, target)))
        .digest('hex');
      expect(digest, `${target} (baseline ${entry.source})`).toBe(entry.sha256);
    }
  });

  it('documents every adapted baseline file and keeps it present', () => {
    const entries = Object.entries(manifest.adapted);
    expect(entries.length).toBeGreaterThan(0);
    for (const [target, entry] of entries) {
      expect(entry.source, target).not.toBe('');
      expect(entry.reason, target).not.toBe('');
      expect(existsSync(path.join(root, target)), target).toBe(true);
    }
  });
});
