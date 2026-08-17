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
