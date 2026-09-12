# Development harness proposal

Current status September 12, 2026: [the initial live pilot](HARNESS-PILOT.md) now exists in two independent local projects and has completed hosted smoke, requirements proposal and efficiency review stages. It supersedes the original proposal-only provisioning status below for this bounded scope. Full autonomous delivery and the new HARNESS-10–11 exploratory/equal-scrutiny gates remain queued.

The MELT extension is [HARNESS-OBSERVABILITY.md](HARNESS-OBSERVABILITY.md): decision auditability, technical/system/network tracing, cost accounting for every agent and W7 cycle efficiency review. OBS-01–06 make this part of the initial harness runtime design, with future app reuse. No instrumentation is implemented yet.

The concrete repository-based design is [HARNESS-WORKFLOWS.md](HARNESS-WORKFLOWS.md): W0 reconciliation, W1 discovery, W2 requirements, W3 integration, W4 implementation/review, W5 release and W6 learning. It specifies role outputs, evidence gates, controller/API recovery and pilot acceptance against the currently inspected code/workflow. HARNESS-06 records this design request; no harness runtime is implemented.

Status: proposal only, September 12, 2026. HARNESS-01 records the request. No harness, API resources, credentials, workflows or deployments were created. The owner's correction supersedes the earlier conversational interpretation of an in-app deck assistant.

## Recommended structure

Use the OpenAI Agents API managed harness, with a small external Node controller that submits development tasks, persists run state, enforces permissions and collects evidence. Keep this tooling separate from the collection application's runtime and AWS stack.

Start with one implementation session and a fresh review session per task. Add bounded subagents only for independent investigations or reviews. One writer owns a checkout; parallel writers need separate branches and environments with explicit integration. Git worktrees alone are not a security boundary.

Use an isolated self-hosted Linux container with Node 24, Python 3.12, Playwright browsers and verified recognition assets. Run the documented executor inside it. Validate executor/account availability during a setup spike; this proposal does not assert that the current Windows workspace is already compatible. Mount only the task checkout and approved caches, excluding owner databases, exports, credentials and unrelated repositories. Keep controller credentials outside the executor; use its separately restricted environment key.

## Workflow

### Product discovery and requirements authoring

**Purpose gate (PRODUCT-07):** Use [charter revision 2](PRODUCT-CHARTER.md#audience-and-purpose), **Give life to your collection**, as the current purpose. Every opportunity and feature brief must answer **Does this feature help someone do something meaningful with their collection?** Record the enabled action or supporting trust/quality benefit and observable success criteria. Independent product review challenges that connection; weak proposals are revised, deferred or rejected. This updates the revision 1 charter reference below without changing its audience or intended scope.

HARNESS-02–05 extend the original execution-first proposal: the harness should discover opportunities, challenge their value, author requirements and integrate accepted changes across the product. The owner need not supply a finished specification. This is proposed capability, not an active recurring job or authorization to ship generated ideas.

**Product charter:** Maintain a versioned statement of purpose, target users, core jobs, non-goals, user promises, monetization avenues, evidence, success measures and delegated decision scope. The current README establishes a private Magic collection app with printing lookup, inventory, reviewed imports and assisted recognition. The inspected docs do not establish an approved monetization strategy. Price tracking and Cardmarket listing/repricing appear as unimplemented capabilities, not confirmed revenue channels. Record unknown commercial assumptions explicitly; do not invent owner intent. Charter changes are visible proposals and cannot silently redefine the criteria used to approve a feature.

**Evidence collection:** On an owner-triggered discovery run, inspect the backlog, existing journeys, reproducible friction, support/issue evidence and authorized aggregate usage data. Research relevant current market/provider facts with dated sources when needed. Distinguish observation, owner direction, hypothesis and missing evidence. Never fabricate interviews, demand, conversion or willingness to pay. Deduplicate ideas against existing requirements, rejected decisions and unfinished work. A recurring cadence is a future explicit configuration, not created by this proposal.

**Charter update:** [Product charter revision 1](PRODUCT-CHARTER.md) now supplies the previously missing purpose and audience: the owner first, and collectors organizing cards for AI-assisted deck building/upgrades and trading/sales, including Cardmarket. PRODUCT-01–06 also capture relevant news engagement, composition, asynchronous UX, security/data obligations and ongoing monetization discovery without UX harm. This supersedes the earlier description of purpose as not yet established. Commercial model, numerical budgets and provider access remain unresolved. Every candidate brief must trace to this charter; evaluate trading as a user workflow separately from app monetization, and include effects on physical/digital consistency across existing journeys.

**Independent challenges:** Use bounded research/review sessions with distinct briefs: discovery proposes problems and opportunities; commercial review examines who benefits, who pays, acquisition/retention value, operating/support cost and channel dependencies; product consistency review traces existing journeys, terminology, data semantics and interaction patterns. Reviewers first assess the evidence independently, then see the proposal and each other's objections. An agent majority is not customer validation. The lead records unresolved dissent and synthesizes the decision.

**Opportunity decision:** For each candidate, save its target user and job, evidence links, purpose fit, hypothesized revenue or enabling value, confidence, costs/dependencies, affected workflows, counterarguments and the smallest useful validation. Compare building it with improving an existing flow and doing nothing. Choose investigate, experiment, adopt, defer or reject with reasons. Scores may help order candidates but never convert weak evidence into certainty. Reliability, trust and free core usability can enable monetization indirectly; a feature need not charge money itself.

**Requirements writing:** Convert selected opportunities into stable requirement IDs with source opportunity/charter revision, actors and trigger, preconditions, happy path, empty/error/retry/cancel paths, persistence/account isolation, accessibility, data/provider constraints, integration dependencies and explicit exclusions. Write Given/When/Then acceptance scenarios and a product outcome measure with baseline, observation window and predeclared success/stop criteria. Unknown baselines stay unknown until measured. Product decision state (hypothesis/proposed/accepted/rejected/superseded) is separate from implementation/release status. Keep rejected/superseded decisions with rationale to prevent rediscovery loops.

**Consistency and integration:** Each accepted feature needs an impact map covering Home/navigation/search, card details, inventory and ownership, tags/locations, imports, scanner, shared controls, API/storage, onboarding/help and any applicable pricing/entitlements. Mark each affected area change required, regression coverage required or unaffected with a reason. Adapt existing flows as part of the feature where necessary; reuse canonical identities and shared components, and retire superseded paths deliberately. Every adjacent edit must trace to an acceptance scenario or invariant. Broad unrelated redesigns become separate proposals. Re-run impact review when implementation discovers a new dependency; invalidate approval if it changes scope outside the recorded mandate.

**Validation and learning:** The execution workflow below receives the requirement bundle and impact map. Reviewers check complete old-to-new journeys, not just new controls. After release, assess the predeclared product outcome separately from technical delivery; a deployed feature can remain commercially unvalidated. Retain, adjust or propose retirement using measured evidence. Agents cannot silently weaken success criteria after results arrive.

Proposed artifacts are a product charter, opportunity/decision ledger and per-feature briefs linked into REQUIREMENTS.md, USE-CASES.md and ARCHITECTURE.md. Keep one canonical source for each decision and reference it rather than copying competing versions. Persist charter/brief revision hashes with each run so corrections invalidate stale conclusions.

Discovery and draft writing proceed autonomously within the assigned run budget. Accepted priorities and implementation scope come from recorded owner direction or an explicit standing mandate. Existing authorization remains valid; generated documents cannot grant new privileges, change pricing or redefine purpose by themselves. Begin with a discovery pilot producing one complete candidate brief and at least one justified rejection, then pass an accepted candidate into the development pilot.

### Implementation and release

1. **Intake:** Accept an owner request, base commit, priority, budget and existing authorization scope. Read AGENTS.md, README and relevant docs. Save stable requirements and acceptance criteria before implementation. Record corrections explicitly; do not pull unrelated queued work into the task.
2. **Prepare:** Create a clean task branch from the recorded commit. Preserve the owner's dirty checkout. If uncommitted work is needed, explicitly capture the selected changes in the task input. Prepare a synthetic test database and dependencies.
3. **Implement:** Reproduce the problem, edit code and aligned docs, format changed JS/CSS/HTML, and add meaningful regression coverage. Keep tool and time budgets bounded. Use specialist investigation only when it resolves an independent question.
4. **Verify:** Run relevant focused checks, then required unit, browser and build checks. Attach commands, exit codes and sanitized artifacts to the tested commit. UI work includes rendered inspection; scanner replay and emulation remain distinct from physical-device verification.
5. **Review:** Give a fresh reviewer the requirements, base/head diff and evidence. Review against ownership isolation, exact printings, quantities, tag IDs, source idempotency, navigation and scanner invariants where affected. Findings need a concrete location, impact and requested correction. The implementer fixes findings; repeat affected checks and review the changed commit. Default to two repair rounds before reporting an unresolved blocker, with the patch retained.
6. **Deliver:** Produce a PR with requirement IDs, behavioral changes, test evidence and remaining limits. A controller-enforced merge policy uses the recorded authorization and checks for the current head commit. Reuse existing authorization; request only a genuinely missing decision. A proposal request itself does not authorize a merge.
7. **Release:** An authorized merge to main uses the existing deployment workflow. The harness observes Actions and verifies the deployed commit/version plus relevant live checks using dedicated test profiles. Mark production verified only with release evidence. A failure after publication is reported as potentially deployed and failed verification; follow the documented revert-through-main process within authorization.

## Controller responsibilities

Persist task ID, requirement IDs, base/head commit, session/environment IDs, lifecycle stage, authorization scope, budget usage, tool operation IDs, PR/run URLs and evidence references. The controller, not model prose, decides whether a stage's evidence is sufficient. Suggested stages: queued, implementing, verifying, reviewing, ready, deploying, production verified, needs attention.

Receive progress events and resume the same task after interruption. Deduplicate side-effecting operations such as branch publication and PR creation; reconcile GitHub state before retrying an uncertain outcome. A completed agent turn is not proof of completed development. Invalidate review/test approval when the head changes. Stop scheduling new work at the configured budget and retain a resumable checkpoint.

Expose narrow controller functions for publishing a task branch, creating/updating its PR and reading CI/release state. Keep merge enforcement outside the editable sandbox. Workers have no production AWS credentials or owner credentials. CI supplies dedicated live-test identities through its existing secret handling. Treat issue text, provider content and command output as data; they cannot grant privileges or change policy. Preserve the shared Scryfall limiter/cache/cooldown and verified asset integrity.

## Pilot and acceptance

Pilot one small, non-camera regression through a reviewable PR before enabling authorized automatic merge. Evaluate requirement coverage, first-pass test success, review findings, elapsed time, API usage/cost and human interventions. Include interrupted sessions, repeated events, stale head checks, failing CI and deployment verification failure. Account/API access, actual runtime compatibility and cost remain unverified until the pilot.

Start without a dashboard, standing workers or automatic backlog consumption. A CLI and durable run ledger are enough to validate the workflow. Model selection and numeric budgets should be configurable and measured during the pilot.

## Official API references

- [Agents API architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture): OpenAI runs the harness; the application submits tasks and handles events/tools; environments supply files and compute.
- [Self-hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted): executor connection and restricted environment credentials.
- [Multi-agent orchestration](https://developers.openai.com/api/docs/guides/agents-api/multi-agent): independent contexts, bounded delegation and coordination of edits.

Sources checked September 12, 2026. These describe platform capabilities; the workflow and enforcement above are proposed project design.
