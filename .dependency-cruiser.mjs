/**
 * Component import boundaries, enforced by `npm run boundaries` and exercised for real by
 * tests/integration/boundaries.test.ts. Each component owns its provider-owned public entry points
 * under src/<component> (docs/architecture.md); other components import those modules rather than
 * the component's internals. Application serves a browser and a backend runtime, so its browser-safe
 * contract is src/application/index.ts and its backend compositions are src/application/backend.ts
 * and the packaged deployment composition src/application/deployment.ts. UserInterface's browser
 * entry points are src/ui/index.ts and the deployment composition src/ui/deployment.ts. Search's
 * browser-safe contract is src/search/browser.ts; its query, count and indexing capabilities stay
 * in src/search/index.ts.
 */

export const components = ['application', 'catalog', 'recognition', 'search', 'ui', 'usercards'];

/** Public entry modules of the components, relative to src/<component>/, without the extension. */
const componentEntries = {
  application: ['index', 'backend', 'deployment'],
  catalog: ['index'],
  recognition: ['index'],
  search: ['index', 'browser'],
  ui: ['index', 'deployment'],
  usercards: ['index'],
};

const publicInterfaceRules = components.map((component) => ({
  name: `no-internals-of-${component}`,
  severity: 'error',
  comment: `Cross-component imports use the ${component} public entry points: ${componentEntries[
    component
  ]
    .map((entry) => `src/${component}/${entry}.ts`)
    .join(', ')}.`,
  from: { path: '^src/', pathNot: `^src/${component}/` },
  to: {
    path: `^src/${component}/`,
    pathNot: `^src/${component}/(${componentEntries[component].join('|')})\\.ts$`,
  },
}));

// Source dependencies follow the composition graph, including type-only imports.
const providers = {
  application: ['catalog', 'recognition', 'search', 'usercards'],
  ui: ['application', 'catalog', 'recognition', 'search', 'usercards'],
  catalog: [],
  recognition: ['catalog'],
  search: ['catalog', 'usercards'],
  usercards: ['catalog'],
};
const directionRules = components
  .filter((component) => component !== 'ui')
  .map((component) => ({
    name: `allowed-providers-of-${component}`,
    severity: 'error',
    from: { path: `^src/${component}/` },
    to: {
      path: `^src/(${components.filter((target) => target !== component && !providers[component].includes(target)).join('|')})/`,
    },
  }));

/** @type {import('dependency-cruiser').IConfiguration} */
const config = {
  forbidden: [
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment: 'Unresolved imports hide missing modules and boundary violations.',
      // The retained browser worker dynamically loads its packaged ONNX runtime bundle
      // (src/recognition/browser/vendor/ort), which is a delivery asset rather than a source
      // module (docs/operations.md#recognition-packaging).
      from: {},
      to: {
        couldNotResolve: true,
        pathNot: '^\\./vendor/ort/ort\\.wasm\\.min\\.mjs$',
      },
    },
    ...publicInterfaceRules,
    ...directionRules,
    { name: 'no-circular', severity: 'error', from: { path: '^src/' }, to: { circular: true } },
    {
      name: 'no-backend-in-ui',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/application/(backend|deployment)\\.ts$' },
    },
  ],
  options: {
    // Dependencies outside the source tree are filtered by path instead of includeOnly: an
    // unresolved dependency keeps the written specifier rather than a src/ path (for example
    // "missing-package"), so includeOnly dropped it before no-unresolvable could inspect it.
    // The prepared recognition assets and the pinned upstream clone are build inputs rather than
    // source modules (docs/operations.md#recognition-packaging).
    exclude: {
      path: '(^|/)(node_modules|build|coverage|\\.turbo)/|^src/recognition/(python/(artifacts|vendor)|browser/vendor)/',
    },
    tsPreCompilationDeps: true,
  },
};

export default config;
