# Development and operations

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

Repository variables are public resource configuration: `AWS_ROLE_ARN`, `WEBSITE_BUCKET`, `DISTRIBUTION_ID`, `API_URL`, `COGNITO_CLIENT_ID`, `WEBSITE_URL`. Six encrypted GitHub secrets contain only the three dedicated test identities. They are not the owner's credentials. `scripts/configure-deployment.mjs` creates/updates the scoped deployment role and variables from completed stack outputs. It is an administrator bootstrap script, not invoked by CI and not a general cross-account provisioner.

New GitHub repositories use an immutable OIDC subject containing owner/repository numeric IDs. The bootstrap reads the actual `sub_claim_prefix` from GitHub and restricts it to `refs/heads/main`; it does not assume the older name-only format. See [GitHub's OIDC reference](https://docs.github.com/en/actions/reference/security/oidc).

Rollback application code by reverting the bad commit on `main` and letting the pipeline redeploy a verified build. Workflow concurrency prevents two deployments for the same branch racing. Database changes must remain compatible with the previous application version; use additive migrations. For data recovery, restore DynamoDB point-in-time recovery to a new table, inspect it, and deliberately update the Lambda/table configuration. Never replace/delete a live table as an application rollback shortcut. Infrastructure changes are deployed separately with CloudFormation by an authorized administrator, not automatically granted to the limited CI role.

## Accounts and secrets

Self-signup is disabled. Owner username: `saint282`; Cognito sent the invitation to the user-provided email. Only the user should choose their permanent password. Admin-created test users `keeper-e2e`, `keeper-isolation` and `keeper-tags` have suppressed invitations and reserved `.invalid` email attributes. `scripts/create-test-users.mjs` creates/rotates only these test identities, puts credentials in GitHub secrets and an ignored `.local-secrets/credentials.json` for local verification. Create the `.local-secrets` directory before running it. Remove that local file after hands-on verification; do not print its contents or commit it. The script must never be adapted to rotate the owner's password silently.

For an expired owner invitation, use Cognito's admin resend invitation workflow with the known username; that sends email and requires user authorization. Password recovery currently uses an administrator; there is no self-service reset button. Sign-out clears this browser session. Refresh tokens last 30 days; ID/access tokens one hour. Authenticated users can access only their own collection even if they know another row ID.

## Tag/source deployment and recovery

The live test suite additionally requires `KEEPER_TAGS_USER` and `KEEPER_TAGS_PASSWORD`. The bootstrap creates three dedicated suppressed-email profiles and six GitHub test secrets. `keeper-tags` retains two synthetic source manifests across runs; do not clear them with the legacy empty-profile test or import test sources into the owner's partition. Delete the ignored local credential file after verification.

Tag documents are an additive migration in the existing table/database. Deploy the CORS addition for PUT through the isolated CloudFormation stack, using the current Lambda bundle and a fresh CodeKey, then ship the application through the normal main workflow. No extra CI permissions or cross-project resources are required. A previous application build does not understand these source projections; rolling back must account for temporarily hiding source-derived inventory rather than assuming it disappeared.

An administrator-assisted source import must first verify the Cognito owner UUID against the authorized account and inspect the requested folder in the user's signed-in browser. Use visible supported exports, resolve exact printings against canonical Scryfall data (bulk data for large imports), record excluded sections and preview each source. The import port commits a snapshot with the preview's expected version. Repeat the preview after success: unchanged snapshots must report zero additions. Never infer ownership from unrelated folders or erase existing loose inventory. Keep raw private exports and owner audit reports in ignored local data, not public artifacts or source control. Do not log authentication tokens or passwords.

## Troubleshooting

For the saved browser-export workflow, `scripts/resolve-moxfield-exports.mjs` reads the verified Commander source list and exports from ignored `data/imports`, validates commander and displayed main-deck totals, then resolves set/collector numbers against a downloaded Scryfall all-language bulk file. Inspect its resolution report before applying; unsupported finishes, missing printings and digital-only choices require review. `scripts/import-deck-sources.mjs` takes explicit `--username`, `--email`, `--folder`, `--manifest` and `--cards` arguments. It previews by default; `--apply` requires already established owner/import authorization. It verifies the Cognito account, preserves native inventory, saves an audit locally and rechecks zero-addition repeat imports.

| Symptom                          | Check                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser says service unreachable | Network and API CORS. OPTIONS must be unauthenticated and return 204; actual routes remain JWT-protected.                                                             |
| Sign-in fails                    | Invitation username, password policy/challenge, account status; never expose tokens in logs.                                                                          |
| Cloud-only write error           | Lambda CloudWatch logs and DynamoDB expression aliases; reserved names differ from SQLite. Run live tests after adapter changes.                                      |
| Catalog returns busy             | Respect Scryfall 429 cooldown; cache prevents repeated searches. Do not raise upstream request rate.                                                                  |
| Camera unavailable or waits      | Use HTTPS, browser permission, another regular browser, or upload a photo. A permission request times out after 15 seconds; closing/pausing invalidates late streams. |
| Poor OCR                         | One upright card, steady frame, even light, reduce glare; correct search manually and choose the printing.                                                            |
| Stale website after deploy       | Check Actions invalidation step and browser reload; generated assets use a five-minute cache policy.                                                                  |
| Batch partly saved               | Saved rows are marked; retry remaining rows. Do not repaste/reconfirm the entire list without checking existing quantities.                                           |
| A test left data behind          | Sign in as the dedicated test profile or rerun LIVE-01, which clears only that profile before verifying. Never clear the owner's partition.                           |

## Extending safely

Keep new business rules in `domain`/`application`; put provider calls and storage details in adapters. Extend the use-case coverage map whenever a control is added. For a new catalog provider, normalize to the existing printing contract and handle ID migration. For an image cache, wrap `public/images.js` and update the CSP narrowly. For recognition, replace `recognizeCard` while retaining candidate review and duplicate controls. For another import format, produce the same parsed-row shape without silently asserting ownership. Large-scale catalog or collection operations should introduce bulk ingestion/pagination and explicit migration tooling rather than growing UI loops indefinitely.

## Scanner acceptance

LIVE-04 uses only `keeper-e2e`, sequentially after the other empty-profile suites. Its generated camera feed drives the actual deployed OCR model, canonical printing lookup, reviewed save and reload persistence; it removes its test entry and signs out. Keep this separate from physical hardware evidence. For phone acceptance, stabilize the camera, scan a card, leave it stationary, remove it, insert a distinct identical copy, then try glare/blur and another clear card. Verify one cue per attempted card, final printing review, thumb scrolling, mute and background/Back shutdown. Never use the owner profile for test writes.
