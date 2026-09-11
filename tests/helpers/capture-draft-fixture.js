// Camera interaction tests use controlled recognition; this is only their pending-store transport.
export async function mockCaptureDrafts(page) {
  const drafts = new Map();
  const handler = async (route) => {
    const url = new URL(route.request().url()),
      raw = route.request().postDataJSON(),
      input = raw?.batch || raw;
    let draft =
      drafts.get(url.searchParams.get("id")) || [...drafts.values()][0] || null;
    if (
      url.pathname.endsWith("/stage") ||
      url.pathname.endsWith("/scan-session/batch")
    ) {
      draft = {
        id: input.id,
        version: 1,
        provider: "reviewed-capture",
        name: "Scanned cards",
        created_at: new Date().toISOString(),
        original: {
          total: input.rows.reduce((n, r) => n + r.quantity, 0),
          excluded: [],
        },
        rows: input.rows.map((row) => ({
          ...row,
          original: {
            ...row,
            section: "mainboard",
            set: "tst",
            collector_number: "1",
            capture_kind: input.kind,
          },
          in_deck: false,
          locations: [],
          tag_ids: [],
          card: row.printing_id
            ? {
                id: row.printing_id,
                name: row.name,
                set: "tst",
                collector_number: "1",
                lang: "en",
                finishes: [row.finish],
              }
            : null,
        })),
      };
      drafts.set(draft.id, draft);
    }
    if (url.pathname.endsWith("/clear")) {
      drafts.delete(input.id);
      draft = null;
    }
    const pending_drafts = [...drafts.values()].map((draft) => ({
      id: draft.id,
      name: draft.name,
      created_at: draft.created_at,
      kind: "capture",
      copies: draft.rows.reduce((n, r) => n + r.quantity, 0),
    }));
    return route.fulfill({
      json: {
        draft,
        ...(raw?.batch
          ? { session_id: raw.id, index: raw.index, staged_id: input.id }
          : {}),
        pending_drafts,
        staged_id: input?.id,
        summary: draft
          ? {
              source_copies: draft.original.total,
              reviewed_copies: draft.original.total,
              additions: draft.original.total,
              errors: [],
              can_add: true,
            }
          : null,
      },
    });
  };
  await page.route("**/api/import-draft**", handler);
  await page.route("**/api/scan-session/batch", handler);
}
