// Access to the WebExtension APIs and localization.

// typeof, not `browser ?? chrome`: reading an undeclared global throws
// a ReferenceError, and only some browsers define `browser`.
const ext: WebExtension = (typeof browser !== "undefined" ? browser : chrome)!;

/**
 * True in Firefox. Detected by the extension page's own URL scheme:
 * modern Chromium also exposes a `browser` global, so probing for it is
 * not a reliable signal.
 */
export const isFirefox = location.protocol === "moz-extension:";

/** The root node of the bookmarks tree. */
export async function getTree(): Promise<BookmarkTreeNode> {
	const [root] = await ext.bookmarks.getTree();
	if (root === undefined) throw new Error("empty bookmarks tree");
	return root;
}

/** The node with the given id (no children), or null when it is gone. */
export async function getBookmark(id: string): Promise<BookmarkTreeNode | null> {
	try {
		const [node] = await ext.bookmarks.get(id);
		return node ?? null;
	} catch {
		return null;
	}
}

/** The subtree rooted at the given folder, or null when it is gone. */
export async function getSubTree(id: string): Promise<BookmarkTreeNode | null> {
	try {
		const [node] = await ext.bookmarks.getSubTree(id);
		return node ?? null;
	} catch {
		return null;
	}
}

/**
 * Moves a bookmark within its folder (`index` alone), into another
 * folder (`parentId`, appended when `index` is absent) — a real change
 * in the browser's bookmark store, visible to the bookmark manager and
 * sync.
 */
export function moveBookmark(
	id: string,
	destination: { parentId?: string; index?: number },
): Promise<unknown> {
	return ext.bookmarks.move(id, destination);
}

/**
 * Renames a bookmark or folder and, for bookmarks, replaces its URL — a
 * real change in the browser's bookmark store, like moveBookmark().
 * Rejects when the store refuses the change (a malformed URL, a
 * permanent folder).
 */
export function updateBookmark(
	id: string,
	changes: { title: string; url?: string },
): Promise<unknown> {
	return ext.bookmarks.update(id, changes);
}

/**
 * Creates a bookmark — or, without a URL, a folder — appended to the
 * given parent in the bookmark store.
 */
export function createBookmark(details: {
	parentId: string;
	title: string;
	url?: string;
}): Promise<unknown> {
	return ext.bookmarks.create(details);
}

/** Deletes a bookmark or an empty folder from the bookmark store. */
export function removeBookmark(id: string): Promise<unknown> {
	return ext.bookmarks.remove(id);
}

/** Deletes a folder with everything in it, recursively. */
export function removeBookmarkTree(id: string): Promise<unknown> {
	return ext.bookmarks.removeTree(id);
}

const ALL_URLS = { origins: ["<all_urls>"] } as const;

/**
 * True if the "<all_urls>" host permission has been granted (needed to
 * read favicon bytes for the icon cache).
 */
export async function hasHostPermission(): Promise<boolean> {
	try {
		return await ext.permissions.contains(ALL_URLS);
	} catch {
		return false;
	}
}

/**
 * Requests the host permission. Must be called from a user-input
 * handler — the browser rejects requests made outside a user gesture.
 */
export function requestHostPermission(): Promise<boolean> {
	return ext.permissions.request(ALL_URLS).catch(() => false);
}

/** The browser's UI language tag (e.g. "ru-RU"), empty on failure. */
export function uiLanguage(): string {
	try {
		return ext.i18n.getUILanguage();
	} catch {
		return "";
	}
}

// Messages of the manually chosen language ("lang" setting), loaded from
// the packaged _locales; null = follow the browser language.
let localeOverride: Map<string, string> | null = null;

/**
 * Loads the messages of the manually chosen language, if any. Must run
 * before any `t()` call; failures silently keep the browser language.
 */
export async function initLocale(lang: string | null): Promise<void> {
	if (lang === null || lang === "") return;
	try {
		const response = await fetch(`/_locales/${lang}/messages.json`);
		const json = (await response.json()) as Record<string, { message?: string }>;
		localeOverride = new Map();
		for (const [key, value] of Object.entries(json)) {
			if (typeof value.message === "string") localeOverride.set(key, value.message);
		}
	} catch {
		localeOverride = null;
	}
}

/**
 * The localized UI string for `key`, honoring the manual language
 * override; falls back to the key itself so text never silently
 * disappears.
 */
export function t(key: string): string {
	const overridden = localeOverride?.get(key);
	if (overridden !== undefined) return overridden;
	let message = "";
	try {
		message = ext.i18n.getMessage(key);
	} catch {
		/* fall through to the key */
	}
	return message === "" ? key : message;
}
