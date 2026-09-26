# Implementation task inventory

Jira owns task scope, acceptance criteria, progress and evidence. This index records the intended
execution order and direct prerequisites. Tasks are ranked in this order and linked with Blocks.
They are currently Draft; moving a task to To Do makes it eligible for Nexus after publication.

| Order | Task                                                                                                                           | Prerequisites                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 1     | [KAN-6: Establish the rebuild workspace and component test harness](https://malton-family.atlassian.net/browse/KAN-6)          | None                                  |
| 2     | [KAN-7: Specify collection migration and verified backup/recovery](https://malton-family.atlassian.net/browse/KAN-7)           | KAN-6                                 |
| 3     | [KAN-8: Implement Catalog identities, batch reads and public query views](https://malton-family.atlassian.net/browse/KAN-8)    | KAN-6                                 |
| 4     | [KAN-9: Implement atomic catalog bulk synchronization](https://malton-family.atlassian.net/browse/KAN-9)                       | KAN-8                                 |
| 5     | [KAN-10: Implement UserCards physical-copy storage and account isolation](https://malton-family.atlassian.net/browse/KAN-10)   | KAN-8, KAN-7                          |
| 6     | [KAN-11: Implement tags, associations and physical locations](https://malton-family.atlassian.net/browse/KAN-11)               | KAN-10                                |
| 7     | [KAN-12: Implement pending imports, review and idempotent confirmation](https://malton-family.atlassian.net/browse/KAN-12)     | KAN-11                                |
| 8     | [KAN-13: Implement source-import parsing and reconciliation](https://malton-family.atlassian.net/browse/KAN-13)                | KAN-12                                |
| 9     | [KAN-14: Implement the Scryfall-compatible local query subset](https://malton-family.atlassian.net/browse/KAN-14)              | KAN-8                                 |
| 10    | [KAN-15: Implement mixed Search, grouping and stable pagination](https://malton-family.atlassian.net/browse/KAN-15)            | KAN-9, KAN-11, KAN-14                 |
| 11    | [KAN-16: Package the preserved recognition engines and regression harness](https://malton-family.atlassian.net/browse/KAN-16)  | KAN-6                                 |
| 12    | [KAN-17: Expose the Recognition lifecycle and candidate contract](https://malton-family.atlassian.net/browse/KAN-17)           | KAN-8, KAN-16                         |
| 13    | [KAN-18: Compose authenticated application services and transports](https://malton-family.atlassian.net/browse/KAN-18)         | KAN-12, KAN-15, KAN-17                |
| 14    | [KAN-19: Build the UI shell, identity and history navigation](https://malton-family.atlassian.net/browse/KAN-19)               | KAN-6, KAN-18                         |
| 15    | [KAN-20: Build bounded asynchronous CardList and card tools](https://malton-family.atlassian.net/browse/KAN-20)                | KAN-19                                |
| 16    | [KAN-21: Build Home and catalog/search browsing](https://malton-family.atlassian.net/browse/KAN-21)                            | KAN-15, KAN-20                        |
| 17    | [KAN-22: Build collection and card/printing/copy details](https://malton-family.atlassian.net/browse/KAN-22)                   | KAN-11, KAN-20                        |
| 18    | [KAN-23: Build tags, wishlist, deck and location workflows](https://malton-family.atlassian.net/browse/KAN-23)                 | KAN-11, KAN-22                        |
| 19    | [KAN-24: Build manual import, pending review and confirmation UI](https://malton-family.atlassian.net/browse/KAN-24)           | KAN-12, KAN-22                        |
| 20    | [KAN-25: Integrate hands-free camera capture and recognition review](https://malton-family.atlassian.net/browse/KAN-25)        | KAN-17, KAN-24                        |
| 21    | [KAN-26: Build source import UI and review recovery](https://malton-family.atlassian.net/browse/KAN-26)                        | KAN-13, KAN-24                        |
| 22    | [KAN-27: Define isolated AWS infrastructure for the rebuild](https://malton-family.atlassian.net/browse/KAN-27)                | KAN-18                                |
| 23    | [KAN-28: Package backend, UI and catalog jobs for explicit deployment](https://malton-family.atlassian.net/browse/KAN-28)      | KAN-9, KAN-21, KAN-23, KAN-26, KAN-27 |
| 24    | [KAN-29: Package preserved Recognition for AWS and browser delivery](https://malton-family.atlassian.net/browse/KAN-29)        | KAN-25, KAN-27                        |
| 25    | [KAN-30: Provide an explicit migration path for existing collection data](https://malton-family.atlassian.net/browse/KAN-30)   | KAN-13, KAN-23, KAN-7                 |
| 26    | [KAN-31: Verify the rebuilt component contracts and complete user journeys](https://malton-family.atlassian.net/browse/KAN-31) | KAN-28, KAN-29, KAN-30                |
| 27    | [KAN-32: Prepare release, migration and rollback acceptance](https://malton-family.atlassian.net/browse/KAN-32)                | KAN-31                                |

## Scope

This backlog implements the agreed six-component architecture and current collection workflows.
Collection migration is required for release. Product-charter ambitions for recommendations,
trading integrations and news need their own requirements before implementation; they are not
silently included in these tickets.

## Handoff

- Publish the prepared main branch before Nexus uses the remote repository.
- Use the `keeper-rebuild` label and Rank order; older KAN tasks are outside this queue.
- Start with KAN-6. It supplies the replacement toolchain and restores meaningful preparation and
  validation commands; the source-only baseline has no application package or build.
- Complete prerequisites before dependent work. Rank orders selection; it does not itself enforce
  completion of Jira Blocks links.
- Keep owner data, credentials and model caches out of Git. Source removal does not remove existing
  AWS resources or migrate the collection.
- Nexus currently requires a named review check in its project schema. The existing
  `delivery.reviewCheck` value remains runner configuration; this reset adds no GitHub branch
  requirement or CI workflow. Resolve that runner policy before launch if review-free delivery is
  required. Post-merge deployment checks have been removed with the old workflows.
