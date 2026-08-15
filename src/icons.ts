// Favicon cache for the Firefox path (Chromium uses its local /_favicon/
// endpoint and needs no caching).
//
// Sites often serve favicon.ico with no-cache, so plain <img> loads
// revalidate over the network on every page open. Instead, icons are
// cached in localStorage as data: URLs and read *synchronously* during
// render — a cache hit paints in the same frame as the bookmark text.
// Fetched icons are re-encoded to 16×16 PNG, shrinking multi-size ICOs
// from tens of kilobytes to well under one: less storage, smaller DOM
// strings, smaller decoded bitmaps.

import { storageGet, storageRemove, storageSet } from "./util.js";

/**
 * Icons older than this are refreshed in the background while the old
 * one keeps being shown (and kept if the refresh fails).
 */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** How long a recorded fetch failure suppresses programmatic retries. */
const FAIL_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_ICON_BYTES = 128 * 1024;
const ENCODED_SIZE = 16;
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

// Origins whose icons are missing from the cache, collected during
// render; fetched only after the first paint so background loading
// never competes with rendering the cached icons.
const pending = new Set<string>();

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

/** Queues the origin's favicon to be fetched and cached after first paint. */
export function prefetch(origin: string): void {
	pending.add(origin);
}

/**
 * Starts the queued fetches strictly after the page has painted:
 * requestAnimationFrame fires just before the next paint, a zero
 * timeout scheduled from it runs right after.
 */
export function flushPrefetch(): void {
	requestAnimationFrame(() => {
		setTimeout(() => {
			for (const origin of pending) void fetchAndStore(origin);
			pending.clear();
		});
	});
}

async function fetchAndStore(origin: string): Promise<void> {
	const key = cacheKey(origin);
	const dataUrl = await fetchIcon(origin);
	if (dataUrl !== null) {
		storageSet(key, `${Date.now()}|${dataUrl}`);
		return;
	}
	// Record the failure (switches the origin to the direct-<img>
	// fallback and throttles retries), but never overwrite a previously
	// cached icon with it.
	const existing = storageGet(key);
	const hasIcon = existing !== null && !existing.endsWith("|");
	if (!hasIcon) storageSet(key, `${Date.now()}|`);
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
