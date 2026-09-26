# Product charter

## Purpose

**Give life to your collection.**

Cards become possibilities: decks to build, strategies to explore, upgrades to discover, and trades that make something new possible. Organization is the foundation; bringing the collection into play is the purpose.

Every proposal must answer: **Does this help someone do something meaningful with their collection?** Organization builds trust in what the user owns. Recommendations reveal possibilities. New releases can spark ideas. Trading helps the collection evolve. Quality, security, accessibility, and performance make those actions dependable.

The owner is the first user. The intended audience is Magic collectors who want an easy, organized hobby, a dependable representation of physical cards, assistance building and improving decks, and help managing trades and sales. Broader demand and willingness to pay remain hypotheses.

## Connected jobs

1. Capture, correct, locate, and organize physical cards with minimal friction and accurate exact-printing, language, finish, condition, and quantity representation.
2. Use the owned and available collection for deck building, inspiration, and upgrades. Keep owned cards, assigned copies, pending imports, and suggested acquisitions distinct; explain suggestions and let the user decide.
3. Manage trading and sales across supported channels, potentially including Cardmarket.
4. Discover useful sets, card reveals, and Wizards news in ways connected to the user's cards and decks. Freshness, provenance, relevance, and user control are mandatory design inputs.

These jobs share card identities and private collection state. New features must account for affected search, navigation, quantities, tags, imports, and source-provenance workflows rather than becoming disconnected islands.

## Product and engineering principles

- Preserve exact physical ownership, source provenance, account isolation, and explicit confirmation. AI or provider output never grants ownership.
- Prefer cohesive modules, inward dependencies, plain-object ports, and the smallest solution that materially improves delivery or user value.
- Make asynchronous work bounded, cancellable, recoverable, and safe against late responses. Measure perceived and actual performance from an observed baseline.
- Treat accessibility, security, privacy, and corresponding-source obligations as product qualities. Automated tests are evidence, not a claim of complete physical-device or legal acceptance.
- Record requests with stable requirements, evaluate alternatives candidly, and preserve explicit owner decisions. A justified defer or no-action result is valid.

## Sustainable operation

Monetization must not contradict the charter or damage trust and task completion. Prefer durable value over short-term revenue; an early objective is to cover measured app-operation and development costs without weakening quality, security, accessibility, or performance.

No revenue model, price, marketplace partnership, research cadence, or human-time valuation is selected. Product operating cost, development cost, app revenue, and the owner's own card-sale proceeds must remain separate. Estimates and unknowns must be labeled and use a consistent accounting period.
