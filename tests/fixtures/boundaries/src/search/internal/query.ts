import { recordShape } from '../../catalog/internal/records.js';

import { searchFilter } from './filters.js';

export function searchQuery(term: string) {
  return recordShape(searchFilter(term));
}
