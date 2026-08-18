// Hiding items — folders and single bookmarks alike. Hidden state is an
// extension-level preference (the bookmark store has no such flag),
// kept in localStorage under "hidden".
//
// Hidden items are always rendered and hidden by CSS outside edit mode,
// so toggling edit mode reveals them without a re-render.

import { eventItem, loadCsv, saveCsv, targetElement } from "./util.js";

const KEY = "hidden";

export function loadHidden(): Set<string> {
	return new Set(loadCsv(KEY));
}

/**
 * Writes one item's hidden state; true when that changed anything.
 * Used by the eye toggle here and by column drags onto/off the shelf
 * (dnd.ts), which are the same action in a different gesture.
 */
export function storeHidden(id: string, hidden: boolean): boolean {
	const ids = loadHidden();
	if (hidden === ids.has(id)) return false;
	if (hidden) ids.add(id);
	else ids.delete(id);
	saveCsv(KEY, ids);
	return true;
}

/**
 * One delegated click listener per root; survives re-renders. Both the
 * matrix and the shelf are passed: the shelf lives outside #main, and
 * its eyes bring columns back (dragging them off the shelf works too).
 *
 * `columnToggled` runs when the toggle hid or revealed a whole column,
 * which moves between the matrix and the shelf (see dnd.ts).
 */
export function initHidden(
	roots: readonly HTMLElement[],
	columnToggled: (column: HTMLElement, hidden: boolean) => void,
): void {
	const onClick = (e: Event): void => {
		if (targetElement(e)?.classList.contains("hide-toggle") !== true) return;
		const item = eventItem(e);
		if (item === null) return;
		const { li, id } = item;

		storeHidden(id, !loadHidden().has(id));

		li.classList.toggle("hidden");
		// Hiding a column's root folder hides the whole column.
		const column = li.closest<HTMLElement>(".column");
		if (column?.getAttribute("data-id") === id) {
			columnToggled(column, column.classList.toggle("hidden"));
		}
	};
	for (const root of roots) root.addEventListener("click", onClick);
}
