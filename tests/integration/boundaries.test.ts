/**
 * The boundary rules in .dependency-cruiser.mjs, run for real against the fixture component tree in
 * tests/fixtures/boundaries. The fixture pairs every documented boundary with an allowed
 * public-entry import and a forbidden internal import, and adds deliberately unresolved relative
 * and package imports, so a rule that silently stops matching fails here.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'boundaries');
const cruiserBin = path.join(
  repoRoot,
  'node_modules',
  'dependency-cruiser',
  'bin',
  'dependency-cruiser.mjs',
);
const configFile = path.join(repoRoot, '.dependency-cruiser.mjs');

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string };
}

/** Cruise the fixture tree with the repository configuration. */
function cruiseFixtures(): Promise<readonly Violation[]> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cruiserBin, '--config', configFile, '--output-type', 'json', '.'],
      { cwd: fixtureRoot },
      (error, stdout) => {
        if (stdout === '') {
          reject(error ?? new Error('dependency-cruiser produced no report'));
          return;
        }
        try {
          const report = JSON.parse(stdout) as {
            summary?: { violations?: readonly Violation[] };
          };
          resolve(report.summary?.violations ?? []);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

describe('component import boundaries', () => {
  it('reports exactly the fixture violations, and nothing else', async () => {
    const violations = await cruiseFixtures();
    const reported = violations
      .map((violation) => `${violation.rule.name}: ${violation.from} -> ${violation.to}`)
      .sort();

    expect(reported).toEqual(
      [
        'allowed-providers-of-application: src/application/index.ts -> src/ui/internal/page.ts',
        'allowed-providers-of-card-list: src/card-list/internal/window.ts -> src/ui/index.ts',
        'allowed-providers-of-capture: src/capture/internal/device.ts -> src/ui/index.ts',
        // UserInterface presents Capture: its public Capture import stays allowed, while the
        // direct Recognition imports this fixture also carries are rejected.
        'allowed-providers-of-ui: src/ui/index.ts -> src/recognition/index.ts',
        'allowed-providers-of-ui: src/ui/index.ts -> src/recognition/internal/engine.ts',
        'allowed-providers-of-usercards: src/usercards/store.ts -> src/search/index.ts',
        'allowed-providers-of-catalog: src/catalog/index.ts -> src/recognition/index.ts',
        // UserInterface modules follow the documented module graph: CaptureControls presents no
        // page, and an editor reaches Navigation through its page rather than directly.
        'allowed-ui-modules-of-capture-controls: src/ui/capture-controls/index.ts -> src/ui/pages/index.ts',
        'allowed-ui-modules-of-editors: src/ui/editors/index.ts -> src/ui/navigation/index.ts',
        'no-circular: src/card-list/internal/window.ts -> src/ui/index.ts',
        // The Capture fixture reads its own internal module, which reaches UserInterface.
        'no-circular: src/capture/index.ts -> src/capture/internal/device.ts',
        'no-circular: src/capture/internal/device.ts -> src/ui/index.ts',
        'no-circular: src/catalog/index.ts -> src/recognition/index.ts',
        'no-backend-in-ui: src/ui/index.ts -> src/application/backend.ts',
        'no-backend-in-ui: src/ui/index.ts -> src/application/catalog-job.ts',
        'no-backend-in-ui: src/ui/index.ts -> src/application/deployment.ts',
        'no-backend-in-ui: src/ui/index.ts -> src/application/indexing-job.ts',
        // Application reads Search internals instead of its public entry point.
        'no-internals-of-search: src/application/index.ts -> src/search/internal/query.ts',
        // Application reads UserInterface internals instead of its public entry point.
        'no-internals-of-ui: src/application/index.ts -> src/ui/internal/page.ts',
        // The packaged finite job entry points are not inter-component public entry points: the
        // fixture's UserInterface import is rejected both as backend composition and as a
        // non-public module, while the packaging command reaches them by path instead.
        'no-internals-of-application: src/ui/index.ts -> src/application/catalog-job.ts',
        'no-internals-of-application: src/ui/index.ts -> src/application/indexing-job.ts',
        // Application reads UserCards internals instead of its public entry point.
        'no-internals-of-usercards: src/application/index.ts -> src/usercards/internal/copies.ts',
        // A page that names another UI module's private type depends on its internals: type-only
        // imports are rejected like value imports (docs/tech-stack.md#component-boundaries).
        'no-ui-internals-of-card-views: src/ui/pages/index.ts -> src/ui/card-views/internal/detail.ts',
        // UserInterface reads Application internals instead of its public entry point.
        'no-internals-of-application: src/ui/index.ts -> src/application/internal/wiring.ts',
        // Search reads Catalog internals instead of its public entry point.
        'no-internals-of-catalog: src/search/internal/query.ts -> src/catalog/internal/records.ts',
        // UserInterface reads a nested Catalog index, which is not the public entry point.
        'no-internals-of-catalog: src/ui/index.ts -> src/catalog/internal/index.ts',
        // UserInterface reads CardList internals instead of its public entry point.
        'no-internals-of-card-list: src/ui/index.ts -> src/card-list/internal/window.ts',
        // UserInterface reads Capture internals instead of its public entry point.
        'no-internals-of-capture: src/ui/index.ts -> src/capture/internal/device.ts',
        // CardList reads a nested Catalog module, which is not the public entry point.
        'no-internals-of-catalog: src/card-list/index.ts -> src/catalog/internal/records.ts',
        // UserCards imports a Catalog internal type; type-only imports stay visible.
        'no-internals-of-catalog: src/usercards/store.ts -> src/catalog/internal/records.ts',
        // UserInterface reads Recognition internals instead of its public entry point.
        'no-internals-of-recognition: src/ui/index.ts -> src/recognition/internal/engine.ts',
        // Deliberately unresolved fixture imports are reported instead of filtered out.
        'no-unresolvable: src/application/internal/unresolved.ts -> ../catalog/missing-record.js',
        'no-unresolvable: src/application/internal/unresolved.ts -> missing-review-package',
      ].sort(),
    );
  }, 30_000);
});
