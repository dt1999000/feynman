import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { EMBEDDING_MODEL, quantize, registerEmbeddingTool, setEmbedderForTests } from "../extensions/research-tools/embeddings.js";

type Tool = {
	execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: { cwd: string }) => Promise<{ details: any }>;
	name: string;
};

// A deterministic stand-in for the model: one axis per topic word, so related
// texts point the same way regardless of language.
const TOPICS = [["sail", "segel"], ["mpc", "prädiktiv", "predictive"], ["protein"], ["rudder", "ruder"]];
const embedded: string[] = [];
function fakeEmbedder(texts: string[]): Promise<Float32Array[]> {
	embedded.push(...texts);
	return Promise.resolve(texts.map((text) => {
		const vector = new Float32Array(384);
		TOPICS.forEach((words, axis) => {
			if (words.some((word) => text.toLowerCase().includes(word))) vector[axis] = 1;
		});
		vector[383] = 0.1;
		const norm = Math.hypot(...vector);
		return vector.map((value) => value / norm);
	}));
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "feynman-embed-"));
	process.env.FEYNMAN_EMBEDDINGS_DIR = dir;
	embedded.length = 0;
	setEmbedderForTests(fakeEmbedder);
});
afterEach(() => {
	delete process.env.FEYNMAN_EMBEDDINGS_DIR;
	setEmbedderForTests(undefined);
});

function registerTool(): Tool {
	let registered: Tool | undefined;
	registerEmbeddingTool({ registerTool(tool: Tool) { registered = tool; } } as never);
	return registered!;
}

const papers = [
	{ id: "10.1/protein", title: "Protein folding", text: "Protein structure prediction" },
	{ id: "10.1/de-sail", title: "Segelboote", text: "Modellprädiktive Regelung für autonome Segelboote" },
	{ id: "10.1/en-sail", title: "Sailboat MPC", text: "Model predictive control of autonomous sailboats" },
	{ id: "10.1/rudder", title: "Rudder", text: "Rudder design for sailboats" },
];

test("rank orders papers by similarity, flags cross-language duplicates, and embeds each text once", async () => {
	const tool = registerTool();
	assert.equal(tool.name, "feynman_embed");
	const query = "MPC for autonomous sailboats";
	const first = await tool.execute("1", { action: "rank", query, items: papers }, undefined, undefined, { cwd: dir });
	assert.deepEqual(first.details.ranked.map((item: { id: string }) => item.id), ["10.1/de-sail", "10.1/en-sail", "10.1/rudder", "10.1/protein"]);
	assert.equal(first.details.ranked[1].nearDuplicateOf, "10.1/de-sail");
	assert.equal(first.details.ranked[0].nearDuplicateOf, undefined);
	assert.deepEqual([first.details.embedded, first.details.fromCache], [5, 0]);

	const library = join(dir, EMBEDDING_MODEL.replace(/[^\w.-]+/g, "_"));
	assert.equal(statSync(join(library, "vectors.i8")).size, 5 * 384);

	embedded.length = 0;
	const again = await tool.execute("2", { action: "rank", query, items: [...papers, { id: "10.1/new", text: "Rudder sail" }] }, undefined, undefined, { cwd: dir });
	assert.deepEqual(embedded, ["Rudder sail"]);
	assert.deepEqual([again.details.embedded, again.details.fromCache], [1, 5]);
	assert.equal(statSync(join(library, "vectors.i8")).size, 6 * 384);
});

test("search finds papers embedded by earlier runs without re-embedding them", async () => {
	const tool = registerTool();
	await tool.execute("1", { action: "rank", query: "anything", items: papers }, undefined, undefined, { cwd: dir });
	embedded.length = 0;
	const result = await tool.execute("2", { action: "search", query: "protein", limit: 2 }, undefined, undefined, { cwd: dir });
	assert.deepEqual(embedded, ["protein"]);
	assert.equal(result.details.libraryPapers, 4);
	assert.equal(result.details.results[0].id, "10.1/protein");
	assert.equal(result.details.results.length, 2);
});

test("rank reads items from a JSON lines file and skips items without id or text", async () => {
	const tool = registerTool();
	writeFileSync(join(dir, "papers.jsonl"), `${papers.map((paper) => JSON.stringify(paper)).join("\n")}\n{"id":"","text":"x"}\n`);
	const result = await tool.execute("1", { action: "rank", query: "protein", file: "papers.jsonl", limit: 1 }, undefined, undefined, { cwd: dir });
	assert.deepEqual(result.details.ranked.map((item: { id: string }) => item.id), ["10.1/protein"]);
	assert.equal(result.details.total, 4);
	assert.equal(result.details.skippedItems, 1);
});

test("quantize keeps a unit vector within int8 range", () => {
	const vector = new Float32Array(384);
	vector[0] = 1;
	vector[1] = -1;
	const q = quantize(vector);
	assert.deepEqual([q[0], q[1], q[2]], [127, -127, 0]);
});
