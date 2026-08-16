// Drag and drop of columns across the row matrix. The layout persists
// in localStorage under "columns" as rows of comma-separated ids joined
// with "|" (a legacy comma-only value reads as a single row).
//
// The matrix is reordered live while dragging: hovering a column
// inserts next to it; dragging past the bottom edge of the last row
// previews a new tail row. Drop commits (cascading overflow past the
// row limit), a cancelled drag restores the saved layout. Listeners are delegated to
// #main — four in total, independent of the column count.

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
	for (const row of main.querySelectorAll(".grid-row")) {
		const ids: string[] = [];
		for (const column of row.children) {
			const id = column.getAttribute("data-id");
			if (id !== null) ids.push(id);
		}
		if (ids.length > 0) rows.push(ids.join(","));
	}
	storageSet("columns", rows.join("|"));
}

/**
 * Enforces the row limit by cascading overflowing columns into the next
 * row, and drops empty rows.
 */
export function normalizeRows(main: HTMLElement, cap: number): void {
	const rows = [...main.querySelectorAll<HTMLElement>(".grid-row")];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row === undefined) continue;
		while (row.children.length > cap) {
			let next = rows[i + 1];
			if (next === undefined) {
				next = createEl("div", "grid-row");
				main.append(next);
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
		if (dragged === null) return;
		e.preventDefault();
		const over = targetElement(e)?.closest<HTMLElement>(".column");
		if (over !== null && over !== undefined) {
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
		if (dragged === null) return;
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

/** Moves the dragged column, pruning its old row if that empties it. */
function moveInto(row: Element | null, before: Element | null): void {
	if (dragged === null || row === null) return;
	const from = dragged.parentElement;
	row.insertBefore(dragged, before);
	if (from !== null && from !== row && from.children.length === 0) from.remove();
}

function previewTailRow(main: HTMLElement, y: number): void {
	if (dragged === null) return;
	const last = main.querySelector<HTMLElement>(".grid-row:last-of-type");
	if (last === null || y <= last.getBoundingClientRect().bottom) return;
	// Already the sole occupant of the last row: nothing to do.
	const current = dragged.parentElement;
	if (current === last && last.children.length === 1) return;
	const row = createEl("div", "grid-row");
	main.append(row);
	moveInto(row, null);
	// This path bypasses normalizeRows, so the tracks are synced here.
	syncTracks(main, main.querySelectorAll(".grid-row"));
}
