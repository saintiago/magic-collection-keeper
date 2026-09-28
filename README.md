# Magic Collection Keeper

This repository contains the approved rebuild design and the workspace harness the rebuild is built
on. The previous application implementation has been removed. Product components from
docs/architecture.md are rebuilt task by task: Catalog already provides its read contract, its
atomic bulk synchronization and its published query surface with their contract tests, and
UserCards provides physical-copy storage, tags, associations and physical locations with their
account-scoped read surface; Search provides its normalized query model, the supported Scryfall
subset, the request and continuation contract and its evaluation over both published query
surfaces; Recognition provides its session lifecycle, its catalog-validated candidate readings and
the execution bounds around the preserved engines; Application assembles those components behind
validated configuration and authenticated transports, and UserInterface provides the shell the
dedicated pages, CardList and the card tools are built on, with Home's recent card activity, the
catalog/search browser and the collection and card-details views built over the Search, Catalog and
UserCards contracts Application supplies.

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
npm run format:check        # Prettier over sources, tests and documentation
npm run lint                # ESLint
npm run typecheck           # tsc --noEmit
npm run boundaries          # dependency-cruiser over src/
npm run lint:infrastructure # cfn-lint over the CloudFormation templates in infra/
npm run test:component      # Vitest component contracts
npm run test:integration    # Vitest integration boundaries
npm run test:browser        # Playwright browser journeys
npm run test:python         # Python unittest recognition suite (src/recognition/python/tests)
npm run test:recognition    # Retained browser recognition regressions (tests/recognition)
npm run build               # compile the component public entry points into build/
```

Focus a scope with a path filter, for example `npm run test:component -- public-contracts`. Component
tests are organised as tests/component/<component>/ so one component's tests can be selected by path.
Vitest shares a two-worker pool across component and integration suites to keep simultaneous
PostgreSQL-in-WebAssembly startups from exhausting setup deadlines on hosts with many CPUs.
The Python runner provisions the pinned `src/recognition/python/requirements-tests.txt` wheels into
the ignored `.recognition-python/` environment once so the retained engine regressions run without
extra setup. The check requires the complete 27-regression suite: when the dependencies are missing
or cannot be installed it fails with an actionable error instead of skipping regressions. Set
`KEEPER_PYTHON` to an interpreter that already provides NumPy, Pillow and OpenCV to bypass
provisioning.
The infrastructure check provisions the pinned `infra/requirements-lint.txt` release into the
ignored `.infrastructure-python/` environment the same way and lints every template under `infra/`;
it establishes template validity only, while the identity and network boundaries of a deployed
environment stay separate evidence (infra/README.md).

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
The AWS stack itself is defined in `infra/`: the foundation template creates the isolated network,
the Aurora cluster behind the RDS Data API, the private buckets, the image repositories and the
database secrets, and the service template adds the app client of the retained user pool, the
JWT-authorized HTTP API, both compute runtimes, the finite catalog task definition and the
CloudFront delivery. `infra/README.md` records create/update/rollback, data retention, cost
assumptions and the checks that require a deployed environment.

UserCards owns the account's physical copies and their organization: each copy keeps one stable
identity, one Catalog printing reference, its finish and condition, its system-owned membership and
at most one physical location, and a corrected or moved copy keeps that identity while its revision
advances. Application supplies the transaction-capable executor and the Catalog contract, so a copy,
an association or a location move is only stored once its references resolve, and each change
commits atomically behind the revision the caller read. Tags keep stable identities with editable
labels; card and printing associations carry the intended quantity, while copy membership identifies
one physical copy and carries none. Copies, tags, associations and the private-data revision are read
through the published views (docs/user-cards.md#query-surface), which filter on the account bound to
the connection inside a read transaction and return nothing without that scope. UserCards also owns
the pending imports behind that surface: a capture observation or parsed source line is staged once
(consecutive accepted capture identities collapse into one entry, unresolved readings advance
nothing), review quotes the entry revision and keeps late recognition alternatives beside the
reviewed values, and confirmation under an account-scoped operation identity creates the individual
copies with their provenance or returns the recorded outcome, so a repeated import adds nothing.
Pending entries have no published relation and never change ownership; source-format parsing and the
UI remain with their own tasks.

Search evaluates one normalized query in a single read-only statement over the published Catalog and
UserCards relations: membership filters, the requested grouping and translated name resolution run
over the complete result before ordering with a stable identity tie-breaker and the page boundary,
and the same snapshot returns the exact total count and the catalog and private revisions. Public
queries read the Catalog views alone, while private criteria or a physical-copy result level read
UserCards' account-scoped views inside the scope Application binds, so a missing scope fails instead
of reading another account's rows. A continuation resumes only the same criteria, ordering, user and
revisions; anything else is a stale continuation that restarts the result.

Recognition prepares a session for its enabled engines on demand, runs one capture attempt at a time
per session and releases that session's local work on disposal (docs/recognition.md#interface).
Requests, capture/attempt identities and frame bounds are validated before inference. A reading
carries catalog-validated candidates in engine order, an editable suggestion that always belongs to
that set and stays distinguishable from engine-supported printing evidence, provisional state,
disagreement, engine versions and timings, and never ownership or physical condition. Later readings
of the hybrid comparison keep the attempt identity; cancellation suppresses later output; no-card,
multiple-card and ambiguous geometry stay unknown; and invalid input, busy, cancelled and
unavailable outcomes remain distinct. The component composes the preserved browser ONNX and Python
visual/OCR engines behind that pipeline — including the hybrid early/later comparison and the
independent identity session call limit — while Application supplies the authenticated transport,
so their matching policies stay unchanged.

Application validates one environment's configuration before serving, constructs Catalog, UserCards,
Search and the finite catalog job through their public contracts and derives trusted user context
from verified Cognito claims only: a private operation never runs anonymously, an unverifiable
identity is rejected instead of downgraded, and a caller-supplied owner field is ignored. The
interactive transport serves the documented component operations, answers the preserved recognition
engines' catalog-hydration envelopes from the published Catalog, maps validation, unauthorized,
missing, conflict, stale-continuation, busy and unavailable outcomes to distinct failures without
exposing storage details or credentials, and reports a deadline as an unknown outcome whose
replayable operation names the receipt to recover. Catalog synchronization stays a separate job
entry point and recognition inference a separate compute runtime reached through the authenticated
client; the browser composition supplies UserInterface with the public settings, the authenticated
transport, the Catalog, Search and private-copy contracts and the Recognition contract over the
preserved engines (docs/application.md#interface, docs/application.md#configuration-and-lifecycle).

UserInterface presents the collection behind one shell (docs/user-interface.md#interface,
docs/user-interface.md#pages-and-navigation): the URL identifies the dedicated view, including the
three card specificity levels, so a reload or a direct entry presents the same page; Back returns to
the entry it left and restores its query, selection, scroll and focus from bounded account-isolated
state that serializes no view content; closing a view aborts its work and detaches its container, so
a late result cannot replace the new view; and a changed account clears that private presentation
state, ends the authenticated session so outstanding responses are rejected and releases the device
resources. A page implementation supplies one page's content and the sources and tools its lists
use. The shared CardList turns one supplied source into a bounded, asynchronous working set
(docs/user-interface.md#list-boundary, docs/user-interface.md#cardlist): a page request carries the
query context, the page size, the continuation and a cancellation signal, and only the request the
user still waits for may replace the window, while a refresh keeps the usable entries presented.
The rendered window and every fragment batch are bounded. Paging keeps selected targets and their
tool availability separately, so selection cannot hide later results. Other enrichment retires when
an entry leaves the window, and changed entries retire reads that can no longer answer for them.
Basic information renders with the entries; images, ownership, tags and tool availability are
separate fragments that load and fail independently, and a failed fragment stays distinguishable
from an empty answer.
Equivalent copies group for convenient selection without losing their individual copies, and the
card tools invoke the owning component's operation for the explicit selection and report its
outcome, with a lost response reported as unknown until the recorded outcome is recovered. The
browsing pages build on that (docs/user-interface.md#browsing-and-organization): Home presents the
account's bounded recent card activity — the cards it opened while browsing, kept only for the
presented account — and the catalog/search page evaluates the text expression and the result-level,
owned-only and finish controls its URL carries as one Search query
(docs/search.md#scryfall-compatibility), so a reload or a shared link presents the same result; the
entries show their basic information and quantities, printing images load and retry as their own
fragment, an unsupported expression stays a distinct reported failure, and opening an entry records
it and presents its card details. Both pages hand the state of their list back through CardList's
own capture and restoration contract, so the list decides how to re-acquire the window it held. The
collection views build on the same boundaries (docs/user-interface.md#browsing-and-organization):
the collection presents the account's owned cards, printings or physical copies — the level and
text expression its URL names — with the physical-copy and intended counts the query evaluated kept
distinct, individually selectable copies group by printing for the bulk changes that act on their
explicit selected identities, and each entry opens the card, printing or copy details it names. The
card-details page presents the published catalog information of the named level and corrects one
physical copy's printing and language, finish and condition under the revision it read: a conflict
or a failed edit keeps the unsaved change for review and retry. After a lost response, the outcome
stays unknown while the current copy is read for review and revision-guarded retry; matching
attributes cannot establish commitment. A saved outcome is presented only once the change reports
it committed. The Import page captures cards hands-free through the camera the deployment supplies
and the Recognition contract (docs/user-interface.md#capture-and-review): a settled frame the
runtime reports as holding one card stages its candidate in the account's pending imports, the
provider suppresses a repeated observation, an unresolved reading receives no success cue while a
later comparison may still resolve the same capture, late alternatives are attached beside the
reviewed values, and stopping or leaving the view releases the camera and the Recognition session.
The remaining dedicated pages and source-import UI build on that in their own tasks.

Integration tests that need PostgreSQL run it in-process through PGlite, PostgreSQL compiled to
WebAssembly, so a fresh checkout proves view, constraint, privilege and revision behaviour without
a database service; the cases that need two writers at once start a local PostgreSQL server
(docs/testing.md). Deployed statements reach Aurora PostgreSQL through the executor Application
supplies.

Each component from docs/architecture.md owns src/<component>/index.ts as its provider-owned public
entry point; cross-component imports use that module, and `.dependency-cruiser.mjs` fails the
boundaries check for anything else, including imports it cannot resolve.
tests/integration/boundaries.test.ts proves that an internal import and an unresolved import are
reported. Tests follow the scopes in docs/testing.md: tests/component, tests/integration,
tests/browser for browser journeys, src/recognition/python/tests for the preserved Python
recognition tests, tests/recognition for the preserved browser recognition regressions, and
tests/unit and tests/system once their first tests exist.

The complete previous implementation is preserved separately at
E:/projects/magic-keeper-old, revision 128c903ff109868acc854f0ff239c8c0f925d803.

Collection migration is required before cutover. Local owner data and existing AWS resources
are preserved; no data migration, resource deletion or deployment is performed by this reset.

Local runtime files are archived outside the repo at E:/projects/magic-keeper-local-backup.
The recognition engines and their regressions are recovered from magic-keeper-old into
src/recognition (KAN-16); their digests are recorded in src/recognition/baseline.json.
