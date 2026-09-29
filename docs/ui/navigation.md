# Navigation

## Responsibility

Own routes, shell navigation, mounted page lifetime and retained history entries.

## Interface

Provide route opening, Back, current-route observation and disposal. Receive a registry of page
factories from UI composition and account access from [Application](../application.md). Each factory
implements the Navigation-owned page contract:

| Operation                                 | Meaning                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Mount(route, host, navigation, retained?) | Render into the supplied host; begin restoration if state is available.                     |
| Retain()                                  | Return an opaque handle for relevant page context, including restoration still in progress. |
| Observe lifecycle                         | Report restoring, ready or interrupted; readiness does not mean all data is loaded.         |
| Dispose()                                 | Release mounted resources and prevent further rendering.                                    |
| Release(retained)                         | Release a retained handle without remounting its page.                                      |

[Pages](pages.md) implements this contract. Factory loading can be asynchronous. An obsolete route
load cannot mount after a newer navigation or account change. A retained handle is meaningful only
to its owning factory and account; Navigation does not serialize its contents itself.

Receive [Search](../search.md#freshness)'s account-scoped observable indexing status through supplied
composition. The shell presents that status; it does not compare publication positions, load card
contents or implement polling. Disposing the account scope removes its subscription and notice.

Expose a notice capability to Pages for showing, updating and dismissing an identified notice with
severity, user-facing text and an optional action. The reporting view supplies the message and action
from its provider's outcome; Navigation owns presentation only. Update an existing notice for the
same operation rather than creating duplicates. Recovery callbacks belong to the reporting page's
mounted lifetime. On departure, keep the notice text and dismiss control but remove those callbacks;
a newly mounted page can supply recovery again when it reports the operation.

## Internal design

- **Route resolution:** parse and construct supported URLs and choose the registered factory.
- **Shell:** persistent navigation, account controls and route-level loading or unavailable feedback.
- **Page lifetime:** mount one active page, dispose the departed one and fence late factory results.
- **History retention:** associate routes with opaque handles and release evicted entries.

URLs carry enough context for direct entry and reload. Reload without retained state opens the
identified activity normally. Back restores retained context when available. Repeated navigation
during restoration must retain the intended context rather than an incomplete loading snapshot.

Retained history has bounded lifetime. Eviction removes an old history entry's resources; it cannot
truncate an active selection or reject unrelated form state. Account changes dispose the active
private view and release that account's retained presentation state. Authentication decisions remain
behind the supplied access capability.

## Indexing notice

Show one floating, non-blocking toast with a spinner and **"Indexing your cards…"** while known saved
changes await indexing. Keep it visible across page navigation and combine concurrent changes into
the same notice. It means the save succeeded and search results are catching up.

Remove the notice when all tracked changes are incorporated. If progress reports delayed or failed,
replace the spinner with an explicit **"Indexing is delayed"** or **"Indexing failed"** message and
a status retry action. Retrying checks progress; it never repeats the original write. Do not invent
percentages or leave a spinner indefinitely after progress has failed.

The toast does not block controls or steal focus. Announce meaningful status changes politely to
assistive technology; the text conveys progress without relying on animation. Account changes clear
the old notice and fence late updates. A failed save does not produce an indexing-success implication.

## Error notices

Reuse the floating toast presentation for errors, with red styling, an error indicator and clear
text. Color alone must not carry the meaning. Stop any progress spinner when an operation reports
failure. Keep the notice non-blocking and accessible, with an explicit dismiss control and a relevant
recovery action when supplied.

Use error toasts for operation and service failures. Keep field-validation messages beside their
fields and row-specific import errors beside their rows so users can locate and correct them.
Preserve drafts. Unknown write outcomes must say that saving could not be confirmed, rather than
claiming the write failed; recovery actions follow the reported outcome.

## Replacement evidence

A replacement accepts existing page factories unchanged. Test direct entry, nested Back, delayed
factory resolution, interrupted restoration, history eviction and account switching with opaque
test handles whose contents are inaccessible to the navigation implementation.

With supplied progress states, verify one notice across navigation and concurrent changes, completion
removal, delayed/failed presentation, status-only retry and account isolation. No indexing worker or
database is needed to verify this presentation.

Verify red error styling with a textual indicator, dismiss/recovery controls, preserved drafts and
accurate wording for unknown outcomes. Presentation must not infer that an uncertain write failed.
