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
      from: {},
      to: { couldNotResolve: true },
    },
    ...publicInterfaceRules,
  ],
  options: {
    includeOnly: '^src/',
    doNotFollow: { path: '(^|/)(node_modules|build|coverage|\\.turbo)/' },
    tsPreCompilationDeps: true,
  },
};

export default config;
