# Rebuild requirements

Accepted means requested and queued. Local verification is distinct from production delivery.
Component documents own behavioral requirements and acceptance criteria. The testing architecture
owns verification guidance. Jira records execution status and links to those repository sections;
it does not supply requirements needed to rebuild the service.
Historical requirement IDs remain in the pinned reference revision and are not reused here.
The old implementation and its prescribed architecture are superseded by the approved rebuild design.

| ID          | Requirement and acceptance                                                                                                                                                                                                    | Status                                | Evidence / work                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| REBUILD-001 | Create an ordered, dependency-linked KAN implementation backlog covering the agreed architecture, with testable acceptance criteria.                                                                                          | Created and verified in Jira          | Task inventory: KAN-6 through KAN-32.                                                                                         |
| REBUILD-002 | Remove the old application implementation and tooling; retain authoritative design and a complete separate source reference, including recognition. Do not delete owner data or AWS resources.                                | Locally verified; not deployed        | Baseline revision 128c903ff109868acc854f0ff239c8c0f925d803 in magic-keeper-old; recognition reference and reset verification. |
| REBUILD-003 | Preserve recognition engine behavior, artifacts/manifests, fixtures and notices while allowing API/deployment boundary changes. Retained files must match their baseline and engine comparisons must pass before integration. | Baseline retained; integration queued | KAN-16, KAN-17, KAN-29.                                                                                                       |
| MIG-001     | Migrate the owner's collection, preserving per-account ownership totals and printing/language/finish/condition, tags, intended quantities, pending entries, provenance and replay protection.                                 | Accepted / queued                     | KAN-7, KAN-30, KAN-32.                                                                                                        |
| MIG-002     | Verify a consistent private backup by isolated restoration; dry-run reconciliation and repeat-safe conversion must pass before production migration.                                                                          | Accepted / queued; no backup claimed  | KAN-7, KAN-30.                                                                                                                |
| MIG-003     | Surface incompatible legacy locations and unresolved identity/attributes without silent loss or invented ownership. Enforce one location per copy only after explicit reconciliation.                                         | Accepted / queued                     | KAN-7, KAN-30.                                                                                                                |
| MIG-004     | Preserve Cognito account continuity, capture writes since the snapshot, and rehearse rollback. Production cutover requires explicit authorization and old storage is retained.                                                | Accepted / queued                     | KAN-32.                                                                                                                       |

## Documentation ownership

**DOC-001 — Documentation updated; implementation queued.** The repository must contain the behavior, acceptance criteria
and verification guidance needed to rebuild the agreed service. Jira tasks reference the relevant
sections and identify exclusions. Jira Rank records execution order and issue links record
dependencies; neither task text nor a copied repository schedule is authoritative for order.
Any requirement found only in a ticket must be discussed before adoption. This replaces the earlier
assignment of detailed acceptance criteria and test instructions to Jira.

Acceptance: every implementation task refers to repository sections that define its scope; task
descriptions contain no additional acceptance criteria or test instructions. Documentation covers
the accepted behavior without needing the removed ticket text. The task index is navigational.
Evidence is the repository review and verified Jira descriptions, not a claim of implementation.

## Approved scope refinements

| ID               | Requirement owner and acceptance                                                                                                                                                     | Status                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| BUILD-001        | Tech stack, Reproducible workspace: locked dependencies, fresh-checkout preparation, focused and aggregate checks, and Nexus command wiring. npm workspaces are not mandated.        | Accepted / queued                        |
| IMPORT-NEW-001   | UserCards, Source imports: pasted card lists, Moxfield decks and reviewed Wizards preconstructed lists become pending entries with provenance and explicit error/replay handling.    | Accepted / queued                        |
| UI-NEW-001       | UserInterface, Browsing and organization / Source imports: preserve edits on conflicts, expose source progress and row errors, and recover pending review and confirmation outcomes. | Accepted / queued                        |
| OPS-001          | Operations: reproducible artifacts, explicit deployment/rollback procedures and release evidence. No mandatory health/readiness endpoints.                                           | Accepted / queued                        |
| DELIVERY-NEW-001 | Operations, Rebuild delivery policy: CI and automatic deployment stay disabled; validation runs through repository commands and deployments are explicit.                            | Policy recorded; workspace checks queued |

These refinements were approved after comparing the Jira descriptions with repository documentation.
Their owning sections and the testing architecture define the behavior and verification; Jira adds
no further acceptance criteria.

## Queued product direction

**DELIVERY-LENS-001 — Accepted; enabling for Nexus execution.** Require the `Nexus Lens review`
check from the configured Nexus Lens GitHub App on main. Keep CI and automatic deployment disabled.
Acceptance: branch protection requires the named check from that App, and Nexus project/runtime
configuration names the same check and publisher. This supersedes removal of the Lens requirement
for the preparation phase.

Recommendations, trading/sales integrations and relevant news remain charter direction. Their
feature requirements are not yet specified and no delivery is claimed by this rebuild backlog.

## Clean rebuild workspace

**REBUILD-004 — Locally verified; not deployed.** Keep documentation, repository guidance and
Git/Nexus configuration in this repo. Recover implementation, recognition engines, fixtures,
models and licenses from the separate old baseline when their implementation tasks begin.
This supersedes retaining recognition implementation and tests in the rebuild checkout.

Move untracked local data, credentials and useful cached assets outside the working directory;
the Git reference alone does not back up these files. Keep AWS resources untouched.
Acceptance: no implementation or generated-asset directories remain in the working directory,
the old source reference is intact, and local runtime files remain recoverable outside it.
Verification: implementation directories are absent; magic-keeper-old remains at the pinned revision. Local runtime directories were moved to E:/projects/magic-keeper-local-backup, with unchanged hashes for the nine checked database/WAL/shared-memory files.
