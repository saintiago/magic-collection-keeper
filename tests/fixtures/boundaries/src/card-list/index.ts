import { catalogEntry } from '../catalog/index.js';
import { recordShape } from '../catalog/internal/records.js';
import { searchEntry } from '../search/index.js';
import { usercardsEntry } from '../usercards/index.js';

import { listWindow } from './internal/window.js';

export const cardListEntry = { catalogEntry, recordShape, searchEntry, usercardsEntry, listWindow };
