# Testing architecture

## Choosing test scope

Test documented behavior at the smallest scope that can reliably expose the relevant failure.
Use many focused tests, fewer integration tests and a small set of complete journeys. The pyramid
guides feedback cost and confidence; it does not impose test counts or percentages.

| Scope | Real parts | What it proves |
| --- | --- | --- |
| Unit | A focused rule or transformation. | Decisions and edge cases that need no assembled component. |
| Component | A component through its public contract, with its internal logic assembled. | Its observable promises under successful and failed dependencies. |
| Integration | The components or infrastructure boundary involved in a specific interaction. | Compatibility, query semantics, persistence and other effects that substitutes cannot establish. |
| System journey | Browser, assembled application and test storage. | A user can complete an important task across the system. |

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

## Keeper's main risks

| Owner | Focused evidence |
| --- | --- |
| Catalog | Card-to-printing resolution, complete basic information and reads independent of live provider requests. |
| UserCards | Stable copy identities; distinction between desired quantities and physical counts; card/printing refinement; pending entries excluded from ownership until confirmation. |
| Search | Mixed catalog and private filters, ordering and pagination over the complete result, without duplicate counts or another user's entries. Use real database queries. |
| UserInterface | Basic information before optional fragments, partial failures, empty versus unavailable results, stale responses after query/navigation/account changes, and preserved interaction context. |
| Recognition | Candidate interpretation, ambiguity and failure handling; recognition output cannot grant ownership. |
| Application | Correct component wiring, rejection of invalid identity and enforcement of private access through every applicable backend entry point. |

Keep detailed variations with their owner. Use a few system journeys to connect them: find a card
and add it to a wishlist; review an import, confirm copies and verify persistence; assign a copy to
a location and inspect the resulting count. Select journeys affected by the change.

Migration tests use representative synthetic legacy records and verify resulting copy counts,
associations, account ownership and provenance. Tests never modify the owner's collection.

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
