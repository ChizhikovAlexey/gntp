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
import { editMode, initColumnDnd, loadOrder, makeDraggable, setEditMode } from "./dnd.js";
import { clearFolds, deviations, persistFolds } from "./folds.js";
import { initFolds } from "./folds.js";
import { initHidden, loadHidden } from "./hidden.js";
import * as icons from "./icons.js";
import { initItems } from "./items.js";
import { createEl, setClass, storageGet, storageRemove, storageSet } from "./util.js";

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

const main = document.getElementById("main") as HTMLElement;

/** Everything render functions need besides the node at hand. */
interface Render {
	readonly hidden: ReadonlySet<string>;
	/** Deviations from the default fold state (see folds.ts). */
	readonly collapsed: ReadonlySet<string>;
}

await initLocale(storageGet("lang"));
document.title = t("newTabTitle");
initItems(main, rebuild);
initColumnDnd(main);
initHidden(main);
initFolds(main, (li, id) => void expandFolder(li, id));
hideBrokenIcons();
addEventListener("resize", updateTooltips);
buildSettingsUi();
applyFont();
await rebuild();
if (isFirefox && !icons.strict()) addPermissionPrompt();

/** Re-renders the whole page from the current bookmarks tree. */
async function rebuild(): Promise<void> {
	icons.revokeObjectUrls();
	main.replaceChildren();
	if (isFirefox) icons.setStrict(await hasHostPermission());
	const root = await getTree();

	const selected = selectedRoot(root);
	fillRootSelector(root, selected.id);

	const ctx: Render = { hidden: loadHidden(), collapsed: deviations() };

	// Columns follow the saved order; ids not in it keep natural order.
	const children = selected.children ?? [];
	const columns: (readonly [string, HTMLElement])[] = [];

	const loose = children.filter((n) => n.children === undefined && n.url !== undefined);
	if (loose.length > 0) {
		columns.push([selected.id, looseColumn(ctx, selected, loose)]);
	}
	for (const node of children) {
		if (node.children !== undefined && hasBookmarks(node)) {
			columns.push([node.id, folderColumn(ctx, node)]);
		}
	}

	const saved = loadOrder();
	const position = (id: string): number => {
		const index = saved.indexOf(id);
		return index < 0 ? Number.MAX_SAFE_INTEGER : index;
	};
	columns.sort(([a], [b]) => position(a) - position(b));

	for (const [id, column] of columns) {
		main.append(column);
		const rootLi = column.querySelector("li");
		if (rootLi !== null) makeDraggable(column, id, rootLi);
	}

	if (isFirefox) {
		icons.flushPrefetch();
		setTimeout(() => void icons.shrinkLegacyEntries(), 1000);
	}
	updateTooltips();
}

/**
 * The default displayed root: the Bookmarks Toolbar. Firefox has a
 * fixed id for it; in Chromium the `folderType` marker is checked first
 * (permanent-folder ids are not guaranteed since account bookmarks)
 * with the traditional id "1" as fallback. Any failure silently falls
 * back to the tree root ("/").
 */
/** The folder the page displays: the stored choice or the default. */
function selectedRoot(root: BookmarkTreeNode): BookmarkTreeNode {
	return findNode(root, storageGet("root") ?? "") ?? defaultRoot(root);
}

function defaultRoot(root: BookmarkTreeNode): BookmarkTreeNode {
	if (isFirefox) return findNode(root, "toolbar_____") ?? root;
	const byType = root.children?.find((n) => n.folderType === "bookmarks-bar");
	return byType ?? findNode(root, "1") ?? root;
}

function findNode(node: BookmarkTreeNode, id: string): BookmarkTreeNode | null {
	if (node.id === id) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, id);
		if (found !== null) return found;
	}
	return null;
}

/** True if the node is a bookmark or a folder that (transitively) contains one. */
function hasBookmarks(node: BookmarkTreeNode): boolean {
	if (node.type === "separator") return false;
	if (node.children === undefined) return node.url !== undefined;
	return node.children.some(hasBookmarks);
}

/** A column showing one child folder of the displayed root. */
function folderColumn(ctx: Render, node: BookmarkTreeNode): HTMLElement {
	const column = createEl("div", "column");
	if (ctx.hidden.has(node.id)) column.classList.add("hidden");
	const ul = createEl("ul");
	// The folder row is moved via the column handle, not its own.
	renderNode(ctx, ul, node, false);
	column.append(ul);
	return column;
}

/**
 * A column with the displayed root's direct bookmarks, titled after the
 * root folder itself ("/" for the unnamed tree root); behaves like any
 * other column — draggable, hideable.
 */
function looseColumn(
	ctx: Render,
	root: BookmarkTreeNode,
	loose: readonly BookmarkTreeNode[],
): HTMLElement {
	const column = createEl("div", "column");
	if (ctx.hidden.has(root.id)) column.classList.add("hidden");

	const li = createEl("li");
	li.setAttribute("data-id", root.id);
	li.append(createEl("a", "folder", root.title === "" ? "/" : root.title));
	li.append(eyeControl());
	if (ctx.hidden.has(root.id)) li.classList.add("hidden");
	// A column root defaults to open: collapsed only when deviated.
	if (ctx.collapsed.has(root.id)) li.classList.add("collapsed");

	const inner = createEl("ul");
	for (const node of loose) renderNode(ctx, inner, node, true);
	li.append(inner);

	const ul = createEl("ul");
	ul.append(li);
	column.append(ul);
	return column;
}

/** The eye toggling an item's hidden state; behavior lives in hidden.ts. */
function eyeControl(): HTMLElement {
	return createEl("span", "hide-toggle", "👁︎");
}

/** Renders a single bookmark or folder as a `<li>` appended to `ul`. */
function renderNode(
	ctx: Render,
	ul: HTMLElement,
	node: BookmarkTreeNode,
	withHandle: boolean,
): void {
	if (!hasBookmarks(node)) return;

	const li = createEl("li");
	li.setAttribute("data-id", node.id);
	if (node.index !== undefined) li.setAttribute("data-index", String(node.index));
	if (withHandle) {
		// Kept outside the <a>: Firefox lets the link's native drag win
		// over a draggable child, which would break row reordering.
		const handle = createEl("span", "drag-handle", "⠿");
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
	li.append(eyeControl());
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
			const inner = createEl("ul");
			for (const child of node.children) renderNode(ctx, inner, child, true);
			li.append(inner);
		}
	}

	ul.append(li);
}

/**
 * Builds a lazily rendered folder's children when it is first expanded;
 * collapsing removed them, so the subtree is fetched fresh.
 */
async function expandFolder(li: HTMLElement, id: string): Promise<void> {
	if (li.querySelector(":scope > ul") !== null) return;
	const node = await getSubTree(id);
	// Discard if the folder vanished or was re-collapsed while fetching.
	if (node?.children === undefined || li.classList.contains("collapsed")) return;
	const ctx: Render = { hidden: loadHidden(), collapsed: deviations() };
	const inner = createEl("ul");
	for (const child of node.children) renderNode(ctx, inner, child, true);
	li.append(inner);
	updateTooltips();
	if (isFirefox) icons.flushPrefetch();
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
		return `/_favicon/?pageUrl=${encodeURIComponent(page)}&size=16`;
	}
	const origin = new URL(page).origin;
	const entry = icons.cached(origin);
	switch (entry.state) {
		case "fresh":
		case "stale":
			if (entry.state === "stale") icons.prefetch(origin);
			return icons.objectUrlFor(origin, entry.data);
		case "failed":
			if (entry.retry) icons.prefetch(origin);
			// Bot protection rejects extension fetches but serves plain
			// <img> loads — use the browser-native request.
			return `${origin}/favicon.ico`;
		case "miss":
			icons.prefetch(origin);
			return icons.strict() ? null : `${origin}/favicon.ico`;
	}
}

/**
 * A failed icon load must reserve its space but show nothing — like the
 * empty placeholder, not the browser's broken-image square. The error
 * event doesn't bubble, hence the capture phase.
 */
function hideBrokenIcons(): void {
	main.addEventListener(
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
 * Gives truncated titles a tooltip with the full text; rows that fit
 * get none. Re-run whenever widths may have changed (render, window
 * resize, font change).
 */
function updateTooltips(): void {
	for (const a of main.querySelectorAll<HTMLElement>("li > a")) {
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
	const panel = createEl("div");
	panel.id = "settings-panel";
	panel.setAttribute("popover", "");
	settings.append(panel);

	addSettingsToggle(head);
	addEditToggle(head, panel);
	// Settings the page honors even while the panel was never opened.
	setClass(main, "no-titles", storageGet("show_root") !== "1");

	// The panel's rows are built on its first opening: a casual new tab
	// never pays their DOM, options and listeners.
	panel.addEventListener(
		"beforetoggle",
		() => {
			addRootSelector(panel);
			addToggleSetting(panel, t("topLevelFolders"), "show_root", false, (on) =>
				setClass(main, "no-titles", !on),
			);
			addToggleSetting(panel, t("rememberOpenFolders"), "remember_open", true, (on) => {
				if (on) persistFolds();
				else clearFolds();
			});
			addFontSettings(panel);
			addLanguageSetting(panel);
			void getTree().then((root) => fillRootSelector(root, selectedRoot(root).id));
		},
		{ once: true },
	);
}

/**
 * The gear next to the pencil, edit mode only. A plain popover trigger:
 * the browser opens and closes the panel (light dismiss and Esc
 * included), no script involved.
 */
function addSettingsToggle(head: HTMLElement): void {
	const button = createEl("button", undefined, "⚙︎");
	button.id = "settings-toggle";
	button.title = t("settings");
	button.setAttribute("popovertarget", "settings-panel");
	head.append(button);
}

/**
 * The edit-mode toggle; drag and drop works only while it is on.
 * Leaving edit mode also closes the settings popover.
 */
function addEditToggle(head: HTMLElement, panel: HTMLElement): void {
	const button = createEl("button", undefined, "✎︎");
	button.id = "edit-toggle";
	button.title = t("edit");
	head.append(button);
	button.addEventListener("click", () => {
		const enabled = !editMode();
		setEditMode(main, enabled);
		if (!enabled) panel.hidePopover();
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
 * rows without one get a spacer so the panel grid stays aligned.
 * Returns the reset button, when present, so the caller can keep its
 * visibility in sync with the value.
 */
function addSettingRow(
	panel: HTMLElement,
	name: string,
	control: HTMLElement,
	reset: (() => void) | null,
): HTMLElement | null {
	const row = createEl("label", "row");
	row.append(createEl("span", undefined, name));
	row.append(control);
	let button: HTMLElement | null = null;
	if (reset !== null) {
		button = createEl("button", "reset off", "⟳");
		button.setAttribute("type", "button");
		button.title = t("resetToDefault");
		row.append(button);
		const btn = button;
		button.addEventListener("click", () => {
			reset();
			syncReset(btn, true);
		});
	} else {
		row.append(createEl("span"));
	}
	panel.append(row);
	return button;
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
	select.id = "root-select";
	addSettingRow(panel, t("rootFolder"), select, () => {
		storageRemove("root");
		void rebuild();
	});

	select.addEventListener("focus", () => styleRootOptions(select, true));
	select.addEventListener("blur", () => styleRootOptions(select, false));
	select.addEventListener("change", () => {
		styleRootOptions(select, false);
		storageSet("root", select.value);
		void rebuild();
	});
}

/** (Re)fills the selector with every folder of the tree, indented by depth. */
function fillRootSelector(root: BookmarkTreeNode, selectedId: string): void {
	const select = document.getElementById("root-select") as HTMLSelectElement | null;
	if (select === null) return;
	select.replaceChildren();
	addFolderOption(select, root, "/", 0);
	select.value = selectedId;
	styleRootOptions(select, false);
	// The row's reset control shows only for a non-default root.
	const resetBtn = select.closest(".row")?.querySelector<HTMLElement>(".reset") ?? null;
	syncReset(resetBtn, selectedId === defaultRoot(root).id);
}

function addFolderOption(
	select: HTMLSelectElement,
	node: BookmarkTreeNode,
	label: string,
	depth: number,
): void {
	const option = createEl("option");
	option.value = node.id;
	// Both spellings of the name: indented for the open list, plain for
	// the closed control (styleRootOptions swaps between them).
	const indented = "  ".repeat(depth) + label;
	option.setAttribute("data-indented", indented);
	option.setAttribute("data-label", label);
	option.textContent = indented;
	select.append(option);

	for (const child of node.children ?? []) {
		if (child.children !== undefined) {
			addFolderOption(select, child, child.title === "" ? "…" : child.title, depth + 1);
		}
	}
}

/**
 * Swaps the root-selector option texts: the open dropdown shows the
 * depth-indented tree; the closed control shows the selected folder's
 * plain name, with no indentation around it.
 */
function styleRootOptions(select: HTMLSelectElement, open: boolean): void {
	for (const option of select.options) {
		const indented = option.getAttribute("data-indented");
		const label = option.getAttribute("data-label");
		if (indented === null || label === null) continue;
		const selected = option.value === select.value;
		option.textContent = selected && !open ? label : indented;
	}
}

/** Applies the stored font settings as inline styles on <body>. */
function applyFont(): void {
	const font = storageGet("font");
	const size = Number(storageGet("font_size"));
	document.body.style.fontFamily = font ?? "";
	document.body.style.fontSize = Number.isFinite(size) && size > 0 ? `${size}px` : "";
	updateTooltips();
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

	const input = createEl("input");
	input.type = "number";
	input.min = "8";
	input.max = "32";
	// The effective default, measured at runtime before any override is
	// applied — never hardcoded.
	input.placeholder = defaultFontSize() ?? t("defaultValue");
	input.value = storageGet("font_size") ?? "";
	const sizeReset = addSettingRow(panel, t("fontSize"), input, () => {
		storageRemove("font_size");
		input.value = "";
		applyFont();
	});
	syncReset(sizeReset, input.value === "");
	input.addEventListener("change", () => {
		storageSet("font_size", input.value);
		applyFont();
		syncReset(sizeReset, input.value === "");
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
	const current = storageGet("lang") ?? defaultLanguage();
	select.value = current;

	const resetBtn = addSettingRow(panel, t("language"), select, () => {
		storageRemove("lang");
		location.reload();
	});
	syncReset(resetBtn, current === defaultLanguage());
	select.addEventListener("change", () => {
		storageSet("lang", select.value);
		location.reload();
	});
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
	const dismiss = createEl("button", "dismiss", "✕");
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
