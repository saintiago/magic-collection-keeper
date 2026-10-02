# Magic Collection Keeper

The app has [three design pillars](docs/PRODUCT-CHARTER.md#design-pillars): architecture, user journeys
and UI design, including motion. Their documents are indexed in [AGENTS.md](AGENTS.md).
[Product requirements](docs/requirements/README.md) define user categories and journeys. The
[task index](docs/tasks/inventory.md) groups delivery work; Jira Rank owns execution order.

The approved design uses direct Catalog public queries and authoritative UserCards private queries,
composed asynchronously by CardList. Combined public/private filtering is deferred. Documentation
defines the target architecture; source delivery and deployment are separate evidence.

## Workspace preparation

Node.js 24, npm and Python 3.12 or newer (the recognition suite baseline) are required. On Windows,
preparation, builds and tests run inside WSL as docs/tech-stack.md requires. Set `KEEPER_PYTHON` to
the interpreter to use when `python3` is not the documented baseline; focused and aggregate checks
honour it.

Prepare a fresh checkout from the committed lockfile, including the browser that Playwright drives:

```sh
npm ci
npm run install:browsers
```

Preparing the deployable recognition assets (`npm run prepare:recognition`) additionally needs the
pinned build requirements of the retained engine and access to the public model and catalog sources
(`infra/README.md#recognition-packaging`); the checks below never need the prepared bytes.

## Checks

```sh
npm run format:check        # Prettier over sources, tests and documentation
npm run lint                # ESLint
npm run typecheck           # tsc --noEmit
npm run boundaries          # dependency-cruiser over src/
npm run lint:infrastructure # cfn-lint over the CloudFormation templates in infra/
npm run test:component      # Vitest component contracts
npm run test:integration    # Vitest integration boundaries
npm run test:browser        # Playwright browser journeys
npm run test:python         # Python unittest recognition suite (src/recognition/python/tests)
npm run test:recognition    # Retained browser recognition regressions (tests/recognition)
npm run build               # compile the component public entry points into build/
npm run package             # build the deployable backend, browser and background-job artifacts
npm run package:recognition # verify and package the recognition image context (needs preparation)
```

Focus a scope with a path filter, for example `npm run test:component -- public-contracts`. Component
tests are organised as tests/component/<component>/ so one component's tests can be selected by path.
Vitest shares a two-worker pool across component and integration suites to keep simultaneous
PostgreSQL-in-WebAssembly startups from exhausting setup deadlines on hosts with many CPUs.
The Python runner provisions the pinned `src/recognition/python/requirements-tests.txt` wheels into
the ignored `.recognition-python/` environment once so the retained engine regressions run without
extra setup. The check requires the complete 27-regression suite: when the dependencies are missing
or cannot be installed it fails with an actionable error instead of skipping regressions. Set
`KEEPER_PYTHON` to an interpreter that already provides NumPy, Pillow and OpenCV to bypass
provisioning.
The infrastructure check provisions the pinned `infra/requirements-lint.txt` release into the
ignored `.infrastructure-python/` environment the same way and lints every template under `infra/`;
it establishes template validity only, while the identity and network boundaries of a deployed
environment stay separate evidence (infra/README.md).

`npm run validate` runs every check through Turborepo, which caches only the deterministic checks
(formatting, linting, type checking and boundaries) and always runs the test suites and build.
The build clears `build/` before compiling; caching is disabled so restoring cached artifacts cannot
leave output from deleted sources behind.
Nexus uses the same commands for preparation and validation (nexus.project.json).

`npm run package` builds the artifacts an explicit deployment publishes into the ignored
`artifacts/` directory: the interactive API package the Lambda runs, the browser bundle CloudFront
delivers, and the finite catalog job with its Dockerfile. The manifest beside them records the source revision, the version label and the digest of
every artifact, so a rebuilt revision produces the same bytes and a released combination can be
inspected and restored. The browser artifact carries no environment-specific file; the deployment
publishes `config.json` from the service stack's public outputs
(`npm run package -- --from-outputs infra/service-outputs.json
--environment test` projects the captured service stack, `--public-settings <file>` publishes a
prepared file), and only the settings the browser may receive are accepted. Publishing, deployment,
rollback and the live checks are recorded in `infra/README.md`.

`npm run release:evidence` prepares the release acceptance evidence beside the packaged artifacts: it
re-verifies every byte the packaging and recognition manifests name, requires both to come from a
clean committed revision, ties them and a captured `release.json` to the same release, and records
source completion, deployment and production acceptance separately, with the unresolved provider,
physical-device and collection-reconciliation checks named explicitly (docs/release-checklist.md).

`npm run prepare:recognition` and `npm run package:recognition` package the retained recognition
engine for both runtimes (docs/operations.md#recognition-packaging): preparation fetches the pinned
public model, catalog, OCR and title-name bytes through the retained scripts and copies the browser
ONNX runtime of the locked dependency, and packaging verifies every pinned manifest and hash — the
content of the pinned upstream checkout, the cached offline catalog feed, the browser manifest's
engine identity and the complete corresponding-source download of the checkout — before it
assembles the recognition image context and records its manifest beside the other artifacts. The
prepared bytes stay out of git and the checks never need them; preparation, the built image,
measurement and rollback are recorded in `infra/README.md#recognition-packaging`.
