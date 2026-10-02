# Product requirements

This directory defines who the app serves and the journeys they should be able to complete.
Journeys are units of design and the basis for E2E suites. We will refine these initial definitions
iteratively.

- [User categories](user-categories.md)
- [User journeys](user-journeys.md)

Categories and journeys have a many-to-many relationship. Each journey includes its purpose and
intended outcome; needs are not a separate layer.

Traceability: **user categories ↔ journey requirements → acceptance criteria → E2E scenarios**.
Requirements and architecture remain separate, without cross-links.

## Stable IDs

Use `USER-NNN` for categories, `REQ-NNN` for product requirements and `ARCH-NNN` for architecture
sections or decisions. IDs remain stable when wording, order or file location changes; do not reuse
retired IDs. New entries take the next unused ID in their prefix. Existing requirement IDs remain
valid.

The [product charter](../PRODUCT-CHARTER.md) owns product direction. These initial journeys do not
expand the delivery scope recorded in [rebuild requirements](../requirements.md). Detailed journey
acceptance criteria and E2E scenarios will be added later.
