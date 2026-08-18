// Small helpers shared by every module.

export function storageGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function storageSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* quota/availability failures are non-fatal */
	}
}

export function storageRemove(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

/** A stored comma-separated id list (ids never contain commas). */
export function loadCsv(key: string): string[] {
	const value = storageGet(key);
	return value === null || value === "" ? [] : value.split(",");
}

export function saveCsv(key: string, values: Iterable<string>): void {
	storageSet(key, [...values].join(","));
}

/** The event target as an Element, or null. */
export function targetElement(e: Event): Element | null {
	return e.target instanceof Element ? e.target : null;
}

/** The bookmark row the event happened in, with its bookmark id. */
export function eventItem(e: Event): { li: HTMLElement; id: string } | null {
	const li = targetElement(e)?.closest<HTMLElement>("li[data-id]") ?? null;
	const id = li?.getAttribute("data-id") ?? null;
	return li === null || id === null ? null : { li, id };
}

/** Adds or removes a class depending on `on`. */
export function setClass(el: Element, name: string, on: boolean): void {
	el.classList.toggle(name, on);
}

export function createEl<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (className !== undefined) el.className = className;
	if (text !== undefined) el.textContent = text;
	return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Single-color icon outlines on a 24×24 grid (Material Icons shapes). */
const ICON_PATHS = {
	eye: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
	pencil: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
	gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
	reset: "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
	cross: "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
	// Material's stroke weight (2-unit bars), but with the arms extended
	// to the 4..20 span the neighbouring icons occupy: the stock 5..19
	// plus leaves more blank margin inside its button than the gear or
	// pencil do, which read as a wider gap between the corner buttons.
	plus: "M13 4h-2v7H4v2h7v7h2v-7h7v-2h-7z",
	bookmark: "M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z",
	folder: "M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z",
} as const;

export type IconKind = keyof typeof ICON_PATHS | "grip";

/**
 * A small single-color inline SVG icon. Font glyphs (👁︎ ✎︎ ⚙︎ ⠿ ⟳ ✕)
 * render at wildly different sizes across platforms — Chromium picks a
 * color-emoji eye that overlaps its neighbours — so the UI draws its
 * own shapes: identical geometry everywhere, colored by currentColor.
 * Sizing and click-inertness live in newtab.css, so delegated listeners
 * always see the icon's host element as the event target.
 */
export function svgIcon(kind: IconKind): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	if (kind === "grip") {
		// A 2×3 dot grip, like the ⠿ it replaces.
		for (const cy of [5, 12, 19]) {
			for (const cx of [8.5, 15.5]) {
				const dot = document.createElementNS(SVG_NS, "circle");
				dot.setAttribute("cx", String(cx));
				dot.setAttribute("cy", String(cy));
				dot.setAttribute("r", "2");
				svg.append(dot);
			}
		}
	} else {
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("d", ICON_PATHS[kind]);
		svg.append(path);
	}
	return svg;
}

/** A span holding an icon — the gutter controls and inline text icons. */
export function iconSpan(className: string, kind: IconKind): HTMLElement {
	const span = createEl("span", className);
	span.append(svgIcon(kind));
	return span;
}

/** A one-element highlight: setting a new element clears the previous. */
export interface Highlight {
	set(el: HTMLElement | null): void;
	get(): HTMLElement | null;
}

/**
 * The drop-into highlight used by both drag flows (items.ts, dnd.ts):
 * the folder row a drop would move the dragged thing inside.
 */
export function highlighter(className: string): Highlight {
	let current: HTMLElement | null = null;
	return {
		set(el: HTMLElement | null): void {
			if (current === el) return;
			current?.classList.remove(className);
			current = el;
			el?.classList.add(className);
		},
		get(): HTMLElement | null {
			return current;
		},
	};
}

/** The node with the given id anywhere under `node`, or null. */
export function findNode(node: BookmarkTreeNode, id: string): BookmarkTreeNode | null {
	if (node.id === id) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, id);
		if (found !== null) return found;
	}
	return null;
}

/**
 * (Re)fills a selector with every folder of the tree, indented by
 * depth — the look and rules of the settings' root selector, shared by
 * the editor's folder selector. `disabled` grays out folders that are
 * no valid choice in the caller's context; they keep their place in
 * the tree rather than vanishing from it.
 */
export function fillFolderTree(
	select: HTMLSelectElement,
	root: BookmarkTreeNode,
	disabled?: (node: BookmarkTreeNode) => boolean,
): void {
	select.replaceChildren();
	addFolderOption(select, root, "/", 0, disabled);
}

function addFolderOption(
	select: HTMLSelectElement,
	node: BookmarkTreeNode,
	label: string,
	depth: number,
	disabled?: (node: BookmarkTreeNode) => boolean,
): void {
	const option = createEl("option");
	option.value = node.id;
	// Both spellings of the name: indented for the open list, plain for
	// the closed control (styleFolderOptions swaps between them). The
	// indent is non-breaking spaces (spelled out — they look just like
	// plain ones): ordinary leading spaces are collapsed away when the
	// browser renders the option texts.
	const indented = "\u00A0\u00A0".repeat(depth) + label;
	option.setAttribute("data-indented", indented);
	option.setAttribute("data-label", label);
	option.textContent = indented;
	if (disabled?.(node) === true) option.disabled = true;
	select.append(option);
	for (const child of node.children ?? []) {
		if (child.children !== undefined) {
			addFolderOption(select, child, child.title === "" ? "…" : child.title, depth + 1, disabled);
		}
	}
}

/**
 * Swaps the folder-selector option texts: the open dropdown shows the
 * depth-indented tree; the closed control shows the selected folder's
 * plain name, with no indentation around it.
 */
export function styleFolderOptions(select: HTMLSelectElement, open: boolean): void {
	for (const option of select.options) {
		const indented = option.getAttribute("data-indented");
		const label = option.getAttribute("data-label");
		if (indented === null || label === null) continue;
		const selected = option.value === select.value;
		option.textContent = selected && !open ? label : indented;
	}
}

/** The control glyphs used inside localized UI messages. */
const GLYPH_ICONS: Record<string, IconKind> = {
	"✎": "pencil",
	"⚙": "gear",
	"👁": "eye",
	"⠿": "grip",
};

/**
 * Appends `text` to `el`, swapping the control glyphs the messages use
 * (✎︎ ⚙︎ 👁︎ ⠿) for the same inline SVG icons the controls draw — so
 * instructions show exactly what the page shows.
 */
export function appendWithIcons(el: HTMLElement, text: string): void {
	// U+FE0E is the (invisible) text-presentation selector the messages
	// attach to the glyphs; it is matched and stripped along with them.
	for (const part of text.split(/([✎⚙👁]\uFE0E?|⠿)/u)) {
		if (part === "") continue;
		const kind = GLYPH_ICONS[part.replace("\uFE0E", "")];
		if (kind === undefined) el.append(part);
		else el.append(iconSpan("inline-icon", kind));
	}
}
