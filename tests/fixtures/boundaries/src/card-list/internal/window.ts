import { catalogEntry } from '../../catalog/index.js';
import { uiEntry } from '../../ui/index.js';

export function listWindow(size: number): number {
  return size + (uiEntry === undefined ? 0 : 1) + (catalogEntry.resolve('x').length > 0 ? 0 : 1);
}
