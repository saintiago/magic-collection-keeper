/**
 * Component import boundaries, enforced by `npm run boundaries` and exercised for real by
 * tests/integration/boundaries.test.ts. Each component owns its provider-owned public entry points
 * under src/<component> (docs/architecture.md); other components import those modules rather than
 * the component's internals. Application serves a browser and a backend runtime, so its browser-safe
 * contract is src/application/index.ts and its backend composition is src/application/backend.ts.
 */

export const components = ['application', 'catalog', 'recognition', 'search', 'ui', 'usercards'];

/** Public entry modules of the components, relative to src/<component>/, without the extension. */
const componentEntries = {
  application: ['index', 'backend'],
  catalog: ['index'],
  recognition: ['index'],
  search: ['index'],
  ui: ['index'],
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
      to: { path: '^src/application/backend\\.ts$' },
    },
  ],
  options: {
    // Dependencies outside the source tree are filtered by path instead of includeOnly: an
    // unresolved dependency keeps the written specifier rather than a src/ path (for example
    // "missing-package"), so includeOnly dropped it before no-unresolvable could inspect it.
    exclude: { path: '(^|/)(node_modules|build|coverage|\\.turbo)/' },
    tsPreCompilationDeps: true,
  },
};

export default config;
