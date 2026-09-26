/**
 * Component scope: each component from docs/architecture.md exposes its provider-owned public
 * contract at src/<component>/index.ts. Component behavior tests replace these bootstrap checks as
 * the components are implemented.
 */

import { describe, expect, it } from 'vitest';

import * as application from '../../src/application/index.js';
import * as catalog from '../../src/catalog/index.js';
import * as recognition from '../../src/recognition/index.js';
import * as search from '../../src/search/index.js';
import * as ui from '../../src/ui/index.js';
import * as usercards from '../../src/usercards/index.js';

const publicContracts = {
  application,
  catalog,
  recognition,
  search,
  ui,
  usercards,
};

describe('component public entry points', () => {
  it.each(Object.entries(publicContracts))(
    'loads the %s public contract',
    (_component, contract) => {
      expect(contract).toBeTypeOf('object');
    },
  );
});
