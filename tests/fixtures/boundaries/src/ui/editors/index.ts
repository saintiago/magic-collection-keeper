import { cardViewsEntry } from '../card-views/index.js';
import { navigationEntry } from '../navigation/index.js';

/** Editors may request a supplied CardViews factory; Navigation is out of direction. */
export const editorsEntry = { cardViewsEntry, navigationEntry };
