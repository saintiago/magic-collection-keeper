/**
 * Component import boundaries, enforced by `npm run boundaries` and exercised for real by
 * tests/integration/boundaries.test.ts. Each component owns its provider-owned public entry points
 * under src/<component> (docs/architecture.md); other components import those modules rather than
 * the component's internals. Application serves a browser and a backend runtime, so its browser-safe
 * contract is src/application/index.ts and its backend compositions are src/application/backend.ts,
 * the packaged deployment composition src/application/deployment.ts and independent production
 * entry points under src/application/entrypoints/. The Web entry point is the composition root
 * allowed to select UserInterface's browser deployment. UserInterface's
 * browser entry points are src/ui/index.ts and the deployment composition src/ui/deployment.ts.
 * UserCards publishes its browser operation facade and constraints through
 * src/usercards/browser.ts, while its backend contracts stay in
 * src/usercards/index.ts.
 * CardList publishes its headless list contract, its source bindings and its account-local recent
 * activity through src/card-list/index.ts, and Capture publishes its headless session contract,
 * its device capability and its browser composition through src/capture/index.ts; the
 * presentation of the UserInterface renders both.
 *
 * UserInterface is one component of five replaceable modules (docs/ui/architecture.md). Each
 * module owns src/ui/<module>/index.ts and the modules compose each other in the documented
 * direction; only the composition root imports their concrete factories. Those rules are declared
 * below and exercised by the same fixture tree.
 */

export const components = [
  'application',
  'card-list',
  'capture',
  'catalog',
  'recognition',
  'ui',
  'usercards',
];

/** Public entry modules of the components, relative to src/<component>/, without the extension. */
const componentEntries = {
  application: ['index', 'backend', 'deployment'],
  'card-list': ['index'],
  capture: ['index'],
  catalog: ['index', 'browser'],
  recognition: ['index'],
  ui: ['index', 'deployment'],
  usercards: ['index', 'browser'],
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
  application: ['card-list', 'capture', 'catalog', 'recognition', 'usercards'],
  'card-list': ['catalog', 'usercards'],
  capture: ['recognition', 'usercards'],
  // UserInterface presents Capture instead of reaching Recognition: the composed capability
  // carries the recognition and staging bindings a capture session needs.
  ui: ['application', 'card-list', 'capture', 'catalog', 'usercards'],
  catalog: [],
  recognition: ['catalog'],
  usercards: ['catalog'],
};
const directionRules = components.map((component) => ({
  name: `allowed-providers-of-${component}`,
  severity: 'error',
  from: {
    path: `^src/${component}/`,
    ...(component === 'application' ? { pathNot: '^src/application/entrypoints/web\\.ts$' } : {}),
  },
  to: {
    path: `^src/(${components.filter((target) => target !== component && !providers[component].includes(target)).join('|')})/`,
  },
}));

/**
 * UserInterface modules (docs/ui/architecture.md#modules-and-composition). Each one publishes its
 * own entry point under src/ui/<module>/; the pages compose the others through the references UI
 * composition supplies. Only the composition root (src/ui/index.ts, src/ui/deployment.ts and the
 * internal/shared composition modules) imports concrete module factories, so a module import that
 * reaches past a public entry point or a module that imports the module it does not compose fails
 * the check, type-only imports included.
 */
const uiModules = ['navigation', 'pages', 'card-views', 'editors', 'capture-controls'];

/** UI modules one module may compose; every other UI module is out of direction. */
const uiModuleProviders = {
  // Navigation owns routes, the shell and page lifetime; no module presents it.
  navigation: [],
  // Pages composes the views it presents, the editors it mounts and the capture controls of an
  // import; Editors may request a supplied CardViews factory for a card/printing picker.
  pages: ['navigation', 'card-views', 'editors', 'capture-controls'],
  'card-views': [],
  editors: ['card-views'],
  'capture-controls': [],
};

const uiModuleEntryRules = uiModules.map((module) => ({
  name: `no-ui-internals-of-${module}`,
  severity: 'error',
  comment: `UserInterface modules import ${module} through its public entry point src/ui/${module}/index.ts, including types.`,
  from: { path: '^src/ui/', pathNot: `^src/ui/${module}/` },
  to: { path: `^src/ui/${module}/`, pathNot: `^src/ui/${module}/index\\.ts$` },
}));

const uiModuleDirectionRules = uiModules.flatMap((module) => {
  const forbidden = uiModules.filter(
    (target) => target !== module && !uiModuleProviders[module].includes(target),
  );
  if (forbidden.length === 0) {
    return [];
  }
  return [
    {
      name: `allowed-ui-modules-of-${module}`,
      severity: 'error',
      from: { path: `^src/ui/${module}/` },
      to: { path: `^src/ui/(${forbidden.join('|')})/` },
    },
  ];
});

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
    ...uiModuleEntryRules,
    ...uiModuleDirectionRules,
    { name: 'no-circular', severity: 'error', from: { path: '^src/' }, to: { circular: true } },
    {
      name: 'no-backend-in-ui',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/application/(backend|deployment|catalog-job)\\.ts$' },
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
