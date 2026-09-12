# Product charter

Revision 3 — September 12, 2026. Source: the owner's product-direction, audience, approved purpose and monetization-priority statements in this conversation. This records intended direction, not implemented capability, market validation or a launch commitment. Requirement mapping: PRODUCT-01–08 in REQUIREMENTS.md.

## Audience and purpose

**Give life to your collection.**

Cards become possibilities: decks to build, strategies to explore, upgrades to discover, and trades that make something new possible. Organization is the foundation; bringing the collection into play is the purpose.

The harness must evaluate every feature with this question: **Does this feature help someone do something meaningful with their collection?** Organization builds trust in what the user owns. AI reveals possibilities. New releases spark ideas. Trading helps the collection evolve. Quality, security and performance improvements support this purpose by making those actions dependable.

The owner is the first user. Serve Magic collectors who want an easy, organized hobby, a dependable digital representation of their physical cards, AI-assisted and inspired deck building and upgrades, and help managing card trading and sales, including but not limited to Cardmarket.

Supporting explanation: **Know what you own, discover what you can build, and manage what you trade.** This earlier working promise now supports the central purpose above. Broader demand and willingness to pay remain hypotheses to validate beyond the owner's experience.

## Connected jobs

Intake policy refinement (HARNESS-11): owner-origin ideas receive the same scrutiny and prioritization criteria as other ideas. Save requests promptly, challenge assumptions candidly and separate requested, assessed and accepted states. Preserve explicit final owner decisions and record tradeoffs; equal scrutiny never means silently discarding a request.

Discovery policy refinement (September 12, 2026; HARNESS-10): exploratory research may examine competitors, communities and emerging technology, but a justified decision that nothing merits action is a successful outcome. Scrutinize every feature before development against purpose, evidence/counterevidence, simpler alternatives, integration/UX complexity, feasibility, security/privacy and lifecycle cost. Discovery alone never promotes work into development or changes existing priorities.

1. Capture, correct, locate and organize physical cards with minimal friction and accurate exact-printing/quantity representation.
2. Use that collection for AI-assisted new decks, inspiration and upgrades; distinguish owned cards, available copies and suggested acquisitions. Explain suggestions and let the user decide.
3. Manage trading and sales across channels, including Cardmarket. Preserve the distinction between physical ownership, deck/location assignments, availability, listing and completed disposal; detailed lifecycle rules remain to be designed and tested. A listing alone must not be assumed to mean a sale.
4. Sustain useful engagement with new sets, card reveals/spoilers and Wizards of the Coast news, connected where relevant to the user's collection and decks. Source, freshness, relevance and user control should be part of proposed acceptance; specific feed/notification behavior remains a design decision.

These jobs share card identities and collection state. New features must adapt affected existing workflows so search, navigation, card views, quantities and terminology remain consistent. Trading/sales help is user value; it does not establish how this app earns revenue.

## Engineering and trust principles

- Maintain high code quality through cohesive composition, inward dependencies, replaceable concrete adapters, independent review and meaningful regression evidence. Avoid abstraction without a real need.
- Prioritize perceived and measured user-experience performance. Use asynchronous work where useful with bounded concurrency, cancellation, stale-result rejection, explicit saving/failure states and recoverable retries. Define measurable budgets per workflow from an observed baseline; asynchronous implementation alone is not acceptance evidence.
- Apply security and user-data protection throughout design, implementation and operation. Identify actual data flows, access boundaries, retention/deletion behavior, providers and intended markets. Assess applicable legal obligations using current authoritative sources for concrete processing decisions; do not claim compliance solely from agent review or tests.
- Preserve existing inventory, provenance, account-isolation and scanner-review invariants. Domain policies must apply equally to UI, AI and future trading integrations.

## Product discovery and monetization

**Monetization must never contradict the app's goals or this charter. Prioritize long-term monetization opportunities over short-term ones. The early financial objective is to cover the app's running and development costs.** Cost recovery is subject to the same charter and UX constraints; it is not an exception to them.

Evaluate candidates in order: charter/UX compatibility, contribution to a sustainable long-term product, then near-term contribution to cost coverage. Reject charter conflicts rather than offsetting them with a revenue score. Keep near-term cost recovery and longer-term growth explicit in each commercial brief. Avoid rewarding immediate revenue at the expense of trust, useful recommendations, security or performance.

Use the harness cost ledger to establish the cost baseline: app operation plus development, including agent/model work, CI, tools and observability. Distinguish recurring operating/development spend from one-time historical investment; record the chosen recovery period and assumptions instead of silently assuming immediate recovery of all past costs. Human development time may be tracked separately with an explicit valuation if selected; no rate is established. Compare net app revenue after attributable collection/payment costs with costs over the same period, without double counting. Unknown revenue, charges or estimates remain labeled. Covering costs is an early objective, not a demonstrated current outcome or permission to introduce a particular charge.

The development harness should continually look for useful features and monetization opportunities that do not harm user experience. Each discovery cycle must evaluate purpose fit, user benefit, evidence, integration impact, commercial mechanism, operating/support cost and effects on trust/performance/task completion. Keep rejected and deferred ideas with reasons. A recurring execution schedule has not been configured.

No revenue model, prices or marketplace partnership is selected. Candidate commercial models are hypotheses, distinct from the user's own card-sale proceeds. Existing owner priorities remain authoritative; discovery does not automatically authorize shipping an idea or changing pricing.

## Initial evidence and unresolved decisions

Use the owner's actual hobby workflows and reported friction as first-person evidence, while keeping production owner data out of automated tests. Validate features with synthetic fixtures and reserved test accounts, then collect voluntarily provided real-use feedback. Measure task completion, correction burden, useful deck decisions and trading reconciliation before assuming engagement or commercial success.

Still to establish through discovery: initial deck formats and preferences, trading lifecycle and cross-channel conflicts, provider access/contracts and permitted integration methods, applicable operating markets/data obligations, numerical performance targets, revenue hypotheses and research cadence. These are design inputs, not reasons to defer recording the stated direction.

## Decision history

Revision 3 records the owner's monetization ordering: charter compatibility is mandatory, long-term opportunities take precedence, and early revenue should cover running and development costs. It refines the earlier open-ended monetization search without selecting a revenue model or changing the purpose.

Revision 2 records the owner's explicit approval of **Give life to your collection** and its meaning above. It supersedes the revision 1 working promise as the primary purpose statement while preserving the audience, connected jobs and engineering principles.

This charter resolves the previously unwritten audience/purpose. It narrows the assistant's broad collector/deck-builder framing to the owner as the initial collector-builder-trader. Cardmarket sales management is explicitly intended scope; provider feasibility is unverified. The previous execution-only harness scope was already extended by HARNESS-02–05 and now evaluates proposals against this charter.
