# Testing architecture

## Choosing test scope

Test documented behavior at the smallest scope that can reliably expose the relevant failure.
Use many focused tests, fewer integration tests and a small set of complete journeys. The pyramid
guides feedback cost and confidence; it does not impose test counts or percentages.

| Scope          | Real parts                                                                    | What it proves                                                                                   |
| -------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Unit           | A focused rule or transformation.                                             | Decisions and edge cases that need no assembled component.                                       |
| Component      | A component through its public contract, with its internal logic assembled.   | Its observable promises under successful and failed dependencies.                                |
| Integration    | The components or infrastructure boundary involved in a specific interaction. | Compatibility, query semantics, persistence and other effects that substitutes cannot establish. |
| System journey | Browser, assembled application and test storage.                              | A user can complete an important task across the system.                                         |

Keep ordinary internal collaborators real. Substitute dependencies outside the scope being tested.
Use real PostgreSQL for database behavior; an in-memory repository cannot prove joins, constraints
or transaction behavior. A browser test with a substituted backend establishes UI behavior only.

## Contracts and cooperation

Each component's tests exercise its provider-owned public contract. Verify observable results and
required effects. Internal refactoring should not require rewriting those tests.

For a changed boundary, verify the consumer against actual provider output or run both together.
Cover the relevant successful result and failure semantics. Type checking and schema validation
establish shape compatibility; behavior needs assertions. Avoid independently invented fixtures
on both sides that agree with each other but differ from the implementation.

Contract and workflow describe what a test proves, not additional test layers. Keep cross-component
scenarios in integration or system tests according to their scope.

For database query contracts, verify each provider's published views against its real writes.
Test combined queries with small contract-conforming view fixtures, then run a focused integration
case against the real providers. Include same-printing/copy filtering, duplicate associations,
account isolation and continuation invalidation. A private table rename must not require Search changes.

For supported Scryfall syntax, keep compatibility cases over a fixed catalog fixture. Verify that
text expressions and equivalent UI criteria select the same entries, preserve supported operator
semantics and reject unsupported expressions. Routine tests do not depend on live search results.

Run the same observable contract cases against replacement implementations. Include failure,
authorization, cancellation and retry behavior where the interface promises them.

## Keeper's main risks

| Owner         | Focused evidence                                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog       | Card-to-printing resolution, complete basic information and reads independent of live provider requests.                                                                                                  |
| UserCards     | Stable copy identities; one physical location per copy; distinction between desired quantities and physical counts; card/printing refinement; pending entries excluded from ownership until confirmation. |
| Search        | Mixed catalog and private filters, ordering and pagination over the complete result, without duplicate counts or another user's entries. Use real database queries.                                       |
| UserInterface | Basic information before optional fragments, partial failures, empty versus unavailable results, stale responses after query/navigation/account changes, and preserved interaction context.               |
| Recognition   | Candidate interpretation, ambiguity and failure handling; recognition output cannot grant ownership.                                                                                                      |
| Application   | Correct component wiring, rejection of invalid identity and enforcement of private access through every applicable backend entry point.                                                                   |

Keep detailed variations with their owner. Use a few system journeys to connect them: find a card
and add it to a wishlist; review an import, confirm copies and verify persistence; assign a copy to
a location and inspect the resulting count. Select journeys affected by the change.

Migration tests use representative synthetic legacy records and verify resulting copy counts,
associations, account ownership and provenance. Tests never modify the owner's collection.

## Component acceptance scenarios

These scenarios verify the requirements in the owning component documents. Run the affected
scenarios at the smallest useful scope; they are not a requirement to rerun every suite per task.

### Catalog

Verify exact card/printing resolution, multilingual names, allowed finishes, missing members in
batch responses and unavailable lookup errors. Reads must succeed without a live provider.
Exercise the published views and grants on real PostgreSQL and verify that consumers cannot read
private tables. For synchronization, use small deterministic snapshots: malformed or interrupted
ingestion preserves the previous revision, retries do not duplicate identities, and concurrent
readers see a coherent published revision.

### UserCards

- **Copies and authorization:** use two synthetic accounts and real PostgreSQL to cover foreign
  references, missing context, protected views, base-table grants and connection reuse. Verify
  identity-preserving printing/finish/condition corrections, rollback and revision conflicts.
- **Tags and associations:** verify rename invariance, card/printing intended quantities, counts of
  distinct copies, specificity changes and atomic location moves, including concurrent moves.
  Planned deck changes must not move or reserve physical copies.
- **Pending imports:** verify save/reload, corrections versus late candidates, account changes and
  the A,A / A,B,A accepted-identity sequence. Unresolved candidates never advance that sequence.
- **Confirmation and provenance:** test competing confirmation, lost response plus identical retry,
  different input under the same operation ID, stale reviewed revisions and rollback on failure.
  Count created copies and verify recorded receipts and permanent source replay protection.
- **Source imports:** cover each supported format with representative fixtures, invalid rows,
  unresolved identities, repeated sources, changed quantities, duplicate lines and partial parsing
  failure. Verify provenance and require review before ownership changes.

### Search

Use fixed public/private fixtures for supported syntax and equivalent UI criteria. Cover supported
quoting, comparisons, combinations and negation, and explicit rejection of unsupported expressions.
Do not infer support for an operator merely because it exists in Scryfall.

Use real PostgreSQL for same-printing/copy predicates, multiple matching associations, translated
names, stable tie breakers, grouping before pagination, absent account context and changes between
pages. Verify a changed query, account or provider revision invalidates continuation. Inspect query
plans when assessing performance; do not replace correctness assertions with timing thresholds.

### Recognition

Run retained engine regression cases without changing expected matching outcomes. Exercise
preparation failure/retry, invalid images, no-card/multiple-card geometry, busy/unavailable results,
initial and late disagreement, completion, cancellation and disposal. Verify independent identity
call limits, whole-title evidence priority and representative-printing uncertainty. Validate model
and source-package hashes and notices separately from live inference and physical-device evidence.

### Application

Exercise actual HTTP boundaries with missing, invalid, expired and wrong-audience identity, two
accounts, malformed input and unavailable providers. Invalid identity must not reach private
operations. Supply alternative providers to verify composition and lifecycle behavior; check that
public settings and diagnostic failures contain no secrets or private record contents.

### UserInterface

- **Navigation:** cover deep links, reload, nested Back, focus/scroll/selection restoration,
  delayed responses and sign-out/account changes through observable browser behavior.
- **CardList:** control response ordering and independent fragment failure/retry. Use a large
  source to verify bounded requests/rendering, stable selection during enrichment and refinement,
  empty versus failed results, and independent state in two lists.
- **Browsing and organization:** cover filters, unsupported search expressions, recent cards,
  set browsing, all three detail levels, grouped-to-individual selection, tag rename, wishlist
  specificity, intended versus owned counts and physical-location changes.
- **Import and capture:** cover saved review reload, manual corrections, repeated confirmation,
  lost responses and actual copy counts. Test camera permission failure, cancellation, geometry,
  accepted-identity sequence, feedback and resource cleanup using supplied device capabilities.
  Record real mobile-camera acceptance separately.
- **Edit recovery and source UI:** verify unsaved corrections survive conflicts/failures, bulk tools
  retain explicit copy selection, import progress and row errors are visible, and source replay
  outcomes remain understandable after reload and confirmation recovery.

### Migration

Use representative synthetic legacy records for duplicates, missing printings, unknown attributes,
overallocated/multiple locations, pending entries and replay receipts. Verify ownership conservation
by account and printing attributes, tag/association meaning, provenance and account continuity.
Check stable reruns, dry-run non-mutation, conflict reporting and restoration from an isolated
backup. The migration document defines reconciliation and cutover acceptance.

## Integrated acceptance

Connect the implemented browsing, organization and import workflows with real providers and test
storage. Include account changes, concurrency, lost responses, late results, safe text rendering,
keyboard/touch navigation and recovery. Exercise the selected import methods; provider outages
must remain visible. Keep repeatable commands and evidence in the repository, with dataset/runtime
conditions for CardList, query and recognition measurements. Distinguish locally verified behavior,
live-provider evidence, physical-device evidence and production acceptance.

Workspace verification starts from a fresh Linux/WSL checkout: install locked dependencies, run the
documented checks, verify builds and demonstrate that an invalid cross-component import is rejected.
For packaging, infrastructure and release acceptance, follow the operations document's checks and
keep template/package verification distinct from live environment evidence.

## Writing tests

- Name the subject, condition and expected outcome. Keep setup, action and assertions easy to see.
- Keep fixtures small and declare the relevant values beside the scenario. Share helpers only when
  they simplify repeated setup without hiding what matters.
- Give each test its own mutable data. Restore mocks and timers; clean up resources even on failure.
- Control clocks and response ordering. Await asynchronous work and observable completion; avoid
  fixed sleeps. Exercise rejected promises and failures deliberately.
- Assert outcomes and meaningful effects. Avoid private-method assertions, incidental call order,
  broad snapshots and expected values calculated with the same logic being tested.
- Use coverage to locate neglected behavior. A percentage alone does not establish useful tests.

## Browser and recognition evidence

Browser tests interact through accessible roles, labels and visible behavior. Use explicit test IDs
where necessary and condition-based waits. Set up unrelated data directly so each journey stays
focused. Use isolated browser contexts and dedicated accounts for account-boundary scenarios.

Exercise keyboard, touch and browser-specific behavior where the changed interaction depends on
them. Visual comparisons serve targeted layout risks; review baseline changes deliberately.
Capture a trace or screenshot for diagnosis when a journey fails.

Recognition logic tests use controlled candidate responses. Model evaluation uses labeled image
fixtures and reports identity/printing accuracy, unresolved cases and latency separately. A saved
image fixture does not verify live camera capture, device performance or physical-card handling.

## Live boundaries and performance

Routine tests run without production credentials or paid provider calls. Use targeted checks in an
isolated AWS environment for Cognito authorization, IAM permissions, the Aurora Data API, deployed
routing and other changed AWS boundaries. Local PostgreSQL tests do not establish those properties.

Measure performance with declared dataset size and runtime conditions. For CardList, distinguish
time to basic information from time to enrichment. For catalog queries and recognition, distinguish
cold and warm runs. Keep benchmarks separate from deterministic correctness tests.

## Agent workflow

1. Identify the behavior being changed, its owner and a plausible failure before choosing a test.
2. Inspect existing coverage and extend the relevant test. For a bug, reproduce it at the smallest
   useful scope and verify the test fails for that reason before applying the fix when practical.
3. Run focused checks first. Broaden to affected boundaries, assembly or browser journeys only when
   they establish additional evidence. Documentation-only changes need document review and link checks.
4. Investigate failures. A passing retry does not explain a failure; do not weaken assertions, update
   baselines or skip tests merely to obtain a passing run.
5. Report the checks run, their outcome, relevant environment and remaining gaps. Distinguish local
   implementation, simulated tests, live verification and deployment.

Once the relevant risks are covered, stop. Additional test frameworks, large fixtures, repeated full
suite runs and tests that restate implementation or documentation require a concrete justification.
