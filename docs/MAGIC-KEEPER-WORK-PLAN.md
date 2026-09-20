# Magic Keeper: preparation and development work list

Assessment and preparation execution: 2026-09-20. B-01–B-08 preparation has started; Part 3 implementation and Jira backlog creation remain unauthorized.

## Ownership and delivery rules

- **You:** choose priorities and product scope; provide access requiring your account; perform physical-device acceptance.
- **Me:** execute the preparation tasks in Part 2 when implementation is requested.
- **Harness:** execute Part 3 tasks and manage coding, reviews, repairs, reruns and completion.
- **Nexus project:** own harness changes separately from Keeper. Part 1 is for that project.

Delivery speed is the objective. Frameworks, services, workflow engines, restructuring, custom fields and additional agents are acceptable when they improve delivery speed enough to justify their setup and maintenance. Choose the smallest effective solution; retain meaningful correctness checks.

Rank prioritisation is in progress in Nexus, as reported by you. Rank prerequisites ahead of dependent tasks. This plan does not add a dependency-selection feature. Keep blocked work out of Ready.

Keeper owns a clean CI/CD process: validate, publish when applicable, verify, report the result for the exact commit. The harness owns repairs, reruns and task completion.

Keep this requested plan in Keeper docs for review and later Jira conversion. Purge the abandoned harness implementation material under B-02; do not archive or migrate it. This plan contains assignments, not harness operating instructions.

## Audit evidence

- Inspected main: 16bc79e9f9ac1f43f84eb4ceeaca4f9eb3c87376. The original working checkout was 56 commits behind with uncommitted work.
- Published release inspected: r130-a1, app/API commit a6454c02dab48b11c288012aea758350e8e313ef.
- [PR validation](https://github.com/saintiago/magic-collection-keeper/actions/runs/34699249952): 17m46s. [Deployment](https://github.com/saintiago/magic-collection-keeper/actions/runs/34700135435): 23m04s; publication succeeded, LIVE-17 failed. [Separate verification](https://github.com/saintiago/magic-collection-keeper/actions/runs/34701362285): 7m; desktop/mobile passed. The focus failure remains unresolved.
- Frontend-only delivery already exists: [measured comparison](https://github.com/saintiago/magic-collection-keeper/blob/16bc79e9f9ac1f43f84eb4ceeaca4f9eb3c87376/tests/performance/FRONTEND-DEPLOYMENT.md), 13m versus 18m18s.
- GitHub inspection found no main protection/ruleset, auto-merge disabled and dependency/security alerts disabled. Lens access to Keeper was unverified.
- [Jira KAN](https://malton-family.atlassian.net/jira/software/projects/KAN/boards/2) has Draft, Ready, In Progress, In Review and Done; Epic, Task, Story and Subtask types. The inspected intake query had no eligible tasks.
- No fresh full test run, physical-device session or end-to-end Keeper harness run was performed. These findings are the audit baseline, not claims about later changes.

## Preparation execution update — September 20, 2026

- **B-01:** selected current `origin/main` at `16bc79e` and isolated the preparation on `codex/keeper-preparation`; product changes and owner data were preserved.
- **B-02:** removed the abandoned Keeper-local harness documents and local records while retaining product mockups, application data, source, tests, license/source records and release evidence.
- **B-03:** established the charter, concise specification, architecture, requirement ledger and E2E-oriented use cases; documentation links and retired-material exclusions validate locally.
- **B-04:** added explicit documentation, JavaScript, Python recognition, build and browser entry points. The measured local baseline is recorded in OPERATIONS; the complete WebKit profile had one transient failure whose exact retry passed, so it is not represented as a clean full run.
- **B-05:** implemented docs/checks/full change classification, a fail-closed `Keeper delivery` aggregate, pull-request-only cancellation, and independent desktop/mobile live diagnostics. Local tests pass; GitHub evidence is still required.
- **B-06:** verified repository administrator access and authenticated Lens App read access to Keeper. Repository settings and an actual protected PR check remain to be completed.
- **B-07:** blocked on the supported Nexus interface. Nexus main currently accepts only its combined configuration, while HARN-24 remains To Do and specifies categories but no project-file name or schema. No speculative Keeper configuration was invented.
- **B-08:** verified Jira KAN and Ready-queue access. The only Ready item, empty placeholder KAN-2, was returned to Draft; no backlog issue was created.

The audit bullets above remain historical baseline evidence. Local implementation or testing does not imply merge, deployment or production delivery.

## Part 1 — Work in Nexus

**Owner: you / your agent working in the separate Nexus project.**

No harness-side showstopper was established. Preflight, bounded execution, continuation, Jira intake, PR delivery, review and completion already exist. Rank prioritisation is already in progress.

Nexus work is managed separately. This plan does not track its delivery. [HARN-24](https://malton-family.atlassian.net/browse/HARN-24) is a reference for the shared/project configuration split used by B-07.

## Part 2 — Preparation before Keeper harness runs

**Owner: me**, except the user actions explicitly noted. These are queued tasks.

### B-01 — Establish a current, clean application source

**Owner:** me. **Dependencies:** none.

Reconcile the original checkout with current main. Preserve product changes and owner data; remove abandoned harness material under B-02.

**Acceptance:** the selected source is clean and current; intended product changes are retained; private data is not committed.

### B-02 — Purge abandoned harness material from Keeper

**Owner:** me. **Dependencies:** B-01; coordinate reconciliation before removing files.

Hard-delete harness documents, requirements, sessions, agent accounting, execution records, budgets, role/model policies and related generated/local files. Remove embedded instructions and links from product documents. Do not migrate, archive or carry these records into Nexus.

Known locations include docs/DEVELOPMENT-HARNESS.md, docs/HARNESS-*.md, embedded sections in REQUIREMENTS, PRODUCT-CHARTER, ARCHITECTURE, OPERATIONS, USE-CASES and AGENTS, harness accounting in release notes, and relevant output/work directories.

**Acceptance:** no abandoned harness context remains in Keeper's tracked or local working files; links resolve. Retain product requirements, application code/tests, owner data and product release/source/license evidence. Mixed files retain only product content. Harness development remains a separate project.

The new repository project configuration specified by HARN-24/B-07 is intentional integration configuration, not abandoned harness material.

### B-03 — Establish the cornerstone documents and reconcile requirements

**Owner:** me; you decide unresolved product intent. **Dependencies:** B-01/B-02.

Use the Nexus scaffolding as a reference for clarity. Adapt Keeper architecture, AGENTS and spec where this improves harness compatibility and delivery speed. Keep the charter focused on the greater product vision.

| Document     | Responsibility                                                                         |
| ------------ | -------------------------------------------------------------------------------------- |
| App charter  | Vision, users, product outcomes and principles; retain “Give life to your collection.” |
| Spec         | Current and accepted future behavior, domain rules and supported workflows.            |
| Architecture | Module responsibilities, data flows, dependencies and implementation decisions.        |
| AGENTS.md    | Concise contributor instructions, commands, checks and rules to preserve.              |
| Use cases    | Observable user journeys and failure cases linked to requirements and E2E coverage.    |

Reuse existing documents; add the missing concise spec. README links the foundation; REQUIREMENTS records stable IDs, status and evidence.

**Acceptance:** remove obsolete instructions and contradictory delivery claims. Correct the scanner sequence policy and CARD-09 status; retain the outstanding IMPORT/SCALE/DATA work. Do not requeue delivered IMPORT-05, SCAN-05, RECENT or VIEW-04. Documents agree with accepted product behavior and usable checks. Create this scaffolding when B-03 is executed, not during planning.

### B-04 — Provide usable local validation commands

**Owner:** me. **Dependencies:** B-01.

Expose reproducible setup, Node tests, build, browser tests and applicable Python recognition tests using existing commands where possible. Document required runtimes, browsers and verified assets.

**Acceptance:** a clean checkout can run the baseline without owner data; local and CI suites agree; Python tests run on relevant ordinary PRs. Record command duration for project configuration. Generic preflight remains an existing Nexus capability.

### B-05 — Simplify and align Keeper CI/CD

**Owner:** me. **Dependencies:** B-04.

Use PR validation and the existing main push workflow for publication and required live verification. Provide one always-evaluated validation result across full, frontend and check-only paths. Collect useful failure evidence; run desktop/mobile checks so one failure does not suppress the other's diagnostics.

**Acceptance:** failed, cancelled, missing or unexpectedly skipped required jobs cannot produce success. The configured push workflow succeeds for the exact merged commit only after applicable checks pass. Separate manual verification cannot replace a failed push result. Preserve release classification, source/license guards and test-account isolation.

Keeper reports the result. Repairs, reruns and completion decisions belong to the harness; do not add that orchestration to Keeper.

### B-06 — Configure protected Git delivery and review access

**Owner:** me; you provide account-level access if needed. **Dependencies:** B-05.

Protect main with PRs, the aggregate CI result and the required Lens App review. Enable native auto-merge with squash merging. Verify review and delivery access.

**Acceptance:** failed checks, stale approval or missing/wrong-App review cannot merge; valid reviewed work can merge through the existing harness workflow. No unrelated cloud-permission changes.

### B-07 — Add Keeper's project configuration

**Owner:** me. **Dependencies:** B-01/B-04–06.

Add the project configuration in Keeper's repository root using Nexus's supported filename and schema. Bind KAN, Keeper's repository/main branch, setup/check commands and deploy.yml. Keep agent profiles, reviewer integration, general limits and workspace policy in the shared Nexus operator configuration. Keep credentials outside both files.

**Acceptance:** the composed configuration passes validation/preflight; review and delivery target Keeper; commands and completion workflows match Keeper CI/CD. No Nexus-wide policy is copied into Keeper.

### B-08 — Prepare Jira access and ranked executable tasks

**Owner:** me for setup/ticket preparation; you for product priority. **Dependencies:** B-03/B-07.

Verify the harness service account's KAN access. Use Epics for outcomes and Tasks for executable work. Keep descriptions self-contained with one Acceptance criteria heading and a nonempty list, verification, constraints and product requirement references.

Rank prerequisites ahead of dependent tasks using the Nexus rank prioritisation work. Keep blocked tasks in Draft; do not queue placeholder issues.

**Acceptance:** service-account access is verified; each Ready task has actionable acceptance and satisfied prerequisites. Task creation remains a later step. Use extra fields only if they improve delivery.

## Part 3 — Work during harness runs

**Owner: harness**, with your involvement explicitly noted below. Part 2 is the prerequisite. Tasks are candidates for later Jira tickets, not execution instructions.

### C-01 — Run one supervised Keeper delivery pilot

**Owner:** harness; me for supervision and evidence review.

**Priority/type:** P1 verification. **Additional dependencies:** B-01–08.

Select one small, useful task from C-04/C-06, or a narrow C-02 check, with objective acceptance and low product risk. Prefer a change that shortens feedback or improves diagnosis. Prove the KAN task's full lifecycle through retained workspace, PR, Lens, enforced merge, deploy.yml and Done. Include source fast-forward before a second task; reuse existing failure tests unless a specific integration gap needs a disposable exercise. Keep paid scope bounded; no duplicate marker-only production feature.

**Acceptance:** links and exact SHAs connect task, check, review, merge and release; restart does not duplicate work; unsuccessful deployment remains open/attention; owner data unchanged. Stop after the bounded exercise for evidence review before unattended operation.

### C-02 — Add maintainable static-quality and architecture checks

**Owner:** harness.

**Priority/type:** P1 implementation. **Sources:** prior audit; PRODUCT-06. **Additional dependencies:** none.

Add ESLint, formatting checks, a practical JS type/syntax strategy, Python linting and import-boundary checks. Introduce explicit exceptions only with reasons; do not hide problematic files. Pin development runtime expectations and make the unified validation entry point authoritative.

Deliver this incrementally: formatting and high-signal correctness rules first, boundary checks where useful, broader typing only where demonstrated defects justify it. Do not make a repository-wide type conversion or mass formatting rewrite the first delivery.

**Acceptance:** representative syntax, unused-code, invalid import-direction and formatting failures are caught; existing source passes without unrelated behavior changes; JS/CSS/HTML formatting is checked; checks work locally and in CI. A TypeScript rewrite is not required.

### C-03 — Automate dependency and source-maintenance tracking

**Owner:** harness.

**Priority/type:** P1 implementation/configuration. **Sources:** audit; PRODUCT-06. **Additional dependencies:** C-02 where check integration needs it.

Enable dependency alerts/security updates and secret scanning/push protection; configure reviewed updates for npm, Python, Actions and Docker. Inspect dependency graph support, Python input/lock reconciliation, duplicate OpenCV distributions and model/artifact notices. Add suitable vulnerability/dependency review and action-reference maintenance.

**Acceptance:** updates produce bounded reviewable PRs; npm lockfile and Python manifests reproduce the intended environment; alert handling has ownership and evidence; model/runtime upgrades retain corresponding-source and recognition regressions. A disabled alert service is not evidence of zero vulnerabilities. No automatic major/model upgrade or unsupervised dependency auto-merge.

### C-04 — Make interaction coverage and browser failure evidence explicit

**Owner:** harness.

**Priority/type:** P1 implementation. **Sources:** QUALITY-01, PRODUCT-02/06. **Additional dependencies:** none.

Create a requirements/use-case/test map for each meaningful control and journey; organize unit, adapter, browser, model, live and performance profiles. Replace separate hard-coded WebKit file lists with named projects or explicit suite metadata. Add forbidOnly, skip reasons, structured reports, safe failure screenshots and trace handling.

Use the reconciled `docs/USE-CASES.md` as the E2E design base, not a test inventory assembled after implementation. Keep each scenario compact: stable UC ID, linked spec/requirement, actor/preconditions, user action, observable result, applicable failure/retry/navigation/persistence variants, browser/device scope and test/evidence links. Start with existing critical journeys (sign-in/isolation, collection/search/card navigation, tags/locations, import confirmation and capture/review) and grow alongside delivered features. Share scenario definitions across browser engines; keep unit/adapter details in tests rather than bloating user journeys. Use additional test tooling if it improves authoring, coverage or feedback speed enough to justify maintenance.

**Acceptance:** a new UI test cannot silently miss its intended browser profile; success, invalid input, failure/retry, persistence, navigation, late responses, account isolation and keyboard/touch cases are traceable; default mocks are clearly labelled; reports map failures to requirements. Live authentication/network traces are redacted or excluded from public artifacts. Keep visual motion review and physical tests distinct from passing assertions.

### C-05 — Diagnose and repair intermittent card return/focus failure

**Owner:** harness.

**Priority/type:** P1 investigation followed by evidence-backed repair. **Sources:** QUALITY-01, CARD-10/16, r130 LIVE-17. **Additional dependencies:** C-04 diagnostics as needed.

Capture active element, source connection, redraw/navigation timing and account state at failure. Reproduce the actual race before choosing a fix; retain source/focus assertions and the original failure evidence.

**Acceptance:** a deterministic regression fails on the old code and passes on the repair where reproduction is achieved; desktop/touch, delayed collection/tag refresh, dismissal and Back retain exact printing and focus; cleanup never masks the original failure. An unchanged green rerun is not a completed repair. If reproduction remains elusive, deliver instrumentation and a clearly open investigation rather than inventing a cause.

### C-06 — Reduce CI feedback time without reducing coverage

**Owner:** harness.

**Priority/type:** P1, first delivery-speed work wave. **Sources:** DEPLOY-01–06, prior timing audit. **Additional dependencies:** only the C-04 reporting/isolation needed for the selected optimization, not the entire coverage program.

Measure repeated warm/cold runs, queue time and per-suite duration. Full r130 browser execution was ~13m50s; preparation is a smaller share. Evaluate isolated Chromium/WebKit/visual jobs or shards, verified preparation reuse, bounded PR cancellation and a genuinely fast documentation-only path. Keep model/source changes on a complete path and tests-only changes validated.

**Acceptance:** agreed latency/cost targets, repeatable before/after evidence, all selected suites retained, stable aggregate gate, correct cancellation and artifact provenance; independent shard data and services. Shared live accounts stay serialized unless explicitly partitioned. Do not solve latency by weakening classifier, source guards, tests or failure thresholds.

### C-07 — Refactor growing modules along existing boundaries

**Owner:** harness.

**Priority/type:** P2 incremental implementation. **Sources:** PRODUCT-06, architecture guidance. **Additional dependencies:** C-02, C-04.

Split frontend orchestration, rendering and I/O around card interactions, imports and scanning; split the very large card-action spec by cohesive behavior. Preserve backend inward dependencies and composition in server.js/cloud.mjs. Define feature ownership and test placement; restructure where it improves delivery speed or testability.

Use `E:/projects/nexus` as the review reference for small named modules, explicit ownership and an obvious validation entry point. Adapt these principles to Keeper's existing JavaScript/browser/Python boundaries. Choose structure and tooling for Keeper's delivery needs; keep Nexus runtime concepts out of the app. Keep the reference in this transitional plan; finished Keeper cornerstone documents describe Keeper alone.

**Acceptance:** small independently verified refactors; stable public behavior/import contracts; reduced coupling and smaller cohesive modules; framework or structural changes have a concrete delivery benefit. Review corresponding-source impact of file movement.

### C-08 — Add accessibility and interaction-state acceptance

**Owner:** harness.

**Priority/type:** P1/P2 implementation. **Sources:** CARD/DRAG/VIEW/SCAN acceptance and PRODUCT-02/06. **Additional dependencies:** C-04.

Add automated accessibility checks plus keyboard, focus restoration, reduced-motion, touch target and screen-reader-status scenarios. Review fixed sleeps and replace incidental waits with observable state while retaining deliberate timing tests.

**Acceptance:** controls remain usable without hover/color alone; overlays do not trap or lose focus; rapid navigation and account changes reject stale responses; important journeys cover narrow/landscape layouts and storage/network failures. Automated accessibility checks do not claim complete assistive-device acceptance.

### C-09 — Design bounded owner-data access and migration

**Owner:** harness.

**Priority/type:** P1 design, separate implementation approval. **Sources:** SCALE-01–05, DATA-01–04, IMPORT-06/08–10. **Additional dependencies:** none.

Audit all whole-collection callers and supported view/filter/sort combinations. Design owner-scoped membership/index access, minimal canonical metadata projections, cursor/order semantics, aggregate queries, cache versioning and an idempotent migration/backfill/recovery strategy.

**Acceptance:** a caller-to-query map includes Home, Recent, suggestions, detail, tags/decks, pending imports and mutation refreshes; bounded reads do not merely slice a full scan; exact-printing/Oracle distinctions remain; 30,000-card acceptance and query-cost budgets are defined. Infrastructure/index changes get concrete scope and applicable authorization before provisioning; preserve owner data and permanent receipts.

### C-10 — Implement bounded private queries, projections and pagination

**Owner:** harness.

**Priority/type:** P1 implementation after design acceptance. **Sources:** SCALE-01/02, DATA-02–04. **Additional dependencies:** C-09.

Implement finite maximum page sizes, server-side filtering/sorting and deterministic cursors, minimal indexed metadata projections and owner-scoped membership reads for collection/tag/deck/pending views.

**Acceptance:** complete matching results across pages, stable ties, concurrent changes, invalid/foreign cursors, metadata refresh and cold caches; no full unrelated inventory materialization; SQLite/Dynamo behavior has contract tests; migration is idempotent and preserves quantities, sources, loose copies and assignments. No live owner backfill is implied by a coding task alone.

### C-11 — Migrate consumers, aggregates and mutation refreshes

**Owner:** harness.

**Priority/type:** P1 implementation. **Sources:** SCALE-03/04, DATA-01/04. **Additional dependencies:** C-10.

Replace full-list reads in Home, Recent, suggestions, details and mutations with bounded identity lookups/query refreshes and backend totals/existence queries. Keep bounded browser pages/cache and account-isolated navigation state.

**Acceptance:** whole-result totals and Commander eligibility do not come from a loaded page; mutations update/invalidate only affected data; Back/reload/filter/scroll/focus work with pagination; no account cache leakage. If full export is later introduced it is an explicit streaming/paged workflow, not a hidden ordinary fetch.

### C-12 — Add progressive catalogue ownership enrichment

**Owner:** harness.

**Priority/type:** P1 implementation. **Sources:** DATA-01/05–07. **Additional dependencies:** C-10/11 lookup contracts.

Render bounded catalogue results before owner enrichment, then patch quantities/tags in place from bounded verified lookups. Preserve unknown/loading/error states, active gestures and newer mutations.

**Acceptance:** delayed, failed and out-of-order enrichment cannot imply unowned/zero or overwrite later edits; account/query changes invalidate replies; retry is targeted; catalogue order stays stable. Private-filtered views still start from authoritative owner membership, never a substituted global catalogue page.

### C-13 — Optimize import confirmation reads and prepared metadata

**Owner:** harness.

**Priority/type:** P1 implementation after scope approval. **Sources:** IMPORT-06/08/09/10. **Additional dependencies:** C-09; reuse C-10 affected-record ports where applicable.

Read only affected ownership/source/tag records at Add. Reuse server-validated printing metadata from staging/editing, revalidate changed dependencies, and share domain preparation policies without duplicating source-import logic.

**Acceptance:** read scope stays independent of unrelated inventory; metadata lookup counts improve; staging grants no ownership; Add atomically commits inventory/tags/source changes, permanent receipt and pending-state removal. Preserve concurrent edits, quantity bounds, supported finish/language/paper rules, loose inventory and source refresh. Measure staging/editing and confirmation to reject moving all repeated work onto each scan.

### C-14 — Complete import and 30,000-card performance evidence

**Owner:** harness.

**Priority/type:** P1 baseline/acceptance. **Sources:** IMPORT-07, SCALE-05, DATA-04, PERF-01. **Additional dependencies:** baseline before C-10–13; final acceptance after them.

Create synthetic inventories and long-session fixtures in isolated profiles. Measure request/backend preparation/commit, post-response rendering, memory, DOM size, query/read cost and latency growth separately. Preserve r130's completed receipt-only UI behavior.

**Acceptance:** repeated before/after runs for 50-row and larger chunked confirmations, 30,000-card navigation/filter/count correctness, concurrent changes and recovery; record actual environments/sample sizes. Do not use owner data or claim scale from frontend slicing. Separate local evidence from cloud measurements and physical devices.

### C-15 — Replace expanded Import rows with shared pending-card interactions

**Owner:** harness.

**Priority/type:** P2 implementation after detailed acceptance review. **Sources:** IMPORT-01–04. **Additional dependencies:** C-04; use bounded query contracts from C-10/11 where needed.

Reuse image-only grid, current mouse/touch enlargement and shared tag controls for pending items; provide printing/alternative, quantity/finish/condition, tags, removal and explicit Add actions with pending-specific ports. Preserve unresolved text-only entries with an actionable fallback.

**Acceptance:** pending entries never use owned-card mutation endpoints; immutable oldest-first capture order with stable ties survives edits/recognizer updates and reload; date grouping cannot reverse the required sequence; unknown legacy dates are not fabricated. Preserve source provenance, scroll/Back, recoverable saves, system lifecycle protection and durable receipt replay. Existing oldest/newest grouping behavior must be deliberately reconciled, not copied blindly.

### C-16 — Add type sorting and explicit format/commander tags

**Owner:** harness.

**Priority/type:** P2 implementation. **Sources:** VIEW-01/02. **Additional dependencies:** C-09/10 supported-query design.

Add card-type sorting and deck-oriented ordering, a format tag family including Commander/Modern, and commander-role semantics. Existing editable labels remain metadata over stable IDs.

**Acceptance:** persisted sorting/filtering and multi-page results are correct; rename/duplicate labels cannot change structural meaning; validation/migration preserves existing location/role/category tags; tags do not grant ownership or conflate legality with selected format.

### C-17 — Add the explicit Commander deck presentation

**Owner:** harness.

**Priority/type:** P2 implementation. **Sources:** VIEW-03. **Additional dependencies:** C-16 and whole-result aggregate/existence contract C-11.

When the nonempty full filtered result meets the explicit Commander-format rule, put commander-role cards first with a prominent golden frame/wrapping at ordinary grid size.

**Acceptance:** test mixed/empty results, pagination and filters; no inference from legality or just the current page; artwork remains readable and the treatment is unmistakable on phone/desktop without hover. Clarify multi-role/multi-format semantics in the ticket before coding.

### C-18 — Finish animated double-sided-card flipping

**Owner:** harness.

**Priority/type:** P2 reconciliation then implementation. **Sources:** CARD-09. **Additional dependencies:** B-03, C-04.

The detail page has a basic image flip, but the inspected shared artwork/gesture modules do not establish the requested overshoot-and-settle flip composed with zoom/tilt. The normalized ledger marks CARD-09 production verified while the explicit release evidence keeps it queued.

**Acceptance:** first identify any overlooked exact implementation/test/release evidence; implement only the remaining gap. True two-sided cards expose a usable flip; ordinary/split cards do not invent a back; rapid input, loading/error, reduced motion, zoom/tilt and dismissal preserve state and ownership. Attach explicit source and production evidence before closing.

### C-19 — Complete split-card recognition without weakening multiple-card rejection

**Owner:** harness.

**Priority/type:** P2 investigation/implementation. **Sources:** SCAN-01/02. **Additional dependencies:** current SCAN-10 contract under B-03.

Add representative public/synthetic split-card and rotated fixtures, including combined identities, alongside ordinary cards, two cards and overlaps. Existing multiple/ambiguous geometry rejection is a regression baseline, not proof that split-card acceptance is complete.

**Acceptance:** one physical split card yields one canonical capture; multiple physical cards still wait/reject; no general removal of geometry checks; identity suppression, late alternatives and explicit ownership remain correct. Record replay and physical-device outcomes separately.

### C-20 — Complete scanner spatial feedback and per-capture provider evidence

**Owner:** harness.

**Priority/type:** P2 gap assessment and implementation. **Sources:** SCAN-06/07. **Additional dependencies:** C-04; maintain C-19 invariants.

Existing scan-overlay already draws measured regions and processing state, so do not rebuild it. Audit remaining routine text replacement, accessible equivalents and the requested icons beside queued cards. Use real provider evidence correlated to capture IDs.

**Acceptance:** spatial framing/processing/result feedback is truthful, bounded and reduced-motion-aware; actionable errors remain understandable; provider icons distinguish result/alternative/failure/corroboration, have labels, and update the original row on late replies. No added copy/cue, false agreement or override of reviewed choices; check persistence/reload where supported. Close only the demonstrated residual gap.

### C-21 — Complete physical scanner and visual-performance acceptance

**Owner:** harness.

**Priority/type:** P1/P2 acceptance. **Your role:** run physical-device checks; harness prepares the protocol and analyses evidence. **Sources:** SCAN-11/14, PERF-01, QUALITY-01. **Additional dependencies:** relevant implementation is already r127; C-19/20 for their new behavior.

Prepare a repeatable real-phone protocol for long sessions, heat/battery, memory/latency drift, idle/background behavior, glare/sleeves, audio and recovery. Reuse the completed 2,000-capture/two-hour Node/SQLite soak as persistence evidence only.

**Acceptance:** actual device/browser/conditions/duration are recorded; physical sequence behavior previously accepted by the owner is preserved; only measured thermal/resource results justify further optimization. The agent may prepare/analyze the exercise but cannot manufacture hardware completion. Visual dense-grid/drag evidence must identify emulated versus physical environments.

### C-22 — Resolve external import-provider readiness

**Owner:** harness.

**Priority/type:** P2 feasibility/integration investigation. **Sources:** existing Moxfield operational limitation; PRODUCT-02. **Additional dependencies:** none.

Live evidence reports Moxfield 403 while the app correctly preserves the draft. Determine supported access, permitted export paths and requirements for approved integration; retain pasted-export fallback.

**Acceptance:** distinguish failure handling from successful provider availability; preserve drafts and permanent source idempotency; cite current official contracts. No impersonated client identity, cookie/challenge bypass or unsupported availability promise. Sending provider messages is a separate explicit action, not authorized by this plan.

### C-23 — Specify collection-grounded deck building and upgrades

**Owner:** harness for research/specification; you for product decisions.

**Priority/type:** P2 product discovery/design, not immediate build. **Sources:** PRODUCT-01/02/03/07. **Additional dependencies:** accurate availability/query contracts C-09–12; smaller discovery can precede implementation.

Define the first supported format, collector job, constraints, available-copy semantics, explanations and user-controlled acceptance. Evaluate adjacent search/deck/location workflows and provider feasibility.

**Acceptance:** testable thin-slice requirements distinguish owned, assigned/available, pending and suggested acquisitions; no AI output mutates ownership by implication; evaluate useful deck outcomes with explicit evidence. Create separate implementation tickets only after scope is accepted.

### C-24 — Specify trading/sales lifecycle and integrations

**Owner:** harness for research/specification; you for product decisions.

**Priority/type:** P2 product discovery/design. **Sources:** PRODUCT-04, PRODUCT-01/02/06. **Additional dependencies:** owner-state contracts and provider feasibility.

Specify listing, reservation, cancellation, trade/sale completion and cross-channel reconciliation, including Cardmarket where supported. Define effects on locations, availability and physical ownership.

**Acceptance:** listing is not disposal; cancellation/retries/concurrent edits are recoverable; supported provider contract and operating constraints are evidenced; owner's sale proceeds are distinct from app revenue. No listing, pricing, payment, account connection or inventory mutation is performed by an investigation task.

### C-25 — Specify useful release/news discovery

**Owner:** harness for research/specification; you for product decisions.

**Priority/type:** P2 product discovery/design. **Sources:** PRODUCT-05/07. **Additional dependencies:** none for research; accepted scope before build.

Define sourced new-card/set/news discovery connected to meaningful collection/deck actions, with freshness, relevance and user control.

**Acceptance:** dated sources and stale/unavailable states, bounded data access, adjacent navigation and measurable usefulness; notifications/schedules remain separate choices. Discovery may validly conclude defer/no action.

### C-26 — Define product observability, trust and sustainable cost evidence

**Owner:** harness for research/specification; you for product decisions.

**Priority/type:** P2 scoped assessment/design. **Sources:** PRODUCT-06/08. **Additional dependencies:** B-02 boundary.

Assess app telemetry, diagnostic retention, performance budgets, privacy/data flows and actual operating costs. Preserve charter-first, long-term monetization and early cost-coverage goals. App infrastructure remains independent of development-tool telemetry.

**Acceptance:** purpose, scope, redaction, retention, access and cost are explicit; no owner identifiers/card content in routine diagnostics; distinguish measured/estimated/unavailable cost and recurring/historical spend. No automatic new observability service, pricing or billing change. Any concrete legal/provider claim needs current authoritative evidence. Keep this work scoped to product operations.

### Requirement audit and disposition matrix

This matrix prevents duplicate implementation tickets and lost queued requests. It is a source/evidence assessment, not a fresh acceptance run. “Existing” does not mean every original criterion has complete physical-device evidence.

| Existing IDs           | Audited disposition                                                                          | Work-list mapping and evidence basis                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CARD-01–03, CARD-06–08 | Delivered earlier; retain regressions                                                        | r88 source/release evidence. C-04/08 maintain coverage; no duplicate feature build. CARD-03's phone presentation is governed by later CARD-15.                                                                                                                 |
| CARD-09                | Conflicting status; animated requirement not established                                     | Normalized ledger says production verified; queued table and R114 release say queued. Basic detail flip exists. C-18.                                                                                                                                          |
| CARD-10–17, DRAG-01–05 | Delivered, with a later unresolved return-focus observation                                  | r88/r114 evidence; do not reimplement overlays/wheel. C-05 isolates the r130 regression/investigation.                                                                                                                                                         |
| RECENT-01–04           | Delivered                                                                                    | r114 and receipt follow-up r130. README still calls a revision unreleased: B-03 documentation correction.                                                                                                                                                      |
| VIEW-01–03             | Unimplemented requested views                                                                | Current sort choices lack type; TAG_TYPES lacks format; commander presentation not established. C-16/17.                                                                                                                                                       |
| VIEW-04                | Delivered                                                                                    | r114 Home-only totals evidence; architecture's older “not deployed” paragraph is stale. B-03.                                                                                                                                                                  |
| IMPORT-01/02           | Unfinished shared pending grid/actions                                                       | import-page-view still renders expanded form rows. C-15.                                                                                                                                                                                                       |
| IMPORT-03/04           | Partial supporting behavior, unfinished combined requirement                                 | Durable drafts, timestamps, lifecycle and receipts exist. Date groups currently sort newest-first; the requested shared oldest-first card sequence is not fully established. C-15 preserves existing safety and supplies missing interaction/order acceptance. |
| IMPORT-05              | Delivered                                                                                    | r130 receipt-only callback; do not rebuild.                                                                                                                                                                                                                    |
| IMPORT-06/08–10        | Not implemented as accepted executable scope                                                 | Bounded affected-record reads/prepared metadata are planned. C-09/13; design approval precedes implementation.                                                                                                                                                 |
| IMPORT-07              | Partially verified                                                                           | r130 verifies receipt removal, retry and deferred reads; repeated cloud before/after and larger-session resource evidence remain. C-14.                                                                                                                        |
| SCALE-01–05            | Planned, not implemented                                                                     | Whole collection still loads for ordinary consumers. C-09–11/14.                                                                                                                                                                                               |
| DATA-01–04             | Accepted design direction, not delivered                                                     | Bounded catalogue/private membership and metadata projection contracts need implementation. C-09–12/14.                                                                                                                                                        |
| DATA-05–07             | Accepted design direction, not delivered                                                     | Progressive bounded enrichment remains queued. C-12.                                                                                                                                                                                                           |
| SCAN-01/02             | Split-card acceptance unresolved; multi-card guard exists                                    | Existing geometry tests cover multiple/ambiguous scenes, not complete physical split-card acceptance. C-19.                                                                                                                                                    |
| SCAN-05                | Core no-50-card-stop request delivered by SCAN-12/13                                         | Old normalized unknown status is stale against r127; B-03, no second cap-removal task.                                                                                                                                                                         |
| SCAN-06                | Partially implemented, full acceptance not established                                       | Measured scan-overlay exists; audit residual presentation/accessibility gap under C-20.                                                                                                                                                                        |
| SCAN-07                | Per-row provider-icon acceptance not established                                             | Underlying alternatives/provider results are not equivalent to requested queue icons. C-20 verifies and fills only remaining gaps.                                                                                                                             |
| SCAN-10                | Delivered and owner physically accepted sequence policy                                      | r125/r127 evidence. Preserve A,A suppression and A,B,A acceptance; consecutive identical copies use quantity.                                                                                                                                                  |
| SCAN-11/14             | Resource implementation/synthetic soak exists; physical thermal evidence missing             | r127 and SCAN12-SOAK evidence; C-21. Not a fresh request to remove already-removed session caps.                                                                                                                                                               |
| SCAN-12/13             | Delivered                                                                                    | Durable rollover, bounded history/recovery and paged batches in r127. Preserve in C-15/19/20.                                                                                                                                                                  |
| DEPLOY-01–05           | Delivered                                                                                    | Existing frontend-only classifier/reuse/main workflow and measured comparison. C-06 improves speed rather than replacing it.                                                                                                                                   |
| DEPLOY-06              | Delivered with explicit failure/retention limits                                             | Keep source/recognition exceptions and exact-run cleanup; B-05 provides the authoritative Keeper CI/CD result.                                                                                                                                                 |
| PERF-01                | Existing measured renderer comparisons; incomplete broad device acceptance                   | CARD-ACTIONS and performance evidence cover stated environments. C-14/21; do not assert no performance work exists.                                                                                                                                            |
| QUALITY-01             | Historical visual releases accepted; ongoing quality obligation and open focus investigation | r130 first failure remains; C-04/05/08/21.                                                                                                                                                                                                                     |
| PRODUCT-01/02/07       | Product purpose and cross-journey policies, not finite missing features                      | Keep charter and apply to C-15–25; avoid empty “implement purpose” tickets.                                                                                                                                                                                    |
| PRODUCT-03             | Future capability, detailed scope absent                                                     | C-23 design then separately accepted implementation slices.                                                                                                                                                                                                    |
| PRODUCT-04             | Future capability, provider/lifecycle scope absent                                           | C-24.                                                                                                                                                                                                                                                          |
| PRODUCT-05             | Future capability, sources/UX scope absent                                                   | C-25.                                                                                                                                                                                                                                                          |
| PRODUCT-06/08          | Ongoing trust/performance/commercial policies; numerical/provider/business decisions missing | C-02–04/08/14/26; no automatic monetization rollout.                                                                                                                                                                                                           |

### Sequence and Jira handoff

1. Me: B-01–08 preparation.
2. Harness, supervised by me: C-01 using a useful C-04/C-06 improvement.
3. Harness: CI speed/reliability and test diagnostics first, then product work in your chosen rank order.
4. Rank prerequisite tasks first; keep blocked tasks out of Ready. C-09 precedes C-10–13; C-14 supplies baseline and final evidence.
5. You: physical-device checks for C-21 and product decisions for C-23–26.

B tasks are preparation; C tasks are Keeper delivery work. Preserve task IDs and product requirement links when creating Jira tickets. Split broad tasks into independently verifiable deliveries. No tickets have been created by this update.
