/**
 * Deliberately unresolved imports: no-unresolvable has to report them, so the cruise must not
 * filter them out before the rules run. Type checking stays honest because each import below is
 * expected to fail.
 */
// @ts-expect-error The relative module does not exist on purpose.
import '../catalog/missing-record.js';
// @ts-expect-error The package does not exist on purpose.
import 'missing-review-package';
