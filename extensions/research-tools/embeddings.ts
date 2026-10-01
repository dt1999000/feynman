import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Local CPU embeddings with a persistent library: each distinct text is embedded
// once, quantized to int8, and appended to ~/.feynman/embeddings/<model>/.
// Later runs read vectors back by text hash and never load the model for them.
//
// paraphrase-multilingual-MiniLM-L12-v2 was chosen over multilingual-e5-small
// after a side-by-side test: for an English query it scored a German paper on
// the same topic 0.86 and unrelated English and German papers 0.11 and 0.06,
// where e5 compressed everything into 0.78-0.88.
export const EMBEDDING_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const DIMENSIONS = 384;
const BATCH_SIZE = 32;
const MAX_ITEMS = 500;
const NEAR_DUPLICATE = 0.92;
const DEFAULT_LIMIT = 30;
// The model was trained on 128-token inputs; a 5,000-character German abstract
// sent whole scored 0.001 against a matching query, so only the opening
// (title plus the start of the abstract) is embedded.
const MAX_TEXT_CHARS = 800;

type Item = { id: string; text: string; title?: string };
type Embedder = (texts: string[]) => Promise<Float32Array[]>;
type Row = { row: number; id?: string; title?: string };

let embedderOverride: Embedder | undefined;
let loadedEmbedder: Promise<Embedder> | undefined;

export function setEmbedderForTests(embedder: Embedder | undefined): void {
	embedderOverride = embedder;
}

export function embeddingsDir(): string {
	const configured = process.env.FEYNMAN_EMBEDDINGS_DIR?.trim();
	if (configured) return resolve(configured);
	const home = process.env.FEYNMAN_HOME?.trim().replace(/^~(?=$|[\\/])/, homedir()) || homedir();
	return resolve(home, ".feynman", "embeddings");
}

async function loadEmbedder(): Promise<Embedder> {
	let transformers: typeof import("@huggingface/transformers");
	try {
		transformers = await import("@huggingface/transformers");
	} catch {
		throw new Error(
			"Local embeddings need the optional package @huggingface/transformers, which this install skipped. Reinstall Feynman without --omit=optional, or run `npm install @huggingface/transformers` in its install folder.",
		);
	}
	transformers.env.cacheDir = join(embeddingsDir(), "models");
	const extractor = await transformers.pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "q8", device: "cpu" });
	return async (texts) => {
		const output = await extractor(texts, { pooling: "mean", normalize: true });
		const data = output.data as Float32Array;
		return texts.map((_, index) => data.slice(index * DIMENSIONS, (index + 1) * DIMENSIONS));
	};
}

function embedder(): Promise<Embedder> {
	if (embedderOverride) return Promise.resolve(embedderOverride);
	loadedEmbedder ??= loadEmbedder().catch((error) => {
		loadedEmbedder = undefined;
		throw error;
	});
	return loadedEmbedder;
}

export function quantize(vector: Float32Array): Int8Array {
	const out = new Int8Array(DIMENSIONS);
	for (let index = 0; index < DIMENSIONS; index += 1) out[index] = Math.max(-127, Math.min(127, Math.round((vector[index] ?? 0) * 127)));
	return out;
}

function cosine(a: Int8Array, b: Int8Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < DIMENSIONS; index += 1) {
		dot += a[index]! * b[index]!;
		normA += a[index]! * a[index]!;
		normB += b[index]! * b[index]!;
	}
	return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

export function embeddingText(text: string): string {
	return text.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

export function textKey(text: string): string {
	return createHash("sha256").update(`${EMBEDDING_MODEL}\n${embeddingText(text)}`).digest("hex").slice(0, 32);
}

function clean(value: string | undefined): string | undefined {
	return value?.replace(/[\t\r\n]+/g, " ").trim() || undefined;
}

// vectors.i8 holds DIMENSIONS bytes per row; index.tsv maps text key -> row, id, title.
class EmbeddingStore {
	private rows = new Map<string, Row>();
	private vectors = new Int8Array(0);
	private indexSize = -1;

	constructor(readonly dir: string) {}

	get indexPath(): string {
		return join(this.dir, "index.tsv");
	}

	get vectorPath(): string {
		return join(this.dir, "vectors.i8");
	}

	refresh(): void {
		const size = existsSync(this.indexPath) ? statSync(this.indexPath).size : 0;
		if (size === this.indexSize) return;
		this.rows.clear();
		// readFileSync can hand back a slice of a shared pool for small files, so copy by offset.
		const bytes = existsSync(this.vectorPath) ? readFileSync(this.vectorPath) : Buffer.alloc(0);
		this.vectors = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length).slice();
		const complete = Math.floor(this.vectors.length / DIMENSIONS);
		if (size > 0) {
			for (const line of readFileSync(this.indexPath, "utf8").split("\n")) {
				const [key, row, id, title] = line.split("\t");
				const index = Number(row);
				if (key && Number.isInteger(index) && index < complete) this.rows.set(key, { row: index, id: id || undefined, title: title || undefined });
			}
		}
		this.indexSize = size;
	}

	vector(key: string): Int8Array | undefined {
		const row = this.rows.get(key)?.row;
		return row === undefined ? undefined : this.vectors.subarray(row * DIMENSIONS, (row + 1) * DIMENSIONS);
	}

	has(key: string): boolean {
		return this.rows.has(key);
	}

	append(entries: Array<{ key: string; vector: Int8Array; id?: string; title?: string }>): void {
		if (entries.length === 0) return;
		mkdirSync(this.dir, { recursive: true });
		this.refresh();
		const start = Math.floor(this.vectors.length / DIMENSIONS);
		const bytes = Buffer.alloc(entries.length * DIMENSIONS);
		entries.forEach((entry, index) => bytes.set(new Uint8Array(entry.vector.buffer, entry.vector.byteOffset, DIMENSIONS), index * DIMENSIONS));
		// Vectors first: a crash between the writes leaves an unindexed vector, never an index row without one.
		appendFileSync(this.vectorPath, bytes);
		appendFileSync(this.indexPath, entries.map((entry, index) => `${entry.key}\t${start + index}\t${clean(entry.id) ?? ""}\t${clean(entry.title) ?? ""}\n`).join(""));
		this.indexSize = -1;
		this.refresh();
	}

	labelled(): Array<{ key: string; id: string; title?: string }> {
		const byId = new Map<string, { key: string; id: string; title?: string }>();
		for (const [key, row] of this.rows) if (row.id) byId.set(row.id, { key, id: row.id, title: row.title });
		return [...byId.values()];
	}
}

const stores = new Map<string, EmbeddingStore>();

function store(): EmbeddingStore {
	const dir = join(embeddingsDir(), EMBEDDING_MODEL.replace(/[^\w.-]+/g, "_"));
	let existing = stores.get(dir);
	if (!existing) stores.set(dir, existing = new EmbeddingStore(dir));
	existing.refresh();
	return existing;
}

// Returns a vector for every text, embedding only those the library lacks.
export async function embedTexts(items: Array<{ text: string; id?: string; title?: string }>): Promise<{ vectors: Int8Array[]; embedded: number; cached: number }> {
	const library = store();
	return withFileMutationQueue(library.indexPath, async () => {
		library.refresh();
		const keys = items.map((item) => textKey(item.text));
		const missing = new Map<string, { text: string; id?: string; title?: string }>();
		items.forEach((item, index) => {
			if (!library.has(keys[index]!) && !missing.has(keys[index]!)) missing.set(keys[index]!, item);
		});
		const pending = [...missing.entries()];
		for (let start = 0; start < pending.length; start += BATCH_SIZE) {
			const batch = pending.slice(start, start + BATCH_SIZE);
			const vectors = await (await embedder())(batch.map(([, item]) => embeddingText(item.text)));
			library.append(batch.map(([key, item], index) => ({ key, vector: quantize(vectors[index]!), id: item.id, title: item.title })));
		}
		return {
			vectors: keys.map((key) => library.vector(key)!),
			embedded: pending.length,
			cached: items.length - pending.length,
		};
	});
}

function readItemsFile(path: string): Item[] {
	const text = readFileSync(path, "utf8");
	const parsed: unknown[] = extname(path).toLowerCase() === ".jsonl"
		? text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
		: JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error("items file must hold a JSON array or JSON lines.");
	return parsed as Item[];
}

function validItems(items: Item[]): Item[] {
	return items.flatMap((item) => {
		const text = typeof item?.text === "string" ? item.text.trim() : "";
		const id = typeof item?.id === "string" ? item.id.trim() : "";
		return text && id ? [{ id, text, title: typeof item.title === "string" ? item.title : undefined }] : [];
	});
}

export async function rankItems(query: string, items: Item[], limit = DEFAULT_LIMIT): Promise<Record<string, unknown>> {
	const valid = validItems(items).slice(0, MAX_ITEMS);
	const { vectors, embedded, cached } = await embedTexts([{ text: query }, ...valid]);
	const [queryVector, ...itemVectors] = vectors;
	const ranked = valid
		.map((item, index) => ({ ...item, index, score: cosine(queryVector!, itemVectors[index]!) }))
		.sort((a, b) => b.score - a.score);
	const kept: typeof ranked = [];
	const results = ranked.map((item) => {
		const duplicate = kept.find((other) => cosine(itemVectors[item.index]!, itemVectors[other.index]!) >= NEAR_DUPLICATE);
		if (!duplicate) kept.push(item);
		return {
			id: item.id,
			...(item.title ? { title: item.title } : {}),
			score: Number(item.score.toFixed(3)),
			...(duplicate ? { nearDuplicateOf: duplicate.id } : {}),
		};
	});
	return {
		model: EMBEDDING_MODEL,
		query,
		ranked: results.slice(0, Math.max(1, Math.floor(limit))),
		returned: Math.min(results.length, Math.max(1, Math.floor(limit))),
		total: results.length,
		skippedItems: items.length - valid.length,
		embedded,
		fromCache: cached,
	};
}

export async function searchLibrary(query: string, limit = DEFAULT_LIMIT): Promise<Record<string, unknown>> {
	const { vectors } = await embedTexts([{ text: query }]);
	const library = store();
	const results = library.labelled()
		.map((entry) => ({ id: entry.id, ...(entry.title ? { title: entry.title } : {}), score: cosine(vectors[0]!, library.vector(entry.key)!) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(1, Math.floor(limit)))
		.map((entry) => ({ ...entry, score: Number(entry.score.toFixed(3)) }));
	return { model: EMBEDDING_MODEL, query, libraryPapers: library.labelled().length, results };
}

export function registerEmbeddingTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "feynman_embed",
		label: "Embeddings",
		description:
			`Rank papers or passages by semantic similarity to a query with a local multilingual embedding model (${EMBEDDING_MODEL}, CPU, English and German and ~50 other languages). Each text is embedded once and kept in a library under ~/.feynman/embeddings, so later calls with the same text cost no model time. Also flags near-duplicates such as an English and a German version of the same paper.`,
		promptSnippet: "Rank papers by semantic similarity to a work description with local multilingual embeddings, cached across runs.",
		promptGuidelines: [
			"Use feynman_embed action=rank to order candidate papers by relevance to the user's work description before reading them in depth, and again before choosing what to cite. Pass each paper as {id, title, text}, where id is its DOI, arXiv ID, or OpenAlex ID and text is its title plus abstract, in any language.",
			"Scores are cosine similarities: treat them as a ranking signal, not proof of relevance. Read the top papers before claiming they are related, and check low-scoring papers the user named explicitly instead of dropping them.",
			"Use action=search to look up papers already embedded in earlier runs before searching the web again.",
		],
		prepareArguments: (args) => {
			if (!args || typeof args !== "object" || Array.isArray(args)) return args as never;
			const input = { ...(args as Record<string, unknown>) };
			for (const key of ["items", "file", "limit"]) if (input[key] === null || input[key] === "" || input[key] === "null") delete input[key];
			if (typeof input.items === "string") input.items = JSON.parse(input.items);
			if (typeof input.limit === "string" && /^\d+$/.test(input.limit.trim())) input.limit = Number(input.limit);
			return input as never;
		},
		parameters: Type.Object({
			action: Type.Union([Type.Literal("rank"), Type.Literal("search")], {
				description: "rank: order the given items by similarity to the query. search: find the closest papers among everything embedded so far.",
			}),
			query: Type.String({ description: "The work description or question to compare against." }),
			items: Type.Optional(Type.Array(Type.Object({
				id: Type.String(),
				title: Type.Optional(Type.String()),
				text: Type.String({ description: "Title plus abstract. Only the first ~128 tokens shape the vector." }),
			}), { description: `For rank: up to ${MAX_ITEMS} items.` })),
			file: Type.Optional(Type.String({ description: "For rank: a workspace-relative .json (array) or .jsonl file of {id, title, text} items, instead of inline items." })),
			limit: Type.Optional(Type.Number({ description: `Results to return. Defaults to ${DEFAULT_LIMIT}.` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { action, query, items, file, limit } = params as { action: "rank" | "search"; query: string; items?: Item[]; file?: string; limit?: number };
			if (!query.trim()) throw new Error("feynman_embed requires a non-empty query.");
			let result: Record<string, unknown>;
			if (action === "search") {
				result = await searchLibrary(query, limit);
			} else {
				const list = file ? readItemsFile(resolve(ctx.cwd, file)) : items ?? [];
				if (list.length === 0) throw new Error("action=rank needs items or a file of items.");
				result = await rankItems(query, list, limit);
			}
			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
		},
	});
}
