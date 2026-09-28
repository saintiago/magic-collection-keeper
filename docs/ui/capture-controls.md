# CaptureControls

## Responsibility

Present the preview, capture controls, progress and feedback. Translate user intent without making
admission or matching decisions.

## Interface

Receive a [Capture](../capture.md) public factory and an existing import identity. Own the session
instance created for this mounted view. Observe its preview capability, status, provisional
readings and feedback events; forward start, stop and retry commands. Provide [Pages](pages.md) with
mount and dispose. A preview capability can be attached to a display surface without handing image
analysis or device lifecycle to the view.

Render accepted-into-review, uncertain and failed outcomes as provided. Use the session's event
identity to present a cue once; displaying an initial snapshot is not a new acceptance event.
Corrections and confirmation use [Editors](editors.md), composed by the page, not this module.

## Presentation and lifetime

Make permission failure and unavailable devices actionable. Show provisional candidates,
disagreement and uncertainty without presenting a suggested printing as certain. Keep controls
usable while preparation or inference is running. Provide accessible visible feedback alongside
sound or other device feedback.

A success cue means accepted into pending review, never confirmed ownership. Do not derive success
from a candidate's confidence or from frame stability. Repeated rendering cannot repeat cues.

Disposal detaches preview, unsubscribes and disposes the session through its public contract,
releasing device work. Retained navigation state contains no live preview or stream;
returning to a page does not silently reactivate a camera.

## Replacement evidence

Drive the view with a supplied session covering preparing, denied, observing, uncertain, accepted
and failed states. Verify commands, preview detachment, feedback identity and late-event suppression.
Device admission and staging behavior are tested outside presentation.
