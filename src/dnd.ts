// Drag and drop reordering of columns, with the order persisted in
// localStorage under the "columns" key (comma-separated folder ids).
//
// Columns are reordered live while dragging (the DOM is updated on
// dragover as a preview); drop commits the order, a cancelled drag
// (Esc / dropped outside) restores the original position. Listeners are
// delegated to #main — four in total, independent of the column count.

import { createEl, loadCsv, saveCsv, setClass, targetElement } from "./util.js";

let dragged: HTMLElement | null = null;
// The dragged column's next sibling, to undo the preview on cancel.
let origNext: Element | null = null;
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

export function loadOrder(): string[] {
	return loadCsv("columns");
}

function saveOrder(main: HTMLElement): void {
	const ids: string[] = [];
	for (const el of main.children) {
		const id = el.getAttribute("data-id");
		if (id !== null) ids.push(id);
	}
	saveCsv("columns", ids);
}

/** Marks a column as draggable by the handle placed in its root row. */
export function makeDraggable(column: HTMLElement, id: string, rootLi: Element): void {
	column.setAttribute("data-id", id);
	// The extra class keeps items.ts from treating it as an item handle.
	const handle = createEl("span", "drag-handle column-handle", "⠿");
	handle.draggable = true;
	rootLi.insertBefore(handle, rootLi.firstChild);
}

/** The four delegated listeners; call once. */
export function initColumnDnd(main: HTMLElement): void {
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
		origNext = column.nextElementSibling;
		dropped = false;
	});

	main.addEventListener("dragover", (e) => {
		if (dragged === null) return;
		const column = targetElement(e)?.closest<HTMLElement>(".column");
		if (column === null || column === undefined) return;
		e.preventDefault();
		if (column === dragged) return;
		const rect = column.getBoundingClientRect();
		const after = e.clientX > rect.left + rect.width / 2;
		main.insertBefore(dragged, after ? column.nextElementSibling : column);
	});

	main.addEventListener("drop", (e) => {
		if (dragged === null) return;
		e.preventDefault();
		dropped = true;
		saveOrder(main);
	});

	main.addEventListener("dragend", (e) => {
		if (targetElement(e)?.classList.contains("column-handle") !== true) return;
		if (dragged !== null) {
			dragged.classList.remove("dragging");
			if (!dropped) main.insertBefore(dragged, origNext);
		}
		dragged = null;
		origNext = null;
		dropped = false;
	});
}
