export const IMPORT_PENDING_TAG = Object.freeze({
  id: "ae07f79b-38cc-44a2-8fc9-56588cf003ab",
  family: "system",
  key: "system:import-pending",
  label: "Import pending",
  type: "system",
  kind: "import-pending",
});
export const isSystemTag = (tag) =>
  tag?.family === "system" ||
  tag?.type === "system" ||
  tag?.id === IMPORT_PENDING_TAG.id;
