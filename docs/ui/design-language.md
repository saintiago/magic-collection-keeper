# Design language

## Direction and scope

The local design workspace explores a visual language inspired by the official
[Reality Fracture artwork](https://magic.wizards.com/en/products/reality-fracture),
[Shattered Mirror treatments](https://magic.wizards.com/en/news/feature/collecting-reality-fracture)
and [fractured alternate worlds](https://magic.wizards.com/en/news/magic-story/planeswalkers-guide-to-reality-fracture).
Our interpretation uses midnight blue, icy cyan magic, violet reflected light, pale stone and
angular mirror facets. The target experience is a living arcane collection: glow, particles, depth
and parallax belong to one coherent interaction language. Create an original collection interface,
without reproducing set artwork, characters, logos or card frames.

## Application adoption

Apply the current main storybook's Reality Fracture colors, typography, controls, screen styling and
implemented interaction feedback to the application. UserInterface owns one shared presentation
stylesheet and its semantic tokens, loaded by both the application and storybook entry points.
Keep storybook toolbar and gallery styles local to the workspace.

The deployable browser artifact includes and loads the shared stylesheet and any assets it directly
uses. Gallery-only assets, mock card images, fixtures and manual progression remain local. Styling
must also cover the real application's sign-in and signed-out presentations.

This promotion preserves workflows, provider contracts, authentication and asynchronous completion.
It carries the existing presentation into the app; the separate game-concept page and further motion
studies are outside this change. Automatic saving, runtime UI replacement and a theme picker remain
outside scope. Frontend deployment follows the normal release boundary.

## Foundations

Define semantic CSS custom properties in the shared presentation stylesheet; component rules consume them
instead of repeating color literals. Keep preset values separate from component rules so another
palette can be evaluated later without rewriting components. The current design has one preset.

| Role           | Value     | Use                                           |
| -------------- | --------- | --------------------------------------------- |
| Canvas         | `#07131f` | Quiet midnight background                     |
| Surface        | `#102332` | Panels and form groups                        |
| Raised surface | `#163346` | Active controls and elevated content          |
| Primary text   | `#eef5f8` | Headings and body text                        |
| Secondary text | `#9eb6c6` | Supporting labels                             |
| Primary accent | `#77deed` | Main actions, focus and selected state        |
| Echo accent    | `#b7a0ed` | Secondary emphasis and decorative reflections |
| Success        | `#8ad5b3` | Confirmed local outcomes                      |
| Warning        | `#edc78a` | Pending or cautionary feedback                |
| Error          | `#f39aa5` | Failure and invalid input                     |

Use dark text on filled accent buttons. Separate decorative panel borders from sufficiently visible
interactive boundaries. Text meets 4.5:1 contrast, large text and meaningful control boundaries 3:1.
Never depend on color alone to distinguish status.

Use a locally available serif display stack such as Georgia for expressive headings, with system
sans-serif body text and controls. Keep small labels readable, body text around 16px and numeric
counts aligned with tabular figures. Use a consistent spacing scale based on 4px, generous section
separation, restrained rounded panels and subtly faceted decorative edges. Do not clip text or
controls into shards. Keep dense collection content calm and easy to scan.

The original [atmosphere asset](design-assets/README.md) supports the showcase hero or outer canvas.
Keep it away from dense reading and input surfaces; use an opaque or darkened text background.
Fonts, images and icons are served locally. Official research images are references, not runtime assets.

## Showcase and shared presentation

Make the design-language page a coherent, responsive reference with an atmospheric introduction,
clear section hierarchy and examples of typography, semantic colors, spacing, buttons, links,
fields, selection controls, card views, empty states, validation, notices and confirmation dialogs.
Demonstrate applicable default, hover, focus, pressed, selected, disabled, loading, success and error
states using the application's actual presentation helpers. Style the same shared controls in the
mocked app so the workflow from design language to local screens is inspectable.

Examples must work: enabled buttons, form submissions, selections, retry controls and dialog actions
produce visible local feedback. Use isolated demonstration state; avoid changing the mocked app's
collection through gallery examples. Give disabled controls a visible reason. Validation stays next
to the input. Feedback must describe the action and its outcome, not just animate a decoration.
Keep keyboard semantics, visible focus, dialog focus restoration and touch use intact. Controls have
comfortable touch targets around 44px. Reflow on narrow screens without horizontal overflow.

## Interaction and motion

Every enabled user action gives immediate feedback. Interactive elements visibly respond to hover,
keyboard focus and press. Selection remains visibly marked after its transition ends. Typing and
changing a field show normal focus and value feedback.

[Motion Design](motion-design.md) owns movement, timing, depth, particles, parallax and the
presentation of transitions. It is part of UI design and follows the same semantic colors,
typography, controls and accessibility rules. Demonstrate the shared motion rules in the
design-language page and then in the mocked app.

[Testing](../testing.md#local-design-storybook) owns verification. [Storybook](storybook.md) owns
mock isolation and manual state progression; these design documents own presentation.
