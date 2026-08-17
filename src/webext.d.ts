// Minimal ambient typings for the WebExtension APIs this extension uses.
// Hand-written instead of a @types dependency: zero packages, and only
// the surface we actually touch.

interface BookmarkTreeNode {
	readonly id: string;
	readonly title: string;
	/** Position among siblings in the parent folder; absent on the root. */
	readonly index?: number;
	readonly url?: string;
	/** "bookmark" | "folder" | "separator" — Firefox only. */
	readonly type?: string;
	/**
	 * "bookmarks-bar" | "other" | "mobile" | "managed" — Chromium only,
	 * marking permanent folders (their ids are no longer guaranteed).
	 */
	readonly folderType?: string;
	readonly children?: readonly BookmarkTreeNode[];
}

interface WebExtension {
	readonly bookmarks: {
		getTree(): Promise<readonly BookmarkTreeNode[]>;
		getSubTree(id: string): Promise<readonly BookmarkTreeNode[]>;
		move(id: string, destination: { parentId?: string; index?: number }): Promise<unknown>;
	};
	readonly i18n: {
		getMessage(key: string): string;
		getUILanguage(): string;
	};
	readonly permissions: {
		contains(query: { origins: readonly string[] }): Promise<boolean>;
		request(query: { origins: readonly string[] }): Promise<boolean>;
	};
}

declare var browser: WebExtension | undefined;
declare var chrome: WebExtension | undefined;
