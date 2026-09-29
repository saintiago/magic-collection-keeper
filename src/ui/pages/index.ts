/**
 * Pages public entry point (docs/ui/pages.md,
 * docs/ui/architecture.md#modules-and-composition).
 *
 * Pages compose one screen around an activity: each page owns its layout, route context, active
 * sections and child lifetimes, implements Navigation's page lifecycle and composes the CardViews,
 * Editors and CaptureControls factories UI composition supplied it. A page forwards route changes
 * and explicit query input without evaluating them, translates the navigation and action intents
 * its children report into routes or explicit editor contexts, and hands the handles its children
 * retain back to Navigation without reading them. Loading card contents, importing, capture
 * admission, operation receipts and other business outcomes stay with their owning components.
 *
 * This module publishes the page implementations of this build; Navigation mounts them through
 * the contract it owns, and its internals stay private to the UI component (docs/architecture.md).
 */

import type { UiPageDefinition } from '../navigation/index.js';

import { createBrowsePages } from './internal/browse.js';
import { createCollectionPages } from './internal/collection.js';
import { createImportPages } from './internal/imports.js';
import { createOrganizationPages } from './internal/organization.js';

export { createBrowsePages } from './internal/browse.js';
export { createCollectionPages } from './internal/collection.js';
export { createImportPages } from './internal/imports.js';
export { createOrganizationPages } from './internal/organization.js';

/** Every dedicated page of this build: Home, catalog, collection, tags, card details and import. */
export function createPages(): readonly UiPageDefinition[] {
  return [
    ...createBrowsePages(),
    ...createCollectionPages(),
    ...createOrganizationPages(),
    ...createImportPages(),
  ];
}
