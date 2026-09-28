import { uiEntry } from '../../ui/index.js';

export function deviceSession(size: number): number {
  return size + (uiEntry === undefined ? 0 : 1);
}
