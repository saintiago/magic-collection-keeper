import type { RecordShape } from '../catalog/internal/records.js';
import { recognitionEntry } from '../recognition/index.js';

export function storeCopies(id: string): RecordShape & typeof recognitionEntry {
  return { ...recognitionEntry, id };
}
