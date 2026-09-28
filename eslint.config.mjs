import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      'build/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      // Turborepo cache and the bundled packaging command it holds.
      '.turbo/**',
      // Prepared recognition assets, the pinned upstream clone and the build environments stay
      // out of git (docs/operations.md#recognition-packaging) and out of linting.
      'src/recognition/python/artifacts/**',
      'src/recognition/python/vendor/**',
      'src/recognition/browser/vendor/**',
      // Generated packaging output and the ignored Python environments.
      'artifacts/**',
      '.recognition-python/**',
      '.recognition-build/**',
      '.infrastructure-python/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The retained 128c903 browser recognition baseline stays byte-identical to its pinned
    // revision (src/recognition/baseline.json) and runs in the browser: worker, camera and
    // canvas globals apply, and unused upstream exports are preserved deliberately.
    files: ['src/recognition/browser/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
