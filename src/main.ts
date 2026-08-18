// GNTP entry point: renders the bookmark columns and the settings UI.

import {
	getSubTree,
	getTree,
	hasHostPermission,
	initLocale,
	isFirefox,
	requestHostPermission,
	t,
	uiLanguage,
} from "./api.js";
import {
	editMode,
	initColumnDnd,
	loadLayout,
	makeDraggable,
	normalizeRows,
	setColumnHidden,
	setEditMode,
} from "./dnd.js";
import { initEdit, openCreate } from "./edit.js";
import { fitAir } from "./fit.js";
import { clearFolds, deviations, initFolds, persistFolds } from "./folds.js";
import { initHidden, loadHidden } from "./hidden.js";
import * as icons from "./icons.js";
import { initItems } from "./items.js";
import {
	appendWithIcons,
	createEl,
	fillFolderTree,
	findNode,
	iconSpan,
	setClass,
	storageGet,
	storageRemove,
	storageSet,
	styleFolderOptions,
	svgIcon,
} from "./util.js";

/**
 * Font choices as (i18n key, font-family value): the browser's menu
 * font (the extension's default — no override at all), the system UI
 * font, then the generic families.
 */
const FONTS: readonly (readonly [string, string])[] = [
	["browserDefault", ""],
	["fontSystem", "system-ui"],
	["fontSansSerif", "sans-serif"],
	["fontSerif", "serif"],
	["fontMonospace", "monospace"],
];

/**
 * Widely shipped fonts across Linux/Windows/macOS; each is offered only
 * when `document.fonts.check()` confirms it is actually installed.
 */
const FONT_CANDIDATES: readonly string[] = [
	"Arial",
	"Helvetica",
	"Verdana",
	"Tahoma",
	"Trebuchet MS",
	"Segoe UI",
	"Roboto",
	"Noto Sans",
	"Inter",
	"Ubuntu",
	"Cantarell",
	"DejaVu Sans",
	"Liberation Sans",
	"Times New Roman",
	"Georgia",
	"Courier New",
	"JetBrains Mono",
	"Fira Code",
];

/**
 * Interface languages offered for manual selection, as endonyms (never
 * translated — the convention for language pickers).
 */
const LANGUAGES: readonly (readonly [string, string])[] = [
	["en", "English"],
	["ru", "Русский"],
	["es", "Español"],
	["de", "Deutsch"],
	["fr", "Français"],
	["pt_BR", "Português (Brasil)"],
	["ja", "日本語"],
	["zh_CN", "简体中文"],
];

const DEFAULT_MAX_COLUMNS = 5;
const MAX_COLUMNS = { min: 1, max: 12 } as const;
const FONT_SIZE = { min: 8, max: 32 } as const;

/**
 * Every localStorage key the page itself writes (icon cache aside):
 * their presence is what tells a used profile from a fresh install.
 */
const STATE_KEYS: readonly string[] = [
	"columns",
	"root",
	"hidden",
	"folds",
	"remember_open",
	"show_root",
	"font",
	"font_size",
	"max_cols",
	"lang",
];

const main = document.getElementById("main") as HTMLElement;

/**
 * The shelf holding hidden top-level columns, in edit mode only. Kept
 * outside the matrix: as a grid item spanning every track it would add
 * its own width to them, so hiding a wide column would still widen the
 * visible ones.
 */
const shelf = createEl("div", "tree");
shelf.id = "shelf";
// Its caption, saying what the strip below the matrix is; localized
// once the locale is ready (the startup sequence below).
const shelfLabel = createEl("div");
shelfLabel.id = "shelf-label";
main.after(shelfLabel, shelf);

/** Everything render functions need besides the node at hand. */
interface Render {
	readonly hidden: ReadonlySet<string>;
	/** Deviations from the default fold state (see folds.ts). */
	readonly collapsed: ReadonlySet<string>;
}

const renderCtx = (): Render => ({ hidden: loadHidden(), collapsed: deviations() });

/** Folders whose children are being fetched (see expandFolder). */
const expanding = new WeakSet<HTMLElement>();

// The root-folder row, built with the settings panel and refilled on
// every rebuild. Declared here, above the startup sequence: the first
// rebuild runs during module evaluation and reads them, which a `let`
// further down the file would answer with a temporal-dead-zone error.
let rootSelect: HTMLSelectElement | null = null;
let rootReset: HTMLElement | null = null;

migrate();
await initLocale(storageGet("lang"));
document.title = t("newTabTitle");
shelfLabel.textContent = t("hiddenFolders");
initItems([main, shelf], rebuild);
initEdit([main, shelf], rebuild);
initColumnDnd(main, shelf, maxColumns, () => void rebuild(), relayout);
initHidden([main, shelf], (column, hidden) => {
	setColumnHidden(main, shelf, column, hidden, maxColumns());
	relayout();
});
initFolds([main, shelf], (li, id) => void expandFolder(li, id), relayout);
hideBrokenIcons();
addEventListener("resize", relayout);
buildSettingsUi();
applyFont();
await rebuild();
if (isFirefox && !icons.strict()) addPermissionPrompt();
maybeOnboard();

/**
 * Re-renders the whole page from the current bookmarks tree. Nothing is
 * touched until the awaits are done: two overlapping rebuilds then each
 * replace the whole page, instead of one appending its rows into the
 * other's half-built matrix.
 */
async function rebuild(): Promise<void> {
	if (isFirefox) icons.setStrict(await hasHostPermission());
	const root = await getTree();
	icons.revokeObjectUrls();
	main.replaceChildren();
	shelf.replaceChildren();

	const selected = selectedRoot(root);
	// The displayed root's id, read by items.ts when a nested folder is
	// dragged out into a column gap — the move target is this folder.
	main.setAttribute("data-root", selected.id);
	fillRootSelector(root, selected.id);

	const ctx = renderCtx();

	// One column per child folder that holds bookmarks, preceded by the
	// root's own loose bookmarks — rendered as a folder named after the
	// root itself ("/" when it is unnamed), so it behaves like any other
	// column: draggable, hideable, collapsible.
	const children = selected.children ?? [];
	const loose = children.filter((n) => n.children === undefined && n.url !== undefined);
	const folders: BookmarkTreeNode[] =
		loose.length > 0
			? [{ id: selected.id, title: selected.title === "" ? "/" : selected.title, children: loose }]
			: [];
	folders.push(...children.filter((n) => n.children !== undefined));

	const columns = folders.map((node) => {
		const column = folderColumn(ctx, node);
		const rootLi = column.querySelector("li");
		if (rootLi !== null) makeDraggable(column, node.id, rootLi);
		return [node.id, column] as const;
	});

	// Hidden columns never occupy matrix cells: they go to the shelf
	// after the matrix, so only the visible ones are laid out in rows.
	const byId = new Map(columns.filter(([id]) => !ctx.hidden.has(id)));

	// Saved rows first (unknown ids dropped), then any new columns
	// appended to the last row; the row limit is enforced afterwards.
	const placed = new Set<string>();
	const rows: string[][] = [];
	for (const row of loadLayout()) {
		const ids = row.filter((id) => byId.has(id) && !placed.has(id));
		for (const id of ids) placed.add(id);
		if (ids.length > 0) rows.push(ids);
	}
	const missing = [...byId.keys()].filter((id) => !placed.has(id));
	if (missing.length > 0) {
		if (rows.length === 0) rows.push([]);
		rows[rows.length - 1]?.push(...missing);
	}

	for (const ids of rows) {
		const row = createEl("div", "grid-row");
		for (const id of ids) {
			const column = byId.get(id);
			if (column !== undefined) row.append(column);
		}
		main.append(row);
	}
	for (const [id, column] of columns) if (ctx.hidden.has(id)) shelf.append(column);
	normalizeRows(main, maxColumns());

	if (isFirefox) {
		// Newly cached icons (first install, new bookmarks) re-render the
		// page once so they show without a manual refresh — but never
		// mid-drag, which would detach the row under the pointer.
		icons.flushPrefetch(() => {
			if (document.querySelector(".dragging") === null) void rebuild();
		});
		setTimeout(() => void icons.shrinkLegacyEntries(), 1000);
	}
	relayout();
}

/** The folder the page displays: the stored choice or the default. */
function selectedRoot(root: BookmarkTreeNode): BookmarkTreeNode {
	return findNode(root, storageGet("root") ?? "") ?? defaultRoot(root);
}

/**
 * The default displayed root: the Bookmarks Toolbar. Firefox has a
 * fixed id for it; in Chromium the `folderType` marker is checked first
 * (permanent-folder ids are not guaranteed since account bookmarks)
 * with the traditional id "1" as fallback. Any failure silently falls
 * back to the tree root ("/").
 */
function defaultRoot(root: BookmarkTreeNode): BookmarkTreeNode {
	if (isFirefox) return findNode(root, "toolbar_____") ?? root;
	const byType = root.children?.find((n) => n.folderType === "bookmarks-bar");
	return byType ?? findNode(root, "1") ?? root;
}

/** A column showing one folder of the displayed root. */
function folderColumn(ctx: Render, node: BookmarkTreeNode): HTMLElement {
	const column = createEl("div", "column");
	if (ctx.hidden.has(node.id)) column.classList.add("hidden");
	const ul = createEl("ul");
	// The folder row is moved via the column handle, not its own.
	renderNode(ctx, ul, node, false);
	column.append(ul);
	return column;
}

/** Renders a single bookmark or folder as a `<li>` appended to `ul`. */
function renderNode(
	ctx: Render,
	ul: HTMLElement,
	node: BookmarkTreeNode,
	withHandle: boolean,
): void {
	// Separators are the only nodes never rendered; empty folders show —
	// they are targets for moving bookmarks into.
	if (node.url === undefined && node.children === undefined) return;

	const li = createEl("li");
	li.setAttribute("data-id", node.id);
	if (node.index !== undefined) li.setAttribute("data-index", String(node.index));
	if (withHandle) {
		// Kept outside the <a>: Firefox lets the link's native drag win
		// over a draggable child, which would break row reordering.
		const handle = iconSpan("drag-handle", "grip");
		handle.draggable = true;
		li.append(handle);
	}

	const a = createEl("a", undefined, node.title === "" ? (node.url ?? "") : node.title);
	if (node.url !== undefined) {
		a.setAttribute("href", node.url);
		// An absent icon still reserves its slot, keeping rows aligned.
		const src = favicon(node.url);
		let icon: HTMLElement;
		if (src === null) {
			icon = createEl("span", "favicon");
		} else {
			const img = createEl("img", "favicon");
			img.alt = "";
			// Decode together with the frame instead of popping in later.
			img.decoding = "sync";
			img.src = src;
			icon = img;
		}
		a.prepend(icon);
	}
	li.append(a);
	// The row's gutter controls: the eye toggling the item's hidden
	// state (hidden.ts), the pencil opening the item editor, and — on
	// folder rows alone — the plus creating a new item inside (edit.ts).
	// Bookmark rows keep the slot empty, so the columns of controls
	// stay aligned.
	li.append(iconSpan("hide-toggle", "eye"));
	li.append(iconSpan("edit-item", "pencil"));
	if (node.children !== undefined) li.append(iconSpan("add-item", "plus"));
	if (ctx.hidden.has(node.id)) li.classList.add("hidden");

	if (node.children !== undefined) {
		a.className = "folder";
		// Nested folders (withHandle) default to collapsed, column roots
		// to open; a deviation flips the default.
		const collapsed = withHandle !== ctx.collapsed.has(node.id);
		if (collapsed) li.classList.add("collapsed");
		// Collapsed nested folders render lazily (see expandFolder), so
		// closed subtrees cost no DOM at all.
		if (!collapsed || !withHandle) {
			li.append(childList(ctx, node.children));
		}
	}

	ul.append(li);
}

/**
 * The rendered children of an open folder. A folder left with nothing
 * to show (empty, or separators only) gets an inert placeholder row, so
 * it still reads as an open folder one can drop bookmarks into.
 */
function childList(ctx: Render, children: readonly BookmarkTreeNode[]): HTMLElement {
	const inner = createEl("ul");
	for (const child of children) renderNode(ctx, inner, child, true);
	if (inner.children.length === 0) {
		inner.append(createEl("li", "empty-note", "<empty>"));
	}
	return inner;
}

/**
 * Builds a lazily rendered folder's children when it is first expanded;
 * collapsing removed them, so the subtree is fetched fresh.
 */
async function expandFolder(li: HTMLElement, id: string): Promise<void> {
	// The marker covers the fetch itself: collapsing and re-expanding
	// meanwhile would otherwise start a second fetch, and both would
	// append their own copy of the children.
	if (li.querySelector(":scope > ul") !== null || expanding.has(li)) return;
	expanding.add(li);
	let node: BookmarkTreeNode | null;
	try {
		node = await getSubTree(id);
	} finally {
		expanding.delete(li);
	}
	// Discard if the folder vanished, was re-collapsed, or was filled by
	// a render while fetching.
	if (node?.children === undefined || li.classList.contains("collapsed")) return;
	if (li.querySelector(":scope > ul") !== null) return;
	li.append(childList(renderCtx(), node.children));
	relayout();
	if (isFirefox) {
		icons.flushPrefetch(() => {
			if (document.querySelector(".dragging") === null) void rebuild();
		});
	}
}

/**
 * Favicon URL for a bookmark, or null when nothing should be shown.
 * Chromium serves icons from its local /_favicon/ endpoint. Firefox
 * reads the localStorage cache synchronously (instant paint); on a
 * cache miss the icon is prefetched for the next page open, and in
 * strict mode nothing is rendered meanwhile — without the permission it
 * falls back to the site's own /favicon.ico.
 */
function favicon(page: string): string | null {
	if (!page.startsWith("http://") && !page.startsWith("https://")) return null;
	if (!isFirefox) {
		return `/_favicon/?pageUrl=${encodeURIComponent(page)}&size=32`;
	}
	const origin = new URL(page).origin;
	const entry = icons.cached(origin);
	switch (entry.state) {
		case "fresh":
		case "stale":
			if (entry.state === "stale") icons.prefetch(origin, false);
			return icons.objectUrlFor(origin, entry.data);
		case "failed":
			if (entry.retry) icons.prefetch(origin, false);
			// Bot protection rejects extension fetches but serves plain
			// <img> loads — use the browser-native request.
			return `${origin}/favicon.ico`;
		case "miss": {
			// Only strict mode leaves the row blank; the fallback <img>
			// paints something, so landing the icon is worth a re-render
			// in the strict case alone.
			const blank = icons.strict();
			icons.prefetch(origin, blank);
			return blank ? null : `${origin}/favicon.ico`;
		}
	}
}

/**
 * A failed icon load must reserve its space but show nothing — like the
 * empty placeholder, not the browser's broken-image square. The error
 * event doesn't bubble, hence the capture phase.
 */
function hideBrokenIcons(): void {
	// On the document: shelf rows carry icons too, and they live outside
	// the matrix.
	document.addEventListener(
		"error",
		(e) => {
			const target = e.target;
			if (target instanceof HTMLElement && target.classList.contains("favicon")) {
				target.style.visibility = "hidden";
			}
		},
		true,
	);
}

/**
 * Re-measures what depends on how much room the page has: the air in
 * the cards, then the truncation it leaves. Call after any change to
 * widths or to what is displayed.
 */
function relayout(): void {
	fitAir(main);
	updateTooltips();
}

/**
 * Gives truncated titles a tooltip with the full text; rows that fit
 * get none.
 */
function updateTooltips(): void {
	for (const a of document.querySelectorAll<HTMLElement>(".tree li > a")) {
		if (a.scrollWidth > a.clientWidth) {
			a.title = (a.textContent ?? "").trim();
		} else {
			a.removeAttribute("title");
		}
	}
}

function buildSettingsUi(): void {
	const settings = createEl("div");
	settings.id = "settings";
	document.body.append(settings);
	const head = createEl("div");
	head.id = "settings-header";
	settings.append(head);
	const panel = createEl("div", "dialog");
	panel.id = "settings-panel";
	panel.setAttribute("popover", "");
	settings.append(panel);

	addCreateToggle(head);
	addSettingsToggle(head);
	addEditToggle(head, panel);
	// Settings the page honors even while the panel was never opened.
	setClass(main, "no-titles", storageGet("show_root") === "0");

	// The panel's rows are built on its first opening: a casual new tab
	// never pays their DOM, options and listeners.
	panel.addEventListener(
		"beforetoggle",
		() => {
			panel.append(createEl("div", "title", t("settings")));
			addRootSelector(panel);
			addToggleSetting(panel, t("topLevelFolders"), "show_root", true, (on) =>
				setClass(main, "no-titles", !on),
			);
			addToggleSetting(panel, t("rememberOpenFolders"), "remember_open", true, (on) => {
				if (on) persistFolds();
				else clearFolds();
			});
			// "Columns per row": the matrix width.
			addNumberSetting(panel, t("maxColumns"), "max_cols", MAX_COLUMNS, {
				fallback: () => String(DEFAULT_MAX_COLUMNS),
				apply: () => void rebuild(),
			});
			addFontSettings(panel);
			addLanguageSetting(panel);
			void getTree().then((root) => fillRootSelector(root, selectedRoot(root).id));
		},
		{ once: true },
	);
}

/** One corner button: an icon, a tooltip, a stable id for the CSS. */
function cornerButton(
	head: HTMLElement,
	id: string,
	icon: Parameters<typeof svgIcon>[0],
	title: string,
): HTMLButtonElement {
	const button = createEl("button");
	button.append(svgIcon(icon));
	button.id = id;
	button.title = title;
	head.append(button);
	return button;
}

/**
 * The plus left of the gear, edit mode only: opens the item editor in
 * its create view — a new bookmark or folder (see edit.ts).
 */
function addCreateToggle(head: HTMLElement): void {
	const button = cornerButton(head, "create-toggle", "plus", t("add"));
	button.addEventListener("click", () => void openCreate(rebuild));
}

/**
 * The gear next to the pencil, edit mode only. A plain popover trigger:
 * the browser opens and closes the panel (light dismiss and Esc
 * included), no script involved.
 */
function addSettingsToggle(head: HTMLElement): void {
	const button = cornerButton(head, "settings-toggle", "gear", t("settings"));
	button.setAttribute("popovertarget", "settings-panel");
}

/**
 * The edit-mode toggle; drag and drop works only while it is on.
 * Leaving edit mode also closes the settings popover.
 */
function addEditToggle(head: HTMLElement, panel: HTMLElement): void {
	const button = cornerButton(head, "edit-toggle", "pencil", t("edit"));
	button.addEventListener("click", () => {
		const enabled = !editMode();
		setEditMode(main, enabled);
		if (!enabled) panel.hidePopover();
		// Edit mode reveals the hidden rows, which can widen the matrix.
		relayout();
	});
}

/**
 * Shows the row's reset control only while the value differs from the
 * setting's default.
 */
function syncReset(button: HTMLElement | null, isDefault: boolean): void {
	if (button !== null) setClass(button, "off", isDefault);
}

/**
 * A "name — control — reset" row in the settings panel. `reset` returns
 * the setting to its default (the button hides itself right after);
 * it is returned so the caller can keep its visibility in sync with the
 * value.
 */
function addSettingRow(
	panel: HTMLElement,
	name: string,
	control: HTMLElement,
	reset: () => void,
): HTMLElement {
	const row = createEl("label", "row");
	row.append(createEl("span", undefined, name));
	row.append(control);
	const button = createEl("button", "reset off");
	button.append(svgIcon("reset"));
	button.type = "button";
	button.title = t("resetToDefault");
	button.addEventListener("click", () => {
		reset();
		syncReset(button, true);
	});
	row.append(button);
	panel.append(row);
	return button;
}

/**
 * A number row whose default is spelled out in the field rather than
 * left as a placeholder, so the spinner arrows step from the value the
 * user sees. Stored under `key`; absent = the default `fallback`
 * reports at that moment. `apply` puts the new value to work.
 */
function addNumberSetting(
	panel: HTMLElement,
	label: string,
	key: string,
	{ min, max }: { min: number; max: number },
	{ fallback, apply }: { fallback: () => string; apply: () => void },
): void {
	const input = createEl("input");
	input.type = "number";
	input.min = String(min);
	input.max = String(max);

	// Back to the default: forget the override, apply, and only then
	// measure — a fallback that reads the page would otherwise report
	// the very value being reset.
	const toDefault = (): void => {
		storageRemove(key);
		apply();
		input.value = fallback();
		input.placeholder = input.value;
	};

	const stored = storedNumber(key, min, max);
	input.value = stored === null ? fallback() : String(stored);
	input.placeholder = input.value;
	const resetBtn = addSettingRow(panel, label, input, toDefault);
	syncReset(resetBtn, stored === null);

	input.addEventListener("change", () => {
		// Typing past min/max is not blocked by the input, and a cleared
		// field means "default": both return the row to the default
		// rather than storing a value every reader would discard.
		const value = Number(input.value);
		if (input.value === "" || !Number.isInteger(value) || value < min || value > max) {
			toDefault();
			syncReset(resetBtn, true);
			return;
		}
		storageSet(key, input.value);
		apply();
		syncReset(resetBtn, false);
	});
}

/**
 * A switch-style boolean setting stored under `key` ("1"/"0"; absent =
 * `defaultOn`). `apply` receives the effective value at setup, on every
 * change and on reset.
 */
function addToggleSetting(
	panel: HTMLElement,
	label: string,
	key: string,
	defaultOn: boolean,
	apply: (on: boolean) => void,
): void {
	const input = createEl("input");
	input.type = "checkbox";
	const stored = storageGet(key);
	const on = stored === null ? defaultOn : stored === "1";
	input.checked = on;
	apply(on);

	const resetBtn = addSettingRow(panel, label, input, () => {
		storageRemove(key);
		input.checked = defaultOn;
		apply(defaultOn);
	});
	syncReset(resetBtn, on === defaultOn);

	input.addEventListener("change", () => {
		const value = input.checked;
		storageSet(key, value ? "1" : "0");
		apply(value);
		syncReset(resetBtn, value === defaultOn);
	});
}

/**
 * The displayed-root selector; the chosen folder id is kept in
 * localStorage under "root".
 */
function addRootSelector(panel: HTMLElement): void {
	const select = createEl("select");
	rootSelect = select;
	rootReset = addSettingRow(panel, t("rootFolder"), select, () => {
		storageRemove("root");
		void rebuild();
	});

	select.addEventListener("focus", () => styleFolderOptions(select, true));
	select.addEventListener("blur", () => styleFolderOptions(select, false));
	select.addEventListener("change", () => {
		styleFolderOptions(select, false);
		storageSet("root", select.value);
		void rebuild();
	});
}

/** (Re)fills the selector with every folder of the tree, indented by depth. */
function fillRootSelector(root: BookmarkTreeNode, selectedId: string): void {
	const select = rootSelect;
	if (select === null) return;
	fillFolderTree(select, root);
	select.value = selectedId;
	styleFolderOptions(select, false);
	// The reset control clears the stored choice, so it shows whenever
	// there is one — even if it happens to name the default folder.
	syncReset(rootReset, storageGet("root") === null);
}

/** How many columns fit in one matrix row before wrapping. */
function maxColumns(): number {
	return storedNumber("max_cols", MAX_COLUMNS.min, MAX_COLUMNS.max) ?? DEFAULT_MAX_COLUMNS;
}

/**
 * A whole number setting, or null when it is unset or outside the range
 * the row offers — a value typed past the input's min/max is stored as
 * given, so every reader checks it.
 */
function storedNumber(key: string, min: number, max: number): number | null {
	const stored = storageGet(key);
	if (stored === null || stored === "") return null;
	const value = Number(stored);
	return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Applies the stored font settings as inline styles on <body>. The size
 * is range-checked, not merely non-zero: a stored 300 would blow the
 * page up and push the settings panel — with its reset control — off
 * the screen, leaving no way back through the UI.
 */
function applyFont(): void {
	document.body.style.fontFamily = storageGet("font") ?? "";
	const size = storedNumber("font_size", FONT_SIZE.min, FONT_SIZE.max);
	document.body.style.fontSize = size === null ? "" : `${size}px`;
	relayout();
}

/**
 * The page's current font size in whole px, as resolved by the browser.
 * Valid as "the default" only while no font-size override is applied.
 */
function defaultFontSize(): string | null {
	const size = getComputedStyle(document.body).fontSize;
	const px = Number.parseFloat(size);
	return Number.isFinite(px) ? String(Math.round(px)) : null;
}

/**
 * True when the font family is available to this browser (installed
 * locally), via the standard CSS Font Loading API.
 */
function fontAvailable(family: string): boolean {
	try {
		return document.fonts.check(`12px "${family}"`);
	} catch {
		return false;
	}
}

/**
 * "Font" and "Font size" rows; values persist in localStorage ("font" =
 * font-family value, "font_size" = px, empty/absent = browser default).
 */
function addFontSettings(panel: HTMLElement): void {
	const select = createEl("select");
	// The first two FONTS stay on top; the rest sorts alphabetically.
	const head = FONTS.slice(0, 2).map(([key, value]) => [t(key), value] as const);
	const rest = [
		...FONTS.slice(2).map(([key, value]) => [t(key), value] as const),
		...FONT_CANDIDATES.filter(fontAvailable).map((f) => [f, f] as const),
	].sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
	for (const [label, value] of [...head, ...rest]) {
		const option = createEl("option", undefined, label);
		option.value = value;
		select.append(option);
	}
	const current = storageGet("font") ?? "";
	select.value = current;
	const fontReset = addSettingRow(panel, t("font"), select, () => {
		storageRemove("font");
		select.value = "";
		applyFont();
	});
	syncReset(fontReset, current === "");
	select.addEventListener("change", () => {
		storageSet("font", select.value);
		applyFont();
		syncReset(fontReset, select.value === "");
	});

	// Without an override the measured size *is* the browser default.
	addNumberSetting(panel, t("fontSize"), "font_size", FONT_SIZE, {
		fallback: () => defaultFontSize() ?? "",
		apply: applyFont,
	});
}

/**
 * The language the extension uses without an override: the browser's UI
 * language when it is among the packaged ones, English otherwise.
 */
function defaultLanguage(): string {
	const ui = uiLanguage().replace("-", "_");
	const primary = ui.split("_")[0];
	const match =
		LANGUAGES.find(([id]) => id === ui) ??
		LANGUAGES.find(([id]) => id.split("_")[0] === primary);
	return match?.[0] ?? "en";
}

/**
 * "Language": interface-language selection under the "lang" key (absent
 * = follow the browser, falling back to English). Changing it reloads
 * the page so every string is rebuilt in the new language.
 */
function addLanguageSetting(panel: HTMLElement): void {
	const select = createEl("select");
	for (const [value, label] of LANGUAGES) {
		const option = createEl("option", undefined, label);
		option.value = value;
		select.append(option);
	}
	select.value = storageGet("lang") ?? defaultLanguage();

	const resetBtn = addSettingRow(panel, t("language"), select, () => {
		storageRemove("lang");
		location.reload();
	});
	syncReset(resetBtn, storageGet("lang") === null);
	select.addEventListener("change", () => {
		storageSet("lang", select.value);
		location.reload();
	});
}

/**
 * One-time stamp of the settings schema. Runs first, before the page
 * has written anything of its own, which makes it the only reliable
 * moment to tell an existing profile from a fresh install — the verdict
 * is recorded here so nothing has to guess it again later.
 *
 * A default that changes must not move the page under existing users:
 * a profile that predates the stamp keeps the old default, written out
 * explicitly, and is never offered the first-run tour. A fresh install
 * stores nothing and simply gets the current defaults.
 */
function migrate(): void {
	if (storageGet("schema") !== null) return;
	if (usedProfile()) {
		// "Top level folders" defaulted to off before 1.2.0.
		if (storageGet("show_root") === null) storageSet("show_root", "0");
		storageSet("onboarded", "1");
	}
	storageSet("schema", "1");
}

/**
 * True when the profile already holds choices from an earlier visit.
 * The icon cache counts too: on Firefox it is written on the very first
 * page load, so it marks a used profile even when nothing was ever
 * configured.
 */
function usedProfile(): boolean {
	return STATE_KEYS.some((key) => storageGet(key) !== null) || icons.cachedAny();
}

/**
 * First-run onboarding: an interactive tour in a card under the ✎︎/⚙︎
 * corner. Each step softly highlights one control and waits for that
 * real action on it — enter edit mode, open the settings, close them,
 * leave edit mode — the last of which ends the tour; the skip button
 * ends it at any point. Shown once, to new users only: a profile that
 * already stores any GNTP state counts as onboarded silently.
 */
function maybeOnboard(): void {
	// migrate() has already excused existing profiles; an unfinished
	// tour is offered again on the next new tab.
	if (storageGet("onboarded") !== null) return;

	const card = createEl("div");
	card.id = "onboarding";
	// A step's message is a list: one instruction per "\n"-joined line.
	const text = createEl("ul", "hint");
	// The control glyphs in the message render as the same SVG icons the
	// controls themselves draw (see appendWithIcons).
	const setText = (key: string): void => {
		text.replaceChildren();
		for (const line of t(key).split("\n")) {
			const item = createEl("li");
			appendWithIcons(item, line);
			text.append(item);
		}
	};
	card.append(text);
	const button = createEl("button", undefined, t("skip"));
	card.append(button);
	document.body.append(card);

	const editBtn = document.getElementById("edit-toggle");
	const gear = document.getElementById("settings-toggle");
	const panel = document.getElementById("settings-panel");

	let target: Element | null = null;
	const highlight = (el: Element | null): void => {
		target?.classList.remove("onboard-target");
		target = el;
		el?.classList.add("onboard-target");
	};

	// The open settings panel is a popover — painted above everything and
	// sitting in the card's own corner — so while it is open the card
	// stands just left of it, close to what that step describes. The
	// panel is filled asynchronously and its width follows the language,
	// so the placement is kept up to date by an observer rather than
	// taken once as it opens.
	const GAP = 8;
	const placeCard = (): void => {
		const open = panel !== null && panel.matches(":popover-open");
		const left = open ? panel.getBoundingClientRect().left : 0;
		if (!open || left <= 0) {
			card.style.removeProperty("right");
			card.style.removeProperty("max-width");
			return;
		}
		card.style.right = `${window.innerWidth - left + GAP}px`;
		// Never wider than the room left of the panel.
		card.style.maxWidth = `${Math.max(200, left - 2 * GAP)}px`;
	};
	const watchPanel = new ResizeObserver(placeCard);
	if (panel !== null) watchPanel.observe(panel);
	watchPanel.observe(document.documentElement);

	let step = 1;
	const show = (at: number, key: string, el: Element | null): void => {
		step = at;
		setText(key);
		highlight(el);
		placeCard();
	};

	const finish = (): void => {
		highlight(null);
		watchPanel.disconnect();
		card.remove();
		editBtn?.removeEventListener("click", onEdit);
		panel?.removeEventListener("toggle", onPanel);
		storageSet("onboarded", "1");
	};

	function onEdit(): void {
		if (editMode()) {
			if (step === 1) show(2, "onboardSettings", gear);
		} else if (step === 4) {
			finish();
		} else {
			// Edit mode left before the tour got there: back to step 1.
			show(1, "onboardEdit", editBtn);
		}
	}

	function onPanel(e: Event): void {
		const open = (e as ToggleEvent).newState === "open";
		if (open && step === 2) show(3, "onboardRoot", gear);
		else if (!open && step === 3) show(4, "onboardExit", editBtn);
		// Reopened at another step: the card still has to clear the panel.
		else placeCard();
	}

	show(1, "onboardEdit", editBtn);
	editBtn?.addEventListener("click", onEdit);
	panel?.addEventListener("toggle", onPanel);
	button.addEventListener("click", finish);
}

/**
 * First-run banner asking for the host permission the icon cache needs.
 * Normally the permission is granted at install time (it is in the
 * manifest), so this shows only when it is missing — e.g. a temporary
 * add-on — and never again once granted. The request must start inside
 * a click handler, hence a banner with a button rather than a silent
 * request on load.
 */
function addPermissionPrompt(): void {
	const banner = createEl("div");
	banner.id = "permission-banner";
	banner.append(createEl("span", undefined, t("permissionRequest")));
	const allow = createEl("button", undefined, t("allow"));
	banner.append(allow);
	const dismiss = createEl("button", "dismiss");
	dismiss.append(svgIcon("cross"));
	banner.append(dismiss);
	document.body.append(banner);

	allow.addEventListener("click", () => {
		// Must be called synchronously inside the click handler.
		void requestHostPermission().then(async (granted) => {
			if (granted) {
				banner.remove();
				await rebuild();
			}
		});
	});
	dismiss.addEventListener("click", () => banner.remove());
}
