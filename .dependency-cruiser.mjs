/**
 * Component import boundaries, enforced by `npm run boundaries` and exercised for real by
 * tests/integration/boundaries.test.ts. Each component owns src/<component>/index.ts as its
 * provider-owned public entry point (docs/architecture.md); other components import that module
 * rather than the component's internals.
 */

export const components = ['application', 'catalog', 'recognition', 'search', 'ui', 'usercards'];

const publicInterfaceRules = components.map((component) => ({
  name: `no-internals-of-${component}`,
  severity: 'error',
  comment: `Cross-component imports use the ${component} public entry point (src/${component}/index.ts).`,
  from: { path: '^src/', pathNot: `^src/${component}/` },
  to: { path: `^src/${component}/`, pathNot: `^src/${component}/index\\.ts$` },
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
