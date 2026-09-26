# Magic Collection Keeper

This repository contains the approved rebuild design and the workspace harness the rebuild is built
on. The previous application implementation has been removed; the product components in
docs/architecture.md are not implemented yet.

Start with AGENTS.md for the documentation index and engineering principles.
The task index is in docs/tasks/inventory.md. Jira Rank holds execution order.

## Workspace preparation

Node.js 24, npm and Python 3.12 or newer (the recognition suite baseline) are required. On Windows,
preparation, builds and tests run inside WSL as docs/tech-stack.md requires. Set `KEEPER_PYTHON` to
the interpreter to use when `python3` is not the documented baseline; focused and aggregate checks
honour it.

Prepare a fresh checkout from the committed lockfile, including the browser that Playwright drives:

```sh
npm ci
npm run install:browsers
```

## Checks

```sh
npm run format:check     # Prettier over sources, tests and documentation
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run boundaries       # dependency-cruiser over src/
npm run test:component   # Vitest component contracts
npm run test:integration # Vitest integration boundaries
npm run test:browser     # Playwright browser journeys
npm run test:python      # Python unittest recognition suite
npm run build            # compile the component public entry points into build/
```

Focus a scope with a path filter, for example `npm run test:component -- public-contracts`. Component
tests are organised as tests/component/<component>/ so one component's tests can be selected by path.

`npm run validate` runs every check through Turborepo, which caches only the deterministic checks
(formatting, linting, type checking, boundaries and the build) and always runs the test suites.
Nexus uses the same commands for preparation and validation (nexus.project.json).

Each component from docs/architecture.md owns src/<component>/index.ts as its provider-owned public
entry point; cross-component imports use that module, and `.dependency-cruiser.mjs` fails the
boundaries check for anything else, including imports it cannot resolve.
tests/integration/boundaries.test.ts proves that an internal import and an unresolved import are
reported. Tests follow the scopes in docs/testing.md: tests/component, tests/integration,
tests/browser for browser journeys, src/recognition/tests for Python recognition tests, and
tests/unit and tests/system once their first tests exist.

The complete previous implementation is preserved separately at
E:/projects/magic-keeper-old, revision 128c903ff109868acc854f0ff239c8c0f925d803.

Collection migration is required before cutover. Local owner data and existing AWS resources
are preserved; no data migration, resource deletion or deployment is performed by this reset.

Local runtime files are archived outside the repo at E:/projects/magic-keeper-local-backup.
Recognition implementation and tests will be recovered from magic-keeper-old when needed.
