// The air around the text is not structure: when a row stops fitting
// the page, it is what gives, and nearly all of it goes before a title
// loses a letter — the cards' right side first, since nothing lives
// there, then the gap between columns, and last the gutter, down to a
// bare nesting indent. Edit mode never asks for more: the controls
// appear on one hovered row at a time, and that row's card borrows the
// air to its left for them (newtab.css), so the matrix stays put in
// both modes.
//
// The browser's own layout is the oracle: the probe pass lets the tracks
// take their full content width, and every row spans the whole track
// set, so one row's width is what the matrix asks for.

/** The gutter at rest: room for a folder row's three controls, the air
 * before the title (--text-air in newtab.css) and a hair of slack. */
const MAX_GUTTER = 3.8;
/** The right side's air at rest; #main's padding-right reserves the
 * difference from the gutter, so the text stays centered regardless. */
const MAX_PAD = 3.5;
/** The least the right side keeps: a hair between text and backdrop. */
const MIN_PAD = 0.25;
/** The gap between column tracks at rest; small, since the cards' own
 * air already separates the texts. */
const MAX_GAP = 1;
/** The least the gap keeps, so the neighbours' cards never touch. */
const MIN_GAP = 0.25;
/** The gutter's floor: the nesting indent and the air before a column.
 * Half a favicon still shows nested rows as nested. */
const MIN_GUTTER = 0.5;
/** Search resolution in em; finer steps are below one pixel of text. */
const STEP = 0.1;

/** What every probe reads; built once per fit, not per measurement. */
interface Probe {
	readonly main: HTMLElement;
	/** Any row: each one spans the full track set. */
	readonly row: Element;
	/** Live declaration — each read sees the padding of the moment. */
	readonly style: CSSStyleDeclaration;
}

/**
 * Grows the card air to the most the page has room for. Costs one
 * layout per probe — one when nothing is cramped, a dozen at worst — so
 * call it when widths can have changed, not per frame.
 */
export function fitAir(main: HTMLElement): void {
	setVar(main, "--gutter", MAX_GUTTER);
	setVar(main, "--pad", MAX_PAD);
	setVar(main, "--gap", MAX_GAP);
	const row = main.querySelector(".grid-row");
	if (row === null) return;
	const probe: Probe = { main, row, style: getComputedStyle(main) };
	main.classList.add("measuring");
	try {
		if (fits(probe)) return;
		search(probe, "--pad", MIN_PAD, MAX_PAD);
		if (fits(probe)) return;
		search(probe, "--gap", MIN_GAP, MAX_GAP);
		if (fits(probe)) return;
		search(probe, "--gutter", MIN_GUTTER, MAX_GUTTER);
	} finally {
		// Must go even if a read throws, or the matrix would be left in
		// its measurement state.
		main.classList.remove("measuring");
	}
}

/**
 * Applies the largest value in [min, max] that fits, or min if none
 * does. Monotonic by construction — more air never needs less width —
 * so halving the interval finds it.
 */
function search(probe: Probe, name: string, min: number, max: number): void {
	let lo = min;
	let hi = max;
	while (hi - lo > STEP) {
		const mid = (lo + hi) / 2;
		setVar(probe.main, name, mid);
		if (fits(probe)) lo = mid;
		else hi = mid;
	}
	setVar(probe.main, name, lo);
}

function setVar(el: HTMLElement, name: string, em: number): void {
	el.style.setProperty(name, `${em}em`);
}

/**
 * True while the matrix asks for no more width than the page offers.
 * The comparison is against the content box: once the two sides differ,
 * #main reserves the difference on the right to keep the text centered,
 * and that room is not the matrix's to eat.
 *
 * Throws if the computed padding is unreadable, which would mean the
 * element is not laid out and every answer here is meaningless.
 */
function fits({ main, row, style }: Probe): boolean {
	const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
	if (!Number.isFinite(padding)) {
		throw new Error(`gntp: unreadable padding on #main: ${style.paddingLeft}/${style.paddingRight}`);
	}
	// Half a pixel absorbs subpixel rounding of the track sizes.
	return row.getBoundingClientRect().width <= main.clientWidth - padding + 0.5;
}
