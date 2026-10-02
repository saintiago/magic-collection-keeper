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
PGlite serves one connection, so a case that needs two writers at once runs beside the server
harness in `tests/support/postgres-server.ts`, which provisions a local PostgreSQL instance and
skips itself where the environment cannot start one.

## Contracts and cooperation

Each component's tests exercise its provider-owned public contract. Verify observable results and
required effects. Internal refactoring should not require rewriting those tests.

For a changed boundary, verify the consumer against actual provider output or run both together.
Cover the relevant successful result and failure semantics. Type checking and schema validation
establish shape compatibility; behavior needs assertions. Avoid independently invented fixtures
on both sides that agree with each other but differ from the implementation.

Contract and workflow describe what a test proves, not additional test layers. Keep cross-component
scenarios in integration or system tests according to their scope.

Verify each owner's query contract against its real storage and writes. Exercise CardList with
actual provider outputs: source membership remains unchanged by enrichment, and current private
fragments follow acknowledged or recovered commits without a background worker. Replacing an
owner's private tables or database deployment must not require consumer changes.

For supported Scryfall syntax, keep compatibility cases over a fixed catalog fixture. Verify that
text expressions and equivalent UI criteria select the same entries, preserve supported operator
semantics and reject unsupported expressions. Routine tests do not depend on live search results.

Run the same observable contract cases against replacement implementations. Include failure,
authorization, cancellation and retry behavior where the interface promises them.

## Keeper's main risks

| Owner         | Focused evidence                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog       | Card-to-printing resolution, complete basic information and reads independent of live provider requests.                                                                                                               |
| UserCards     | Stable copy identities; deck membership distinct from physical location and ownership; intended quantities independent of owned counts; card/printing refinement; import confirmation applies an explicit destination. |
| UserInterface | Replaceable screen modules, accessible presentation, retained drafts, opaque history and correct intent routing.                                                                                                       |
| CardList      | Basic information before optional fragments, independent failure/recovery, bounded loading, stable selection and restoration.                                                                                          |
| Capture       | Frame-correlated admission, bounded device work, authoritative staging outcomes and feedback.                                                                                                                          |
| Recognition   | Candidate interpretation, ambiguity and failure handling; recognition output cannot grant ownership.                                                                                                                   |
| Application   | Correct component wiring, rejection of invalid identity and enforcement of private access through every applicable backend entry point.                                                                                |

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
Exercise public queries and grants on real PostgreSQL; consumers must not read private tables or views.
Use small deterministic snapshots: malformed/interrupted ingestion preserves the previous revision,
retries do not duplicate identities, and concurrent readers see a coherent revision. Verify complete
atomic revision publication, removals and revision-bound query continuation. Removed provider
printings leave current query membership while historical resolution and printing-to-card mapping
remain available. Cover a refresh removing a printing before private reference preparation; subsequent
provider-contract resolution and repeat-safe backfill must preserve the saved records.

### UserCards

- **Copies and authorization:** use two synthetic accounts and real PostgreSQL to cover foreign
  references, missing context, read authorization, storage grants and connection reuse. Verify
  identity-preserving printing/finish/condition corrections, rollback and revision conflicts.
- **Tags and associations:** verify rename invariance, card/printing intended quantities, counts of
  distinct copies, specificity changes and atomic location moves, including concurrent moves.
  Competing claims of one tag target report a conflict, not an outage. Planned deck changes must not
  move or reserve physical copies.
  One copy may participate in several decks. Intended deck quantities can exceed ownership.
  Cover quantities larger than a request batch, including an imported deck requirement above 1000;
  provider batching must preserve the complete intended quantity.
- **Pending imports:** verify save/reload, corrections versus late candidates, account changes and
  the A,A / A,B,A accepted-identity sequence. Unresolved candidates never advance that sequence.
- **Confirmation and provenance:** test competing confirmation, lost response plus identical retry,
  different input under the same operation ID, stale reviewed revisions and rollback on failure.
  Count created copies and verify recorded receipts and permanent source replay protection.
  Accept a deck from names and quantities with no printing or owned copies: verify deck associations
  and zero ownership changes. Cover optional printing specificity, explicit ownership acquisition,
  destination changes under a reused operation identity, current reads and rollback for each outcome.
- **Source imports:** cover each supported format with representative fixtures, invalid rows,
  unresolved identities, repeated sources, changed quantities, duplicate lines and partial parsing
  failure. Verify provenance and require review before ownership changes.
- **Import identity:** two new imports with identical contents or source references remain separate
  lists and each applies its explicit destination. Retry, reopen and reconciliation within one
  import preserve its identity and do not duplicate its acquisitions. Cover lost responses and
  reload for pasted lists, Moxfield and reviewed Wizards sources.
- **Current queries:** complete confirmation/location changes, account-scoped revisions and deletion
  are immediately observable through new authoritative reads. Pending-only state is absent from
  ordinary lists and ownership fragments. Recovery returns the recorded domain outcome without
  another write.

### Owner queries and direct refresh

Catalog query cases cover the supported syntax and equivalent structured criteria over fixed
fixtures, translated names, same-printing predicates, duplicate matches, stable tie breakers,
grouping before pagination and revision-bound continuation. Unsupported expressions fail explicitly.

UserCards query cases use real PostgreSQL and two accounts. Verify collection/tag membership at
card/printing/copy levels, direct versus derived associations, exact owned/intended/location counts,
planned decks without ownership, pending exclusion, same-copy predicates and complete grouping/order
before pagination. Changed request/account/revision invalidates continuation; another account's
writes do not. Zero and successful absence remain distinct from unavailable reads.

After real commits and recovered outcomes, verify new authoritative list/fragment reads contain the
saved state with no worker or projection. Interrupt compatible reference upgrades and repeat them;
all existing identities, receipts, archives, intended quantities and ownership must remain exact.
Inspect query plans when assessing performance; timing thresholds do not replace correctness.

CardList integration verifies public membership with private enrichment and private membership with
batched public basics. Enrichment never changes membership, order, grouping or page boundaries.
Refresh affected private sources/fragments after commit, retain usable content while pending and
report failed refresh independently of save success. Fence late results across query/account changes.

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
public settings and diagnostic failures contain no secrets or private record contents. Background
job failure checks also require a safe stage and provider error classification/correlation identity
when available; raw exception text, SQL, response bodies and bound values must not appear.

### CardList

Exercise the [list contract](card-list.md#interface) without DOM or page code. Control response order
and fragment failures. Use a large source to establish bounded acquisition, selection beyond the
loaded window and independent instances. Cover retry versus sequence restart, failed restarts,
obsolete reads and account isolation. Use actual provider output to verify source/error translation.

Exercise retain/restore with available and delayed content, repeated interruption and user changes.
Selecting more than 100 entries must not be restricted by history storage. Verify explicit absent
targets, grouped-to-individual selection and local change invalidation without page repair callbacks.
Test basic-content availability independently of optional fragments.

### Capture

Exercise [capture admission and lifecycle](capture.md#admission-and-lifecycle) without screen code.
Use controlled devices and actual recognition output for local-only and hybrid paths. Cover geometry
and candidate frame correlation, permission/preparation failure, accepted-identity sequence, late
readings, lost staging responses, feedback identity and resource release. Preserve engine regression
outcomes. Record physical mobile-camera acceptance separately.

### UserInterface

Test each [UI module](ui/architecture.md#modules-and-composition) through its provided interface with
supplied capabilities. Module documents define replacement evidence. Focus browser tests on:

- **Navigation/Pages:** direct links, reload, nested Back, opaque retention, child lifetime and
  account changes. Test late factory results and interrupted restoration without decoding child state.
- **Error notices:** exercise the [notice contract](ui/navigation.md#error-notices): clear text and
  red indicator, dismiss/recovery controls, keyboard access, account cleanup and accurate wording
  for unknown write outcomes. A refresh failure must not imply a failed save.
- **CardViews:** safe and accessible rendering, partial/empty/failed states, viewport demand,
  bounded DOM, input mapping and focus/scroll application. No backend is needed to test a renderer.
- **Editors:** exact target context, unsaved drafts during submission or refresh, conflict feedback,
  unknown operation outcomes, source progress and reattachment through supplied handles.
- **CaptureControls:** preview, start/stop, provisional evidence and once-per-event cues; no staging
  decision or geometry rule is implemented by a presentation test fixture.

Keep integration journeys for cooperation: filters and unsupported expressions, recent cards, set
browsing, all detail levels, tag rename, wishlist refinement, distinct intended/owned counts and
physical-location changes. Import journeys cover saved review reload, source reconciliation,
confirmation/recovery, importing an unowned deck from names and actual copy counts for ownership
actions. Confirm that provider change invalidations refresh
affected lists while preserving drafts. Navigation away during a write must not invent a failure or
another import. These journeys do not replace individual provider contract tests.

### Client operation lifecycle

Verify UserCards attempt retention and recovery independently of UI: lost responses, reattachment
after reload, identical contents in distinct imports, account switching and revision conflicts.
Committed and recovered outcomes emit compatible local invalidations; unknown writes do not emit
speculative success. Tests of the transport alone cannot establish these domain guarantees.

### Migration

Use representative synthetic legacy records for duplicates, missing printings, unknown attributes,
overallocated/multiple locations, pending entries and replay receipts. Verify ownership conservation
by account and printing attributes, tag/association meaning, provenance and account continuity.
Check stable reruns, dry-run non-mutation, conflict reporting and restoration from an isolated
backup. Verify legacy deck quantities remain deck associations even when they exceed ownership,
without inventing owned copies or physical locations. [Collection migration](migration.md) owns
the mapping and execution gates.

## Component replacement checks

Exercise consumer entry points with implementations of provider-owned contracts, without constructing
the default provider or mocking its SQL. Cover result/error translation, trusted context and lifecycle.
Test the PostgreSQL composition separately with real storage. Supply a replacement browser recognition
factory and verify that UI access and disposal still use its contract.

Run the same provider behavior assertions against a proposed replacement. A substitute that merely
returns canned values proves a consumer seam, not provider equivalence. Verify current-query
behavior, read authorization, revision consistency and account scoping against real storage.
Boundary fixtures must reject private imports, forbidden dependency directions, cycles and
backend imports from browser presentation code, including type-only dependencies.

## Integrated acceptance

Connect the implemented browsing, organization and import workflows with real providers and test
storage. Include account changes, concurrency, lost responses, late results, safe text rendering,
keyboard/touch navigation and recovery. Exercise the selected import methods; provider outages
must remain visible. Keep repeatable commands and evidence in the repository, with dataset/runtime
conditions for CardList, query and recognition measurements. Distinguish locally verified behavior,
live-provider evidence, physical-device evidence and production acceptance.

Workspace verification starts from a fresh Linux/WSL checkout: install locked dependencies, run the
checks documented in [README](../README.md#checks), verify builds and demonstrate that an invalid
cross-component import is rejected.
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
