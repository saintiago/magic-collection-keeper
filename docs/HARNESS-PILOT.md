# Development harness pilot — September 12, 2026

Later HARNESS-12 update: a replaceable Langfuse exporter and eight-span synthetic evaluation are locally implemented, adding two passing tests (12 total across both projects). Real local-cycle export preview succeeded. Langfuse remote authentication/agent-graph/cost/isolation verification remains pending dedicated project keys. See `E:/projects/harness-observability/docs/LANGFUSE-EVALUATION.md`. No additional model calls or paid observability service were used for this evaluation.

HARNESS-09's initial live cycle completed. This is an independent local development-tooling pilot, not an application release or a complete autonomous W0–W7 delivery system.

## Repositories and infrastructure

- Controller: `E:/projects/development-harness`, Node 24, OpenAI SDK, OpenTelemetry SDK and durable SQLite ledger/outbox.
- Independent harness-observability service: `E:/projects/harness-observability`, a separate Node process on `127.0.0.1:4319`, credential-scoped ingestion/query, SQLite and an HTML timeline/OTLP JSON export. No app backend dependency. Docker/WSL are not installed; Grafana/Loki/Tempo/Collector, backups, retention and production hosting remain queued.
- Runtime data lives under `%LOCALAPPDATA%/DevelopmentHarness` and `%LOCALAPPDATA%/HarnessObservability`, outside repositories. Controller key remains Windows DPAPI encrypted at rest, loaded by the launcher and never sent to the sandbox. Runtime directories are restricted to the current user, SYSTEM and administrators. Local observability tokens are scoped read/ingest credentials.
- Discussion thread: `01a09590-d325-7322-94f5-2c916b708ce6` (Magic collection — product discussion), authorized to read implementation status and relay agreed decisions. Implementation thread: `01a094ae-408b-7023-9650-4c2b26a76ed2`.

## Live evidence

Cycle `3ff07cc2-fff9-4b83-9b9b-3a3c2d9c4ab0`:

1. Authenticated model/template preflight succeeded. A hosted shell reported Node **22.23.2** and Python **3.12.12**, and produced a PASS result for a synthetic listing/sale-idempotency example. This did not execute app code. Command-item exit code/duration were null; the agent's claimed exit zero is not independent exit-code evidence. The app requires Node 24, so this template is **not yet validated for app development**. Hosted session deletion succeeded after local evidence/usage capture.
2. Initial environment-free sessions were rejected with HTTP 400. A no-input diagnostic established that conversation-only sessions require initial input. The controller was corrected to include it. The same cycle resumed and reused the completed hosted result without another hosted model run.
3. The requirements role produced “Collection-Grounded Deck Seeds,” identifying existing scanner/deployment priority conflicts and proposing INSPIRE-01–03. This remains an unapproved candidate artifact, not accepted app requirements. In particular its availability/assignment formula needs domain review before adoption.
4. The independent W7 role proposed context reduction, caching and deterministic preflight experiments. These are hypotheses from one cycle. Its input initially omitted previous failed-attempt history and did not explain that only the requirements stage received the repository snapshot. That limited its diagnosis. Subsequent code adds scoped telemetry history and explicit context routing; this refinement is locally checked, not rerun as a second paid review of the same cycle.

Artifacts: `%LOCALAPPDATA%/DevelopmentHarness/cycles/3ff07cc2-fff9-4b83-9b9b-3a3c2d9c4ab0/` contains `snapshot.json`, `hosted-smoke.md`, `requirements-proposal.md`, `efficiency-review.md` and `result.json`. The snapshot includes only allowlisted repository text, with content hashes; no owner collection or account data. Timeline: `%LOCALAPPDATA%/DevelopmentHarness/timeline.html`.

## Accounting and limits

| Role                  | Input tokens | Cached subset | Output tokens | Partial token estimate USD |
| --------------------- | -----------: | ------------: | ------------: | -------------------------: |
| Hosted smoke          |       22,150 |         7,609 |           656 |                  0.0371638 |
| Requirements proposal |       30,156 |             0 |         1,367 |                  0.0739820 |
| Efficiency review     |        6,674 |             0 |           661 |                  0.0199580 |
| Total                 |       58,980 |         7,609 |         2,684 |                  0.1311038 |

These are provisional standard Sol short-context token subtotals using the September 12 [official pricing snapshot](https://developers.openai.com/api/docs/pricing), not final billed amounts. Cached input is included in input, and reasoning tokens in output. Cache-write charges, hosted compute and final usage adjustments remain pending. Development of this harness in Codex is outside its runtime accounting; its dollar cost is unavailable, not zero. No additional cloud observability infrastructure was purchased.

The owner's USD 100 total pilot budget is recorded; billing funding is owner-confirmed rather than verified via a billing API. A USD 10 reservation remains held for the cycle. Current guards refuse overlapping/ambiguous cycles, retain reservations, bound stage duration and stop on observed token subtotals. They are **not a provider-enforced dollar ceiling**: usage is delayed and the API's session-create contract exposes no per-request maximum-token field. Reservation reconciliation and a production budget service remain incomplete; no autonomous schedule is enabled.

## Verification and remaining work

Ten local tests passed: seven controller tests for durable reservations/revised usage, source protection, telemetry outage, ambiguous creation, initial-input sessions/completed reuse, rejection recovery and async trace parenting; three service tests for credential/project isolation, redaction/idempotency/pagination, HTML escaping and OTLP trace export. These tests use temporary databases and synthetic data.

A local Chromium check loaded the generated 149-event timeline, verified both no-match and stage filters, and captured a visually inspected screenshot. This is report UI evidence, not app E2E or physical-device verification.

Telemetry records real controller HTTP spans, filesystem snapshot boundaries, stage/cycle correlation, decisions, usage and provider command metadata. The initial hosted segment predates the parent-span refinement and is linked by cycle ID; later stages have nested trace parents. Provider host kernel calls and hidden internal network/model spans remain unavailable. Local telemetry export itself avoids recursive instrumentation. Full OS syscall tracing, complete historical/hosting cost reconciliation, backup/retention, hosted Node 24/build/browser validation, structured candidate promotion, scrutiny enforcement, independent code review, PR/release gates and app observability remain queued.

HARNESS-10–11 additionally queue free roam discovery, justified no-action outcomes, scrutiny before development and equal assessment of owner-origin ideas. No exploratory research run or priority change was triggered by recording them.
