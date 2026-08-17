// Favicon cache for the Firefox path (Chromium uses its local /_favicon/
// endpoint and needs no caching).
//
// Sites often serve favicon.ico with no-cache, so plain <img> loads
// revalidate over the network on every page open. Instead, icons are
// cached in localStorage as data: URLs and read *synchronously* during
// render — a cache hit paints in the same frame as the bookmark text.
// Fetched icons are re-encoded to 32×32 PNG (crisp in the 16px CSS slot
// on HiDPI screens), shrinking multi-size ICOs from tens of kilobytes
// to a few: less storage, smaller DOM strings, smaller decoded bitmaps.

import { storageGet, storageRemove, storageSet } from "./util.js";

/**
 * Icons older than this are refreshed in the background while the old
 * one keeps being shown (and kept if the refresh fails).
 */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** How long a recorded fetch failure suppresses programmatic retries. */
const FAIL_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_ICON_BYTES = 128 * 1024;
const ENCODED_SIZE = 32;
/**
 * Hard cap on a stored entry: anything bigger decodes into a large
 * bitmap attributed to every new tab page. Icons that can't be
 * re-encoded under the cap are treated as failures (blank icon) —
 * memory first.
 */
const MAX_STORED_CHARS = 8 * 1024;

// Strict mode = the host permission is granted: only instant cached
// icons are ever rendered; misses stay blank and get cached for the
// next open, so the page never shows icons loading.
let strictMode = false;

export function setStrict(enabled: boolean): void {
	strictMode = enabled;
}

export function strict(): boolean {
	return strictMode;
}

// Origins whose icons the render could not paint from the cache,
// fetched only after the first paint so background loading never
// competes with rendering the cached icons. The flag records whether
// the row was left blank, i.e. whether landing the icon is worth a
// re-render.
const pending = new Map<string, boolean>();
// Origins being fetched right now: a folder expanded mid-batch must not
// queue them a second time.
const inFlight = new Set<string>();

let shrinking = false;

const cacheKey = (origin: string): string => `icon:${origin}`;

// Cached data URLs are handed to <img> as short-lived blob: URLs: a
// long data URI in src is accounted to the DOM node itself (parsed URI
// plus decoded surface), while a blob reference keeps the node light.
const objectUrls = new Map<string, string>();

/** A blob: URL for the origin's cached icon; stable within one render era. */
export function objectUrlFor(origin: string, dataUrl: string): string {
	const existing = objectUrls.get(origin);
	if (existing !== undefined) return existing;
	let url: string;
	try {
		const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
		url = URL.createObjectURL(new Blob([bytes], { type: mime }));
	} catch {
		url = dataUrl;
	}
	objectUrls.set(origin, url);
	return url;
}

/** Frees the previous render era's blob URLs (call before a rebuild). */
export function revokeObjectUrls(): void {
	for (const url of objectUrls.values()) URL.revokeObjectURL(url);
	objectUrls.clear();
}

export type Cached =
	| { readonly state: "fresh" | "stale"; readonly data: string }
	| { readonly state: "failed"; readonly retry: boolean }
	| { readonly state: "miss" };

/**
 * Cache entries are stored as "<timestamp_ms>|<data URL>"; an empty data
 * part records a fetch failure. A failure never overwrites a cached
 * icon, so icons can't be lost to transient outages (VPN off, site
 * down) — at worst their refresh is postponed.
 */
export function cached(origin: string): Cached {
	const entry = storageGet(cacheKey(origin));
	const separator = entry?.indexOf("|") ?? -1;
	if (entry === null || separator < 0) return { state: "miss" };
	const age = Date.now() - Number(entry.slice(0, separator));
	const data = entry.slice(separator + 1);
	if (data === "") return { state: "failed", retry: age > FAIL_TTL_MS };
	return { state: age < TTL_MS ? "fresh" : "stale", data };
}

/**
 * True if the cache holds anything at all — evidence that this profile
 * has opened the page before, even with no setting ever changed.
 */
export function cachedAny(): boolean {
	for (let i = 0; i < localStorage.length; i++) {
		if (localStorage.key(i)?.startsWith("icon:") === true) return true;
	}
	return false;
}

/**
 * Queues the origin's favicon to be fetched and cached after first
 * paint. `blank` says the row shows no icon at all meanwhile, so a
 * successful fetch is worth re-rendering for.
 */
export function prefetch(origin: string, blank: boolean): void {
	if (!inFlight.has(origin)) pending.set(origin, blank);
}

/**
 * Starts the queued fetches strictly after the page has painted:
 * requestAnimationFrame fires just before the next paint, a zero
 * timeout scheduled from it runs right after.
 *
 * `gained` runs once, after the whole batch settles, if the cache now
 * holds an icon for a row the render left blank (first install, new
 * bookmarks) — the caller re-renders so those icons show without a
 * manual refresh. Background TTL refreshes never trigger it.
 */
export function flushPrefetch(gained?: () => void): void {
	requestAnimationFrame(() => {
		setTimeout(() => {
			const batch = [...pending].map(([origin, blank]) => fetchAndStore(origin, blank));
			pending.clear();
			void Promise.all(batch).then((fresh) => {
				if (fresh.some(Boolean)) gained?.();
			});
		});
	});
}

/**
 * Fetches and caches one origin's icon. True only when the row it was
 * queued for showed nothing and the cache now holds an icon — the one
 * case a re-render improves. The cache is read back instead of trusting
 * the write: a full quota stores nothing (storageSet swallows the
 * error), and claiming otherwise would ask for a re-render that only
 * queues the very same fetch again, forever.
 */
async function fetchAndStore(origin: string, blank: boolean): Promise<boolean> {
	const key = cacheKey(origin);
	inFlight.add(origin);
	try {
		const dataUrl = await fetchIcon(origin);
		if (dataUrl !== null) {
			storageSet(key, `${Date.now()}|${dataUrl}`);
		} else if (!hasIcon(key)) {
			// Record the failure (switches the origin to the direct-<img>
			// fallback and throttles retries), but never overwrite a
			// previously cached icon with it.
			storageSet(key, `${Date.now()}|`);
		}
		return blank && hasIcon(key);
	} finally {
		inFlight.delete(origin);
	}
}

/** True when the stored entry holds an icon rather than a failure. */
function hasIcon(key: string): boolean {
	const entry = storageGet(key);
	// Base64 never ends in "|", so an entry that does records a failure.
	return entry !== null && !entry.endsWith("|");
}

/**
 * The well-known /favicon.ico first; if the site doesn't serve one,
 * full discovery like a browser: fetch the page and follow its
 * <link rel="icon"> declaration.
 */
async function fetchIcon(origin: string): Promise<string | null> {
	return (await fetchImage(`${origin}/favicon.ico`)) ?? discoverIcon(origin);
}

async function discoverIcon(origin: string): Promise<string | null> {
	try {
		const response = await fetch(origin);
		if (!response.ok) return null;
		// Relative hrefs resolve against the final URL, after redirects.
		const base = response.url;
		const html = await response.text();
		const doc = new DOMParser().parseFromString(html, "text/html");
		// ~= matches "icon" as a word, covering rel="shortcut icon" too.
		const href = doc.querySelector("link[rel~='icon']")?.getAttribute("href");
		if (href === null || href === undefined) return null;
		return await fetchImage(new URL(href, base).href);
	} catch {
		return null;
	}
}

async function fetchImage(url: string): Promise<string | null> {
	try {
		const response = await fetch(url);
		if (!response.ok) return null;
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
		// Like <img>, trust the bytes over the content-type header:
		// personal servers often serve favicon.ico as octet-stream.
		const header = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
		const mime = sniffMime(bytes) ?? (header.startsWith("image/") ? header : null);
		if (mime === null) return null;
		const blob = new Blob([bytes], { type: mime });
		const objectUrl = URL.createObjectURL(blob);
		let encoded: string | null;
		try {
			encoded = (await reencode(objectUrl)) ?? (await dataUrl(blob));
		} finally {
			URL.revokeObjectURL(objectUrl);
		}
		return encoded !== null && encoded.length <= MAX_STORED_CHARS ? encoded : null;
	} catch {
		return null;
	}
}

/**
 * Re-encodes an icon of any format the browser can decode (ICO
 * included) into a tiny fixed-size PNG; null when decoding fails, in
 * which case the original bytes are cached instead.
 */
async function reencode(src: string): Promise<string | null> {
	try {
		const image = new Image();
		image.src = src;
		await image.decode();
		const canvas = new OffscreenCanvas(ENCODED_SIZE, ENCODED_SIZE);
		const context = canvas.getContext("2d");
		if (context === null) return null;
		context.drawImage(image, 0, 0, ENCODED_SIZE, ENCODED_SIZE);
		return await dataUrl(await canvas.convertToBlob({ type: "image/png" }));
	} catch {
		return null;
	}
}

/**
 * Entries written before re-encoding existed hold full-size icons (up
 * to 128 KB); the whole localStorage snapshot lives in process memory,
 * so they are shrunk in place — from the cached bytes, no network.
 * Runs sequentially in idle time; keeps each entry's timestamp.
 */
export async function shrinkLegacyEntries(): Promise<void> {
	// Armed by every render; the scan itself is worth running only once.
	if (shrinking) return;
	shrinking = true;
	const RECODE_THRESHOLD = 2048;
	const keys: string[] = [];
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (key !== null && key.startsWith("icon:")) keys.push(key);
	}
	for (const key of keys) {
		const entry = storageGet(key);
		const separator = entry?.indexOf("|") ?? -1;
		if (entry === null || separator < 0) continue;
		const data = entry.slice(separator + 1);
		if (data.length <= RECODE_THRESHOLD || !data.startsWith("data:")) continue;
		const small = await reencode(data);
		// A fetch may have replaced the entry while it was re-encoding;
		// the fresh icon must not lose to this stale copy.
		if (storageGet(key) !== entry) continue;
		if (small !== null && small.length <= MAX_STORED_CHARS) {
			storageSet(key, entry.slice(0, separator + 1) + small);
		} else {
			// Un-shrinkable oversized entries are evicted: the next open
			// refetches them under the new size policy.
			storageRemove(key);
		}
	}
}

function dataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error("unreadable blob"));
		reader.readAsDataURL(blob);
	});
}

function sniffMime(bytes: Uint8Array): string | null {
	const [a, b, c, d] = [bytes[0], bytes[1], bytes[2], bytes[3]];
	if (a === 0x00 && b === 0x00 && c === 0x01 && d === 0x00) return "image/x-icon";
	if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return "image/png";
	if (a === 0xff && b === 0xd8) return "image/jpeg";
	if (a === 0x47 && b === 0x49 && c === 0x46 && d === 0x38) return "image/gif";
	if (a === 0x42 && b === 0x4d) return "image/bmp";
	return null;
}
