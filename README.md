# Magic Collection Keeper

A private Magic collection app with Scryfall printing lookup, persistent inventory, reviewed text imports, and browser camera OCR.

- App: https://d3r1grp0vvv9f.cloudfront.net
- Repository: https://github.com/saintiago/magic-collection-keeper
- [Use cases and interaction coverage](docs/USE-CASES.md)
- [Architecture and adapter contracts](docs/ARCHITECTURE.md)
- [Development, deployment, recovery](docs/OPERATIONS.md)

## Use it

Sign in with your invitation. On first sign-in, choose a new password. Your collection starts empty. Search **Discover cards**, review the exact set, collector number and language, choose condition/finish/quantity, and add it. **Update collection** reloads saved inventory; it does not scrape prices or overwrite owned quantities with catalog data.

**Scan cards** opens a full-screen rear-camera view. Tap **Start camera** once for browser camera permission and audio activation. Hold a card inside the guide until the cue, then slide the next card in. There is no per-card shutter or Next button. A rising two-note cue means a confident exact printing was matched into the review batch; a lower cue means the reading needs review. Sound can be muted. The lower quarter contains a chronological wheel: newest readings arrive at the bottom and become selected; swipe to previous readings, or use arrow keys. Only the selected reading has quantity and remove controls. **Back** or **Review** stops the camera and opens final printing/finish/condition review and ownership confirmation. Unresolved readings never save automatically. Photo upload remains available before starting the camera. Images stay in the browser.

**Import list** accepts pasted Moxfield/Arena/MTGO-style text, for example:

```text
2 Lightning Bolt (M11) 149
1 Sol Ring
```

Choose exact printings where the text omits them. Check quantities and attributes before confirming ownership. Unresolved/unselected rows stay out. Batches are limited to 50 card lines. A deck list is never treated as proof of ownership. Moxfield's [official feature documentation](https://github.com/moxfield/moxfield-public/wiki/Features) describes Arena/MTGO export; this app uses pasted exports. No supported public Moxfield API contract was established during this implementation, so URL scraping is not implemented.

## Organize your cards

**Tags & locations** creates deck, binder, box and other locations, plus reusable roles (such as Card Draw) and categories. Labels are editable; each tag has a stable, opaque identity. Open a card and choose **Edit locations & tags** to assign copies, move them between locations, or add/remove classifications. The collection shows location icons and quantities, and filters by any tag.

Owned quantity and location quantities are independently editable. If three copies are assigned but only two owned, the card shows **3 assigned · 2 owned**. This is an inline reminder: saving remains available and no assignment is discarded. Unassigned copies never display as negative.

Verified deck-source imports contribute copies per source while preserving existing loose inventory. Reimporting the same source does not add copies again. Source reductions release copies to loose inventory; they do not delete ownership. Source metadata and exclusions are available under **View deck sources**. Printing, language and finish remain distinct, and source condition is **Unknown (imported)** until physical condition is established. The source import API is an administrator-assisted workflow; the normal **Import list** button remains a reviewed one-off text import and does not create a synchronized deck source.

## Run locally

Source cards with unresolved or digital-only printing references remain listed under **Printing review needed** in their deck source. They do not increase the physical owned total until their paper printing is resolved. Imports preserve exported variants; they cannot independently verify the edition, condition or finish of a physical card.

Node 24 and npm are required.

```sh
npm ci
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

OCR is an assisted capture tool, not guaranteed recognition. English names work best; small footer text, foils, glare, rotation, sleeves and older layouts can require manual correction. Visual transition checks detect sustained changes, then require a stable, detailed image; they do not identify card geometry or artwork. A stationary card is read once. Another identical copy can be counted after a visible removal or slide and re-entry. A swap with no visible change cannot be distinguished, and glare, camera movement or a textured background can still cause an extra or unclear reading. Keep the camera steady and review the batch. Recognition is sequential with a small bounded capture queue; moving cards too quickly leaves an explicit review item. Batches remain limited to 50 readings. Review batches are in browser memory and are lost on reload. No physical phone-camera accuracy benchmark has been performed.

Images require a network connection; there is no offline image cache. The whole owned collection is loaded in the initial foundation, so very large inventories will need server pagination. Direct finish/condition editing uses remove-and-add; quantity is editable in place. Price tracking, Cardmarket listing/repricing and deck building are not implemented.

Scryfall [API rules](https://scryfall.com/docs/api) and [current rate limits](https://scryfall.com/docs/api/rate-limits) were checked September 7, 2026: search is limited to two requests/second. This app uses a shared 600 ms request lease, 24-hour search caching, and a cooldown after 429 responses. Large catalog ingestion should use bulk data, not repeated searches. Full card images preserve artist/copyright credit. Magic: The Gathering and card artwork © Wizards of the Coast; this app is not endorsed by Wizards or Scryfall.
