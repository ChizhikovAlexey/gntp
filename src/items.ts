// Drag and drop reordering of bookmarks inside their folder (edit mode
// only). The result is written to the browser's bookmark store via
// bookmarks.move(), not kept in the extension; the page is then
// re-rendered from the fresh tree.
//
// Listeners are delegated to #main, so they survive re-renders and cost
// four closures total instead of four per bookmark.

import { isFirefox, moveBookmark } from "./api.js";
import { editMode } from "./dnd.js";
import { targetElement } from "./util.js";

let dragged: HTMLElement | null = null;
// The dragged li's next sibling, to undo the preview on cancel.
let origNext: Element | null = null;
let dropped = false;

/** The re-render used after a move; injected to avoid an import cycle. */
export function initItems(main: HTMLElement, rebuild: () => Promise<void>): void {
	main.addEventListener("dragstart", (e) => {
		const target = targetElement(e);
		// Column handles belong to dnd.ts.
		if (
			target === null ||
			!target.classList.contains("drag-handle") ||
			target.classList.contains("column-handle")
		) {
			return;
		}
		const li = target.closest<HTMLElement>("li[data-id]");
		if (li === null) return;
		if (!editMode()) {
			e.preventDefault();
			return;
		}
		li.classList.add("dragging");
		if (e.dataTransfer !== null) {
			e.dataTransfer.setData("text/plain", li.getAttribute("data-id") ?? "");
			const rect = li.getBoundingClientRect();
			e.dataTransfer.setDragImage(li, e.clientX - rect.left, e.clientY - rect.top);
		}
		origNext = li.nextElementSibling;
		dragged = li;
		dropped = false;
	});

	main.addEventListener("dragover", (e) => {
		if (dragged === null) return;
		const li = targetElement(e)?.closest("li[data-id]");
		if (li === null || li === undefined) return;
		if (li === dragged) {
			e.preventDefault();
			return;
		}
		if (li.parentElement !== dragged.parentElement) return;
		e.preventDefault();
		const rect = li.getBoundingClientRect();
		const after = e.clientY > rect.top + rect.height / 2;
		dragged.parentElement?.insertBefore(dragged, after ? li.nextElementSibling : li);
	});

	main.addEventListener("drop", (e) => {
		if (dragged === null) return;
		e.preventDefault();
		dropped = true;
		const position = targetPosition(dragged);
		if (position === null) return;
		void moveBookmark(position.id, position.index).finally(rebuild);
	});

	main.addEventListener("dragend", () => {
		if (dragged !== null) {
			dragged.classList.remove("dragging");
			if (!dropped) {
				dragged.parentElement?.insertBefore(dragged, origNext);
			}
		}
		dragged = null;
		origNext = null;
		dropped = false;
	});
}

/**
 * Bookmark id and its new index in the folder, derived from where the
 * preview left the dragged <li>. Neighbors carry their original
 * bookmark indices in data-index, which accounts for items that exist
 * in the folder but are not rendered (separators, empty subfolders).
 */
function targetPosition(li: HTMLElement): { id: string; index: number } | null {
	const id = li.getAttribute("data-id");
	const orig = attrIndex(li);
	if (id === null || orig === null) return null;
	const prev = li.previousElementSibling;
	if (prev === null) return { id, index: 0 };
	const p = attrIndex(prev);
	if (p === null) return null;
	// Moving down: Firefox expects the final position (the list without
	// the item), Chromium the pre-removal position — one higher.
	const index = orig < p ? (isFirefox ? p : p + 1) : p + 1;
	return { id, index };
}

function attrIndex(el: Element): number | null {
	const value = el.getAttribute("data-index");
	if (value === null) return null;
	const index = Number(value);
	return Number.isInteger(index) ? index : null;
}
