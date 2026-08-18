// Drag and drop of columns across the row matrix. The layout persists
// in localStorage under "columns" as rows of comma-separated ids joined
// with "|" (a legacy comma-only value reads as a single row).
//
// Hidden columns live on the shelf, a container of its own after the
// matrix (shown in edit mode only), so they stay out of the saved
// layout, the row cascade and the grid's track sizing entirely.
// Dragging a column onto the shelf hides it and dragging it back into
// the matrix shows it — the same state change as the eye, in a
// different gesture. Shelf bookmarks also move as items like any
// others (items.ts listens on the shelf too).
//
// The matrix is reordered live while dragging: hovering a column
// inserts next to it; a folder title nests the column inside; the band
// under the last row previews a new tail row; anything below the
// matrix box lands the column on the shelf. Drop commits (cascading
// overflow past the row limit), a cancelled drag restores the saved
// layout. dragstart and dragend are delegated to #main and the shelf —
// they hold the handles; dragover and drop live on the document, so
// the standing preview commits wherever the mouse is released.

import { moveBookmark } from "./api.js";
import { storeHidden } from "./hidden.js";
import {
	createEl,
	highlighter,
	iconSpan,
	setClass,
	storageGet,
	storageSet,
	targetElement,
} from "./util.js";

let dragged: HTMLElement | null = null;
let dropped = false;
let editing = false;
// The folder row a drop would move the whole column into (its title
// hovered); mirrors the drop-into of item drags (items.ts).
const into = highlighter("drop-into");

export function editMode(): boolean {
	return editing;
}

/**
 * Enables or disables column drag and drop; the "editing" class
 * shows/hides the drag handles.
 */
export function setEditMode(main: HTMLElement, enabled: boolean): void {
	editing = enabled;
	setClass(main, "editing", enabled);
}

/** The saved matrix: rows of column ids. */
export function loadLayout(): string[][] {
	const raw = storageGet("columns");
	if (raw === null || raw === "") return [];
	return raw.split("|").map((row) => row.split(",").filter((id) => id !== ""));
}

/**
 * Persists the matrix as it stands in the DOM. Exported for items.ts,
 * whose new-column preview (a nested folder dragged into a column gap)
 * must save the ghost column's slot before the move re-renders.
 */
export function saveLayout(main: HTMLElement): void {
	const rows: string[] = [];
	for (const row of matrixRows(main)) {
		const ids: string[] = [];
		for (const column of row.children) {
			const id = column.getAttribute("data-id");
			if (id !== null) ids.push(id);
		}
		if (ids.length > 0) rows.push(ids.join(","));
	}
	storageSet("columns", rows.join("|"));
}

function matrixRows(main: HTMLElement): HTMLElement[] {
	return [...main.querySelectorAll<HTMLElement>(".grid-row")];
}

function appendRow(main: HTMLElement): HTMLElement {
	const row = createEl("div", "grid-row");
	main.append(row);
	return row;
}

/**
 * Enforces the row limit by cascading overflowing columns into the next
 * row, and drops empty rows.
 */
export function normalizeRows(main: HTMLElement, cap: number): void {
	const rows = matrixRows(main);
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row === undefined) continue;
		while (row.children.length > cap) {
			let next = rows[i + 1];
			if (next === undefined) {
				next = appendRow(main);
				rows.push(next);
			}
			const overflow = row.lastElementChild;
			if (overflow === null) break;
			next.insertBefore(overflow, next.firstChild);
		}
	}
	for (const row of rows) if (row.children.length === 0) row.remove();
	syncTracks(main, rows);
}

/**
 * Publishes the track count the rows subgrid onto: the longest row's
 * length. An empty trailing track would still add its gap, so the count
 * follows the actual rows, not the row limit.
 */
function syncTracks(main: HTMLElement, rows: Iterable<Element>): void {
	let cols = 1;
	for (const row of rows) cols = Math.max(cols, row.children.length);
	// Runs on every drag preview: skip the style invalidation when the
	// count has not moved.
	const value = String(cols);
	if (main.style.getPropertyValue("--cols") !== value) {
		main.style.setProperty("--cols", value);
	}
}

/**
 * Moves a top-level column between the matrix and the hidden shelf, so
 * hidden columns never occupy matrix cells. Hiding frees the column's
 * cell (its emptied row closes up); unhiding appends the column to the
 * last row. The saved layout follows.
 */
export function setColumnHidden(
	main: HTMLElement,
	shelf: HTMLElement,
	column: HTMLElement,
	hidden: boolean,
	cap: number,
): void {
	if (hidden) {
		shelf.append(column);
	} else {
		const rows = matrixRows(main);
		(rows[rows.length - 1] ?? appendRow(main)).append(column);
	}
	normalizeRows(main, cap);
	saveLayout(main);
}

/** Marks a column as draggable by the handle placed in its root row. */
export function makeDraggable(column: HTMLElement, id: string, rootLi: Element): void {
	column.setAttribute("data-id", id);
	// The extra class keeps items.ts from treating it as an item handle.
	const handle = iconSpan("drag-handle column-handle", "grip");
	handle.draggable = true;
	rootLi.insertBefore(handle, rootLi.firstChild);
}

/**
 * The drag listeners; call once. `relayout` re-measures the matrix
 * after a drop — the preview moves columns between rows, which changes
 * how much width each row asks for.
 */
export function initColumnDnd(
	main: HTMLElement,
	shelf: HTMLElement,
	rowLimit: () => number,
	restore: () => void,
	relayout: () => void,
): void {
	const onDragstart = (e: DragEvent): void => {
		const target = targetElement(e);
		if (target === null || !target.classList.contains("column-handle")) return;
		const column = target.closest<HTMLElement>(".column");
		if (column === null) return;
		if (!editing) {
			e.preventDefault();
			return;
		}
		column.classList.add("dragging");
		// Firefox needs dataTransfer content for the drag to start.
		if (e.dataTransfer !== null) {
			e.dataTransfer.setData("text/plain", column.getAttribute("data-id") ?? "");
			const rect = column.getBoundingClientRect();
			e.dataTransfer.setDragImage(column, e.clientX - rect.left, e.clientY - rect.top);
		}
		dragged = column;
		dropped = false;
	};
	main.addEventListener("dragstart", onDragstart);
	shelf.addEventListener("dragstart", onDragstart);

	// On document, not #main: the tail-row preview lives below #main's
	// box, and the drop must be allowed there too.
	document.addEventListener("dragover", (e) => {
		const column = activeDrag();
		if (column === null) return;
		e.preventDefault();
		const target = targetElement(e);
		// A folder row's title (any column, matrix or shelf, but never the
		// dragged column's own subtree) is the nest-into target: dropping
		// the column there moves the whole folder inside. Everywhere else
		// keeps the layout gestures below.
		const nest = target?.closest("a.folder")?.closest<HTMLElement>("li[data-id]") ?? null;
		if (nest !== null && !column.contains(nest)) {
			into.set(nest);
			return;
		}
		into.set(null);
		const over = target?.closest<HTMLElement>(".column") ?? null;
		// A matrix column under the pointer: reorder within the matrix.
		if (over !== null && !shelf.contains(over)) {
			if (over === column) return;
			insertBeside(over.parentElement, over, e.clientX);
			// Cascade the row-limit overflow live, as part of the preview.
			normalizeRows(main, rowLimit());
			return;
		}
		// Everything below the matrix box — the caption, the shelf, the
		// rest of the page — is the hide zone. The boundary is geometric
		// (not "over the shelf's elements") and self-stabilizing: the
		// column previewing onto the shelf shrinks the matrix, moving its
		// bottom edge *away* from the pointer, so the state latches
		// instead of flip-flopping as the page reflows under the drag.
		if (e.clientY > main.getBoundingClientRect().bottom) {
			if (over !== null && over !== column) {
				insertBeside(shelf, over, e.clientX);
			} else if (column.parentElement !== shelf) {
				// Never re-append a column already previewing on the shelf,
				// which would jump it to the end on every pointer move.
				moveInto(shelf, null);
			}
			// The matrix may have just lost the column: close its gap.
			normalizeRows(main, rowLimit());
			return;
		}
		// The narrow band left under the last row (still inside the
		// matrix box): a new tail row. Its preview grows the matrix down
		// past the pointer — the same latching, in the other direction.
		previewTailRow(main, e.clientY);
	});

	document.addEventListener("drop", (e) => {
		const column = activeDrag();
		if (column === null) return;
		e.preventDefault();
		dropped = true;
		const id = column.getAttribute("data-id");
		// The highlighted folder wins over layout: the column becomes a
		// nested folder inside it — a real move in the bookmark store —
		// and sheds its own hidden flag, which only means something for
		// top-level columns.
		const nestId = into.get()?.getAttribute("data-id");
		if (id !== null && nestId !== undefined && nestId !== null) {
			into.set(null);
			storeHidden(id, false);
			void moveBookmark(id, { parentId: nestId })
				.catch(() => undefined)
				.finally(restore);
			return;
		}
		// Landing on the shelf hides the column, leaving it shows it —
		// the same state the eye toggles, committed by the drop.
		const hidden = shelf.contains(column);
		if (id !== null && storeHidden(id, hidden)) {
			column.classList.toggle("hidden", hidden);
			column.querySelector(":scope > ul > li")?.classList.toggle("hidden", hidden);
		}
		normalizeRows(main, rowLimit());
		saveLayout(main);
		relayout();
	});

	const onDragend = (e: DragEvent): void => {
		if (targetElement(e)?.classList.contains("column-handle") !== true) return;
		into.set(null);
		if (dragged !== null) {
			dragged.classList.remove("dragging");
			if (!dropped) restore();
		}
		dragged = null;
		dropped = false;
	};
	main.addEventListener("dragend", onDragend);
	shelf.addEventListener("dragend", onDragend);
}

/**
 * The column being dragged, or null. A re-render during a drag detaches
 * it, and its dragend then fires on the detached node — never reaching
 * the delegated listeners — so the stale state is dropped here instead
 * of being carried into the next drag.
 */
function activeDrag(): HTMLElement | null {
	if (dragged !== null && !dragged.isConnected) {
		dragged = null;
		dropped = false;
		into.set(null);
	}
	return dragged;
}

/** Puts the dragged column beside `over` — the pointer's half decides. */
function insertBeside(container: Element | null, over: HTMLElement, x: number): void {
	const rect = over.getBoundingClientRect();
	const after = x > rect.left + rect.width / 2;
	moveInto(container, after ? over.nextElementSibling : over);
}

/** Moves the dragged column, pruning its old row if that empties it. */
function moveInto(row: Element | null, before: Element | null): void {
	if (dragged === null || row === null) return;
	const from = dragged.parentElement;
	row.insertBefore(dragged, before);
	// Only matrix rows are disposable. The shelf can also empty out here
	// (its last column dragged back into the matrix), but it is a
	// permanent container — removing it would strand every column
	// hidden afterwards in a detached element, visible nowhere.
	if (
		from !== null &&
		from !== row &&
		from.children.length === 0 &&
		from.classList.contains("grid-row")
	) {
		from.remove();
	}
}

function previewTailRow(main: HTMLElement, y: number): void {
	if (dragged === null) return;
	const rows = matrixRows(main);
	const last = rows[rows.length - 1];
	if (last === undefined || y <= last.getBoundingClientRect().bottom) return;
	// Already the sole occupant of the last row: nothing to do.
	if (dragged.parentElement === last && last.children.length === 1) return;
	moveInto(appendRow(main), null);
	// This path bypasses normalizeRows, so the tracks are synced here.
	syncTracks(main, matrixRows(main));
}
