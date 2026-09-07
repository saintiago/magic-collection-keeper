import {
  validateEntry,
  validateQuantity,
  validateSearch,
} from "../domain/inventory.js";
// Ports are ordinary objects. No HTTP, browser, Scryfall, or AWS dependencies.
export function createCollectionService({ repository, catalog }) {
  return {
    list: (owner) => repository.list(owner),
    async search(query, page = 1) {
      validateSearch(query, page);
      return catalog.search(query, page);
    },
    async add(owner, input) {
      const printing = await repository.getPrinting(input.printing_id);
      validateEntry(input, printing);
      await repository.add(owner, input, printing);
      return repository.list(owner);
    },
    async setQuantity(owner, id, quantity) {
      validateQuantity(quantity);
      await repository.setQuantity(owner, id, quantity);
      return repository.list(owner);
    },
    async remove(owner, id) {
      await repository.remove(owner, id);
      return repository.list(owner);
    },
  };
}
