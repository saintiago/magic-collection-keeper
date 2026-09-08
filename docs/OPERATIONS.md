# Development and operations

## Automatic deployment versions

Every main deployment gets `0.1.0+deploy.<run number>.<attempt>` using the package.json base and [GitHub workflow counters](https://docs.github.com/en/actions/reference/workflows-and-actions/variables). No version commit or bot loop is needed. Test/PR builds remain local development; failed pre-publish runs do not change served HTML. A rerun gets a new attempt. A failed check after HTML publication may still have deployed the visible version: the footer's Actions link shows actual check status.

The deploy job reads the published S3 HTML release marker before preparing its bundle and refuses an equal/older counter. Use a new main revert commit or new workflow_dispatch run on main for rollback/redeployment. The existing CI role has the needed S3 rights; no role or unrelated infrastructure changes are needed.

Assets and metadata live under `releases/rN-aA/` with a one-year immutable header. Upload the complete prefix before replacing root index.html. Root config.json remains for legacy clients and operational tests. Root HTML/config are no-store and invalidated; [CloudFront's existing CachingOptimized policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html) still has a one-second minimum edge TTL. Prior prefixes are retained deliberately. Never delete them as part of a bucket-wide site sync while older tabs may reference them. Retention adds an OCR bundle per release; later cleanup needs an explicit retention decision. S3 object replacement is atomic, but Lambda/site updates are not one transaction. Keep APIs compatible with older frontends.

For loading failures, read the timestamp/status and retry. Sign-out clears snapshots and invalidates other open tabs; clearing site data also removes snapshots. Storage-disabled browsers use placeholders and fetch normally. A 35-second collection request bound turns stalled requests into a retry state. This addresses demonstrated zero-before-load and tag-blocked rendering, not an unverified claim about every network delay or physical device.

## Local setup and checks

Use Node 24, run `npm ci`, `npm run build`, then `npm start` (loopback port 3000). `PORT` and `DB_PATH` override the local listener/database. The app has no local account system and cannot be used as a LAN/public server. Use the protected AWS deployment for phones. Local collection data is in ignored `data/collection.sqlite`; stop the server before making a simple file backup so the WAL is checkpointed.

`npm run build` creates the Lambda bundle and same-origin Tesseract worker/core/English model assets. It fetches the English model from the Tesseract distribution on the first build. These assets are generated and ignored by git; package versions are locked by `package-lock.json`. Do not commit `public/config.json`, collection files, credentials, test outputs or compiled artifacts.

Checks:

```sh
npm test
npx playwright install chromium
npm run test:ui
npm run build
```

Local UI tests run their own isolated in-memory SQLite server on port 3100. Controlled network fixtures exercise failures without writing inventory to Scryfall or AWS. The live suite needs `LIVE_URL`, `KEEPER_TEST_USER`, `KEEPER_TEST_PASSWORD`, `KEEPER_OTHER_USER`, `KEEPER_OTHER_PASSWORD`, and runs with `npx playwright test --config playwright.live.config.js`. It creates/removes data only in those dedicated test profiles. The service tests include a real file database reopen rather than only mocks.

## AWS resources

Region: `us-east-1`. Stack: `magic-collection-keeper`. Website: https://d3r1grp0vvv9f.cloudfront.net. CloudFront distribution `E28KIVWY6CUO4Q`, private site bucket `magic-collection-keeper-website-rpk3neiywwgb`, Lambda/table `magic-collection-keeper`, API `exex6mzt02`, Cognito pool `us-east-1_uqmXAk4AF`. The separate bootstrap code bucket is `magic-collection-keeper-build-698643713254`. No custom domain or Route 53 resources are used. Pantry resources are not part of this stack.

`infra/template.mjs` generates the checked-in CloudFormation template. Run `node infra/template.mjs` after infrastructure edits. Package `build/cloud.mjs` as `cloud.mjs` at the root of a zip, upload to a new key in the code bucket, and deploy with:

```sh
aws cloudformation deploy --template-file infra/template.json --stack-name magic-collection-keeper --capabilities CAPABILITY_IAM --parameter-overrides CodeBucket=magic-collection-keeper-build-698643713254 CodeKey=releases/NEW-RELEASE.zip --no-fail-on-empty-changeset
```

Use a new CodeKey for infrastructure deployments; do not accidentally reapply an old bootstrap bundle. The table has on-demand billing, point-in-time recovery and encryption. Existing data/pool/site are retained when a completed stack is deleted; newly created empty resources are removed on failed creation. CloudWatch logs retain 14 days. This foundation has no cost dashboard or automatic budget alarm; inspect actual AWS usage in the account.

## Main-branch CI/CD

The private GitHub repository runs `.github/workflows/deploy.yml`. Pull requests run unit/UI/build checks. Pushes to `main` run the same checks, obtain temporary AWS credentials through OIDC, update the Lambda bundle, sync the site, invalidate CloudFront, then run the live protected-collection test. The GitHub role is scoped to this repo's `main` OIDC subject and the exact app resources; the workflow has no static AWS key.

Repository variables are public resource configuration: `AWS_ROLE_ARN`, `WEBSITE_BUCKET`, `DISTRIBUTION_ID`, `API_URL`, `COGNITO_CLIENT_ID`, `WEBSITE_URL`. Eight encrypted GitHub secrets contain only the four dedicated test identities. They are not the owner's credentials. `scripts/configure-deployment.mjs` creates/updates the scoped deployment role and variables from completed stack outputs. It is an administrator bootstrap script, not invoked by CI and not a general cross-account provisioner.

New GitHub repositories use an immutable OIDC subject containing owner/repository numeric IDs. The bootstrap reads the actual `sub_claim_prefix` from GitHub and restricts it to `refs/heads/main`; it does not assume the older name-only format. See [GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

Rollback application code by reverting the bad commit on `main` and letting the pipeline redeploy a verified build. Workflow concurrency prevents two deployments for the same branch racing. Database changes must remain compatible with the previous application version; use additive migrations. For data recovery, restore DynamoDB point-in-time recovery to a new table, inspect it, and deliberately update the Lambda/table configuration. Never replace/delete a live table as an application rollback shortcut. Infrastructure changes are deployed separately with CloudFormation by an authorized administrator, not automatically granted to the limited CI role.

## Accounts and secrets

Self-signup is disabled. Owner username: `saint282`; Cognito sent the invitation to the user-provided email. Only the user should choose their permanent password. Admin-created test users `keeper-e2e`, `keeper-isolation`, `keeper-tags` and `keeper-import` have suppressed invitations and reserved `.invalid` email attributes. `scripts/create-test-users.mjs` creates/rotates only these test identities, puts credentials in GitHub secrets and an ignored `.local-secrets/credentials.json` for local verification. Use `--only keeper-import` to create/rotate only that reserved identity; unknown usernames are rejected. Remove that local file after hands-on verification; do not print its contents or commit it. The script must never be adapted to rotate the owner's password silently.

For an expired owner invitation, use Cognito's admin resend invitation workflow with the known username; that sends email and requires user authorization. Password recovery currently uses an administrator; there is no self-service reset button. Sign-out clears this browser session. Refresh tokens last 30 days; ID/access tokens one hour. Authenticated users can access only their own collection even if they know another row ID.

## Tag/source deployment and recovery

The live test suite additionally requires `KEEPER_TAGS_USER` and `KEEPER_TAGS_PASSWORD`. The bootstrap creates four dedicated suppressed-email profiles and eight GitHub test secrets. `keeper-tags` retains two synthetic Moxfield source manifests and one synthetic Wizards source across runs; do not clear them with the legacy empty-profile test or import test sources into the owner's partition. Delete the ignored local credential file after verification.

Tag documents are an additive migration in the existing table/database. Deploy the CORS addition for PUT through the isolated CloudFormation stack, using the current Lambda bundle and a fresh CodeKey, then ship the application through the normal main workflow. No extra CI permissions or cross-project resources are required. A previous application build does not understand these source projections; rolling back must account for temporarily hiding source-derived inventory rather than assuming it disappeared.

An administrator-assisted source import must first verify the Cognito owner UUID against the authorized account and inspect the requested folder in the user's signed-in browser. Use visible supported exports, resolve exact printings against canonical Scryfall data (bulk data for large imports), record excluded sections and preview each source. The import port commits a snapshot with the preview's expected version. Repeat the preview after success: unchanged snapshots must report zero additions. Never infer ownership from unrelated folders or erase existing loose inventory. Keep raw private exports and owner audit reports in ignored local data, not public artifacts or source control. Do not log authentication tokens or passwords.

For user-owned official precons, use the official Wizards decklist instead of a Moxfield folder/export. Compare every included name and quantity, including the playable commander. The publisher's interactive decklist warns its displayed printings may differ from the product; verify exact printing/art variants with product-level catalog data (such as MTGJSON's deck definitions cross-checked against Scryfall bulk IDs). Resolve language and finish before ownership writes, including standard-edition foil commanders. Record tokens and thick display cards as excluded unless requested. Use provider `wizards-precon`, an edition/language-specific namespaced source ID and the actual official URL. Do not invent a Moxfield source. Review existing source manifests/tags and exact-printing overlap first; an additional owned precon contributes physical copies even when another deck already owns that printing. Use the same preview/apply script and application port, verify repeat previews add zero, then compare prior source manifests, allocations, loose inventory and pending items against the saved pre-import state.

## Troubleshooting

Tag links use a browser fragment such as `#tag=<UUID>`; the fragment is not an ownership selector sent to the API. A copied link still requires sign-in and only shows that account's matching cards. An unknown/deleted tag stays explicitly selected with an empty/unavailable state; **Clear tag filter** returns to the collection. Cached labels may refresh to a renamed label while the stable ID remains selected. Tag navigation does not save an open editor or mutate inventory.

A deck's distinct entries are not its number of cards. Compare summed per-location assignments against current source lots and explicit pending quantities, then compare the original saved export. Do not sum pooled row ownership for a single deck or reimport to fix an entry-count display. A source total includes pending review items; they remain outside owned inventory. Manual assignments and source reductions may intentionally differ from the original source. The September 8 read-only owner audit verified all 41 original 100-card exports: 4,094 imported copies and six pending, with no missing allocations. Private evidence is retained under `data/deck-count-verification`; no owner repairs were necessary.

For the saved browser-export workflow, `scripts/resolve-moxfield-exports.mjs` reads the verified Commander source list and exports from ignored `data/imports`, validates commander and displayed main-deck totals, then resolves set/collector numbers against a downloaded Scryfall all-language bulk file. Inspect its resolution report before applying; unsupported finishes, missing printings and digital-only choices require review. `scripts/import-deck-sources.mjs` takes explicit `--username`, `--email`, `--folder`, `--manifest` and `--cards` arguments. It previews by default; `--apply` requires already established owner/import authorization. It verifies the Cognito account, preserves native inventory, saves an audit locally and rechecks zero-addition repeat imports.

| Symptom                          | Check                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser says service unreachable | Network and API CORS. OPTIONS must be unauthenticated and return 204; actual routes remain JWT-protected.                                                             |
| Sign-in fails                    | Invitation username, password policy/challenge, account status; never expose tokens in logs.                                                                          |
| Cloud-only write error           | Lambda CloudWatch logs and DynamoDB expression aliases; reserved names differ from SQLite. Run live tests after adapter changes.                                      |
| Catalog returns busy             | Respect Scryfall 429 cooldown; cache prevents repeated searches. Do not raise upstream request rate.                                                                  |
| Camera unavailable or waits      | Use HTTPS, browser permission, another regular browser, or upload a photo. A permission request times out after 15 seconds; closing/pausing invalidates late streams. |
| Poor OCR                         | One upright card, steady frame, even light, reduce glare; correct search manually and choose the printing.                                                            |
| Stale website after deploy       | Check Actions invalidation step and browser reload; check the footer version, immutable release paths, and root HTML invalidation.                                    |
| Batch partly saved               | Saved rows are marked; retry remaining rows. Do not repaste/reconfirm the entire list without checking existing quantities.                                           |
| A test left data behind          | Sign in as the dedicated test profile or rerun LIVE-01, which clears only that profile before verifying. Never clear the owner's partition.                           |

## Extending safely

Keep new business rules in `domain`/`application`; put provider calls and storage details in adapters. Extend the use-case coverage map whenever a control is added. For a new catalog provider, normalize to the existing printing contract and handle ID migration. For an image cache, wrap `public/images.js` and update the CSP narrowly. For recognition, replace `recognizeCard` while retaining candidate review and duplicate controls. For another import format, produce the same parsed-row shape without silently asserting ownership. Large-scale catalog or collection operations should introduce bulk ingestion/pagination and explicit migration tooling rather than growing UI loops indefinitely.

## Scanner acceptance

LIVE-04 uses only `keeper-e2e`, sequentially after the other empty-profile suites. Its generated camera feed drives the actual deployed OCR model, canonical printing lookup, reviewed save and reload persistence; it removes its test entry and signs out. Keep this separate from physical hardware evidence. For phone acceptance, stabilize the camera, scan a card, leave it stationary, remove it, insert a distinct identical copy, then try glare/blur and another clear card. Verify one cue per attempted card, final printing review, thumb scrolling, mute and background/Back shutdown. Never use the owner profile for test writes.

## Saved import operation and provider access

LIVE-06 additionally needs `KEEPER_IMPORT_USER` and `KEEPER_IMPORT_PASSWORD`. `scripts/seed-import-fixture.mjs` is an administrator-only setup tool: it verifies keeper-import and its reserved email, seeds a synthetic 100-card draft using canonical Scryfall cards, and verifies ownership is unchanged. It cannot target the owner. No HTTP fixture endpoint is deployed. CI edits/restores this persistent fixture without Add/Clear; after manual Add/Clear acceptance, reseed it for later runs. Existing keeper-tags sources and empty-profile tests remain separate.

The Import page saves on each edit. A stale version requires Reload saved draft; a failed save retains browser edits and disables Add until retried. Clear affects only the exact active draft. An ambiguous Add response is safe to retry because its permanent receipt and source identity prevent duplicate ownership. Do not delete receipts or reset draft revisions during recovery. Pending drafts never become owned through general tag edits. Older six printing-review references in existing sources are a separate concept and must not be cleared as staged drafts.

A September 8 local server probe received Moxfield HTTP 403 with the application's honest identity. Verify the deployed Lambda request as well before concluding production availability. Moxfield's [official feature documentation](https://github.com/moxfield/moxfield-public/wiki/Features) supports user-visible Arena/MTGO exports, but no documented supported backend export API was established. Their [terms/contact page](https://moxfield.com/help/terms) lists support@moxfield.com. Obtain approved backend access from Moxfield before configuring `MOXFIELD_USER_AGENT` to the application's own approved identity. Never borrow an allowlisted client's identity, browser cookies or challenge-bypass service. Contacting support sends a message and requires explicit user authorization. Provider access requires external approval; the normal main application workflow needs no broader CI role or unrelated resource changes.
