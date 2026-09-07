# Magic Collection Keeper

A private Magic collection app with Scryfall printing lookup, persistent inventory, reviewed text imports, and browser camera OCR.

- App: https://d3r1grp0vvv9f.cloudfront.net
- Repository: https://github.com/saintiago/magic-collection-keeper
- [Use cases and interaction coverage](docs/USE-CASES.md)
- [Architecture and adapter contracts](docs/ARCHITECTURE.md)
- [Development, deployment, recovery](docs/OPERATIONS.md)

## Use it

Sign in with your invitation. On first sign-in, choose a new password. Your collection starts empty. Search **Discover cards**, review the exact set, collector number and language, choose condition/finish/quantity, and add it. **Update collection** reloads saved inventory; it does not scrape prices or overwrite owned quantities with catalog data.

**Scan cards** uses the rear camera when available. Hold one card steady inside the guide. OCR runs in your browser, attempts set/collector number, then uses the name if the footer cannot be matched. Check every candidate. For another copy of the same printing, press **Next physical card** or increase quantity. Confirm ownership to save the batch. Uploaded card photos are a fallback and stay in the browser.

**Import list** accepts pasted Moxfield/Arena/MTGO-style text, for example:

```text
2 Lightning Bolt (M11) 149
1 Sol Ring
```

Choose exact printings where the text omits them. Check quantities and attributes before confirming ownership. Unresolved/unselected rows stay out. Batches are limited to 50 card lines. A deck list is never treated as proof of ownership. Moxfield's [official feature documentation](https://github.com/moxfield/moxfield-public/wiki/Features) describes Arena/MTGO export; this app uses pasted exports. No supported public Moxfield API contract was established during this implementation, so URL scraping is not implemented.

## Run locally

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

OCR is an assisted capture tool, not guaranteed recognition. English names work best; small footer text, foils, glare, rotation, sleeves and older layouts can require manual correction. Stable-frame checks detect motion, not card geometry. The app does not identify cards by artwork. Continuous scanning is one card at a time, with explicit rearming for identical physical copies. Review batches are in browser memory and are lost on reload. No physical phone-camera accuracy benchmark has been performed.

Images require a network connection; there is no offline image cache. The whole owned collection is loaded in the initial foundation, so very large inventories will need server pagination. Direct finish/condition editing uses remove-and-add; quantity is editable in place. Price tracking, Cardmarket listing/repricing and deck building are not implemented.

Scryfall [API rules](https://scryfall.com/docs/api) and [current rate limits](https://scryfall.com/docs/api/rate-limits) were checked September 7, 2026: search is limited to two requests/second. This app uses a shared 600 ms request lease, 24-hour search caching, and a cooldown after 429 responses. Large catalog ingestion should use bulk data, not repeated searches. Full card images preserve artist/copyright credit. Magic: The Gathering and card artwork © Wizards of the Coast; this app is not endorsed by Wizards or Scryfall.
