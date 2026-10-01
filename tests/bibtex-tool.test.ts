import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { citationKey, latexSafe, parseBibtex, parseIdentifier, registerBibtexTool } from "../extensions/research-tools/bibtex.js";

type Tool = {
	execute: (toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: { cwd: string }) => Promise<{ content: Array<{ text: string }>; details: any }>;
	name: string;
	prepareArguments?: (args: unknown) => unknown;
};

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

// Verbatim doi.org responses (Crossref, then DataCite for an arXiv DOI).
const NATURE = " @article{LeCun_2015, title={Deep learning}, volume={521}, ISSN={1476-4687}, url={http://dx.doi.org/10.1038/nature14539}, DOI={10.1038/nature14539}, number={7553}, journal={Nature}, publisher={Springer Science and Business Media LLC}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, year={2015}, month=May, pages={436–444} }\n";
const ATTENTION = `@misc{https://doi.org/10.48550/arxiv.1706.03762,
  doi = {10.48550/ARXIV.1706.03762},
  url = {https://arxiv.org/abs/1706.03762},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki},
  keywords = {Computation and Language (cs.CL), FOS: Computer and information sciences},
  title = {Attention Is All You Need},
  publisher = {arXiv},
  year = {2017},
  copyright = {arXiv.org perpetual, non-exclusive license}
}`;

function registerTool(): Tool {
	let registered: Tool | undefined;
	registerBibtexTool({ registerTool(tool: Tool) { registered = tool; } } as never);
	return registered!;
}

function mockDoiOrg(requests: string[]): void {
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		requests.push(url);
		assert.equal((init?.headers as Record<string, string>).accept, "application/x-bibtex");
		if (url === "https://doi.org/10.1038/nature14539") return new Response(NATURE);
		if (url === "https://doi.org/10.48550/arXiv.1706.03762") return new Response(ATTENTION);
		return new Response("DOI Not Found", { status: 404 });
	}) as typeof fetch;
}

test("parseIdentifier accepts DOI and arXiv spellings and routes arXiv through DataCite", () => {
	for (const raw of ["10.1038/nature14539", "doi:10.1038/nature14539", "https://doi.org/10.1038/nature14539"]) {
		assert.deepEqual(parseIdentifier(raw)?.doi, "10.1038/nature14539");
	}
	for (const raw of ["1706.03762", "arXiv:1706.03762v7", "https://arxiv.org/abs/1706.03762", "https://arxiv.org/pdf/1706.03762v2.pdf", "10.48550/arXiv.1706.03762"]) {
		assert.deepEqual(parseIdentifier(raw), { input: raw, kind: "arxiv", doi: "10.48550/arXiv.1706.03762", arxivId: "1706.03762" });
	}
	assert.equal(parseIdentifier("hep-th/9711200")?.arxivId, "hep-th/9711200");
	assert.equal(parseIdentifier("Attention is all you need"), undefined);
});

test("parseBibtex reads one-line Crossref output with bare values and skips @string", () => {
	const [entry] = parseBibtex(`@string{nat = "Nature"}\n${NATURE}`);
	assert.equal(entry!.key, "LeCun_2015");
	assert.deepEqual(entry!.fields.find((field) => field.name === "month"), { name: "month", value: "May", bare: true });
	assert.equal(citationKey(entry!), "lecun2015deep");
	assert.equal(citationKey(parseBibtex(ATTENTION)[0]!), "vaswani2017attention");
	assert.equal(citationKey(parseBibtex("@article{x, author={G{\\\"o}del, Kurt}, title={On Formally Undecidable Propositions}, year={1931}}")[0]!), "godel1931formally");
});

test("latexSafe drops emoji and turns curly quotes into LaTeX quotes", () => {
	assert.equal(latexSafe("On the Dangers of Stochastic Parrots: Can Language Models Be Too Big? 🦜"), "On the Dangers of Stochastic Parrots: Can Language Models Be Too Big?");
	assert.equal(latexSafe("FAccT ’21 and “quoted” Gödel"), "FAccT '21 and ``quoted'' Gödel");
});

test("feynman_bibtex merges real entries into a .bib file and skips papers it already has", async () => {
	const requests: string[] = [];
	mockDoiOrg(requests);
	const cwd = mkdtempSync(join(tmpdir(), "feynman-bibtex-"));
	const tool = registerTool();
	assert.equal(tool.name, "feynman_bibtex");

	const first = await tool.execute("1", { ids: ["10.1038/nature14539", "arXiv:1706.03762", "10.9999/missing", "not an id"], output: "papers/demo/refs.bib" }, undefined, undefined, { cwd });
	assert.deepEqual(first.details.results.map((result: { status: string; key?: string }) => [result.status, result.key]), [
		["added", "lecun2015deep"],
		["added", "vaswani2017attention"],
		["failed", undefined],
		["failed", undefined],
	]);
	assert.equal(first.details.results[2].error, "DOI not found at doi.org.");

	const bib = readFileSync(join(cwd, "papers/demo/refs.bib"), "utf8");
	assert.match(bib, /^@article\{lecun2015deep,\n {2}title = \{Deep learning\},/);
	assert.match(bib, /pages = \{436--444\}/);
	assert.match(bib, /month = may/);
	assert.match(bib, /@misc\{vaswani2017attention,[\s\S]*eprint = \{1706\.03762\},\n {2}archiveprefix = \{arXiv\}\n\}/);
	assert.doesNotMatch(bib, /keywords|copyright/);

	requests.length = 0;
	const second = await tool.execute("2", { ids: ["https://doi.org/10.1038/nature14539", "1706.03762v3"], output: "papers/demo/refs.bib" }, undefined, undefined, { cwd });
	assert.deepEqual(second.details.results.map((result: { status: string; key?: string }) => [result.status, result.key]), [
		["existing", "lecun2015deep"],
		["existing", "vaswani2017attention"],
	]);
	assert.deepEqual(requests, []);
	assert.equal(readFileSync(join(cwd, "papers/demo/refs.bib"), "utf8"), bib);
});

test("feynman_bibtex keeps hand-written entries and avoids their keys", async () => {
	mockDoiOrg([]);
	const cwd = mkdtempSync(join(tmpdir(), "feynman-bibtex-"));
	writeFileSync(join(cwd, "refs.bib"), "@book{lecun2015deep,\n  title = {Some Other Book},\n  year = {2015}\n}\n");
	const tool = registerTool();
	const result = await tool.execute("1", { ids: ["10.1038/nature14539"], output: "refs.bib" }, undefined, undefined, { cwd });
	assert.equal(result.details.results[0].key, "lecun2015deepa");
	const bib = readFileSync(join(cwd, "refs.bib"), "utf8");
	assert.match(bib, /^@book\{lecun2015deep,\n {2}title = \{Some Other Book\},\n {2}year = \{2015\}\n\}\n\n@article\{lecun2015deepa,/);

	await assert.rejects(tool.execute("2", { ids: ["10.1038/nature14539"], output: "refs.tex" }, undefined, undefined, { cwd }), /\.bib file/);
	assert.deepEqual(tool.prepareArguments!({ ids: "1706.03762, 10.1038/nature14539", output: null }), { ids: ["1706.03762", "10.1038/nature14539"] });
});
