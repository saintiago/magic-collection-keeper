# Magic Collection Keeper

A private Magic collection app with Scryfall printing lookup, persistent inventory, reviewed text imports, and browser camera OCR.

- App: https://d3r1grp0vvv9f.cloudfront.net
- Repository: https://github.com/saintiago/magic-collection-keeper
- [Use cases and interaction coverage](docs/USE-CASES.md)
- [Architecture and adapter contracts](docs/ARCHITECTURE.md)
- [Development, deployment, recovery](docs/OPERATIONS.md)

## Use it

Home opens with a compact symbol/account bar, Scan, Import, Tags & locations, and the shared search field. It shows up to six recently opened cards and four recent decks or other tags. Card opens, tag visits, and tag creation/renaming count as activity; unfinished typing and background loading do not. Earlier selected search cards can appear too. If no deck/tag activity has been recorded on this browser, the sections are honestly labeled **Your decks** and **Your tags**. Nothing is added to ownership by appearing on Home.

**View collection** opens the complete inventory with its filters, quantities, tags and **Update collection**. The small ✦ Home link returns to the dashboard; browser Back and reload preserve the active collection, tag, search or import view. **Import** opens the saved URL-import page, with **Import list** available there for pasted text. Home activity stays on this browser under your verified account. Signing out hides it; **Clear activity** removes this account's Home activity and recent searches on this browser. Deleted tags disappear and renamed tags use their current label.

Sign in with your invitation. On first sign-in, choose a new password. Your collection starts empty. The shared **Search all Magic cards** field works the same in **My collection** and **All cards**. Type an English or translated name: **Piracy** ranks ahead of **Coastal Piracy** and **Conspiracy**; **relampa** suggests **Lightning Bolt — Relámpago**. Suggestions use a small inline checkmark for **Owned** and an empty circle for **Not owned**, with accessible labels and no quantities. Loading, unavailable and saved ownership have separate icons and descriptive labels. Translated subtext appears only when it explains a match absent from the English name or English face names: **nephilim** hides the redundant French name; **relampa** still shows **Relámpago**. Recent cards omit historical translated aliases. Search text is retained when switching views; the collection's tag, set, color, finish and sort controls remain independent browsing filters.

Use arrow keys and Enter, click, or tap a suggestion to open its dedicated card page directly. Search submission shows one English result per identity, with English rules text. Escape dismisses suggestions. Use **Change printing or language** to match your physical card, then review condition/finish/quantity before adding it. Translated aliases can match more than one card; suggestions preserve each identity and show the matching language when that alias explains the query. **Update collection** reloads saved inventory; it does not scrape prices or overwrite owned quantities with catalog data.

Focus the empty search field to see your ten most recent searches and card choices, newest first. A recent card opens its page; a recent text query runs that search again. Typing switches back to ordinary name suggestions. History records submitted searches and cards selected from suggestions or search results, not unfinished typing. It stays on this browser under your verified account across reloads and sign-ins; signing out hides it. **Clear recent searches**, beside the search label, removes this account's history on this browser. Storage failures are shown explicitly and do not prevent searching.

**Scan cards** opens a full-screen rear-camera view. Tap **Start camera** once for browser camera permission and audio activation; a single test tone is distinct from card cues. **Test sound** activates or resumes audio on a direct tap. The separate sound status reports browser readiness; it cannot prove device volume or audibility. Hold a card inside the guide until the cue, then slide the next card in. There is no per-card shutter or Next button. A rising two-note cue means a confident exact printing was matched into the review batch; a lower cue means retry or check optional possible matches. Sound can be muted. The lower quarter contains a chronological wheel: only matched cards enter the wheel and copy count. The newest card sits at the bottom beside its controls without a trailing gap; scrolling back centers older selections with newer cards below. Swipe or use arrow keys. Only the selected reading has quantity and remove controls. **Back** or **Review** stops the camera and opens final printing/finish/condition review and ownership confirmation. Failed reads show a brief retry message without adding a copy or an empty review form. Up to ten recent uncertain readings with actual candidates are available in a separate **Possible matches** area; choosing a printing is optional. Back/Review includes only selected printings and discards unresolved attempts. Photo upload remains available before starting the camera. Images stay in the browser.

**Import list** accepts pasted Moxfield/Arena/MTGO-style text, for example:

```text
2 Lightning Bolt (M11) 149
1 Sol Ring
```

Choose exact printings where the text omits them. Check quantities and attributes before confirming ownership. Unresolved/unselected rows stay out. Batches are limited to 50 card lines. A deck list is never treated as proof of ownership. Moxfield's [official feature documentation](https://github.com/moxfield/moxfield-public/wiki/Features) describes Arena/MTGO export; pasted exports remain available. The separate **Import** page stages public Moxfield URLs through the backend. Moxfield may deny this application server access; this is reported without changing saved drafts or owned cards. No supported public API contract was established, and successful provider access is not guaranteed.

## Saved URL imports

Open **Import**, paste a public Moxfield deck URL and choose **Load deck**. One pending draft is saved per account, with up to 150 included card lines. It survives reloads and later sign-ins. Change quantities, delete lines, choose exact paper printings and finishes, and add/remove existing location or classification tags. Edits save automatically; failed saves keep your edits visible with **Retry saving edits**. Create new tag labels in **Tags & locations**.

Review fetched-source and reviewed totals separately. **Add** explicitly confirms ownership and commits the entire reviewed source atomically; unresolved printings or unavailable tags must be repaired first. Retrying Add and importing the same source again cannot duplicate its existing contribution. **Clear** removes only the current pending draft. Pending cards stay out of collection totals, filters and deck-source views until Add succeeds. Original source lines remain available as provenance after edits. A source refreshed elsewhere requires a fresh draft.

## Organize your cards

On touch devices, a completed tap opens a suggestion; scrolling through the list does not select a card. The dedicated card page appears immediately with its name and **Opening [card name]…** while details load. Images and your owned printings load independently. A failed lookup offers **Retry opening card** on that page. **Back** restores the originating Home, collection filters or search results; browser Back/Forward and copied card links work too. Reload verifies exact printing and Oracle identity, and an owned entry is resolved only in your signed-in collection. Invalid or unavailable entries never become an Add form. Choosing a card does not create a one-card search result or open a detail modal. Submitting a text query still opens ordinary search results. Printing/language and tag editing use auxiliary dialogs.

Selecting a shared-search suggestion by click, tap, or arrow keys and Enter opens its dedicated card page directly. **Your printings & tags** refreshes your collection and lists each owned printing separately, including its language, finish and condition. Use its **Edit locations & tags** button to add/remove tags or location assignments. A failed ownership refresh offers Retry. Cards with no owned copies retain the explicit printing review and Add flow before tags can be assigned.

**Tags & locations** creates deck, binder, box and other locations, plus reusable roles (such as Card Draw) and categories. Labels are editable; each tag has a stable, opaque identity. Open a card and choose **Edit locations & tags** to assign copies, move them between locations, or add/remove classifications. The collection shows location icons and quantities, and filters by any tag.

Click any displayed tag to open its filtered card list. This works on cards, card details, tag management, assignment links and deck-source headings. Navigation closes the current dialog and clears other filters so matching cards are visible. The active tag has a **Clear tag filter** control; browser Back returns to the previous tag and reload preserves the selection. Links use tag IDs, so renaming or duplicate labels cannot change the target. Select menus, checkboxes, Rename and Remove remain editing controls. Clicking an assignment link leaves unsaved edits unsaved.

Owned quantity and location quantities are independently editable. If three copies are assigned but only two owned, the card shows **3 assigned · 2 owned**. This is an inline reminder: saving remains available and no assignment is discarded. Unassigned copies never display as negative.

The library count distinguishes **assigned copies** from **distinct entries** when a deck or other location is selected. Repeated basic lands count once per physical copy; entries represent separate printing/finish/condition rows. Cards and quantity sorting use that location's assigned quantity, with pooled ownership labeled separately. Additional filters show the matching copies out of the location total. The top statistics always describe the whole owned collection. **View deck sources** separates total source cards, imported copies and copies awaiting printing review; pending items never increase owned totals. Source totals include commanders and can differ from current assignments after manual edits.

Verified deck-source imports contribute copies per source while preserving existing loose inventory. Reimporting the same source does not add copies again. Source reductions release copies to loose inventory; they do not delete ownership. Source metadata and exclusions are available under **View deck sources**. Printing, language and finish remain distinct, and source condition is **Unknown (imported)** until physical condition is established. The source import API is an administrator-assisted workflow; the normal **Import list** button remains a reviewed one-off text import and does not create a synchronized deck source.

Official Wizards preconstructed decks use their own source identities and official decklist links, alongside existing Moxfield sources. Exact set printings, deck-specific artwork, language and finish are resolved before import. A standard-edition deck may still include traditional-foil commanders; display commanders and tokens are recorded as exclusions unless separately requested. Owning the same printing in another deck does not replace those existing copies.

On a first visit, loading totals show dashes. Later visits in the same signed-in session show the device snapshot with its last-loaded time and an **Updating** status. A failed update keeps those cards visible with **Retry collection**. Zero and the empty-collection prompt require a successful empty response, or an explicitly labeled saved empty snapshot. Signing out clears snapshots. If browser storage is unavailable or evicted, the app still loads from the service.

The footer shows the version of the app files you actually loaded. Select it for the full commit and deployment checks. Reload to move an older open tab to the newest deployment.

## Run locally

Source cards with unresolved or digital-only printing references remain listed under **Printing review needed** in their deck source. They do not increase the physical owned total until their paper printing is resolved. Imports preserve exported variants; they cannot independently verify the edition, condition or finish of a physical card.

Node 24 and npm are required.

```sh
npm ci
node scripts/build-name-index.mjs
npm run build
npm start
```

Open http://localhost:3000. The local server binds to loopback and uses `data/collection.sqlite`; it has no cloud sign-in and is a separate collection. `npm run dev` restarts the server after changes. OCR assets are downloaded at build time and served from the app's own origin.

```sh
npm test
npx playwright install chromium
npm run test:ui
```

## Scope and limitations

OCR is an assisted capture tool, not guaranteed recognition. English names work best; small footer text, foils, glare, rotation, sleeves and older layouts can require manual correction. Visual transition checks detect sustained changes, then require a stable, detailed image; they do not identify card geometry or artwork. A stationary card is read once. Another identical copy can be counted after a visible removal or slide and re-entry. A swap with no visible change cannot be distinguished, and glare, camera movement or a textured background can still cause an extra or unclear reading. Keep the camera steady and review the batch. Recognition is sequential with a small bounded capture queue; moving cards too quickly gives a retry cue without counting a copy. Batches remain limited to 50 matched/pending entries. Review batches are in browser memory and are lost on reload. No physical phone-camera accuracy benchmark has been performed.

Images require a network connection; there is no offline image cache. The whole owned collection is loaded in the initial foundation, so very large inventories will need server pagination. Direct finish/condition editing uses remove-and-add; quantity is editable in place. Price tracking, Cardmarket listing/repricing and deck building are not implemented.

Scryfall [API rules](https://scryfall.com/docs/api) and [current rate limits](https://scryfall.com/docs/api/rate-limits) were checked September 7, 2026: search is limited to two requests/second. This app uses a shared 600 ms request lease, 24-hour search caching, and a cooldown after 429 responses. Large catalog ingestion should use bulk data, not repeated searches. Full card images preserve artist/copyright credit. Magic: The Gathering and card artwork © Wizards of the Coast; this app is not endorsed by Wizards or Scryfall.

## Discovery catalog freshness

Name suggestions use a compact public catalog of every available translated and card-face name, mapped to English card identities. The browser downloads about 5.64 MB once, verifies it, and searches in a Web Worker. IndexedDB retains the last verified snapshot across reloads; only the top eight results reach the UI. Ready local searches have no typing debounce. While the index loads, or if workers/storage/downloads fail, the existing server search remains available. Images and fresh card details still require a connection.

Catalog publication runs weekly on Monday at 06:23 UTC. Browsers and warm servers check for changes weekly on use, in the background, and download only a changed snapshot. A complete verified replacement switches atomically; failed updates retain the last good snapshot and mark delayed freshness. Weekly publication plus weekly checks can delay a new name by roughly fourteen days, plus upstream bulk/scheduler delay and up to five minutes of cached suggestions. Manual workflow runs and deployment bootstrap remain available. No change was made to the 24-hour card-detail/Scryfall caches.

Selecting a name resolves its exact English printing and Oracle identity directly. A bounded browser detail cache and a server cache reuse printings previously fetched in another result batch. Public names/details never contain your owned quantities or tags; those indicators come from your verified account's collection. Exact language/finish selection and explicit ownership confirmation remain unchanged.

## Prepared server recognition

The optional CollectorVision/Paddle service and swappable model ports are in [recognition/README.md](recognition/README.md), including AGPL source access, frozen artifact installation and the isolated administrator review packet. It remains disabled in production pending infrastructure/deployed verification; current scans still use browser OCR. When enabled, the scanner explains transient server processing before capture and offers the covered source download. ML automatic printing confirmations remain disabled pending real-frame calibration.
