import { catalogEntry } from '../catalog/index.js';
import { recognitionEntry } from '../recognition/index.js';
import { searchEntry } from '../search/index.js';
import { searchQuery } from '../search/internal/query.js';
import { uiPage } from '../ui/internal/page.js';
import { usercardsEntry } from '../usercards/index.js';
import { copyStore } from '../usercards/internal/copies.js';

export const application = {
  catalogEntry,
  recognitionEntry,
  searchEntry,
  searchQuery,
  uiPage,
  usercardsEntry,
  copyStore,
};
