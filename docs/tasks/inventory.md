# Implementation task index

The repository owns requirements, acceptance criteria and test guidance. Jira tasks identify the
documented scope to implement and its exclusions. Jira Rank owns execution order; Blocks links
record dependencies. This index groups tasks by subject and does not prescribe execution order.

## Application and tooling

- [KAN-6: Establish the rebuild workspace and component test harness](https://malton-family.atlassian.net/browse/KAN-6)
- [KAN-18: Compose authenticated application services and transports](https://malton-family.atlassian.net/browse/KAN-18)

## Catalog

- [KAN-8: Implement Catalog identities, batch reads and public query views](https://malton-family.atlassian.net/browse/KAN-8)
- [KAN-9: Implement atomic catalog bulk synchronization](https://malton-family.atlassian.net/browse/KAN-9)

## Collection migration

- [KAN-7: Specify collection migration and verified backup/recovery](https://malton-family.atlassian.net/browse/KAN-7)
- [KAN-30: Provide an explicit migration path for existing collection data](https://malton-family.atlassian.net/browse/KAN-30)

## Deployment and release

- [KAN-27: Define isolated AWS infrastructure for the rebuild](https://malton-family.atlassian.net/browse/KAN-27)
- [KAN-28: Package backend, UI and catalog jobs for explicit deployment](https://malton-family.atlassian.net/browse/KAN-28)
- [KAN-29: Package preserved Recognition for AWS and browser delivery](https://malton-family.atlassian.net/browse/KAN-29)
- [KAN-32: Prepare release, migration and rollback acceptance](https://malton-family.atlassian.net/browse/KAN-32)

## Recognition

- [KAN-16: Package the preserved recognition engines and regression harness](https://malton-family.atlassian.net/browse/KAN-16)
- [KAN-17: Expose the Recognition lifecycle and candidate contract](https://malton-family.atlassian.net/browse/KAN-17)

## Search

- [KAN-14: Implement the Scryfall-compatible local query subset](https://malton-family.atlassian.net/browse/KAN-14)
- [KAN-15: Implement mixed Search, grouping and stable pagination](https://malton-family.atlassian.net/browse/KAN-15)

## UserCards

- [KAN-10: Implement UserCards physical-copy storage and account isolation](https://malton-family.atlassian.net/browse/KAN-10)
- [KAN-11: Implement tags, associations and physical locations](https://malton-family.atlassian.net/browse/KAN-11)
- [KAN-12: Implement pending imports, review and idempotent confirmation](https://malton-family.atlassian.net/browse/KAN-12)
- [KAN-13: Implement source-import parsing and reconciliation](https://malton-family.atlassian.net/browse/KAN-13)

## UserInterface

- [KAN-19: Build the UI shell, identity and history navigation](https://malton-family.atlassian.net/browse/KAN-19)
- [KAN-20: Build bounded asynchronous CardList and card tools](https://malton-family.atlassian.net/browse/KAN-20)
- [KAN-21: Build Home and catalog/search browsing](https://malton-family.atlassian.net/browse/KAN-21)
- [KAN-22: Build collection and card/printing/copy details](https://malton-family.atlassian.net/browse/KAN-22)
- [KAN-23: Build tags, wishlist, deck and location workflows](https://malton-family.atlassian.net/browse/KAN-23)
- [KAN-24: Build manual import, pending review and confirmation UI](https://malton-family.atlassian.net/browse/KAN-24)
- [KAN-25: Integrate hands-free camera capture and recognition review](https://malton-family.atlassian.net/browse/KAN-25)
- [KAN-26: Build source import UI and review recovery](https://malton-family.atlassian.net/browse/KAN-26)

## Verification

- [KAN-31: Verify the rebuilt component contracts and complete user journeys](https://malton-family.atlassian.net/browse/KAN-31)

## Handoff

- Publish the prepared main branch before Nexus uses the remote repository.
- Select the `keeper-rebuild` label and Jira Rank. Older KAN tasks are outside this queue.
- Draft tasks are not eligible for execution; To Do tasks are eligible once their prerequisites
  are complete. Rank does not itself enforce Jira dependency links.
- The documentation-only baseline has no application package or build. Workspace implementation supplies
  preparation and validation commands.
- Nexus currently requires a named review check in its project schema. The existing
  `delivery.reviewCheck` setting does not enable a GitHub branch requirement or CI workflow.
  Resolve the runner policy before launch if review-free delivery is required.
