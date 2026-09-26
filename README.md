# Magic Collection Keeper

This repository contains the approved rebuild design and the workspace harness the rebuild is built
on. The previous application implementation has been removed. Product components from
docs/architecture.md are rebuilt task by task: Catalog already provides its read contract, its
atomic bulk synchronization and its published query surface with their contract tests, and
UserCards provides physical-copy storage with its account-scoped read surface; the remaining
components are not implemented yet.

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
(formatting, linting, type checking and boundaries) and always runs the test suites and build.
The build clears `build/` before compiling; caching is disabled so restoring cached artifacts cannot
leave output from deleted sources behind.
Nexus uses the same commands for preparation and validation (nexus.project.json).

Synchronization is the finite catalog job of the deployed stack (docs/tech-stack.md#aws-stack): the
configured source streams one provider snapshot from the private data bucket, and Catalog upserts it
into a candidate revision through one transaction before making it visible. Application supplies
the snapshot source and the transaction-capable RDS Data API executor; resource definitions,
packaging and deployment stay with the deployment tasks listed in docs/tasks/inventory.md. The
component and integration checks exercise the same statements, provider limits, rollback and
published relations that the deployed job uses.

UserCards owns the account's physical copies: each copy keeps one stable identity, one Catalog
printing reference and its finish and condition, and a corrected copy keeps that identity while its
revision advances. Application supplies the transaction-capable executor and the Catalog contract,
so a copy is only stored once its printing resolves and offers the stored finish. Copies are read
through the published views (docs/user-cards.md#query-surface), which filter on the account bound to
the connection inside a read transaction and return nothing without that scope; tags,
associations, imports and the UI remain with their own tasks.

Integration tests that need PostgreSQL run it in-process through PGlite, PostgreSQL compiled to
WebAssembly, so a fresh checkout proves view, constraint, privilege and revision behaviour without
a database service. Deployed statements reach Aurora PostgreSQL through the executor Application
supplies.

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
