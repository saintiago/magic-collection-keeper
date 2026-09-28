# Capture

## Responsibility

Own a live camera session: device acquisition, frame scheduling, admission into pending review and
attempt feedback. Keep this workflow independent of a screen and of recognition engine internals.

## Interface

Provide [UserInterface](ui/architecture.md) with prepare/start, stop, retry, observe and dispose.
Construction binds one account and import identity; changing that binding ends the old session.
Expose a preview attachment capability, status, provisional readings and identified feedback events.
Observe returns current state then updates; disposing suppresses later delivery. Stopping capture
releases live device work; disposing additionally releases session subscriptions/resources.

Use [Recognition](recognition.md) for preparation, frame-correlated geometry evidence, candidates
and later readings. Use [UserCards](user-cards.md) for staging, accepted-attempt identity, candidate
attachment and recorded outcomes. Receive these capabilities and runtime settings from
[Application](application.md). Preserve [recognition engine behavior](recognition-preservation.md).

Geometry and identity evidence must refer to the same capture/frame. The public geometry result
distinguishes single-card, no-card, multiple, ambiguous and unavailable/unknown. An engine path that
cannot provide geometry must use an available geometry capability or report that admission is not
ready; identity confidence is not a substitute. Geometry provision is an interface boundary change,
not permission to retune the preserved matching engines.

Successful staging produces an accepted-into-review event with attempt and pending-entry identity.
An unknown staging outcome is recoverable through the same UserCards operation; do not create another
attempt to guess whether it committed. No capture operation confirms ownership.

## Internal design

| Unit                 | Responsibility                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Device session       | Permission, stream/preview attachment, frame acquisition and release.                             |
| Frame scheduler      | Stability, bounded in-flight work and attempt/frame identity.                                     |
| Admission            | Require affirmative single-card geometry and a usable candidate for the same frame.               |
| Staging coordination | Submit eligible evidence, attach later readings and observe the admission outcome.                |
| Feedback             | Identified provisional, uncertain, accepted and failed events; bounded repeated cues per attempt. |

Device APIs are private behind a replaceable device capability. Test with supplied frames without a
browser camera. Device state and workflow state have separate lifetimes; no rendering dependency is
needed to run the session. Stored pending records, review decisions and accepted-identity sequencing
remain with the staging capability, not a parallel capture database.

## Admission and lifecycle

Ordinary capture is hands-free after activation. Stable imagery alone is insufficient: missing,
unknown or unavailable geometry never admits a frame, nor do no-card, multiple-card or ambiguous
results. Apply the same rule to local-only and hybrid inference. Unresolved identity produces no
success cue. Later candidates preserve disagreement and cannot overwrite reviewed fields.

Retain one attempt's identity while its result is pending or being recovered. Stop scheduling on
pause, departure or account change; release camera resources and suppress stale feedback. An already
submitted write may still commit. Its outcome remains attached to the original import and account,
and is recovered through its owning operation rather than a new live session's state.

Load device and inference resources on demand. Bound frame memory and concurrent inference; discard
unused frames and never retain raw images as navigation state or diagnostics. Preparation failure
does not prevent browsing or reviewing already pending entries.

## Replacement evidence

Run the session without UI using supplied devices and provider contracts. Cover permission failure,
late frames, geometry/identity correlation, provisional updates, unknown staging outcomes, accepted
feedback, stop/dispose and account changes. A different capture implementation must preserve pending
admission behavior and the retained engine regression results.
