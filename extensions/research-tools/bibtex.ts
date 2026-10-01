import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { withCrossrefPacing } from "./science-databases.js";

// BibTeX comes from DOI content negotiation, never from the model: Crossref and
// DataCite (which issues arXiv's 10.48550 DOIs) both answer doi.org with
// Accept: application/x-bibtex. arXiv's own /bibtex endpoint reports the year
// of the latest version (2023 for a 2017 paper), so arXiv IDs go through DataCite.

type BibField = { name: string; value: string; bare: boolean };
export type BibEntry = { type: string; key: string; fields: BibField[] };

type Identifier = { input: string; kind: "doi" | "arxiv"; doi: string; arxivId?: string };

type BibtexResult = {
	id: string;
	status: "added" | "existing" | "failed";
	key?: string;
	title?: string;
	year?: string;
	firstAuthor?: string;
	error?: string;
};

const DOI_BASE = "https://doi.org/";
const MAX_IDS = 50;
const REQUEST_TIMEOUT_MS = 25_000;
const DROPPED_FIELDS = new Set(["abstract", "copyright", "keywords"]);
const TITLE_STOPWORDS = new Set([
	"a", "an", "and", "are", "can", "do", "does", "for", "from", "how", "in", "is", "of", "on", "the", "to", "toward", "towards", "via", "what", "when", "why", "with",
]);

const ARXIV_NEW_ID = /^(\d{4}\.\d{4,5})(?:v\d+)?$/;
const ARXIV_OLD_ID = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/;

export function parseIdentifier(raw: string): Identifier | undefined {
	const input = raw.trim();
	let value = input
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "")
		.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "arxiv:")
		.replace(/\.pdf$/i, "");
	const arxivDoi = value.match(/^10\.48550\/arxiv\.(.+)$/i);
	if (arxivDoi) value = `arxiv:${arxivDoi[1]}`;
	const bare = value.replace(/^arxiv:\s*/i, "");
	const arxiv = bare.match(ARXIV_NEW_ID) ?? bare.match(ARXIV_OLD_ID);
	if (arxiv) return { input, kind: "arxiv", doi: `10.48550/arXiv.${arxiv[1]}`, arxivId: arxiv[1] };
	if (/^10\.\d{4,9}\/\S+$/.test(value)) return { input, kind: "doi", doi: value };
	return undefined;
}

function skipSpace(text: string, at: number): number {
	while (at < text.length && /\s/.test(text[at]!)) at += 1;
	return at;
}

function readDelimited(text: string, at: number): { value: string; end: number } {
	const close = text[at] === "{" ? "}" : '"';
	let depth = 0;
	for (let index = at + 1; index < text.length; index += 1) {
		const char = text[index];
		if (char === "\\") index += 1;
		else if (char === "{") depth += 1;
		else if (char === "}" && depth > 0) depth -= 1;
		else if (char === close && depth === 0) return { value: text.slice(at + 1, index), end: index + 1 };
	}
	throw new Error("Unterminated BibTeX value.");
}

// A small reader for the BibTeX that DOI resolvers and common .bib files emit:
// braced, quoted, and bare values; @string, @comment, and @preamble are skipped.
export function parseBibtex(text: string): BibEntry[] {
	const entries: BibEntry[] = [];
	let at = 0;
	while ((at = text.indexOf("@", at)) !== -1) {
		const head = text.slice(at).match(/^@\s*(\w+)\s*[{(]/);
		if (!head) {
			at += 1;
			continue;
		}
		const type = head[1]!.toLowerCase();
		at += head[0].length;
		if (type === "string" || type === "comment" || type === "preamble") continue;
		const keyEnd = text.indexOf(",", at);
		if (keyEnd === -1) break;
		const entry: BibEntry = { type, key: text.slice(at, keyEnd).trim(), fields: [] };
		at = keyEnd + 1;
		for (;;) {
			at = skipSpace(text, at);
			while (text[at] === ",") at = skipSpace(text, at + 1);
			if (at >= text.length || text[at] === "}" || text[at] === ")") {
				at += 1;
				break;
			}
			const name = text.slice(at).match(/^([\w-]+)\s*=\s*/);
			if (!name) throw new Error(`Malformed BibTeX field in entry ${entry.key}.`);
			at += name[0].length;
			if (text[at] === "{" || text[at] === '"') {
				const { value, end } = readDelimited(text, at);
				entry.fields.push({ name: name[1]!.toLowerCase(), value: value.replace(/\s+/g, " ").trim(), bare: false });
				at = end;
			} else {
				const bare = text.slice(at).match(/^[^,}\s]+/)?.[0] ?? "";
				entry.fields.push({ name: name[1]!.toLowerCase(), value: bare, bare: true });
				at += bare.length;
			}
		}
		entries.push(entry);
	}
	return entries;
}

function field(entry: BibEntry, name: string): string | undefined {
	return entry.fields.find((item) => item.name === name)?.value;
}

function setField(entry: BibEntry, name: string, value: string): void {
	const existing = entry.fields.find((item) => item.name === name);
	if (existing) Object.assign(existing, { value, bare: false });
	else entry.fields.push({ name, value, bare: false });
}

function asciiWord(value: string): string {
	return value.normalize("NFD").replace(/\\.|[{}]/g, "").replace(/[^A-Za-z]/g, "").toLowerCase();
}

export function firstAuthorSurname(authors: string | undefined): string | undefined {
	const first = authors?.split(/\s+and\s+/i)[0]?.trim();
	if (!first) return undefined;
	const surname = first.includes(",") ? first.split(",")[0]! : first.split(/\s+/).at(-1)!;
	return asciiWord(surname) || undefined;
}

export function citationKey(entry: BibEntry): string {
	const author = firstAuthorSurname(field(entry, "author")) ?? "anon";
	const year = field(entry, "year")?.match(/\d{4}/)?.[0] ?? "";
	const words = (field(entry, "title") ?? "").split(/[\s-]+/).map(asciiWord);
	const word = words.find((item) => item.length > 1 && !TITLE_STOPWORDS.has(item)) ?? "";
	return `${author}${year}${word}`;
}

function uniqueKey(base: string, used: Set<string>): string {
	if (!used.has(base)) return base;
	for (let suffix = 0; ; suffix += 1) {
		const key = `${base}${String.fromCharCode(97 + (suffix % 26))}${suffix >= 26 ? Math.floor(suffix / 26) : ""}`;
		if (!used.has(key)) return key;
	}
}

// pdflatex stops on emoji (Bender et al. 2021 has one in its Crossref title);
// accented letters are fine with the default UTF-8 input encoding.
export function latexSafe(value: string): string {
	return value
		.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
		.replace(/[‘’]/g, "'")
		.replace(/“/g, "``")
		.replace(/”/g, "''")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeEntry(entry: BibEntry, id: Identifier): BibEntry {
	const fields = entry.fields
		.filter((item) => !DROPPED_FIELDS.has(item.name))
		.map((item) => ({ ...item, value: latexSafe(item.name === "pages" ? item.value.replace(/\s*[–—-]+\s*/g, "--") : item.value) }));
	const normalized: BibEntry = { type: entry.type, key: entry.key, fields };
	if (id.arxivId) {
		normalized.type = "misc";
		setField(normalized, "doi", id.doi);
		setField(normalized, "eprint", id.arxivId);
		setField(normalized, "archiveprefix", "arXiv");
	} else if (!field(normalized, "doi")) {
		setField(normalized, "doi", id.doi);
	}
	return normalized;
}

export function formatEntry(entry: BibEntry): string {
	const lines = entry.fields.map((item) => `  ${item.name} = ${item.bare ? item.value.toLowerCase() : `{${item.value}}`}`);
	return `@${entry.type}{${entry.key},\n${lines.join(",\n")}\n}\n`;
}

function identityOf(entry: BibEntry): string[] {
	const ids: string[] = [];
	const doi = field(entry, "doi")?.toLowerCase();
	if (doi) ids.push(`doi:${doi}`);
	const eprint = field(entry, "eprint");
	if (eprint) ids.push(`arxiv:${eprint.replace(/v\d+$/, "").toLowerCase()}`);
	const arxivDoi = doi?.match(/^10\.48550\/arxiv\.(.+)$/);
	if (arxivDoi) ids.push(`arxiv:${arxivDoi[1]}`);
	return ids;
}

function identityKey(id: Identifier): string {
	return id.arxivId ? `arxiv:${id.arxivId.toLowerCase()}` : `doi:${id.doi.toLowerCase()}`;
}

async function fetchBibtexOnce(doi: string): Promise<{ status: number; text: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const mailto = process.env.CROSSREF_MAILTO?.trim() || process.env.NCBI_EMAIL?.trim();
	try {
		const response = await fetch(`${DOI_BASE}${doi}`, {
			headers: {
				accept: "application/x-bibtex",
				...(mailto ? { "user-agent": `feynman (mailto:${mailto})` } : {}),
			},
			redirect: "follow",
			signal: controller.signal,
		});
		return { status: response.status, text: await response.text() };
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchBibtex(doi: string): Promise<BibEntry> {
	const polite = Boolean(process.env.CROSSREF_MAILTO?.trim() || process.env.NCBI_EMAIL?.trim());
	let response = await withCrossrefPacing(polite, () => fetchBibtexOnce(doi));
	if (response.status === 429) {
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		response = await withCrossrefPacing(polite, () => fetchBibtexOnce(doi));
	}
	if (response.status === 404) throw new Error("DOI not found at doi.org.");
	if (response.status !== 200) throw new Error(`doi.org returned HTTP ${response.status}.`);
	const entry = parseBibtex(response.text)[0];
	if (!entry || !field(entry, "title")) throw new Error("doi.org did not return a BibTeX entry with a title.");
	return entry;
}

export async function resolveBibtex(ids: string[], existingText = ""): Promise<{ results: BibtexResult[]; added: BibEntry[] }> {
	const existing = parseBibtex(existingText);
	const used = new Set(existing.map((entry) => entry.key));
	const known = new Map<string, string>();
	for (const entry of existing) for (const identity of identityOf(entry)) known.set(identity, entry.key);
	const results: BibtexResult[] = [];
	const added: BibEntry[] = [];
	for (const raw of ids.slice(0, MAX_IDS)) {
		const id = parseIdentifier(raw);
		if (!id) {
			results.push({ id: raw, status: "failed", error: "Not a DOI or arXiv ID." });
			continue;
		}
		const knownKey = known.get(identityKey(id));
		if (knownKey) {
			results.push({ id: raw, status: "existing", key: knownKey });
			continue;
		}
		try {
			const entry = normalizeEntry(await fetchBibtex(id.doi), id);
			entry.key = uniqueKey(citationKey(entry), used);
			used.add(entry.key);
			for (const identity of [...identityOf(entry), identityKey(id)]) known.set(identity, entry.key);
			added.push(entry);
			results.push({
				id: raw,
				status: "added",
				key: entry.key,
				title: field(entry, "title"),
				year: field(entry, "year"),
				firstAuthor: field(entry, "author")?.split(/\s+and\s+/i)[0],
			});
		} catch (error) {
			results.push({ id: raw, status: "failed", error: error instanceof Error ? error.message : String(error) });
		}
	}
	for (const raw of ids.slice(MAX_IDS)) results.push({ id: raw, status: "failed", error: `Over the ${MAX_IDS}-ID limit for one call; send it in another call.` });
	return { results, added };
}

export function registerBibtexTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feynman_bibtex",
		label: "BibTeX",
		description:
			"Fetch BibTeX for DOIs and arXiv IDs from doi.org (Crossref and DataCite) and optionally merge it into a .bib file. Assigns stable citation keys (surname + year + first title word, e.g. vaswani2017attention) and skips papers the file already has.",
		promptSnippet: "Fetch real BibTeX for DOIs and arXiv IDs from doi.org and merge it into a .bib file with stable citation keys.",
		promptGuidelines: [
			"Use feynman_bibtex for every bibliography entry in a LaTeX artifact; never write BibTeX entries by hand or from memory. Cite only the keys it returns.",
			"Prefer a paper's published DOI when it has one; use the arXiv ID for preprints. A `failed` result means the identifier did not resolve: look the paper up again with feynman_science_database_search instead of inventing an entry.",
			"Compare each returned title, year, and first author with the paper you meant to cite before citing its key.",
		],
		prepareArguments: (args) => {
			if (!args || typeof args !== "object" || Array.isArray(args)) return args as never;
			const input = { ...(args as Record<string, unknown>) };
			if (input.output === null || input.output === "" || input.output === "null") delete input.output;
			if (typeof input.ids === "string") input.ids = input.ids.split(/[\s,]+/).filter(Boolean);
			return input as never;
		},
		parameters: Type.Object({
			ids: Type.Array(Type.String(), {
				description: `DOIs or arXiv IDs, up to ${MAX_IDS}. Examples: 10.1038/nature14539, https://doi.org/10.1038/nature14539, 1706.03762, arXiv:1706.03762v7, https://arxiv.org/abs/1706.03762.`,
			}),
			output: Type.Optional(Type.String({
				description: "Workspace-relative .bib file to merge new entries into, e.g. papers/<slug>/refs.bib. Created if missing; existing entries are kept. Omit to only return the BibTeX.",
			})),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { ids, output } = params as { ids: string[]; output?: string };
			if (!output) {
				const { results, added } = await resolveBibtex(ids);
				const details = { results };
				return { content: [{ type: "text", text: `${added.map(formatEntry).join("\n")}\n${JSON.stringify(details, null, 2)}` }], details };
			}
			if (extname(output).toLowerCase() !== ".bib") throw new Error("output must be a .bib file.");
			const path = resolve(ctx.cwd, output);
			return withFileMutationQueue(path, async () => {
				const before = existsSync(path) ? readFileSync(path, "utf8") : "";
				const { results, added } = await resolveBibtex(ids, before);
				if (added.length > 0) {
					mkdirSync(dirname(path), { recursive: true });
					const separator = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
					writeFileSync(path, `${before}${separator}${added.map(formatEntry).join("\n")}`);
				}
				const details = { output, added: added.length, results };
				return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
			});
		},
	});
}
