# Pages

## Responsibility

Compose one screen around an activity. Own layout, route context, active sections and child lifetimes.

## Interface

Implement [Navigation](navigation.md)'s page lifecycle. Receive factories and narrow public
capabilities through UI composition. Compose [CardViews](card-views.md), [Editors](editors.md) and
[CaptureControls](capture-controls.md). Pass [CardList](../card-list.md) descriptions to card views;
forward route changes and explicit query input without evaluating them.

Use [UserCards](../user-cards.md) for import/tag resource references and non-card metadata. Cards,
printing choices and pending entries are displayed through list instances. Pass the existing import
identity to capture controls. Observe [Application](../application.md)'s
account state for presentation. Pages neither construct clients nor wrap providers with new policies.

Child views expose navigation/action intents, retained handles and lifecycle status. Translate an
open-card intent into a details route, or pass an explicit selected-target context to an editor.
Do not infer selected targets from visible rows. Compose retained handles without reading them.

## Page map

| Page           | Composition and route context                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| Home           | Recent-card list and navigation to collection, search and import.                                        |
| Catalog/search | Query controls, set context and results list.                                                            |
| Collection     | Owned-card/copy list, filters and explicit-selection edit tools.                                         |
| Tags           | Tag metadata and create/rename controls; opening a tag leads to its own page.                            |
| Tag view       | Tag identity, its card list and the applicable organization editors.                                     |
| Card details   | Typed card/printing/copy target, detail presentation and related printings/copies lists.                 |
| Import         | Import identity, source/manual controls, pending list, review/confirmation editors and capture controls. |

Each page is a small factory with a mounted lifetime. Shared composition is extracted only when it
has the same responsibility. An import screen does not implement source parsing, capture admission,
confirmation transactions or recovery by arranging callbacks around its children.

## State and lifetime

Keep page-local layout and form placement. Independent regions can mount and fail independently.
Retain child handles and page-local context; delegate restoration to the children. Report completion
when their restoration has completed or been explicitly interrupted, not when every image arrives.
New user intent supersedes the affected restored context without freezing future retention.

Dispose every mounted child and subscription on departure. No card-content arrays, continuation
tokens, write receipts or camera frames belong in page state. Resource metadata loading may update
a heading; it must not become a second way to load card contents.

## Replacement evidence

Replace a page factory without changing navigation or child modules. With supplied child views,
verify route context, layout, intent routing and retain/dispose delegation. Content-loading and
business-outcome tests belong to their providers.
