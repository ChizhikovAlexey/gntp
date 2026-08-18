// Drag and drop of bookmarks (edit mode only): reordering inside a
// folder and moving into any other folder, at any nesting level and
// across columns. Hovering a bookmark inserts next to it (top/bottom
// half); a folder header splits into three zones — top quarter inserts
// before, bottom quarter after, and the middle highlights the folder
// itself: dropping there appends inside. The result is written to the
// browser's bookmark store via bookmarks.move(), not kept in the
// extension; the page is then re-rendered from the fresh tree.
//
// dragstart is delegated to the roots (#main and the shelf of hidden
// columns) — only they hold drag handles; dragover, drop and dragend
// live on the document, so releasing the mouse anywhere commits. The
// drag state is module-level, so a drag crosses freely between the
// roots — a bookmark can leave a shelved column for the matrix and
// vice versa.
//
// The preview IS the pending result: every dragover is preventDefaulted
// while a drag is active, and the drop applies exactly the standing
// preview (or the drop-into highlight). The pointer only ever *updates*
// the preview — it never silently invalidates it, so what the page
// shows during the drag is always what releasing the mouse does.

import { isFirefox, moveBookmark } from "./api.js";
import { editMode, saveLayout } from "./dnd.js";
import { createEl, highlighter, targetElement } from "./util.js";

let dragged: HTMLElement | null = null;
// The dragged li's original list and next sibling, to undo the preview
// on cancel and to tell a reorder from a cross-folder move.
let origParent: Element | null = null;
let origNext: Element | null = null;
// Where the pointer was when the zones were last evaluated. A dragover
// closer than HYSTERESIS re-affirms the standing preview instead of
// recomputing it: previews reflow the page, and reevaluating under a
// pointer that has not really moved would let the shifted layout — not
// the user — flip the target back and forth (a folder previewing as a
// new column shifts its neighbours; one of them would then swallow it).
const HYSTERESIS = 5;
let anchorX = 0;
let anchorY = 0;
let anchored = false;
// The folder row a drop would move the bookmark into; mutually
// exclusive with the insertion preview.
const into = highlighter("drop-into");
// The new-column preview: a dragged folder held in the gap between
// columns wears this temporary .column wrapper; dropping commits it as
// a top-level folder occupying that slot.
let ghost: HTMLElement | null = null;
let dropped = false;

/** The re-render used after a move; injected to avoid an import cycle. */
export function initItems(roots: readonly HTMLElement[], rebuild: () => Promise<void>): void {
	const onDragstart = (e: DragEvent): void => {
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
		anchored = false;
		dragged = li;
		dropped = false;
		// A committed ghost survives its dragend so the preview stands
		// until the re-render; by the next drag it is definitely stale.
		dropGhost();
	};

	const onDragover = (e: DragEvent): void => {
		const source = activeDrag();
		if (source === null) return;
		// The drop is allowed everywhere: releasing the mouse commits the
		// standing preview, wherever the pointer happens to be. Below,
		// the pointer position only updates that preview.
		e.preventDefault();
		// Within the hysteresis radius the standing preview is the answer.
		if (anchored && Math.hypot(e.clientX - anchorX, e.clientY - anchorY) < HYSTERESIS) return;
		anchorX = e.clientX;
		anchorY = e.clientY;
		anchored = true;
		// A standing new-column preview holds while the pointer stays
		// inside its box (with a little slack): inserting it shifted the
		// neighbouring columns, and a wobble of the hand over one of them
		// must not let that neighbour swallow the folder back.
		if (ghost !== null && ghost.contains(source)) {
			const rect = ghost.getBoundingClientRect();
			if (
				e.clientX > rect.left - 8 &&
				e.clientX < rect.right + 8 &&
				e.clientY > rect.top - 8 &&
				e.clientY < rect.bottom + 8
			) {
				return;
			}
		}
		const li = targetElement(e)?.closest<HTMLElement>("li[data-id]") ?? null;
		if (li === null) {
			// Off the rows. A dragged folder held in the gap between
			// columns previews as a new top-level column in that slot.
			const slot = columnSlot(source, e);
			if (slot !== null) {
				previewAsColumn(source, slot.row, slot.before);
				return;
			}
			// The empty space below a column's last row is the natural
			// "append to the end of this column" target — and the only
			// workable one when that last row is a folder (whose own
			// after-zone is a few pixels of header).
			const tail = tailUl(source, e);
			// Ahead of the <empty> placeholder when the column is empty.
			if (tail !== null) previewAt(tail, tail.querySelector(":scope > .empty-note"));
			else into.set(null);
			return;
		}
		if (li === source) {
			// Back over the dragged row itself: the drop lands where the
			// preview stands, so any folder target must be dropped first.
			into.set(null);
			return;
		}
		// A folder can never land inside its own subtree: hovering there
		// leaves the preview as it stands.
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
			if (e.clientY < rect.top || e.clientY > rect.bottom) {
				// Below the header of a folder with no rows of its own sits
				// only the <empty> placeholder: preview the row inside the
				// folder, exactly like insertion between rows elsewhere.
				// The dragged row itself is not "a row of its own" — the
				// preview must survive its next dragover events.
				const inner = li.querySelector(":scope > ul");
				if (
					inner !== null &&
					inner.querySelector(":scope > li[data-id]:not(.dragging)") === null
				) {
					previewAt(inner, inner.firstElementChild);
				}
				return;
			}
			const zone = (e.clientY - rect.top) / (rect.height || 1);
			if (canInsert && zone < 0.25) previewAt(ul, li);
			else if (canInsert && zone > 0.75) previewAt(ul, li.nextElementSibling);
			else into.set(li);
			return;
		}
		if (!canInsert) return;
		const rect = li.getBoundingClientRect();
		const after = e.clientY > rect.top + rect.height / 2;
		previewAt(ul, after ? li.nextElementSibling : li);
	};

	const onDrop = (e: DragEvent): void => {
		const source = activeDrag();
		if (source === null) return;
		e.preventDefault();
		const id = source.getAttribute("data-id");
		// Appended to the highlighted folder, made a new top-level column
		// (the ghost preview), or placed where the preview left the row.
		const parentId = into.get()?.getAttribute("data-id");
		const destination =
			parentId !== undefined && parentId !== null
				? { parentId }
				: (ghostDestination(source) ?? targetPosition(source));
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
	};

	for (const root of roots) root.addEventListener("dragstart", onDragstart);
	// On the document: the preview must be committable (and cancelable)
	// no matter where over the page the mouse is released.
	document.addEventListener("dragover", onDragover);
	document.addEventListener("drop", onDrop);
	document.addEventListener("dragend", reset);
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
		into.set(null);
		// Restore only into a list that is still live, with a row that is
		// still live and a reference node that still belongs to that list:
		// a re-render mid-drag replaces all three, and putting the stale
		// row back would duplicate it on the fresh page.
		const before = origNext?.parentElement === origParent ? origNext : null;
		if (!dropped && dragged.isConnected && origParent?.isConnected === true) {
			origParent.insertBefore(dragged, before);
		}
	}
	// An emptied ghost goes with the drag; a committed one stands until
	// the re-render replaces the page (dropGhost keeps it while the row
	// is still inside).
	dropGhost();
	dragged = null;
	origParent = null;
	origNext = null;
	anchored = false;
	dropped = false;
}

/**
 * The child list of the column whose empty tail the pointer sits in:
 * below the column's last row, within its track (matched by x, since
 * the space belongs to the row or shelf box, not the column element),
 * no further down than the row's own band. Null anywhere else — or when
 * the tail belongs to the dragged folder's own subtree.
 */
function tailUl(source: HTMLElement, e: DragEvent): HTMLElement | null {
	const area = targetElement(e)?.closest("#main, #shelf") ?? null;
	if (area === null) return null;
	// Rows stack, so several columns can share the pointer's x; the one
	// whose rows end nearest above the pointer owns the space under it.
	let best: HTMLElement | null = null;
	let bestBottom = -Infinity;
	for (const column of area.querySelectorAll<HTMLElement>(".column")) {
		const rect = column.getBoundingClientRect();
		if (e.clientX < rect.left || e.clientX > rect.right) continue;
		// Strictly below the column's rows (the root li), not merely
		// inside the column box, which the list's own margins pad out.
		const rows = column.querySelector(":scope > ul > li[data-id]")?.getBoundingClientRect();
		if (rows === undefined || e.clientY < rows.bottom || rows.bottom <= bestBottom) continue;
		// Not past the row band (its bottom margin included), or the tail
		// would swallow the gap in front of the next row of columns.
		const band = column.parentElement?.getBoundingClientRect();
		if (band === undefined || e.clientY > band.bottom + 24) continue;
		best = column;
		bestBottom = rows.bottom;
	}
	const ul = best?.querySelector<HTMLElement>(":scope > ul > li[data-id] > ul") ?? null;
	if (ul === null || source.contains(ul)) return null;
	return ul;
}

/** Moves the insertion preview, clearing any drop-into highlight. */
function previewAt(ul: Element, before: Element | null): void {
	if (dragged === null) return;
	into.set(null);
	ul.insertBefore(dragged, before);
	dropGhost();
}

/**
 * The new-column slot under the pointer, for a dragged folder: a gap
 * between (or beside) the columns of a matrix row. Anything else —
 * bookmarks can't be columns, the pointer is over a column or outside
 * the row bands — is null.
 */
function columnSlot(
	source: HTMLElement,
	e: DragEvent,
): { row: Element; before: Element | null } | null {
	if (source.querySelector(":scope > a.folder") === null) return null;
	const area = targetElement(e)?.closest("#main") ?? null;
	if (area === null) return null;
	for (const row of area.querySelectorAll(".grid-row")) {
		const rect = row.getBoundingClientRect();
		if (e.clientY < rect.top || e.clientY > rect.bottom) continue;
		let before: Element | null = null;
		for (const column of row.children) {
			const r = column.getBoundingClientRect();
			if (e.clientX < r.left) {
				before = column;
				break;
			}
			// Inside a column's own box: its tail zone, not a gap.
			if (e.clientX <= r.right) return null;
		}
		return { row, before };
	}
	return null;
}

/**
 * Holds the dragged folder in a temporary column of its own at the
 * given slot — a live preview of it becoming a top-level folder there.
 */
function previewAsColumn(source: HTMLElement, row: Element, before: Element | null): void {
	into.set(null);
	if (ghost === null) {
		ghost = createEl("div", "column");
		const id = source.getAttribute("data-id");
		if (id !== null) ghost.setAttribute("data-id", id);
		ghost.append(createEl("ul"));
	}
	ghost.querySelector(":scope > ul")?.append(source);
	if (before !== ghost) row.insertBefore(ghost, before);
}

/** Discards the ghost column once the dragged row is no longer in it. */
function dropGhost(): void {
	if (ghost !== null && (dragged === null || !ghost.contains(dragged))) {
		ghost.remove();
		ghost = null;
	}
}

/**
 * The move behind a standing new-column preview: into the displayed
 * root itself. The ghost's slot is saved into the column layout first,
 * so the new column keeps its place through the re-render.
 */
function ghostDestination(source: HTMLElement): { parentId: string } | null {
	if (ghost === null || !ghost.contains(source)) return null;
	const main = ghost.closest<HTMLElement>("#main");
	const rootId = main?.getAttribute("data-root");
	if (main === null || rootId === null || rootId === undefined) return null;
	saveLayout(main);
	return { parentId: rootId };
}

/**
 * The move destination derived from where the preview left the dragged
 * <li>: the folder id when it changed lists, and its new index in that
 * folder. Neighbors carry their original bookmark indices in
 * data-index, which accounts for items that exist in the folder but are
 * not rendered (separators).
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
