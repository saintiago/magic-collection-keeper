# Magic Collection Keeper

[Owner requirements, acceptance criteria and queued requests](docs/REQUIREMENTS.md).

A private Magic collection app with Scryfall printing lookup, persistent inventory, reviewed text imports, and assisted camera recognition.

- App: https://d3r1grp0vvv9f.cloudfront.net
- Repository: https://github.com/saintiago/magic-collection-keeper
- [Use cases and interaction coverage](docs/USE-CASES.md)
- [Architecture and adapter contracts](docs/ARCHITECTURE.md)
- [Development, deployment, recovery](docs/OPERATIONS.md)

Deployment classifies changes against the published application. Supported presentation changes use a separate frontend workflow that reuses the verified API and browser model assets; other runtime changes use the full workflow. About shows the frontend and API identities independently, and the authenticated source download includes the matching frontend and backend source. The first controlled production comparison took 13 minutes for the frontend path versus 18m 18s for the full path, with the API and model assets unchanged. [Evidence and limits](tests/performance/FRONTEND-DEPLOYMENT.md); see operations for compatibility checks and rollback.

## Use it

A separate, unreleased Recent cards revision preserves different printings of the same card and keeps each Home artwork/tag action on its exact printing. It records confirmed autocomplete choices and successful dedicated-page additions, without treating reloads, highlighting or failed additions as new activity. Local Chromium/WebKit checks pass; Import-batch addition events and production verification remain pending.

Scan stays briefly disabled while your account and saved captures load after sign-in; it becomes available as soon as that recovery finishes.

Home opens with a compact symbol/account bar, Scan, Import, Tags & locations, and the shared search field. It shows up to six recently opened cards and four recent decks or other tags. Card opens, tag visits, and tag creation/renaming count as activity; unfinished typing and background loading do not. Earlier selected search cards can appear too. If no deck/tag activity has been recorded on this browser, the sections are honestly labeled **Your decks** and **Your tags**. Nothing is added to ownership by appearing on Home.

**View collection** opens the complete inventory with its filters, quantities, tags and **Update collection**. The small ✦ Home link returns to the dashboard; browser Back and reload preserve the active collection, tag, search or import view. **Import** opens the saved URL-import page, with **Import list** available there for pasted text. Home activity stays on this browser under your verified account. Signing out hides it; **Clear activity** removes this account's Home activity and recent searches on this browser. Deleted tags disappear and renamed tags use their current label.

Sign in with your invitation. On first sign-in, choose a new password. Your collection starts empty. The shared **Search all Magic cards** field works the same in **My collection** and **All cards**. Type an English or translated name: **Piracy** ranks ahead of **Coastal Piracy** and **Conspiracy**; **relampa** suggests **Lightning Bolt — Relámpago**. Suggestions use a small inline checkmark for **Owned** and an empty circle for **Not owned**, with accessible labels and no quantities. Loading, unavailable and saved ownership have separate icons and descriptive labels. Translated subtext appears only when it explains a match absent from the English name or English face names: **nephilim** hides the redundant French name; **relampa** still shows **Relámpago**. Recent cards omit historical translated aliases. Search text is retained when switching views; the collection's tag, set, color, finish and sort controls remain independent browsing filters.

Use arrow keys and Enter, click, or tap a suggestion to open its dedicated card page directly. Search submission shows one English result per identity, with English rules text. Escape dismisses suggestions. Use **Change printing or language** to match your physical card, then review condition/finish/quantity before adding it. Translated aliases can match more than one card; suggestions preserve each identity and show the matching language when that alias explains the query. **Update collection** reloads saved inventory; it does not scrape prices or overwrite owned quantities with catalog data.

Focus the empty search field to see your ten most recent searches and card choices, newest first. A recent card opens its page; a recent text query runs that search again. Typing switches back to ordinary name suggestions. History records submitted searches and cards selected from suggestions or search results, not unfinished typing. It stays on this browser under your verified account across reloads and sign-ins; signing out hides it. **Clear recent searches**, beside the search label, removes this account's history on this browser. Storage failures are shown explicitly and do not prevent searching.

**Scan cards** opens the rear-camera view. Tap **Start camera** once for browser permission and audio activation, then hold each card inside the guide until the cue and slide in the next. There is no per-card shutter or printing chooser. A supported identity enters the chronological wheel with a **suggested printing**; the success cue means queued, not verified ownership or edition. Uncertain identities add no copy and get a retry cue. Quantity/remove controls affect the selected wheel entry. **Test sound** and mute remain available; displayed audio readiness cannot prove audibility.

**Review** or **Back** stops capture and opens the same **Import** page used for pasted lists and Moxfield. Each scan or pasted list becomes a separate account-saved pending import, grouped by its creation date in your local timezone. Check printing, language, finish, condition, quantity and tags; change printings or delete rows there. **Add** explicitly confirms ownership and saves up to 50 capture lines atomically. A lost response can be retried without duplicates. **Clear** removes only that pending import. Back, reload and later sign-ins preserve account-saved drafts. A small account-isolated browser journal protects captures while their initial save is interrupted; storage failures are visible and block replacement scans.

The browser prepares visual ONNX models on Scan entry. Geometry must indicate exactly one stable visible card before recognition; multiple or ambiguous overlapping cards quietly wait. A transparent overlay follows measured card regions and actual recognition activity. Browser artwork recognition, the private visual/OCR backend and an independent Amazon Nova Pro image read can run together. The first validated identity appears immediately; later supported alternatives update the same capture without another copy or sound and remain selectable in Import. Manual edits stay authoritative. The primary backend retains exact English or translated OCR titles and, only for a still-unresolved plausible card, a bounded Amazon Nova Lite title read. Independent proposals must also resolve exactly against the canonical catalog; model text never supplies printing IDs, foil status or ownership. Images are transient and are not stored. **Recognition & source (AGPL-3.0)** in the footer explains processing and provides matching source outside the camera. [Measured guard/model behavior and limits](tests/performance/SCANNER-GUARDS.md).

Camera controls are optional and capability-driven: continuous focus, exposure and white balance, with a centre point of interest where advertised. The rear camera and 2560×1440 resolution are preferences; actual settings can differ. The guide maps into actual video pixels, and a short burst chooses a sharper, better-exposed frame without changing visual departure/stability gating. No torch or zoom is forced. Recorded photographs/video and automated browsers do not establish the capabilities or live accuracy of a particular phone.

**Import list** accepts pasted Moxfield/Arena/MTGO-style text, for example:

```text
2 Lightning Bolt (M11) 149
1 Sol Ring
```

Choose exact printings where the text omits them. Pasted lists stage up to 50 lines in the shared Import page. Unresolved rows remain saved and block Add until corrected or deleted. Review quantities and attributes, then use **Add** to confirm ownership. A deck list is never proof of ownership. Moxfield’s [official feature documentation](https://github.com/moxfield/moxfield-public/wiki/Features) describes Arena/MTGO export. Public Moxfield URLs use the same Import page; provider denial is reported without replacing pending captures or owned cards. Successful live provider access is not guaranteed.

## Saved URL imports

Open **Import**, expand **New import**, paste a public Moxfield URL and choose **Load deck**. One URL draft with up to 150 included lines can coexist with multiple separate scan/text drafts. All are saved under your verified account and survive reload and later sign-ins. The date-grouped selector keeps separate same-day batches distinct. Edit quantities, printings, finishes, capture condition and existing tags. Edits save automatically; failed saves retain the visible changes with **Retry saving edits**. Create tag labels in **Tags & locations**.

Review fetched-source and reviewed totals separately. **Add** explicitly confirms ownership and commits the entire reviewed source atomically; unresolved printings or unavailable tags must be repaired first. Retrying Add and importing the same source again cannot duplicate its existing contribution. **Clear** removes only the current pending draft. Pending cards stay out of collection totals, filters and deck-source views until Add succeeds. Original source lines remain available as provenance after edits. A source refreshed elsewhere requires a fresh draft.

## Organize your cards

The following card controls describe the locally verified working revision; its cloud release remains pending. Collection, deck/tag, catalogue and Home tiles show only artwork at rest. A continuous 300ms mouse hover lifts one opaque card toward twice its rendered tile size, capped to leave 16px at viewport edges, with pointer tilt and plain glass tag toggles. A mouse click requests three times the tile size; a finger tap requests twice the tile size with a radial Add/Remove tag wheel. Both keep the source slot and surrounding grid visible, shifting and reducing the scale only as needed to fit the full card with 24px side and 32px vertical dismissal margins plus safe areas. Tags share selected, pending and error state across presentations. Wheel and pinch zoom remain available. A completed outside click/tap, Escape or browser Back animates the same image into its current source tile without activating a card behind it. **Card details**, in the source card's **More tags** menu, opens the dedicated printing and ownership page; Back restores the search. Autocomplete and recent-search selections still open that page directly. Quantity, condition and finish editing remain on dedicated workflows, where allocation reminders never block edits.

Drag a card directly, from its mouse hover enlargement, or after a brief touch hold (keyboard pickup: Shift+F10). A full-size translucent copy follows the pointer while the opaque pickup remains visible. You can also drag an already enlarged touch card onto its radial tags. Current tags load before pickup targets are fixed. Assigned targets read **Remove [tag]** and unassigned targets **Add [tag]**; a drop performs the indicated operation once, preserving other assignments and owned totals. Removing a location removes that assignment; toggling it back in the same open view restores its prior quantity. The layout and action stay fixed during a gesture, including when another save completes. **More tags** contains the complete searchable list and other card actions; long labels that cannot fit remain readable there. Escape, a release outside a target or pointer cancellation sends no tag edit. Resize, sign-out and a second finger cancel an enlarged-card drag; two fingers retain pinch zoom. **Edit tags** opens the existing location quantity editor.

Catalogue tag actions save a **pending Catalogue selections** import. Review its printing and use **Add** to confirm ownership; pending-card actions only edit that draft. Interrupted owned/catalogue actions show **Retry card action**, including after reload in the same browser tab. The retry uses the original operation and cannot duplicate copies. A blocked browser journal prevents a new action until it can safely save. Recent tags and retry state stay isolated to your verified account.

On touch devices, a completed tap opens a suggestion; scrolling through the list does not select a card. The dedicated card page appears immediately with its name and **Opening [card name]…** while details load. Images and your owned printings load independently. A failed lookup offers **Retry opening card** on that page. **Back** restores the originating Home, collection filters or search results; browser Back/Forward and copied card links work too. Reload verifies exact printing and Oracle identity, and an owned entry is resolved only in your signed-in collection. Invalid or unavailable entries never become an Add form. Choosing a card does not create a one-card search result or open a detail modal. Submitting a text query still opens ordinary search results. Printing/language and tag editing use auxiliary dialogs.

Selecting a shared-search suggestion by click, tap, or arrow keys and Enter opens its dedicated card page directly. **Your printings & tags** refreshes your collection and lists each owned printing separately, including its language, finish and condition. Use its **Edit locations & tags** button to add/remove tags or location assignments. A failed ownership refresh offers Retry. Cards with no owned copies retain the explicit printing review and Add flow before tags can be assigned.

**Tags & locations** creates deck, binder, box and other locations, plus reusable roles (such as Card Draw) and categories. Labels are editable; each tag has a stable, opaque identity. Open a card and choose **Edit locations & tags** to assign copies, move them between locations, or add/remove classifications. Tags display plain names. Owned and assigned quantities remain separate information and editing fields; the collection filters by any tag.

Click any displayed tag to open its filtered card list. This works on cards, card details, tag management, assignment links and deck-source headings. Navigation closes the current dialog and clears other filters so matching cards are visible. The active tag has a **Clear tag filter** control; browser Back returns to the previous tag and reload preserves the selection. Links use tag IDs, so renaming or duplicate labels cannot change the target. Select menus, checkboxes, Rename and Remove remain editing controls. Clicking an assignment link leaves unsaved edits unsaved.

Owned quantity and location quantities are independently editable. If three copies are assigned but only two owned, the card shows **3 assigned · 2 owned**. This is an inline reminder: saving remains available and no assignment is discarded. Unassigned copies never display as negative.

The library count distinguishes **assigned copies** from **distinct entries** when a deck or other location is selected. Repeated basic lands count once per physical copy; entries represent separate printing/finish/condition rows. Cards and quantity sorting use that location's assigned quantity, with pooled ownership labeled separately. Additional filters show the matching copies out of the location total. The top statistics always describe the whole owned collection. **View deck sources** separates total source cards, imported copies and copies awaiting printing review; pending items never increase owned totals. Source totals include commanders and can differ from current assignments after manual edits.

Verified deck-source imports contribute copies per source while preserving existing loose inventory. Reimporting the same source does not add copies again. Source reductions release copies to loose inventory; they do not delete ownership. Source metadata and exclusions are available under **View deck sources**. Printing, language and finish remain distinct, and source condition is **Unknown (imported)** until physical condition is established. The source import API is an administrator-assisted workflow; the normal **Import list** button remains a reviewed one-off text import and does not create a synchronized deck source.

Official Wizards preconstructed decks use their own source identities and official decklist links, alongside existing Moxfield sources. Exact set printings, deck-specific artwork, language and finish are resolved before import. A standard-edition deck may still include traditional-foil commanders; display commanders and tokens are recorded as exclusions unless separately requested. Owning the same printing in another deck does not replace those existing copies.

On a first visit, loading totals show dashes. Later visits in the same signed-in session show the device snapshot with its last-loaded time and an **Updating** status. A failed update keeps those cards visible with **Retry collection**. Zero and the empty-collection prompt require a successful empty response, or an explicitly labeled saved empty snapshot. Signing out clears snapshots. If browser storage is unavailable or evicted, the app still loads from the service.

The footer shows the version of the app files you actually loaded. Select it for the full commit and deployment checks. Reload to move an older open tab to the newest deployment.

## Run locally

Source cards with unresolved or digital-only printing references remain listed under **Printing review needed** in their deck source. They do not increase the physical owned total until their paper printing is resolved. Imports preserve exported variants; they cannot independently verify the edition, condition or finish of a physical card.

Node 24, npm and Python 3.12 are required.

```sh
npm ci
node scripts/build-name-index.mjs
pip install -r recognition/requirements-visual.txt
python recognition/scripts/prepare.py --visual-only
npm run build
npm start
```

Open http://localhost:3000. The local server binds to loopback and uses `data/collection.sqlite`; it has no cloud sign-in and is a separate collection. `npm run dev` restarts the server after changes. Verified recognition assets are prepared at build time and served from the app's own origin. Their initial download is about 56.8 MB plus small app/runtime files; verified cached assets are reused where browser storage permits. See [measured comparison](tests/performance/EVIDENCE.md).

```sh
npm test
npx playwright install chromium
npm run test:ui
```

## Scope and limitations

Recognition is an assisted capture tool, not guaranteed identification. Glare, sleeves, older layouts and small text can require correction. The visual gate requires a stable detailed image after a sustained departure; names never rearm it. A stationary card is read once. An identical copy needs a visibly empty guide across at least three geometry checks and 600 ms, then stable re-entry; an invisible swap cannot be distinguished. Camera movement, glare, backgrounds and multiple cards can produce extra or unclear readings. Keep one card in the guide and review the pending import. Capture processing has a bounded queue and at most one backend verification in flight; moving too quickly produces a retry cue without a copy. Each capture batch allows 50 lines. Account-saved pending imports survive browser storage clearing; unstaged local captures do not. Private replay evidence and hardware limits are documented in [scanner evidence](tests/performance/PHONE-EVIDENCE.md).

Images require a network connection; there is no offline image cache. The whole owned collection is loaded in the initial foundation, so very large inventories will need server pagination. Direct finish/condition editing uses remove-and-add; quantity is editable in place. Price tracking, Cardmarket listing/repricing and deck building are not implemented.

Scryfall [API rules](https://scryfall.com/docs/api) and [current rate limits](https://scryfall.com/docs/api/rate-limits) were checked September 7, 2026: search is limited to two requests/second. This app uses a shared 600 ms request lease, 24-hour search caching, and a cooldown after 429 responses. Large catalog ingestion should use bulk data, not repeated searches. Full card images preserve artist/copyright credit. Magic: The Gathering and card artwork © Wizards of the Coast; this app is not endorsed by Wizards or Scryfall.

## Discovery catalog freshness

Name suggestions use a compact public catalog of every available translated and card-face name, mapped to English card identities. The browser downloads about 5.64 MB once, verifies it, and searches in a Web Worker. IndexedDB retains the last verified snapshot across reloads; only the top eight results reach the UI. Ready local searches have no typing debounce. While the index loads, or if workers/storage/downloads fail, the existing server search remains available. Images and fresh card details still require a connection.

Catalog publication runs weekly on Monday at 06:23 UTC. Browsers and warm servers check for changes weekly on use, in the background, and download only a changed snapshot. A complete verified replacement switches atomically; failed updates retain the last good snapshot and mark delayed freshness. Weekly publication plus weekly checks can delay a new name by roughly fourteen days, plus upstream bulk/scheduler delay and up to five minutes of cached suggestions. Manual workflow runs and deployment bootstrap remain available. No change was made to the 24-hour card-detail/Scryfall caches.

Selecting a name resolves its exact English printing and Oracle identity directly. A bounded browser detail cache and a server cache reuse printings previously fetched in another result batch. Public names/details never contain your owned quantities or tags; those indicators come from your verified account's collection. Exact language/finish selection and explicit ownership confirmation remain unchanged.

## Server-assisted recognition

The CollectorVision visual model and independently replaceable Paddle ONNX text adapter are documented in [recognition/README.md](recognition/README.md), including AGPL source access, frozen artifact installation and the isolated administrator review packet. The deployment enables it only after authenticated cloud verification. When enabled, Recognition & source explains transient processing and offers the covered source download in the footer. Suggested printings remain editable and require final explicit ownership confirmation; automatic confirmed recognition remains disabled.

Hover and expanded zoom use a brief damped spring: a small overshoot then settling at the viewport-bounded source-relative scale. Nested reveal and tilt layers keep cursor tilt continuous; reduced-motion preferences skip the reveal animation.

## Fonts

The app self-hosts Cinzel for display headings and Inter for readable body text and action labels. Both are unmodified Google Fonts WOFF2 files licensed under SIL OFL 1.1; their licenses, source URLs and hashes are in `public/fonts`. Only the two Latin subsets are preloaded (74,160 bytes total); Latin Extended loads on demand. No proprietary Magic font is used. Font failures retain readable system fallbacks. The wheel freezes its loaded font or fallback at pickup, so a late font cannot move an active target.
