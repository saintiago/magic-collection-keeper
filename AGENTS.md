# Repository guidance

## Core design principles

Apply these principles when shaping documentation, requirements, workflows, architecture, code and tests.

- **KISS:** Prefer the simplest design that meets the need and is easy to understand, debug and
  maintain.
- **DRY:** Give each rule or contract one authoritative home. Extract repeated behavior only
  when the cases share a responsibility.
- **YAGNI:** Add a capability, setting, state or extension point only when a current requirement
  needs it.
- **Avoid premature optimization:** Require evidence of a bottleneck before adding performance
  complexity to an architecture or implementation.
- **Composition over inheritance:** Assemble focused behaviors through components and delegation
  instead of deep inheritance hierarchies. Use inheritance when a genuine subtype relationship is
  simpler; avoid components that add no clarity.

Account for the full cost of a design choice: implementation, validation, failure handling,
persistence, tests, documentation and maintenance. Even a small field can create obligations across
components. When removing a mechanism, remove its dependent validation, state and tests.

Keep specialized guarantees within the component or action that needs them.

## Low coupling and high cohesion

Keep related state and decisions within the owning component.

Components depend on provider-owned public contracts. Compatible internal changes should not force
consumer changes; routine coordinated redesign indicates a boundary problem.

Each component architecture is independent. Its interface section is the only place that names other
components, imports their contracts or defines interaction with them. Its internal design uses its
own responsibilities and state. System composition and flows belong in the high-level architecture.

Contract tests verify individual boundaries. Integration and workflow tests verify cooperation.
A multi-component flow does not create a special shared contract.

## SOLID principles

Apply these to component responsibilities and public contracts as well as code.

- **Single Responsibility:** Give a component, module or action one coherent reason to change.
- **Open/Closed:** Keep stable public contracts when adding a supported variation; change the
  design directly when that is simpler than an extension mechanism.
- **Liskov Substitution:** Any alternative implementation must honor the behavior promised by its
  public contract.
- **Interface Segregation:** Let consumers depend only on the focused capabilities they use.
- **Dependency Inversion:** Make policy depend on owned public contracts at external boundaries,
  not on concrete providers.

## Documentation references

The repository owns requirements, acceptance criteria and test guidance. Keep each rule in its
owning document. Jira tasks reference the relevant document sections and identify scope exclusions;
they do not define additional behavior or test instructions. Jira Rank owns execution order and
issue links record dependencies. Discuss undocumented requirements with the owner before adopting
them; an existing ticket or old implementation does not establish a requirement.

All documents in `docs/` are relevant to the rebuild.

- [Product charter](docs/PRODUCT-CHARTER.md)
- [Architecture](docs/architecture.md)
- [Application](docs/application.md)
- [UserInterface](docs/user-interface.md)
- [Catalog](docs/catalog.md)
- [UserCards](docs/user-cards.md)
- [Search](docs/search.md)
- [Recognition](docs/recognition.md)
- [Tech stack](docs/tech-stack.md)
- [Testing architecture](docs/testing.md)
- [Build and release operations](docs/operations.md)
- [Rebuild requirements](docs/requirements.md)
- [Collection migration](docs/migration.md)
- [Recognition baseline](docs/recognition-preservation.md)
- [Implementation task inventory](docs/tasks/inventory.md)

Search reference:

- [Scryfall search syntax](https://scryfall.com/docs/syntax)

Testing background:

- [JavaScript testing best practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- [Test pyramid](https://martinfowler.com/bliki/TestPyramid.html)
- [Playwright best practices](https://playwright.dev/docs/best-practices)
