// Hiding items — folders and single bookmarks alike. Hidden state is an
// extension-level preference (the bookmark store has no such flag),
// kept in localStorage under "hidden".
//
// Hidden items are always rendered and hidden by CSS outside edit mode,
// so toggling edit mode reveals them without a re-render.

import { loadCsv, saveCsv, targetElement } from "./util.js";

const KEY = "hidden";

export function loadHidden(): Set<string> {
	return new Set(loadCsv(KEY));
}

/** One delegated click listener on #main; survives re-renders. */
export function initHidden(main: HTMLElement): void {
	main.addEventListener("click", (e) => {
		const target = targetElement(e);
		if (target === null || !target.classList.contains("hide-toggle")) return;
		const li = target.closest("li[data-id]");
		const id = li?.getAttribute("data-id");
		if (li === null || id === null || id === undefined) return;

		const ids = loadHidden();
		if (!ids.delete(id)) ids.add(id);
		saveCsv(KEY, ids);

		li.classList.toggle("hidden");
		// Hiding a column's root folder hides the whole column.
		const column = li.closest(".column");
		if (column?.getAttribute("data-id") === id) column.classList.toggle("hidden");
	});
}
