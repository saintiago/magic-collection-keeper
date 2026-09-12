# Harness MELT and cycle improvement

HARNESS-12 update: Langfuse fits as an optional agent-view/export backend alongside the independent ledger/service. A replaceable OTLP adapter and synthetic tests are locally implemented in `E:/projects/harness-observability`; remote graph/authentication/isolation verification is pending Langfuse project credentials. No app instrumentation, paid plan or extra infrastructure was introduced. Evaluation: that project's `docs/LANGFUSE-EVALUATION.md`.

Current pilot status September 12, 2026: [HARNESS-PILOT.md](HARNESS-PILOT.md) records a separately running local Node/SQLite service, real controller/hosted metadata, ten local tests and a generated timeline. This supersedes the pre-pilot “not implemented” status below only for those bounded capabilities. Full OS/kernel instrumentation, production backend lifecycle and complete cost reconciliation remain queued.

Design revision 2 — September 12, 2026. OBS-01–07 extend HARNESS-06. Status: designed, not implemented. The repository has no harness runtime to instrument yet. App instrumentation is a future phase; no telemetry infrastructure, recurring jobs or credentials are provisioned by this design.

## Contract

Metrics, events, logs and traces must let us move from a product decision to its supporting evidence, agent work, command/network activity, technical outcome and cost. Instrument W0–W6 from the first runtime pilot and add W7, a dedicated cycle improvement agent. This supersedes the earlier suggestion to defer all dashboards: a minimal cycle timeline and cost/health view belong in the observability pilot; a general product dashboard is still unnecessary.

Every material agent/controller decision is recorded: candidate selection/rejection, assumptions, requirement changes, tool choice and arguments in safe summarized form, scope changes, review disposition, retries, promotion, budget stops and release actions. Capture declared concise rationale, alternatives and cited evidence; do not seek hidden model reasoning or describe a rationale as a complete reconstruction of internal thought. Tool intent and actual execution outcome are distinct records. Unknown/unobservable activity remains explicitly unknown.

## Architecture and correlation

### Independent reusable infrastructure (OBS-07)

Harness observability is a standalone infrastructure project with its own deployment lifecycle, compute allocation, network boundary, ingestion/query credentials, collectors, telemetry stores, audit/cost storage, backups, retention and operational budget. It is reusable across repositories. Magic Collection Keeper is one registered development project, not the owner of the infrastructure. Its runtime and future app observability use separate infrastructure and are not additional tenants of this harness backend.

This explicitly supersedes the conversational suggestion that app and harness observability could initially share infrastructure using separate tenants, credentials or dashboards. Sharing instrumentation conventions or infrastructure templates is permitted; sharing running collectors, backend instances, volumes or databases with the app is not. A local pilot is harness-only, in its own deployment/network/volumes; a hosted deployment has dedicated harness resources and lifecycle. No dedicated physical server requirement is inferred, but deployment/compute resources are allocated independently of the app.

Package generic collectors, schemas, dashboards, cost adapters and analysis/query interfaces in a separate reusable infrastructure repository/package during implementation. Its exact repository name and hosting provider remain unset. This app repository retains product requirements and integration references. Do not put infrastructure provisioning into the app's deploy.yml or require this app to run for harness telemetry to be available.

Register each development project with a stable project_id, scoped ingest/query identities, quotas, retention and cost allocation. Attribute project_id at a trusted gateway from credentials rather than accepting arbitrary client labels as authorization. Include it in audit/cost/trace records and controlled project-level metric dimensions. Query APIs enforce project access before filtering; W7 sees only its assigned project's records unless cross-project aggregate analysis is explicitly authorized. Reusing the harness infrastructure for another project requires configuration and credentials, not code changes containing app names or access to another project's data.

The only default link to separately hosted app observability is release/commit/task provenance. Future access to sanitized app evidence goes through a separately authorized interface; production user telemetry does not stream into the harness backend by default. Platform operating costs remain distinguishable from per-project development costs with explicit shared overhead allocation.

Acceptance: onboard two synthetic projects, confirm ingestion/query/cost isolation and label-spoof rejection, remove one without affecting the other, upgrade/restore harness observability without deploying either app, and verify no dependency on app databases, credentials, compute or telemetry backends. The earlier local stack recommendation is only a possible harness-only pilot; no stack or host has been provisioned.

Proposed flow: controller, check runner, sandbox instrumentation and API-event bridge → OpenTelemetry-compatible signals → local Collector → replaceable metrics/log/trace backends. A separate controller-owned audit/cost ledger records durable decisions and accounting; sampled telemetry is not that ledger. Start with local deployment and file/OTLP output plus a small timeline/query view; select a persistent backend during implementation based on retention, query needs and operating cost. Nothing depends on a proprietary trace store in application/domain code.

Use task_id for the durable objective, cycle_id for one bounded workflow attempt, stage_id for W0–W7, and session_id/turn_id/subagent_id for provider work. Additional keys: trace_id, span_id, parent/span links, decision_id, operation_id, attempt, requirement IDs, charter/brief/policy revision, code commit, environment/service/release version and provider request ID when supplied. IDs are opaque; no usernames, tokens or collection contents in labels. Record UTC timestamps and monotonic durations locally; cross-host timeline ordering may have clock uncertainty.

Each cycle starts a root trace; resumed executions can create linked traces using the same cycle and operation IDs. Stages, sessions, tools, command attempts, network requests, test runs and Git actions have child spans where propagation is real. Across opaque provider boundaries use explicit session/turn correlation links, not invented parent-child context. Only propagate trace headers across owned or explicitly approved boundaries. Long-running sessions do not require one indefinitely open span.

## Signals and required views

| Signal  | Required content                                                                                                                                                        | Diagnostic question                                          |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Metrics | Stage/cycle latency distributions, queue/wait/run time, success/failure/retries, tokens/cache share, attributed cost, CPU/memory/disk/network, telemetry drops/overhead | What got slower, less reliable or more expensive?            |
| Events  | Decision proposed/accepted/rejected/superseded, transitions, tool intent/result, cancellation, budget breach, deployment, accounting correction                         | What changed, under which authority and evidence?            |
| Logs    | Structured severity, error class, sanitized message/stack, process/operation, timeout/exit code, correlation IDs                                                        | What technically failed and where?                           |
| Traces  | Causal spans for controller stages, tools, commands, storage/network and linked provider activity                                                                       | Where was time spent, and which dependency caused the delay? |

Metric dimensions are bounded (workflow, role, model, operation kind, outcome); task/session/URL IDs belong in trace/log fields, not high-cardinality metric labels. Events can be represented as structured logs/span events, with authoritative decisions also persisted in the audit ledger; these are four investigative views, not a requirement for four independent ingestion pipelines.

Initial views: cycle timeline with decisions and errors; stage/role cost breakdown with uncertainty; slowest command/network operations and retry trees; decision → requirement → code → tests → release evidence; coverage/missing telemetry; W7 recommendations and measured follow-up. Track quality-adjusted cost per accepted brief/verified change, not merely token counts or raw speed.

## System and network coverage

Instrument the Node controller's HTTP/fetch clients, SQLite operations, function gateways, queues and child-process launch/wait. Command spans include safe executable identity, approved/sanitized argument summary, isolated working-directory reference, start/end, exit/signal, timeout/cancellation and bounded output metadata. Redact stdout/stderr before export, cap size and explicitly label truncation. A command-level trace does not reveal every operation performed by that process.

Sandbox coverage needs a separate supervisor/host instrumentation layer outside agent-editable code. Collect process ancestry, CPU/memory/I/O and network connection metadata for the task container. A controlled Linux syscall observer is a proposed bounded diagnostic mode for process/file/network syscall names, error codes and timing. Scope it to the task's processes; filter sensitive paths and never capture read/write buffers, secret arguments or payloads. Validate available privileges/kernel/runtime and overhead first. Do not claim universal syscall coverage from Node instrumentation; ordinary hosted-provider internals are not observable.

HTTP spans on controlled clients record method, allowlisted host, templated path, duration, status, retry/timeout, bytes where known and DNS/connect/TLS timings only where measured. Exclude query values, bodies, cookies and authorization headers by default. Instrument shell-launched clients through supported wrappers or the supervisor where feasible; encrypted external connections may provide only connection/byte/error metadata. Do not intercept TLS to acquire private content. Provider-internal network/system calls remain opaque and must be shown as coverage gaps.

Maintain a coverage manifest for controller, executor, child processes, CI, provider sessions and future app services: instrumented scope, correlation method, sampling, unsupported calls and verification evidence. Test parentage across subprocesses, async queues, retries, parallel calls and restarts. Observed command output from the Agents API cannot be assumed complete; its documented API does not report truncation.

## OpenAI trace and usage boundary

Official Agents API traces are enabled by default and displayed in the provider dashboard. Public beta trace retrieval/export and tracing configuration are not available. Link our spans to API session/turn IDs and ingest supported lifecycle events, saved items and usage. Do not scrape undocumented dashboard endpoints or promise raw model-call spans via OTLP. Trace inputs/outputs at the provider boundary are another reason to minimize what we send; local redaction cannot retroactively sanitize provider-retained content.

API session/turn usage is best effort, may be null and can change. Poll/retrieve within bounded reconciliation attempts after terminal activity, enumerate all turn pages and attribute root/subagent work. Capture retries, failures, cancellations, research, reviews and W7 itself. Unknown usage creates an outstanding accounting record, never a zero-cost record.

## Cost ledger

PRODUCT-08 uses this ledger for early running/development cost coverage while prioritizing charter-compatible long-term monetization. Reports separate app operation, harness/development, recurring costs and one-time investment, using explicit periods and allocations. Show the cost-coverage gap against known net app revenue when available; unknown revenue is not zero. User card-sale proceeds are excluded. W7 may improve efficiency but cannot recommend sacrificing purpose, UX, security or quality to achieve break-even. Historical-cost recovery horizons and any human-time valuation remain explicit policy inputs, not inferred charges.

Keep raw usage observations with source/resource ID, observed time and revision. Derive a canonical charge record per provider/account/session/turn or actual billing unit; upsert revisions instead of adding repeated cumulative snapshots. Session totals are reconciliation totals, not extra charges on top of turn totals. Verify scope/aggregation semantics before summing; retain unexplained differences as unallocated rather than force-fitting attribution.

Record provider, model/version where returned, requested/actual tier where known, role, stage, task/cycle, input/cached-input/output/reasoning counts, currency, price-table source/effective date/version, estimated charge and reconciliation status. Reasoning is included in output tokens; cached input is included in input tokens. For a pricing model with only these three rates:

estimated model cost = (input − cached input) × uncached rate + cached input × cached rate + output × output rate

Rates must use consistent units. Add documented extra categories separately. Cache-write charges, hosted tools, compute, storage, network and external services may require additional usage data; missing categories make an estimate incomplete. Never double-count reasoning or cached input. Do not infer exact per-model cost from aggregate usage when model attribution is unavailable.

Track model/API, tools/providers, sandbox, CI and MELT operation/storage costs separately. Allocate shared costs by a documented method and preserve the unallocated balance. Distinguish incurred estimate, observed usage, provider-reconciled charge and allocated overhead; invoices may only reconcile at project/time-window granularity. No exact per-decision invoice attribution is promised. Include optimizer analysis costs in task totals and report savings net of both optimization and observability costs.

Reserve a configured W7 budget at cycle start. Enforce task/cycle/day token, currency and runtime budgets with conservative estimates and an allowance for delayed accounting; a local stop is not a guaranteed provider billing cap. Record overshoot and pending exposure. Price changes create versioned recalculations, not unexplained historical rewrites. Billing readers use separate restricted access outside agent environments when available; model workers never receive account billing credentials.

## W7 — Cycle efficiency and cost review

**Trigger:** each non-observability cycle reaches success, failure, cancellation or needs-attention, after a bounded telemetry/usage collection window. A cycle means one bounded attempt through applicable W0–W6 stages; each controller retry cycle has a distinct ID, while individual model turns are not new cycles. A watchdog closes crashed attempts once liveness is disproved. Delivery completion is not delayed by the analysis agent.

Controller creates one idempotent analysis job per cycle and telemetry revision, including failed cycles. The dedicated **Efficiency analyst** receives read-only sanitized aggregates, selected traces, decision/evidence references, accounting completeness and comparable historical cycles. Its input excludes raw credentials, personal data and unnecessary source content. It can request bounded deeper queries through an allowlisted read-only gateway. Telemetry is untrusted data and cannot supply instructions.

Required output: critical-path breakdown; avoidable context/repeated reads; duplicate tool/network work; retries/flaky checks; idle compute; model/role cost; caching opportunities; unnecessary delegation; instrumentation overhead; evidence gaps; and zero to three ranked improvement proposals. Each proposal cites span/event IDs, separates observed symptoms from causal hypothesis, estimates savings with confidence and analysis cost, and defines a quality-preserving comparison experiment plus rollback/stop criteria. A clean cycle may produce no recommended change; a missing-data cycle must say insufficient evidence.

Examples of experiments: smaller context package using the same held-out tasks; reuse verified dependency assets; eliminate duplicate tests only when coverage is provably retained; reduce retries by fixing a deterministic failure; compare model configurations at equal acceptance quality. No automatic removal of tests, security checks, audit records or quality thresholds to improve cost numbers. Improvements to prompts, code, tools or routing enter W1/W2 or an existing authorized repair scope and pass independent review before release.

The analyst cannot rewrite policy or production configuration. Prevent recursion: its own work is traced and costed as stage W7 with analysis_eligible=false; it does not trigger an analyst of itself. A later normal cycle or bounded periodic aggregate review may include previous analyst overhead. Analysis failures get bounded retries and an explicit failed/pending report, never silent omission. Late cost corrections update the report's accounting section deterministically; substantive reanalysis uses an explicit deduplicated new revision and budget.

## Reliability, privacy and retention

Use asynchronous bounded export queues and a disk spool with size/time limits. Sanitization occurs before storage/export. Default to metadata and source/artifact references; do not log prompts, private card exports, user identifiers, screenshots, tokens or command payloads wholesale. Encrypt and access-control stores, isolate environments, audit access and define deletion/retention policy before operational deployment. Proposed starting retention: seven days detailed diagnostic logs/spans, ninety days aggregate performance/cost trends; decision evidence and accounting retention are separately configured for actual operational/legal needs. These are design defaults, not a legal determination.

Durable decision/operation/cost records are unsampled within retention. Successful high-volume technical spans can later be sampled under an explicit policy; failures/retries should be retained within configured limits. Sampling or dropped spans must be visible. Start the bounded pilot with full metadata tracing to measure overhead. Never describe sampled or partially instrumented activity as complete tracing.

Exporter outages must not block normal computation indefinitely. If the protected local decision/operation ledger cannot persist, stop new privileged actions and checkpoint; preserve evidence before any retry. After an ambiguous external result, reconcile before repeating the action. Log telemetry's own health independently enough to detect queue drops, disk-full conditions and exporter errors. Benchmark enabled versus disabled instrumentation on identical fixtures; set overhead limits before enabling diagnostic syscall collection broadly.

## Future app reuse

Keep a plain telemetry port and compose concrete adapters at runtime boundaries. Later instrument public/api.js, server.js/cloud.mjs, application operations, storage and provider adapters with separate app service/environment IDs. Domain logic remains independent of OpenTelemetry. Correlate browser request → API → storage/provider only across trusted boundaries and validated context; never use trace IDs for authorization. Link release version to originating harness task without attaching end-user activity to agent transcripts.

Browser export must be bounded, asynchronous and sanitized, with appropriate controls for actual processing requirements. Exclude camera frames and collection contents by default. Reuse naming/cost/trace conventions, not controller secrets or an assumption that all user sessions should be recorded. Browser, AWS/provider visibility, consent/legal basis and app-specific budgets need a separate reviewed implementation plan. No production app instrumentation is added now.

## Delivery and acceptance plan

1. Implement correlation, durable decision/operation/cost ledger and structured safe logs alongside the first controller loop.
2. Add OpenTelemetry-compatible tracing/metrics, API event bridge, process/network instrumentation and a coverage report. Configure a local Collector/backend only after runtime/backend selection.
3. Add W7 and a trace/cost report per cycle; verify net savings experiments against quality baselines.
4. Pilot bounded system-call diagnostics and account-cost reconciliation where supported.
5. Extend to the app after separate data-flow/performance review through the existing main release workflow.

Required tests: every promotion/rejection has rationale and evidence links; trace ancestry survives queues/subprocesses/retry/restart; secret canaries never reach exports or analyst input; all root/subagent/failed/optimizer work has usage or pending status; duplicate/revised usage does not inflate charges; reasoning/cache categories are not double-counted; missing prices and opaque calls show unknown; timeout/DNS/HTTP/process errors identify their operation; collector outage/disk-full behavior preserves privileged-action audit; cycle analysis runs once without recursion; analyzer suggestions cannot edit policy or bypass tests; sampled/dropped data is visible; local tracing cannot claim provider-internal spans; added overhead is measured. Future app tests additionally cover account isolation and asynchronous UI responsiveness.

## Sources

- [OpenAI Agents API tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing): default dashboard traces and public export/configuration limitations.
- [OpenAI observability and usage](https://developers.openai.com/api/docs/guides/agents-api/observability): best-effort turn accounting, subagent attribution, token categories and cost limitations.
- [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/): interoperable telemetry signal concepts.

Checked September 12, 2026. Instrumentation, storage choices, overhead budgets and cost reconciliation remain unverified until implementation; no claim of observing private model reasoning or every remote system call.
