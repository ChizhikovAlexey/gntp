// Editing bookmarks and folders in place (edit mode only): the pencil
// in a card's gutter opens a small popover — the settings panel's
// chrome — with the item's name, its URL (bookmarks), and the folder it
// lives in. Saving writes to the browser's bookmark store via
// bookmarks.update()/move(), not kept in the extension; the page is
// then re-rendered from the fresh tree. Light dismiss and Esc cancel,
// as in the settings popover.
//
// Deleting goes through an in-place confirmation view. For a folder
// with contents it offers a checkbox: delete everything inside too
// (previewing the first few items and the count of the rest), or spill
// the contents into the parent folder and delete the folder alone.
//
// The click listener is delegated to the roots, so it survives
// re-renders; the popover itself is built on the first click, so a
// casual new tab never pays its DOM.

import {
	createBookmark,
	getBookmark,
	getSubTree,
	getTree,
	isFirefox,
	moveBookmark,
	removeBookmark,
	removeBookmarkTree,
	t,
	updateBookmark,
} from "./api.js";
import { editMode } from "./dnd.js";
import * as icons from "./icons.js";
import {
	createEl,
	eventItem,
	fillFolderTree,
	findNode,
	styleFolderOptions,
	svgIcon,
	targetElement,
} from "./util.js";

/** How many of a folder's items the delete confirmation lists. */
const PREVIEW_ROWS = 5;

/** Everything the editor popover is made of; built on the first open. */
interface Ui {
	readonly form: HTMLFormElement;
	readonly title: HTMLElement;
	readonly tabBookmark: HTMLButtonElement;
	readonly tabFolder: HTMLButtonElement;
	readonly name: HTMLInputElement;
	readonly url: HTMLInputElement;
	readonly urlRow: HTMLElement;
	readonly urlIcon: HTMLImageElement;
	readonly folder: HTMLSelectElement;
	/** The confirmation view's parts. */
	readonly question: HTMLElement;
	readonly contentsRow: HTMLElement;
	readonly contents: HTMLInputElement;
	readonly preview: HTMLElement;
	readonly more: HTMLElement;
}

let ui: Ui | null = null;
let iconTimer = 0;
/** Editing an existing item, or creating a new one. */
let mode: "edit" | "create" = "edit";
/** What the open editor works on; drives the title and the URL row. */
let kind: "bookmark" | "folder" = "bookmark";
/** The id being edited; null while creating. */
let editedId: string | null = null;
/** The folder the edited item was in when the popover opened. */
let editedParentId: string | null = null;

export function initEdit(roots: readonly HTMLElement[], rebuild: () => Promise<void>): void {
	const onClick = (e: Event): void => {
		const target = targetElement(e);
		const pencil = target?.classList.contains("edit-item") === true;
		const plus = target?.classList.contains("add-item") === true;
		if (!pencil && !plus) return;
		// The controls only render in edit mode, but the check keeps a
		// stray synthetic click from opening the editor outside it.
		if (!editMode()) return;
		const item = eventItem(e);
		if (item === null) return;
		if (pencil) void open(item.id, rebuild);
		else void openCreateNear(item.id, rebuild);
	};
	for (const root of roots) root.addEventListener("click", onClick);
}

/**
 * The row's plus: create a new item where this row lives — inside a
 * folder row, or alongside a bookmark row (its parent folder).
 */
async function openCreateNear(id: string, rebuild: () => Promise<void>): Promise<void> {
	const node = await getBookmark(id);
	if (node === null) return;
	const folderId = node.url === undefined ? node.id : (node.parentId ?? null);
	await openCreate(rebuild, folderId);
}

/** Fills the editor with the item's current state and shows it. */
async function open(id: string, rebuild: () => Promise<void>): Promise<void> {
	// Fetched from the store, not scraped off the row: the row's text
	// falls back to the URL when the title is empty.
	const node = await getBookmark(id);
	if (node === null) return;
	const tree = await getTree().catch(() => null);
	const u = buildEditor(rebuild);
	mode = "edit";
	kind = node.url === undefined ? "folder" : "bookmark";
	editedId = id;
	editedParentId = node.parentId ?? null;
	u.name.value = node.title;
	u.url.value = node.url ?? "";
	// Neither the tree root (browsers refuse items placed directly in
	// it) nor the edited folder's own subtree can be the parent; they
	// stay visible but grayed, keeping the tree's shape intact.
	if (tree !== null) {
		const banned = new Set([tree.id]);
		if (node.children !== undefined) {
			const self = findNode(tree, id);
			if (self !== null) banSubtree(self, banned);
		}
		fillFolderTree(u.folder, tree, (n) => banned.has(n.id));
		if (editedParentId !== null) u.folder.value = editedParentId;
		styleFolderOptions(u.folder, false);
	}
	present(u);
	u.name.select();
}

/**
 * Opens the editor in its create view: the tabs choose whether a new
 * bookmark or folder is made; it lands in the selected folder — `at`
 * when given (a row's plus), the displayed root otherwise.
 */
export async function openCreate(
	rebuild: () => Promise<void>,
	at?: string | null,
): Promise<void> {
	const tree = await getTree().catch(() => null);
	const u = buildEditor(rebuild);
	mode = "create";
	kind = "bookmark";
	editedId = null;
	editedParentId = null;
	u.name.value = "";
	u.url.value = "";
	if (tree !== null) {
		fillFolderTree(u.folder, tree, (n) => n.id === tree.id);
		const rootId = at ?? document.getElementById("main")?.getAttribute("data-root");
		if (rootId !== null && rootId !== undefined) u.folder.value = rootId;
		// The stamped root can be the unselectable tree root itself: fall
		// back to the first real folder.
		if (u.folder.selectedOptions[0]?.disabled !== false) {
			const first = [...u.folder.options].find((option) => !option.disabled);
			if (first !== undefined) u.folder.value = first.value;
		}
		styleFolderOptions(u.folder, false);
	}
	present(u);
	u.name.focus();
}

/** Marks every folder of the subtree as no valid parent. */
function banSubtree(node: BookmarkTreeNode, banned: Set<string>): void {
	banned.add(node.id);
	for (const child of node.children ?? []) {
		if (child.children !== undefined) banSubtree(child, banned);
	}
}

function clearValidity(): void {
	if (ui === null) return;
	ui.name.setCustomValidity("");
	ui.url.setCustomValidity("");
	ui.folder.setCustomValidity("");
}

/** The shared tail of opening either view: reset, render, show. */
function present(u: Ui): void {
	clearValidity();
	updateUrlIcon();
	applyView();
	u.form.classList.remove("confirming");
	u.form.showPopover();
}

/** Aligns the window with the mode and kind: title, tabs, URL row. */
function applyView(): void {
	if (ui === null) return;
	const bookmark = kind === "bookmark";
	ui.form.classList.toggle("creating", mode === "create");
	ui.tabBookmark.classList.toggle("on", bookmark);
	ui.tabFolder.classList.toggle("on", !bookmark);
	// Folders have no URL; the row keeps its grid cells when hidden via
	// display:none on the whole label (see newtab.css).
	ui.urlRow.classList.toggle("off", !bookmark);
	ui.title.textContent = t(
		mode === "create"
			? bookmark
				? "createBookmark"
				: "createFolder"
			: bookmark
				? "editBookmark"
				: "editFolder",
	);
}

/**
 * The editor popover, built once. A <form>, so Enter in a field saves
 * through the native submit path (ignored while confirming a delete).
 */
function buildEditor(rebuild: () => Promise<void>): Ui {
	if (ui !== null) return ui;
	const form = createEl("form", "dialog");
	form.id = "item-editor";
	form.setAttribute("popover", "");

	// The window's heading, and — in the create view — the tabs picking
	// what is being created.
	const title = createEl("div", "title");
	form.append(title);
	const tabs = createEl("div", "tabs");
	const tabBookmark = tabButton("bookmark");
	const tabFolder = tabButton("folder");
	tabs.append(tabBookmark, tabFolder);
	form.append(tabs);

	const name = createEl("input");
	name.type = "text";
	// A rejection notice (see submit) sticks to its field — and blocks
	// the next submit — until the field is retyped.
	name.addEventListener("input", () => name.setCustomValidity(""));
	form.append(row(t("itemName"), name));

	const url = createEl("input");
	url.type = "text";
	url.addEventListener("input", () => {
		url.setCustomValidity("");
		// Debounced: re-resolving the icon on every keystroke would fire
		// a network image load per character typed.
		clearTimeout(iconTimer);
		iconTimer = setTimeout(updateUrlIcon, 300);
	});
	// The field's icon slot, laid over the input's left padding.
	const box = createEl("span", "url-box");
	const urlIcon = createEl("img", "url-icon");
	urlIcon.alt = "";
	// Hidden until each load succeeds, so a stale or broken icon never
	// lingers next to an address it doesn't belong to.
	urlIcon.addEventListener("load", () => urlIcon.style.removeProperty("visibility"));
	urlIcon.addEventListener("error", () => hideUrlIcon());
	box.append(urlIcon, url);
	const urlRow = row(t("itemUrl"), box);
	form.append(urlRow);

	// Where the item lives; changing it moves the item on save. The
	// selector is the settings' root selector, mechanism and all (see
	// fillFolderTree in util.ts).
	const folder = createEl("select");
	folder.addEventListener("focus", () => styleFolderOptions(folder, true));
	folder.addEventListener("blur", () => styleFolderOptions(folder, false));
	folder.addEventListener("change", () => {
		folder.setCustomValidity("");
		styleFolderOptions(folder, false);
	});
	form.append(row(t("folder"), folder));

	const buttons = createEl("div", "buttons");
	const del = createEl("button", "delete", t("delete"));
	del.type = "button";
	del.addEventListener("click", () => void askDelete());
	const cancel = createEl("button", undefined, t("cancel"));
	cancel.type = "button";
	cancel.addEventListener("click", () => form.hidePopover());
	const save = createEl("button", undefined, t("save"));
	save.type = "submit";
	buttons.append(del, cancel, save);
	form.append(buttons);

	// The delete-confirmation view, swapped in over the rows.
	const confirm = createEl("div", "confirm");
	const question = createEl("div", "question");
	confirm.append(question);
	const contentsRow = createEl("label", "contents");
	const contents = createEl("input");
	contents.type = "checkbox";
	contents.checked = true;
	contents.addEventListener("change", syncPreview);
	contentsRow.append(contents, ` ${t("deleteContents")}`);
	confirm.append(contentsRow);
	const preview = createEl("ul", "preview");
	confirm.append(preview);
	const more = createEl("div", "more");
	confirm.append(more);
	const confirmButtons = createEl("div", "buttons");
	const back = createEl("button", undefined, t("cancel"));
	back.type = "button";
	back.addEventListener("click", () => form.classList.remove("confirming"));
	const really = createEl("button", "delete", t("delete"));
	really.type = "button";
	really.addEventListener("click", () => void doDelete(rebuild));
	confirmButtons.append(back, really);
	confirm.append(confirmButtons);
	form.append(confirm);

	form.addEventListener("submit", (e) => {
		e.preventDefault();
		if (form.classList.contains("confirming")) return;
		void submit(rebuild);
	});
	document.body.append(form);
	ui = {
		form,
		title,
		tabBookmark,
		tabFolder,
		name,
		url,
		urlRow,
		urlIcon,
		folder,
		question,
		contentsRow,
		contents,
		preview,
		more,
	};
	return ui;
}

/** A create-view tab: the kind's icon and name; clicking picks it. */
function tabButton(pick: "bookmark" | "folder"): HTMLButtonElement {
	const tab = createEl("button", "tab");
	tab.type = "button";
	tab.append(svgIcon(pick), createEl("span", undefined, t(pick)));
	tab.addEventListener("click", () => {
		kind = pick;
		applyView();
	});
	return tab;
}

/** A "name — control" row of the editor grid, as in the settings panel. */
function row(name: string, control: HTMLElement): HTMLElement {
	const label = createEl("label", "row");
	label.append(createEl("span", undefined, name));
	label.append(control);
	return label;
}

/**
 * Anything with an explicit scheme — proto://…, or the schemeless kinds
 * of URL browsers bookmark (about:, javascript:, mailto:, …). A colon
 * alone is not enough: "localhost:8080" names a host, not a scheme.
 */
const HAS_SCHEME =
	/^(?:[a-z][a-z0-9+.-]*:\/\/|about:|data:|javascript:|mailto:|file:|view-source:|chrome:|edge:|moz-extension:|chrome-extension:|place:)/i;

/**
 * The address as it should be stored: bare hosts like "yandex.ru" get
 * https:// in front — the store would refuse them as typed.
 */
function normalizeUrl(raw: string): string {
	const page = raw.trim();
	if (page === "" || HAS_SCHEME.test(page)) return page;
	return `https://${page}`;
}

function hideUrlIcon(): void {
	if (ui !== null) ui.urlIcon.style.visibility = "hidden";
}

/**
 * The icon for a page address, resolved like the bookmark rows resolve
 * theirs. Chromium serves it from the local /_favicon/ endpoint;
 * Firefox reads the extension's icon cache, falling back to the site's
 * own /favicon.ico for origins not cached yet.
 */
function faviconSrc(page: string): string | null {
	if (!page.startsWith("http://") && !page.startsWith("https://")) return null;
	let origin: string;
	try {
		origin = new URL(page).origin;
	} catch {
		return null;
	}
	if (!isFirefox) return `/_favicon/?pageUrl=${encodeURIComponent(page)}&size=32`;
	const entry = icons.cached(origin);
	return entry.state === "fresh" || entry.state === "stale"
		? icons.objectUrlFor(origin, entry.data)
		: `${origin}/favicon.ico`;
}

/**
 * Points the URL field's icon at the current address. Only a successful
 * load reveals it (see buildEditor). The cache itself is not written
 * here: saving re-renders the page, and the ordinary render path
 * fetches and caches the new origin's icon like any other.
 */
function updateUrlIcon(): void {
	if (ui === null) return;
	hideUrlIcon();
	const src = faviconSrc(normalizeUrl(ui.url.value));
	if (src !== null) ui.urlIcon.src = src;
}

async function submit(rebuild: () => Promise<void>): Promise<void> {
	if (ui === null) return;
	if (mode === "create") {
		const details: { parentId: string; title: string; url?: string } = {
			parentId: ui.folder.value,
			title: ui.name.value,
		};
		// Without a URL the store creates a folder.
		if (kind === "bookmark") details.url = normalizeUrl(ui.url.value);
		try {
			await createBookmark(details);
		} catch {
			const guilty = kind === "bookmark" ? ui.url : ui.name;
			guilty.setCustomValidity(t(kind === "bookmark" ? "invalidUrl" : "cantSave"));
			guilty.reportValidity();
			return;
		}
		ui.form.hidePopover();
		await rebuild();
		return;
	}
	if (editedId === null) return;
	const changes: { title: string; url?: string } = { title: ui.name.value };
	const hasUrl = !ui.urlRow.classList.contains("off");
	if (hasUrl) changes.url = normalizeUrl(ui.url.value);
	try {
		await updateBookmark(editedId, changes);
	} catch {
		// The store refused. For a bookmark that is in practice a
		// malformed URL — said on the field, and the editor stays open
		// for a correction. A folder rename can only be refused wholesale
		// (permanent folder, item deleted meanwhile).
		const guilty = hasUrl ? ui.url : ui.name;
		guilty.setCustomValidity(t(hasUrl ? "invalidUrl" : "cantSave"));
		guilty.reportValidity();
		return;
	}
	// A different folder chosen: move there (appended at its end).
	if (ui.folder.value !== "" && editedParentId !== null && ui.folder.value !== editedParentId) {
		try {
			await moveBookmark(editedId, { parentId: ui.folder.value });
		} catch {
			ui.folder.setCustomValidity(t("cantSave"));
			ui.folder.reportValidity();
			return;
		}
	}
	ui.form.hidePopover();
	await rebuild();
}

/** Swaps the editor into the delete-confirmation view. */
async function askDelete(): Promise<void> {
	if (ui === null || editedId === null) return;
	// The subtree as it stands right now: what the deletion covers.
	const node = await getSubTree(editedId);
	if (node === null) {
		// Deleted meanwhile (another window): nothing left to confirm.
		ui.form.hidePopover();
		return;
	}
	const name = node.title !== "" ? node.title : (node.url ?? "…");
	// The name lands in the message as a bold element, not quoted text.
	const message = t("deleteQuestion");
	const at = message.indexOf("{name}");
	ui.question.replaceChildren();
	if (at < 0) {
		ui.question.append(message);
	} else {
		ui.question.append(
			message.slice(0, at),
			createEl("b", undefined, name),
			message.slice(at + "{name}".length),
		);
	}
	const inside = flatten(node);
	// Only a folder with contents offers the recursive choice.
	ui.contentsRow.classList.toggle("off", inside.length === 0);
	ui.contents.checked = true;
	renderPreview(inside);
	syncPreview();
	ui.form.classList.add("confirming");
}

/** The folder's contents, depth first — the deletion order shown. */
function flatten(node: BookmarkTreeNode): BookmarkTreeNode[] {
	const out: BookmarkTreeNode[] = [];
	const walk = (n: BookmarkTreeNode): void => {
		for (const child of n.children ?? []) {
			// Separators are not worth listing or counting.
			if (child.url === undefined && child.children === undefined) continue;
			out.push(child);
			walk(child);
		}
	};
	walk(node);
	return out;
}

/** The first few doomed items, plus a count of the unlisted rest. */
function renderPreview(inside: readonly BookmarkTreeNode[]): void {
	if (ui === null) return;
	ui.preview.replaceChildren();
	for (const node of inside.slice(0, PREVIEW_ROWS)) {
		const item = createEl("li");
		const src = node.url === undefined ? null : faviconSrc(node.url);
		if (src === null) {
			// Folders (and unresolvable icons) keep the slot, like rows do.
			item.append(createEl("span", "favicon"));
		} else {
			const img = createEl("img", "favicon");
			img.alt = "";
			img.src = src;
			item.append(img);
		}
		item.append(node.title !== "" ? node.title : (node.url ?? "…"));
		ui.preview.append(item);
	}
	const rest = inside.length - Math.min(inside.length, PREVIEW_ROWS);
	ui.more.textContent = rest > 0 ? t("andMore").replace("{n}", String(rest)) : "";
}

/** The doomed-items list shows only while contents are being deleted. */
function syncPreview(): void {
	if (ui === null) return;
	const on = ui.contents.checked && !ui.contentsRow.classList.contains("off");
	ui.preview.classList.toggle("off", !on);
	ui.more.classList.toggle("off", !on);
}

async function doDelete(rebuild: () => Promise<void>): Promise<void> {
	if (ui === null || editedId === null) return;
	const withContents = !ui.contentsRow.classList.contains("off");
	try {
		if (withContents && ui.contents.checked) {
			await removeBookmarkTree(editedId);
		} else if (withContents) {
			// Keep the contents: spill them into the parent folder (at its
			// end, in order), then delete the emptied folder itself.
			if (editedParentId === null) throw new Error("no parent");
			const node = await getSubTree(editedId);
			for (const child of node?.children ?? []) {
				await moveBookmark(child.id, { parentId: editedParentId });
			}
			await removeBookmark(editedId);
		} else {
			await removeBookmark(editedId);
		}
	} catch {
		// Refused (a permanent folder, say): said in place of the question.
		ui.question.textContent = t("cantSave");
		return;
	}
	ui.form.hidePopover();
	await rebuild();
}
