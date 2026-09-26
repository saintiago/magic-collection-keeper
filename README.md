# Magic Collection Keeper

This repository contains the approved rebuild design and bootstrap configuration.
The previous application implementation has been removed. The rebuild is not yet runnable.

Start with AGENTS.md for the documentation index and engineering principles.
The task index is in docs/tasks/inventory.md. Jira Rank holds execution order.

The complete previous implementation is preserved separately at
E:/projects/magic-keeper-old, revision 128c903ff109868acc854f0ff239c8c0f925d803.

Collection migration is required before cutover. Local owner data and existing AWS resources
are preserved; no data migration, resource deletion or deployment is performed by this reset.

Local runtime files are archived outside the repo at E:/projects/magic-keeper-local-backup.
Recognition implementation and tests will be recovered from magic-keeper-old when needed.
