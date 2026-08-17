// Drag and drop of columns across the row matrix. The layout persists
// in localStorage under "columns" as rows of comma-separated ids joined
// with "|" (a legacy comma-only value reads as a single row).
//
// Hidden columns live on the shelf, a container of its own after the
// matrix (shown in edit mode only), so they stay out of the saved
// layout, the row cascade and the grid's track sizing entirely. Shelf
// columns are not draggable and accept no drops: the eye puts them
// back.
//
// The matrix is reordered live while dragging: hovering a column
// inserts next to it; dragging past the bottom edge of the last row
// previews a new tail row. Drop commits (cascading overflow past the
// row limit), a cancelled drag restores the saved layout. The four
// listeners are delegated — dragstart and dragend on #main, dragover
// and drop on the document, whose box also covers the tail-row preview
// below the matrix — so their number is independent of the columns.

import { createEl, setClass, storageGet, storageSet, targetElement } from "./util.js";

let dragged: HTMLElement | null = null;
let dropped = false;
let editing = false;

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

function saveLayout(main: HTMLElement): void {
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
	const handle = createEl("span", "drag-handle column-handle", "⠿");
	handle.draggable = true;
	rootLi.insertBefore(handle, rootLi.firstChild);
}

/**
 * The four delegated listeners; call once. `relayout` re-measures the
 * matrix after a drop — the preview moves columns between rows, which
 * changes how much width each row asks for.
 */
export function initColumnDnd(
	main: HTMLElement,
	shelf: HTMLElement,
	rowLimit: () => number,
	restore: () => void,
	relayout: () => void,
): void {
	main.addEventListener("dragstart", (e) => {
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
	});

	// On document, not #main: the tail-row preview lives below #main's
	// box, and the drop must be allowed there too.
	document.addEventListener("dragover", (e) => {
		if (activeDrag() === null) return;
		e.preventDefault();
		const over = targetElement(e)?.closest<HTMLElement>(".column");
		// A shelf column is no insertion anchor: hovering the shelf acts
		// like empty space below the matrix.
		if (over !== null && over !== undefined && !shelf.contains(over)) {
			if (over === dragged) return;
			// Left half inserts before the hovered column, right half after.
			const rect = over.getBoundingClientRect();
			const after = e.clientX > rect.left + rect.width / 2;
			moveInto(over.parentElement, after ? over.nextElementSibling : over);
			// Cascade the row-limit overflow live, as part of the preview.
			normalizeRows(main, rowLimit());
		} else {
			// A new row appears only when the pointer actually leaves the
			// matrix past its bottom edge; never above the first row.
			previewTailRow(main, e.clientY);
		}
	});

	document.addEventListener("drop", (e) => {
		if (activeDrag() === null) return;
		e.preventDefault();
		dropped = true;
		normalizeRows(main, rowLimit());
		saveLayout(main);
		relayout();
	});

	main.addEventListener("dragend", (e) => {
		if (targetElement(e)?.classList.contains("column-handle") !== true) return;
		if (dragged !== null) {
			dragged.classList.remove("dragging");
			if (!dropped) restore();
		}
		dragged = null;
		dropped = false;
	});
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
	}
	return dragged;
}

/** Moves the dragged column, pruning its old row if that empties it. */
function moveInto(row: Element | null, before: Element | null): void {
	if (dragged === null || row === null) return;
	const from = dragged.parentElement;
	row.insertBefore(dragged, before);
	if (from !== null && from !== row && from.children.length === 0) from.remove();
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
