---
title: Related Work
description: Research prior work in English and German, find the research gap, and write the introduction and related work of your LaTeX thesis or paper.
section: Workflows
order: 11
---

The related work workflow writes the introduction and related-work chapters of your own thesis or paper, in your LaTeX project, in English or German. It finds the research gap your work fills, checks that gap for novelty, and scores the result against the guidance in your template.

## Usage

Put a brief in your project as `feynman-brief.md`:

```markdown
Name: Path tracking for autonomous sailboats
Language: de

## Description
A few sentences on the problem, what you build or study, how you evaluate it, and what you expect to contribute.

## Seed papers
- 10.1109/xxxx
- arXiv:2401.12345
- "Exact Title of a Paper"
```

Then run, from the REPL or the CLI:

```
/relwork ./my-thesis
```

```bash
feynman relwork ./my-thesis
feynman relwork ./my-thesis lang=en "related work at most six pages"
```

`lang=en` or `lang=de` overrides the brief; without either, the document's language option decides. `brief=<file>` reads the brief from somewhere else. Without a brief, Feynman asks for the name, description, seed papers, and language once.

## How it works

1. **Guidance becomes a rubric.** Feynman reads the project and collects every piece of guidance the template gives for these chapters, such as the questions a related-work chapter must answer, into `outputs/.plans/<slug>-rubric.md`.
2. **Embedding first.** Seed papers and papers from earlier runs are ranked against your description with [local embeddings](/docs/tools/embeddings), and the ranking sharpens the search themes.
3. **English and German search.** One researcher per theme searches in both languages, including German theses and reports, follows the citation graph of the closest papers, and names the field's main venues and research groups.
4. **Rank and select.** All candidates are ranked against your description again. English and German versions of the same work are merged, and your seed papers are kept.
5. **Research gap.** `outputs/<slug>-gaps.md` lists candidate gaps with a coverage table. Each gap gets a novelty check: searches in both languages that try to find work that already fills it. Gaps that are already filled are dropped.
6. **Write.** BibTeX comes from doi.org through `feynman_bibtex`. Chapter files are backed up as `<name>.template.tex`, and the [latex-writer](/docs/agents/latex-writer) writes the related work, then the introduction, answering every rubric item.
7. **Check and score.** The [verifier](/docs/agents/verifier) checks each citation. The [reviewer](/docs/agents/reviewer) writes `outputs/<slug>-scorecard.md`, which scores every rubric item from 0 to 2 and rates, from 1 to 5, relevance to your description (with per-paragraph embedding similarity), the gap's novelty, and writing quality. If any rubric item scores 0, relevance is below 4, or novelty is below 3, the sections are revised once and scored again.

## Output

- The chapters in your project, with the originals kept as `<name>.template.tex`. A chapter that already holds your own prose is not overwritten; the new text goes to `<name>.feynman.tex`.
- New entries in your `.bib` file.
- `outputs/<slug>-gaps.md` and `outputs/<slug>-scorecard.md`.
- `% TODO(feynman)` comments wherever a citation could not be resolved or a claim needs your input.
- `outputs/<slug>.provenance.md` with English and German paper counts, embedding cache hits, the chosen gap and its novelty label, the final scores, and whether the project compiled.
