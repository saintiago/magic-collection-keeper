# Repository-based harness workflows

HARNESS-12 adds Langfuse evaluation and conditional integration to observability work. Local adapter/synthetic evidence is recorded separately from remote verification; vendor model-cost views never replace the durable ledger. See [observability update](HARNESS-OBSERVABILITY.md).

Current pilot status September 12, 2026: [HARNESS-PILOT.md](HARNESS-PILOT.md) records one live hosted smoke, requirements proposal and W7 efficiency review. A real controller/ledger and independent local telemetry service now exist. This supersedes the original design-only/no-runtime statement below for that pilot; full W0–W7 discovery/delivery/release automation remains queued. HARNESS-10–11 refine exploratory discovery and equal scrutiny before development.

Design revision 1, September 12, 2026. Implements the design request HARNESS-06, supporting HARNESS-01–05 and PRODUCT-01–07. This is a design artifact: no runtime, agents, scheduled jobs, PRs or deployments were created. It specializes [DEVELOPMENT-HARNESS.md](DEVELOPMENT-HARNESS.md); where earlier wording is less specific, this workflow contract applies.

## Purpose and starting evidence

**Give life to your collection.** Every proposal must identify the meaningful collector action it enables, or the trust/performance foundation that enables that action. The owner is the first collector-builder-trader. The canonical direction is [PRODUCT-CHARTER.md](PRODUCT-CHARTER.md), revision 2.

This design inspected the local working tree, not a verified production checkout. Documentation has existing edits and several new documents are untracked; a future harness must capture selected working-tree inputs explicitly rather than assuming a clone contains them. No existing uncommitted work should be discarded or implicitly included in a feature branch.

| Existing evidence                                                      | What the harness should reuse or account for                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| AGENTS.md; docs/PRODUCT-CHARTER.md                                     | Owner rules and purpose; immutable input revisions for each task                                                   |
| docs/REQUIREMENTS.md                                                   | Stable IDs and corrections; legacy status/priority wording needs reconciliation before automatic selection         |
| docs/USE-CASES.md; docs/ARCHITECTURE.md; docs/OPERATIONS.md            | Journey, dependency, acceptance and deployment context, checked against code                                       |
| domain/inventory.js, tags.js, deck-import.js, import-draft.js          | Existing inventory, assignment, source and pending-state policies                                                  |
| application/collection.js, tagged-collection.js, import-drafts.js      | Existing orchestration; tagged-collection currently assembles multiple owner-wide lists                            |
| application/discovery.js; adapters/name-index.js, scryfall.js          | Card-name/printing discovery, not product discovery or an AI recommendation engine                                 |
| adapters/sqlite.js, dynamo.js, document-store.js; server.js; cloud.mjs | Local/cloud seams and composition roots; changes must work across both storage modes                               |
| tests/*.test.js; tests/ui; tests/live; tests/mobile-live               | Existing unit, controlled-browser and protected deployed coverage                                                  |
| tests/performance/README.md, EVIDENCE.md, startup.mjs, compare.mjs     | Recognition/startup measurement methods with explicitly limited evidence; no general app-wide performance baseline |
| .github/workflows/deploy.yml                                           | PR tests/build and main deployment, plus live/mobile checks; preserve its release path                             |
| .github/workflows/catalog.yml                                          | Weekly public name-index refresh, not news discovery or a harness scheduler                                        |

SCALE-01–05 and DATA-01–07 describe planned bounded access and progressive enrichment; they are not current guarantees. The inspected deployment still performs full API/site publication; queued frontend-only release requirements are not an available shortcut. Deck inspiration, marketplace sales and news remain intended capabilities rather than established integrations.

## Control model and roles

A small Node controller owns state transitions, evidence validation, budgets and external actions. The Agents API owns model/tool execution and session context. The controller and its credentials run outside task sandboxes and the application runtime. Keep a local durable SQLite ledger initially; neither the app's inventory database nor its production DynamoDB table is the harness ledger.

Roles are reusable session instructions, not permanently running services:

| Role                          | Deliverable                                                   | Write authority                                   |
| ----------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| Repository analyst            | Capability/evidence map and unresolved contradictions         | Proposed documentation only                       |
| Product researcher            | Sourced opportunity briefs and validation options             | Candidate artifacts only                          |
| Commercial challenger         | Purpose, business and UX critique with disconfirming evidence | Findings only                                     |
| Journey/architecture reviewer | Cross-app impact map and consistency findings                 | Findings only                                     |
| Requirements author           | Versioned acceptance bundle and linked use cases              | Task documentation checkout                       |
| Implementer                   | Cohesive patch and regression coverage                        | One isolated task checkout                        |
| Independent reviewer          | Commit-specific product/code/security findings                | Separate review environment; no merge credentials |
| Controller/test runner        | Actual exit codes, artifact hashes, PR/release state          | Narrow privileged actions under recorded policy   |

Start with at most two concurrent reasoning sessions and one writer per checkout. Run commercial and journey reviews independently when their work can proceed in parallel. Only invoke specialists relevant to the change. Fresh review sessions receive source evidence and the diff, without inheriting the implementer's conclusion as authority. They may inspect and run checks in their isolated copy. Two repair rounds is a proposed initial limit; retain unresolved findings and checkpoint instead of looping indefinitely.

## W0 — Reconcile repository and priorities

**Trigger:** first run, changed base commit/charter/rules, or contradictory evidence. **Owner:** repository analyst plus controller.

1. Record commit, dirty paths, explicitly included working-tree changes and content hashes. Read guidance and classify required context by changed domain.
2. For each relevant requirement, link implementation locations, tests and any release evidence. Track intent, code presence, local verification and production verification separately. A test filename or a status sentence alone is not a passing run.
3. Resolve explicit supersession using owner decision provenance. Preserve historical text; produce an effective priority list with reasons. Do not use file order as decision chronology. If conflicting exclusive-priority notes cannot be resolved, ask one concrete priority question before selecting dependent implementation; discovery can still continue.
4. Produce the snapshot and a bounded ready queue. Reuse it until relevant inputs change; do not reread the entire repository for every agent.

**Exit:** current input revisions and selected scope are unambiguous. **Failure:** unresolved capability or release facts remain unknown, not promoted to done. Initial known issue: scanner, UI, deployment and scale requirements have overlapping historical priority language.

## W1 — Discover opportunities and commercial hypotheses

**Commercial policy (PRODUCT-08, charter revision 3):** Reject any conflict with purpose or UX before ranking candidates. Prioritize durable long-term monetization; the early financial objective is covering app running and development costs. Each brief states both horizons and links cost coverage to the OBS ledger with an explicit period, net revenue assumptions and uncertainty. Include agent/CI/tool/telemetry costs; separate recurring spend from historical investment. Cost recovery never permits weaker quality/security or biased recommendations. This refines earlier commercial scoring guidance; W6 evaluates actual results on the same basis and W7 reduces costs within those constraints.

**Trigger:** owner idea/friction report, completed learning review, or a future enabled discovery cadence. **Owner:** researcher; independent commercial challenger.

Use charter, effective backlog, owner-provided hobby observations and authorized evidence. Investigate new cards/sets, provider changes or market facts with dated primary sources when relevant. Product research may read external information; it does not automatically introduce an in-app news feed or ingest owner data.

Each run returns at most three new candidates, deduplicated against accepted, rejected and deferred ideas. Each candidate records: user job, problem, source/confidence, purpose contribution, existing alternatives, required integration, commercial hypothesis, recurring costs, UX/privacy burden, cheapest validation and rejection conditions. An empty result is valid. Do not invent demand to fill a quota.

The challenger assesses why this should not be built, including whether improving an existing flow is better. Compare app revenue with costs separately from the user's card-sale proceeds. Evaluate monetization against task completion, trust, performance and recommendation independence. No prices, fees, affiliation or willingness to pay are assumed. Select investigate, experiment, adopt, defer or reject with explicit dissent and rationale.

**Exit:** evidence-backed candidates and decisions. **Failure:** unavailable sources/access produce a research gap, not an invented provider capability. Purpose fit alone is insufficient evidence of commercial demand.

## W2 — Author and challenge requirements

**Trigger:** owner request or candidate selected within the standing product mandate. **Owner:** requirements author; journey/architecture and commercial reviewers as relevant.

Write a feature brief, then update stable IDs in REQUIREMENTS.md and linked use cases. Required fields:

- Origin: opportunity/owner instruction, charter and scope revisions, decision authority.
- User outcome: actor, trigger, job, evidence, why it gives life to the collection.
- Scenarios: preconditions, happy path, empty/loading/error/cancel/retry/reload, keyboard/touch accessibility, account switch and stale work.
- Data: identities, ownership/pending semantics, persistence/versioning/idempotency, provider facts and unresolved assumptions.
- Integration: impact map, migration/compatibility needs, explicit exclusions and necessary adjacent changes.
- Acceptance: Given/When/Then behavior, matching test plan, measurable latency/read/memory budgets with baseline or planned measurement, product outcome measure and observation window.
- Decision: counterarguments, dependencies, unresolved questions, smallest reversible delivery, success/stop criteria.

Reviews produce concrete contradictions or missing scenarios. The author revises the same brief; tests are not allowed to define the product by merely mirroring proposed code. Record rejected/superseded requirements without reusing their IDs. Runtime completion and product acceptance are separate statuses. Unknown budget baselines can route to a measurement spike; they cannot pass a performance gate.

**Exit:** a complete, reviewed brief within existing authority. **Failure:** missing consequential business decisions remain questions; routine design choices are resolved autonomously. Generated requirements cannot authorize their own scope expansion.

## W3 — Integrate across the app

**Trigger:** every accepted feature, and any newly discovered dependency. **Owner:** journey/architecture reviewer, then implementer.

For each surface mark change, regression-only or unaffected, with a reason: Home, shared search, card page/overlays, collection, tags/locations, pending imports, scanner, source views, navigation/history, APIs/storage, help and applicable commercial controls. Trace every adjacent edit to an acceptance scenario or invariant. Prefer a complete vertical slice over a new standalone page disconnected from existing state.

Start with an example candidate, **“What can I build from my collection?”** This is a design example, not an approved implementation priority:

1. Reuse canonical card identities and current collection/tag/source policies. Do not equate a deck location or imported source with a complete editable deck-building model; define the missing deck-intent model first.
2. Define bounded collection/availability queries consistent with SCALE/DATA plans. A new AI feature must not cement the current full-list loading pattern.
3. Keep recommendation orchestration in a proposed application service receiving collection/catalog/AI ports; compose the concrete AI adapter in server.js/cloud.mjs. Do not call a model from the browser or domain layer.
4. Make proposals read-only with respect to ownership. Show suggested versus owned copies; explain choices. Opening a suggestion uses shared card navigation and returns to the proposal. Allocating actual copies is a separate validated user action.
5. Map stale recommendations after quantity edits, pending imports excluded from availability, overassignment reminders, late AI responses after navigation and model/provider failure. New recommendation evaluations supplement existing deterministic invariant tests.

For trading, first define reservation/listing/sale/cancellation semantics, then map card and deck availability. Never overload an editable tag label as sale state. For news, define trustworthy sources and freshness before linking articles to canonical cards and decks. For both, provider feasibility is a research dependency, not an assumed API.

**Exit:** a bounded implementation plan with affected old journeys, storage implications and tests. **Failure:** scope changes beyond the mandate return to W2; necessary in-scope integration proceeds without another permission round.

## W4 — Implement, verify and independently review

HARNESS-13 is a pending-assessment refinement of the existing independent reviewer: dedicate its remit to code quality, architecture adherence and PR review without automatically adding a duplicate agent. Proposed acceptance requires actual diff/surrounding-code inspection, architecture/AGENTS/domain/security/requirement checks and verification of meaningful test evidence. Findings identify file/line, impact and actionable correction, distinguishing blockers from suggestions. Review attaches to the exact commit, rechecks fixes and invalidates affected conclusions after edits. The reviewer is independent from the implementer and cannot approve its own changes; review is not release evidence. This request does not launch a paid delivery cycle or change priorities.

**Trigger:** W0–W3 satisfied, or an already specified owner fix using their relevant subset. **Owner:** implementer, external test runner and fresh reviewer.

Use a disposable checkout/container prepared for Node 24, Python 3.12, verified recognition assets and Chromium/WebKit. Do not mount private exports, owner SQLite, .local-secrets, host credentials or unrelated projects. Workers cannot publish or deploy through shell credentials. Worktrees separate edits; container/credential boundaries enforce isolation.

Reproduce, implement, update docs, format changed JS/CSS/HTML and run targeted checks first. Required release checks remain those in the pinned trusted deploy workflow. The current baseline is npm test, npm run build, npm run test:ui and the workflow's additional WebKit invocation. Build requires the name index and prepared recognition assets. playwright.config.js uses its own in-memory server at port 3100. Do not reuse an owner's local server.

| Change area                            | Existing checks to extend/select                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership, persistence, source imports | core.test.js, service.test.js, tags.test.js, import-drafts.test.js; UI import/tags/deck-counts; relevant live suites                                       |
| Search, Home, navigation               | discovery/hybrid-search/card-page/home/tag-navigation unit and UI suites; specified WebKit paths and mobile-live counterparts                              |
| Capture/recognition                    | scanner/browser/backend/hybrid unit suites, scanner/review/model UI suites; relevant live tests; performance scripts only for pertinent measured questions |
| Release logic                          | release.test.js, live/release.spec.js, workflow run and published release metadata                                                                         |
| Planned scale/AI/trading/news          | New behavior-specific fixtures/evaluations are required; existing tests do not establish these capabilities                                                |

Tests and command selection are recorded against the exact head. Workflow/test/policy changes receive explicit review so an agent cannot pass by removing checks or weakening assertions. The controller takes results from its runner/CI, not agent-written status. UI changes require visual inspection; synthetic scanner trials never satisfy physical-phone acceptance. Security review follows changed data flows and boundaries; concrete legal/provider questions require current authoritative evidence and qualified assessment where necessary. No blanket compliance claim.

**Exit:** requirement-to-test map, clean patch, successful required checks, and disposition of each independent finding. **Failure:** route specific findings back to implementation; stop at repair/budget limit with checkpoint and exact blocker. Further edits invalidate affected checks and the head-specific review.

## W5 — Publish and verify the release

**Trigger:** verified patch and recorded delivery authorization. **Owner:** controller.

Publish a task branch and create/update one PR through narrow functions. The PR states user behavior, requirement IDs, tests and limitations. Merge authorization is evaluated against current head, allowed paths/scope and required checks; preserve existing owner grants. A changed head or charter/scope dependency invalidates the relevant decision.

Use .github/workflows/deploy.yml on main. Its OIDC credentials and dedicated live-test secrets stay in the existing trusted CI boundary. Do not grant workers AWS access or expand the CI role. Observe API/site publication, release identity and live plus mobile-live outcomes. Infrastructure remains separately scoped under AGENTS.md.

**Exit:** production verified only when the correct published release and relevant live checks agree. **Failure:** distinguish not published, published but failed verification, and unknown outcome. Reconcile the actual Actions/release state before retrying. Use the documented revert-through-main route within authorization; never reset inventory or delete release prefixes as rollback.

## W6 — Learn and renew the discovery queue

**Trigger:** post-release technical verification, an owner feedback session, or the brief's observation window ending. **Owner:** product researcher plus challenger.

Compare the predeclared outcome with actual evidence: correction burden when capturing, useful decks/upgrades accepted, time to locate/build, trading reconciliation errors, useful news-to-card/deck actions. These are candidate metrics to validate, not existing telemetry. Start with voluntary owner reports and existing safe test evidence; any new analytics is its own data-reviewed requirement.

Record outcome unknown, promising, met or missed separately from deployment status. Recommend retain, adjust, investigate or retire. Preserve prior thresholds; changing them requires an explained new experiment. Feed resulting questions into W1, not directly into automatic implementation. Noisy feedback or one user's success cannot establish market-wide demand.

Suggested future cadence: one weekly bounded discovery digest, immediate owner-idea intake and a review per released feature. No schedule is enabled by this design. Deduplicate signals and cap work in progress so discovery does not starve urgent repairs.

## Runtime and API contract

### Hosted pilot decision

Owner-approved total pilot budget: USD 100, recorded September 12, 2026 (HARNESS-08). Apply across pilot work, including hosted compute, analysis and attributable telemetry/tools; account credits and project budget settings are not the controller's enforcement mechanism. Reserve headroom for in-flight work and delayed usage. Billing funding and key permissions are not verified yet. Planned Windows secret location: `%LOCALAPPDATA%/DevelopmentHarness/secrets/controller-key.xml`, a SecureString exported with PowerShell CLIXML under the owner's Windows identity. It must be decrypted only by the trusted controller/setup process on that account/machine, never copied into a sandbox or printed. This is a storage convention, not a claim the secret file exists.

Owner-supplied environment template ID: `envtmpl_65a1f73aeaf0429889ad15dad8166a775c6f7593a73f4a55a3` (September 12, 2026). This is a non-secret project configuration reference. Existence, project access, template settings and successful sandbox setup have not yet been verified through the API. Supply it as `environment_template_id` when configuring the hosted pilot environment; keep it configurable per OpenAI project rather than hardcoding it into reusable harness logic.

HARNESS-07 records the owner's selection of OpenAI-hosted execution for the pilot. This supersedes self-hosted-first setup elsewhere in the earlier proposal; no executor/environment key is needed for this mode. Use a reusable hosted template and validate the actual Node/Python/build/Playwright requirements through setup checks. Keep application/controller API credentials outside the sandbox. Template packages/setup are configuration, not an already prepared repository or a persistent worker. The independent harness MELT infrastructure remains required, with explicit gaps in provider-host/system visibility. Preserve a replaceable environment adapter for future self-hosting.

### W7 and MELT extension

OBS-07 requires the MELT backend to be an independently deployed reusable harness infrastructure project, separate from all app runtime/observability resources. Task registration and each W7 query carry trusted project scope. Generic telemetry infrastructure is packaged outside this app; per-project adapters/configuration connect the controller to it. This supersedes any shared app/harness runtime-backend assumption; see the [infrastructure boundary](HARNESS-OBSERVABILITY.md#independent-reusable-infrastructure-obs-07).

[HARNESS-OBSERVABILITY.md](HARNESS-OBSERVABILITY.md) adds OBS-01–06: correlated metrics/events/logs/traces, material decision provenance, process/system/network coverage, complete-work cost accounting and a dedicated Efficiency analyst after every completed/failed/cancelled/needs-attention cycle. W7 runs asynchronously with its own reserved budget and read-only evidence; its cost is included and its own run cannot recursively trigger analysis. Controller decisions and external operations must be auditable from the first pilot. Detailed provider traces remain in OpenAI's dashboard; our trace correlation uses supported events/items/usage and explicit visibility gaps. The dedicated document defines cost uncertainty, privacy, retention, failure behavior and acceptance. The earlier W0–W6 learning workflow measures product value; W7 measures harness efficiency without replacing that review.

Proposed initial layout (not created): tools/harness/ with cli.mjs, controller.mjs, policy.mjs, ledger.mjs, agents-api.mjs, git-gateway.mjs, check-runner.mjs and role prompts. Keep these cohesive named modules with plain-object ports. Future checked-in product artifacts can live in docs/opportunities/ and docs/features/; only create an artifact when a real task needs it. Private run DB/logs live outside the worker checkout with an explicit retention policy. Avoid a dashboard until the CLI proves useful.

The Agents API integration uses client.beta.agents.sessions.create for a managed session, session events for input/progress and session retrieval/items for recovery. Handle agent.session.requires_action using actual session.required_actions, validate function arguments and return tool results tied to turn_id/call_id. An observed historical function-call item is not proof that execution is pending. The event stream completing, a subagent completing or an idle event is not a workflow gate.

On disconnection, retrieve saved session/turn/items and reconcile pending actions with the local operation ledger. Do not assume the live event stream replays all missed events. Persist event IDs for deduplication, paginate recovered items, and keep inputs/tool results idempotent where supported. On budget exhaustion stop dispatching, cancel active work where supported, checkpoint and release idle compute; cancellation can have delayed effect and does not undo external actions.

Minimal persisted records:

| Record    | Required fields                                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task      | ID, workflow, owner request, requirement/opportunity IDs, charter/rules/brief hashes, base/head, selected dirty-input manifest, mandate, state, budgets, dependency IDs |
| Session   | Task/role, API session/environment/turn IDs, last observed event IDs, lifecycle, usage, recovery state                                                                  |
| Decision  | Proposal revision, reviewer findings, accept/defer/reject/revise, reasons, authority reference, invalidation dependencies                                               |
| Evidence  | Task/head, command and exit code, trusted runner, artifact hash/location, coverage IDs, local/live/hardware classification, timestamp                                   |
| Operation | Logical operation ID, session/turn/call IDs, normalized argument hash, pending/succeeded/failed/unknown, durable result and external resource ID                        |

Proposed controller functions: get_task_context, submit_candidate, submit_brief, request_checks, publish_branch, upsert_pr and read_release. Each resolves task/repo/head from controller state, not arbitrary model arguments. request_checks accepts named trusted profiles rather than arbitrary privileged shell. Merge/release transition is controller policy, not a broadly exposed agent function. Validate output schemas and references before persisting promotion decisions. Untrusted issues/web pages cannot grant authorization or modify the protected policy snapshot.

Promotion sequence: observed → candidate → proposed → accepted → implementing → verified → reviewed → ready → deploying → production verified. Deferred/rejected are product decisions; needs-attention is a runtime state; product outcome remains a separate field. Corrections can invalidate and return work to earlier stages without losing evidence or already completed independent work.

## Pilot order and harness acceptance

1. **Read-only reconciliation:** W0 maps current evidence and priority conflicts; no inferred production claims.
2. **Product pilot:** W1–W3 create one collection-grounded deck-inspiration brief, a trading feasibility question and a justified rejection/defer decision. These are candidate exercises, not a backlog reprioritization.
3. **Delivery pilot:** Implement one owner-selected, bounded existing requirement after priority reconciliation, to a reviewed PR. Verify current environment/API/account access before committing to runtime details.
4. **Release pilot:** Follow an authorized merge through the existing workflow, including failure-state recovery.
5. **Learning pilot:** Record real owner feedback and compare with the brief; then decide whether to enable a bounded cadence.

Before autonomous promotion, test the controller with fake API/Git/check ports: duplicate tool calls create one PR; a dropped stream resumes without rerunning completed side effects; stale head/charter invalidates promotion; failed or missing checks cannot pass; an altered test profile cannot weaken baseline gates; a subagent completion cannot finish the root task; a private path is excluded from the sandbox; limited budgets stop new work; absent market evidence stays unknown; conflicting priority needs a decision; rejected ideas are not recycled without new evidence; an integrated feature covers affected old journeys. Then perform one live Agents API smoke test in a disposable environment, without owner data or deploy credentials. No such tests have been run for this design.

## Sources and verification scope

### Free roam discovery — queued (HARNESS-10)

W1 gains an exploratory mode that selects research topics within the charter rather than requiring a predefined feature. Sources span competitors, public community discussions and emerging technologies. Preserve dated citations, source class, counterevidence and confidence; primary technical documentation must support feasibility claims. Community anecdotes are signals, not market validation. Each candidate maps to a meaningful collection action, affected requirements/journeys and charter-compatible long-term monetization, with a bounded validation experiment.

No-action is a successful, justified outcome. W2 may author proposed requirements, but development entry requires a recorded scrutiny decision covering charter fit, concrete benefit, evidence quality, existing capability overlap, simpler alternatives, UX complexity, technical feasibility, security/privacy and build/maintenance/running costs. Valid dispositions are reject, defer, investigate/validate further, or accept for development. Acceptance does not implement/release or override existing priorities. No community messaging, owner-data disclosure, automatic implementation, recurring cadence or extra budget is authorized by this queued request.

### Original design source scope

HARNESS-11 applies the same scrutiny and prioritization criteria to all intake sources, including the owner. Save owner requests immediately as requested/pending assessment; source alone grants neither development acceptance nor priority. Agents must challenge assumptions and offer simpler alternatives or reject/defer/validate outcomes when evidence warrants them. Preserve and transparently record explicit final owner decisions and their tradeoffs. Do not silently drop requests, override governing constraints or automatically reorder the backlog.

Repository sources above were inspected locally September 12, 2026. This document is a proposed controller/workflow design; only platform capabilities below are established by the cited official documentation:

- [Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture): managed harness, environment and application responsibilities.
- [Self-hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted): executor and credential isolation.
- [Multi-agent](https://developers.openai.com/api/docs/guides/agents-api/multi-agent): independent tasks and coordinated editing.
- [Events and items](https://developers.openai.com/api/docs/guides/agents-api/sessions/events): lifecycle, streaming and saved-state recovery.
- [Functions](https://developers.openai.com/api/docs/guides/agents-api/tools/functions): required actions and correlated tool results.

No model, pricing, Cardmarket availability or legal-compliance guarantee is selected or asserted. Those require task-specific verification.
