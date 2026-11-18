/*
 * SEOdash. Copyright (C) 2026 the SEOdash authors. Licensed under GPL-3.0-only; see LICENSE.
 */
/**
 * Helpers for building JSON-LD: dropping empty values, absolute URLs, ISO dates and durations, and
 * tolerant parsing of the list-like text fields (one item per line).
 */
import { isRecord } from "../../kit.js";

export type Node = Record<string, unknown>;

export const CONTEXT = "https://schema.org";

/** Keys that describe a node without saying anything about the thing itself. */
const STRUCTURAL = new Set(["@type", "@context", "@id"]);

function pruneValue(value: unknown): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "string") return value.trim() ? value.trim() : undefined;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value)) {
		const items = value.map(pruneValue).filter((item) => item !== undefined);
		return items.length ? items : undefined;
	}
	if (isRecord(value)) {
		const out: Node = {};
		for (const [key, inner] of Object.entries(value)) {
			const kept = pruneValue(inner);
			if (kept !== undefined) out[key] = kept;
		}
		const keys = Object.keys(out);
		// A reference (`{"@id": …}`, with or without a type) is meaningful on its own; a bare `@type` is not.
		return "@id" in out || keys.some((key) => !STRUCTURAL.has(key)) ? out : undefined;
	}
	return value;
}

/** Removes empty strings, empty lists and nodes that hold nothing but `@type`, at every depth. */
export function prune(node: Node): Node | null {
	const out = pruneValue(node);
	return isRecord(out) ? out : null;
}

/** An absolute http(s) URL, or "" when the value is not a usable URL. */
export function absoluteUrl(value: string, base: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	try {
		const url = new URL(trimmed, base || undefined);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
	} catch {
		return "";
	}
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * An ISO 8601 date or date-time. Accepts `2026-05-01`, `2026-05-01 19:30`, `2026-05-01T19:30:00+02:00`
 * and anything `Date` can read; returns "" for text that is not a date.
 */
export function isoDate(value: string): string {
	const text = value.trim();
	if (!text) return "";
	const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(text);
	if (match) {
		const [, year, month, day, hour, minute, second, zone] = match;
		if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return "";
		const date = `${year}-${pad(Number(month))}-${pad(Number(day))}`;
		if (hour === undefined || minute === undefined) return date;
		if (Number(hour) > 23 || Number(minute) > 59) return "";
		const offset = zone ? (zone.toUpperCase() === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`) : "";
		return `${date}T${pad(Number(hour))}:${minute}:${second ?? "00"}${offset}`;
	}
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

/** The date part (`YYYY-MM-DD`) of anything `isoDate` accepts. */
export const isoDay = (value: string): string => isoDate(value).slice(0, 10);

/**
 * An ISO 8601 duration. Accepts one as is (`PT1H30M`), clock notation (`1:30:00`; two parts are
 * hours:minutes when a bare number means minutes, minutes:seconds when it means seconds), words
 * (`1h 30m`, `45 min`) and a bare number in `unit`.
 */
export function isoDuration(value: string, unit: "minutes" | "seconds" = "minutes"): string {
	const text = value.trim();
	if (!text) return "";
	if (/^P(?=.)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=.)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/i.test(text)) return text.toUpperCase();
	let seconds = 0;
	if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
		const parts = text.split(":").map(Number);
		if (parts.length === 3) seconds = (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
		else seconds = unit === "minutes" ? (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 : (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
	} else if (/^\d+(\.\d+)?$/.test(text)) {
		seconds = Math.round(Number(text) * (unit === "minutes" ? 60 : 1));
	} else {
		const words = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)];
		if (!words.length) return "";
		for (const [, amount, name] of words) {
			const first = (name ?? "").charAt(0).toLowerCase();
			seconds += Number(amount) * (first === "h" ? 3600 : first === "m" ? 60 : 1);
		}
		seconds = Math.round(seconds);
	}
	if (seconds <= 0) return "";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
}

/** A number from loosely typed text (`"1,299.00"`, `"4,5"`, `"$12"`), or null. */
export function numberOf(value: string): number | null {
	let text = value.trim().replace(/[^\d.,-]/g, "");
	if (!text) return null;
	if (text.includes(",") && text.includes(".")) text = text.replace(/,/g, "");
	else if (/,\d{1,2}$/.test(text)) text = text.replace(",", ".");
	else text = text.replace(/,/g, "");
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Non-empty trimmed lines, without list bullets or numbering. */
export function lines(value: string): string[] {
	return value
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
		.filter(Boolean);
}

/** Comma- or line-separated values. */
export const listOf = (value: string): string[] =>
	value
		.split(/[,\n]/)
		.map((item) => item.trim())
		.filter(Boolean);

const cells = (line: string) => line.split("|").map((cell) => cell.trim());

/**
 * Questions and answers. Either one `Question | Answer` per line, or blocks separated by a blank
 * line whose first line is the question and the rest the answer. A leading `Q:` / `A:` is dropped.
 */
export function parsePairs(value: string): Array<{ question: string; answer: string }> {
	const out: Array<{ question: string; answer: string }> = [];
	const clean = (text: string) => text.replace(/^\s*(?:[-*•]\s+)?(?:Q|A|Question|Answer)\s*:\s*/i, "").trim();
	for (const block of value.split(/\r?\n\s*\r?\n/)) {
		const rows = block
			.split(/\r?\n/)
			.map((row) => row.trim())
			.filter(Boolean);
		if (!rows.length) continue;
		if (rows.some((row) => row.includes("|"))) {
			for (const row of rows) {
				const [question = "", ...rest] = cells(row);
				const answer = rest.join(" | ").trim();
				if (clean(question) && clean(answer)) out.push({ question: clean(question), answer: clean(answer) });
			}
		} else if (rows.length >= 2) {
			const question = clean(rows[0] ?? "");
			const answer = rows.slice(1).map(clean).filter(Boolean).join(" ");
			if (question && answer) out.push({ question, answer });
		}
	}
	return out;
}

/** Steps, one per line: `Name | Instructions | Image URL`, or just the instructions. */
export function parseSteps(value: string): Array<{ name: string; text: string; image: string }> {
	return lines(value)
		.map((line) => {
			const parts = cells(line);
			if (parts.length === 1) return { name: "", text: parts[0] ?? "", image: "" };
			const last = parts[parts.length - 1] ?? "";
			const image = parts.length > 2 && /^(https?:)?\/\S+$/i.test(last) ? last : "";
			const text = parts
				.slice(1, image ? -1 : undefined)
				.filter(Boolean)
				.join(" | ");
			return { name: text ? (parts[0] ?? "") : "", text: text || (parts[0] ?? ""), image };
		})
		.filter((step) => step.text);
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type Day = (typeof DAYS)[number];
export const WEEK: readonly Day[] = DAYS;

const dayOf = (text: string): number => DAYS.findIndex((day) => day.toLowerCase().startsWith(text.toLowerCase().slice(0, 3)));

/** `9`, `9:30`, `0930`, `9.30`, `9am`, `9:30 pm` → `09:30`; "" when it is not a time. */
export function clock(value: string): string {
	const match = /^(\d{1,2})(?:[:.h]?(\d{2}))?\s*(am|pm)?$/i.exec(value.trim());
	if (!match) return "";
	let hour = Number(match[1]);
	const minute = Number(match[2] ?? "0");
	const half = match[3]?.toLowerCase();
	if (half === "pm" && hour < 12) hour += 12;
	if (half === "am" && hour === 12) hour = 0;
	if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) return "";
	return hour === 24 ? "23:59" : `${pad(hour)}:${pad(minute)}`;
}

export interface Hours {
	day: Day;
	opens: string;
	closes: string;
}

/**
 * Opening hours, one line per day or range of days: `Monday 09:00-12:00, 14:00-18:00`,
 * `Mon-Fri 9-17`, `Sat, Sun 10:00-14:00`. A line with no time range (or "closed") is skipped.
 */
export function parseHours(value: string): Hours[] {
	const out: Hours[] = [];
	for (const line of lines(value)) {
		const start = line.search(/\d/);
		if (start < 0) continue;
		const days = new Set<number>();
		for (const part of line.slice(0, start).split(/[,;&/]|\band\b/i)) {
			const names = part.match(/[A-Za-z]{3,}/g) ?? [];
			if (!names.length) continue;
			const from = dayOf(names[0] ?? "");
			const to = names.length > 1 ? dayOf(names[names.length - 1] ?? "") : from;
			if (from < 0 || to < 0) continue;
			for (let i = from; ; i = (i + 1) % 7) {
				days.add(i);
				if (i === to) break;
			}
		}
		const ranges = [...line.slice(start).matchAll(/(\d{1,2}(?:[:.h]?\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to|until)\s*(\d{1,2}(?:[:.h]?\d{2})?\s*(?:am|pm)?)/gi)];
		for (const index of [...days].sort((a, b) => a - b)) {
			for (const [, from, to] of ranges) {
				const opens = clock(from ?? "");
				const closes = clock(to ?? "");
				const day = DAYS[index];
				if (opens && closes && day) out.push({ day, opens, closes });
			}
		}
	}
	return out;
}

export const hoursNodes = (hours: Hours[]): Node[] => hours.map((slot) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${slot.day}`, opens: slot.opens, closes: slot.closes }));

/**
 * Reads pasted JSON-LD: an object or a list of objects, with or without its `<script>` wrapper.
 * Returns the nodes, or an error message for the editor.
 */
export function parseJsonLd(value: string): { nodes: Node[] } | { error: string } {
	const text = value
		.trim()
		.replace(/^<script\b[^>]*>/i, "")
		.replace(/<\/script\s*>$/i, "")
		.trim();
	if (!text) return { error: "Paste the JSON-LD to print." };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { error: `This is not valid JSON: ${error instanceof Error ? error.message.slice(0, 120) : "it could not be read"}` };
	}
	const list = Array.isArray(parsed) ? parsed : [parsed];
	if (!list.length || !list.every(isRecord)) return { error: "JSON-LD must be an object, or a list of objects." };
	return { nodes: list as Node[] };
}
