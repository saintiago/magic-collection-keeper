# Motion Design

## Purpose and scope

Motion is part of the [UI design pillar](../PRODUCT-CHARTER.md#design-pillars). Give the collection
an arcane, game-like experience through responsive light, particles, depth and parallax, with a
consistent relationship between a user's action and what moves.

The [design language](design-language.md) owns visual foundations and controls. This document owns
how their presentation changes over time. Motion belongs to the mounted UI view; it presents
application state without creating business states or changing provider contracts.

Explore these rules in the local design-language page and mocked app. This contract does not
install a library, change production styling or establish that the motion has been implemented.

## Shared motion rules

Define reusable motion roles alongside the visual tokens. Components use those roles rather than
inventing a separate animation style for each screen. Each example identifies its trigger, initial
state, movement, final state and reduced-motion presentation.

| Interaction                | Motion and lasting feedback                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Hover or keyboard focus    | Light gathers around the target; a card may lift or tilt. Focus remains clearly visible.                                           |
| Press                      | The target compresses or briefly intensifies its light; a discrete action may release sparks.                                      |
| Selection                  | The selected card moves into emphasis while surrounding content recedes. A persistent mark remains.                                |
| Opening related content    | Preserve the selected object's visual identity as its detail presentation opens, so the destination feels connected to the source. |
| Loading or partial content | Use active energy or a spinner to show pending work. Keep already available content usable while other regions wait.               |
| Success                    | Motion settles into the confirmed state with readable outcome feedback.                                                            |
| Failure                    | Interrupt the pending presentation and expose readable error or validation feedback with the available recovery action.            |

Typing uses ordinary focus and value feedback; decorative bursts accompany deliberate actions rather
than every character. Hover enhancements are supplementary: keyboard and touch users can identify,
select and operate the same objects without hovering.

## Timing and depth

Use short control transitions around 120-180ms and entry or state transitions around 220-280ms as
initial baselines. Related transitions share easing and timing roles; demonstrate any longer object
movement in context before adopting it. User actions and observed application state trigger motion.
An animation ending never asserts that a provider operation has completed.

Keep a consistent depth hierarchy: atmosphere behind content, selected objects in emphasis, and
controls and text clearly readable. Background layers may move more slowly than foreground objects
for parallax. Tilt, glow and particles reinforce the target or state change without obscuring card
art, text, focus or controls. Reflow for the available screen; depth does not excuse clipping or
horizontal overflow. Dense collection content remains easy to scan.

Ambient particles and drifting reflections may establish the world's atmosphere. Their motion stays
secondary to interaction feedback. Avoid flashing and unnecessary layout movement.

## Inspection and accessibility

Inspect motion through the storybook's [manual state progression](storybook.md#manual-state-progression).
The workspace owns when mocked stages advance, how transient states remain inspectable and which
keyboard events consume Space.

Respect [reduced motion](https://www.w3.org/WAI/WCAG21/Understanding/animation-from-interactions):
remove parallax, tilt, transforms and nonessential particle or ambient animation. Keep clear static
hover, focus, pressed, selected, pending and outcome feedback, with the same available actions and
manual progression.

Dispose animation loops, pointer listeners and decorative rendering resources with their mounted
view. Hidden or disposed demonstrations cannot consume Space or update a replacement view.

[Testing](../testing.md#local-design-storybook) owns verification. The contract is independent of the
rendering or animation library; tooling choices must support these presentation and lifecycle rules.
