// Drag and drop of bookmarks (edit mode only): reordering inside a
// folder and moving into any other folder, at any nesting level and
// across columns. Hovering a bookmark inserts next to it (top/bottom
// half); a folder header splits into three zones — top quarter inserts
// before, bottom quarter after, and the middle highlights the folder
// itself: dropping there appends inside. The result is written to the
// browser's bookmark store via bookmarks.move(), not kept in the
// extension; the page is then re-rendered from the fresh tree.
//
// Listeners are delegated to #main, so they survive re-renders and cost
// four closures total instead of four per bookmark.

import { isFirefox, moveBookmark } from "./api.js";
import { editMode } from "./dnd.js";
import { targetElement } from "./util.js";

let dragged: HTMLElement | null = null;
// The dragged li's original list and next sibling, to undo the preview
// on cancel and to tell a reorder from a cross-folder move.
let origParent: Element | null = null;
let origNext: Element | null = null;
// The folder li highlighted as the drop-into target; mutually exclusive
// with the insertion preview.
let intoLi: HTMLElement | null = null;
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
		origParent = li.parentElement;
		origNext = li.nextElementSibling;
		dragged = li;
		dropped = false;
	});

	main.addEventListener("dragover", (e) => {
		const source = activeDrag();
		if (source === null) return;
		const li = targetElement(e)?.closest<HTMLElement>("li[data-id]") ?? null;
		if (li === null) {
			// Off the rows: no drop is allowed here, so no target is shown.
			setInto(null);
			return;
		}
		if (li === source) {
			// Back over the dragged row itself: the drop lands where the
			// preview stands, so any folder target must be dropped first.
			setInto(null);
			e.preventDefault();
			return;
		}
		// A folder can never land inside its own subtree.
		if (source.contains(li)) return;
		const header = li.querySelector<HTMLElement>(":scope > a");
		if (header === null) return;
		// Insertion next to li targets its list; a column root has no such
		// list (its siblings are not bookmarks), leaving only drop-into.
		const ul = li.parentElement;
		const canInsert = ul !== null && ul.closest("li[data-id]") !== null;

		if (header.classList.contains("folder")) {
			// Zones are measured on the header row, not the li: an expanded
			// folder's li spans its children too.
			const rect = header.getBoundingClientRect();
			if (e.clientY < rect.top || e.clientY > rect.bottom) return;
			e.preventDefault();
			const zone = (e.clientY - rect.top) / (rect.height || 1);
			if (canInsert && zone < 0.25) previewAt(ul, li);
			else if (canInsert && zone > 0.75) previewAt(ul, li.nextElementSibling);
			else setInto(li);
			return;
		}
		if (!canInsert) return;
		e.preventDefault();
		const rect = li.getBoundingClientRect();
		const after = e.clientY > rect.top + rect.height / 2;
		previewAt(ul, after ? li.nextElementSibling : li);
	});

	main.addEventListener("drop", (e) => {
		const source = activeDrag();
		if (source === null) return;
		e.preventDefault();
		const id = source.getAttribute("data-id");
		// Appended to the highlighted folder, or placed where the preview
		// left the row.
		const parentId = intoLi?.getAttribute("data-id");
		const destination =
			parentId !== undefined && parentId !== null ? { parentId } : targetPosition(source);
		if (id === null || destination === null) return;
		// Left false above, so an undecipherable drop restores the preview
		// in dragend instead of leaving the page out of step with the
		// bookmark store.
		dropped = true;
		// The move can still be refused (the folder deleted in another
		// window); the page is rebuilt from the tree either way, so the
		// rejection is observed here rather than left unhandled.
		void moveBookmark(id, destination)
			.catch(() => undefined)
			.finally(rebuild);
	});

	main.addEventListener("dragend", reset);
}

/**
 * The row being dragged, or null. A re-render during a drag detaches
 * it, and its dragend then fires on the detached node — never reaching
 * the delegated listeners — so the stale state is dropped here instead
 * of being carried into the next drag.
 */
function activeDrag(): HTMLElement | null {
	if (dragged !== null && !dragged.isConnected) reset();
	return dragged;
}

/** Ends the drag, undoing the preview unless it was committed. */
function reset(): void {
	if (dragged !== null) {
		dragged.classList.remove("dragging");
		setInto(null);
		// Restore only into a list that is still live, with a row that is
		// still live and a reference node that still belongs to that list:
		// a re-render mid-drag replaces all three, and putting the stale
		// row back would duplicate it on the fresh page.
		const before = origNext?.parentElement === origParent ? origNext : null;
		if (!dropped && dragged.isConnected && origParent?.isConnected === true) {
			origParent.insertBefore(dragged, before);
		}
	}
	dragged = null;
	origParent = null;
	origNext = null;
	dropped = false;
}

/** Moves the insertion preview, clearing any drop-into highlight. */
function previewAt(ul: Element, before: Element | null): void {
	if (dragged === null) return;
	setInto(null);
	ul.insertBefore(dragged, before);
}

/** Highlights `li` as the folder a drop would move the bookmark into. */
function setInto(li: HTMLElement | null): void {
	if (intoLi === li) return;
	intoLi?.classList.remove("drop-into");
	intoLi = li;
	li?.classList.add("drop-into");
}

/**
 * The move destination derived from where the preview left the dragged
 * <li>: the folder id when it changed lists, and its new index in that
 * folder. Neighbors carry their original bookmark indices in
 * data-index, which accounts for items that exist in the folder but are
 * not rendered (separators, empty subfolders).
 */
function targetPosition(li: HTMLElement): { parentId?: string; index: number } | null {
	// The preview never left home. Moving anyway would re-seat the item
	// right after its previous *rendered* neighbour, jumping it over
	// separators and empty folders that sit in between — a real reorder
	// in the bookmark store from a gesture that changed nothing.
	if (li.parentElement === origParent && li.nextElementSibling === origNext) return null;
	const ul = li.parentElement;
	const parentId = ul?.closest("li[data-id]")?.getAttribute("data-id");
	if (ul === null || parentId === null || parentId === undefined) return null;
	const sameFolder = ul === origParent;
	const prev = li.previousElementSibling;
	if (prev === null) return sameFolder ? { index: 0 } : { parentId, index: 0 };
	const p = attrIndex(prev);
	if (p === null) return null;
	// A cross-folder move needs no removal adjustment: the source list is
	// not the one being inserted into.
	if (!sameFolder) return { parentId, index: p + 1 };
	const orig = attrIndex(li);
	if (orig === null) return null;
	// Moving down: Firefox expects the final position (the list without
	// the item), Chromium the pre-removal position — one higher.
	const index = orig < p ? (isFirefox ? p : p + 1) : p + 1;
	return { index };
}

function attrIndex(el: Element): number | null {
	const value = el.getAttribute("data-index");
	if (value === null) return null;
	const index = Number(value);
	return Number.isInteger(index) ? index : null;
}
