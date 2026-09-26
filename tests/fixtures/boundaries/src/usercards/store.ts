import type { RecordShape } from '../catalog/internal/records.js';
import { searchEntry } from '../search/index.js';

export function storeCopies(id: string): RecordShape & typeof searchEntry {
  return { ...searchEntry, id };
}
