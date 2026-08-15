// Collapsible folders at any nesting level: clicking a folder header
// toggles its children.
//
// Defaults: nested folders are collapsed, column roots are open. The
// set of *deviations* from those defaults lives in this page's memory —
// so re-renders (e.g. after drag and drop) never change fold state —
// and persists in localStorage under "folds" while the "Remember open
// folders" setting is on.

import { loadCsv, saveCsv, storageGet, storageRemove, targetElement } from "./util.js";

const KEY = "folds";

let state: Set<string> | null = null;

/** The "Remember open folders" setting; on unless explicitly disabled. */
export function remember(): boolean {
	return storageGet("remember_open") !== "0";
}

function deviationSet(): Set<string> {
	state ??= new Set(remember() ? loadCsv(KEY) : []);
	return state;
}

/** Folder ids whose fold state deviates from the default, for rendering. */
export function deviations(): ReadonlySet<string> {
	return deviationSet();
}

/**
 * Writes the current state to storage (used when the remember setting
 * is turned on mid-session).
 */
export function persistFolds(): void {
	saveCsv(KEY, deviationSet());
}

/**
 * Forgets the stored state (used when the setting is turned off); the
 * current page keeps its in-memory state.
 */
export function clearFolds(): void {
	storageRemove(KEY);
}

/**
 * One delegated click listener on #main; survives re-renders. Nested
 * folders render lazily (HNTP-style, to keep the DOM small): `expand`
 * builds a folder's children on open, and collapsing removes them.
 */
export function initFolds(
	main: HTMLElement,
	expand: (li: HTMLElement, id: string) => void,
): void {
	main.addEventListener("click", (e) => {
		const target = targetElement(e);
		if (target === null || target.closest("a.folder") === null) return;
		const li = target.closest<HTMLElement>("li[data-id]");
		const id = li?.getAttribute("data-id");
		if (li === null || id === null || id === undefined) return;

		const collapsed = li.classList.toggle("collapsed");
		// Column roots default to open, nested folders to collapsed.
		const isRoot = li.matches(".column > ul > li");
		const deviated = collapsed === isRoot;
		const set = deviationSet();
		if (deviated) set.add(id);
		else set.delete(id);
		if (remember()) saveCsv(KEY, set);

		if (!isRoot) {
			if (collapsed) li.querySelector(":scope > ul")?.remove();
			else expand(li, id);
		}
	});
}
