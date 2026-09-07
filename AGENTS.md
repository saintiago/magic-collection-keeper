# Repository guidance

- Read README and the relevant architecture/use-case/operations section before edits. Preserve the owner's data and the separate test profiles.
- Keep dependency direction inward: transports and adapters depend on application/domain, never the reverse. Compose concrete adapters in `server.js` and `cloud.mjs`.
- Keep inventory ownership separate from cached catalog printings. Derive cloud owner from verified JWT only. Preserve quantity bounds, exact-printing language/finish rules and idempotency.
- Tag labels are editable metadata, never structural keys. Keep location quantities separate from owned totals; a shortfall is an inline reminder and must not block edits or discard assignments. Preserve source provenance, loose copies and permanent source-import idempotency.
- Prefer cohesive named functions and plain-object ports. Do not introduce framework layers or generic abstractions without an actual replacement/test seam. Split growing controllers from pure rendering and I/O.
- Scryfall search is currently 2 requests/second; keep the shared limiter, 24-hour cache and 429 cooldown. Recheck official guidance when changing provider behavior. Use bulk data for large ingestion.
- Camera recognition is fallible. Preserve candidate review, explicit ownership confirmation and safe handling of consecutive identical physical cards. Do not label simulated or mocked camera results as physical-device verification.
- Escape untrusted text in HTML. Never place credentials in source, public config, screenshots, logs or artifacts. Tests must not use the owner's account.
- Add/update traceable use cases and meaningful E2E tests for changed controls, failures and persistence. Run unit, browser, build and deployed tests appropriate to the change; local mocks do not prove cloud correctness.
- Format changed JS/CSS/HTML with Prettier. Keep docs synchronized with actual implementation and acknowledge unverified hardware/provider behavior.
- Deploy application changes through the existing main workflow. Infrastructure uses isolated CloudFormation resources and administrator review; do not widen the CI role or touch pantry resources casually.
