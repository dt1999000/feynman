---
title: Related Work
description: Research prior work for your LaTeX paper and write its related-work section and introduction.
section: Workflows
order: 11
---

The related work workflow writes the related-work section and introduction of your own paper, in your LaTeX project, citing only papers whose BibTeX was fetched from real records.

## Usage

From the REPL:

```
/relwork ./my-paper
/relwork ./my-paper related work only, at most one page
```

From the CLI:

```bash
feynman relwork ./my-paper
```

The path is your LaTeX project, such as a venue template you have started filling in. Anything after the path is optional focus or instructions.

## How it works

Feynman reads the project: the root `.tex` file and every `\input` it pulls in, your title, abstract, method and results, the citation package, the bibliography file, and your macros. It writes a plan to `outputs/.plans/<slug>.md` with a summary of your paper, its contributions, and 3–6 related-work themes.

One researcher per theme searches the literature in parallel, starting from the papers you already cite and following the citation graph of the closest ones. Each paper found is recorded with its DOI or arXiv ID and how it relates to your work: builds on it, competes with it, or is background.

Feynman selects the papers to cite and calls `feynman_bibtex` to merge their BibTeX into your `.bib` file from doi.org. The [latex-writer](/docs/agents/latex-writer) writes the related work, then the introduction, so the gap the introduction names matches the related work. The [verifier](/docs/agents/verifier) checks that each `\cite` key exists and supports its sentence, and the [reviewer](/docs/agents/reviewer) checks for missing closest work, unfair descriptions of competing work, and contributions stated more strongly than your results support.

## Output

- Section files in your project. A section file that holds only a placeholder is filled in; one that already has your prose is left alone, and the new text goes to `<section>.feynman.tex` next to it for you to merge.
- New entries in your `.bib` file. Papers it already has are not duplicated.
- `% TODO(feynman)` comments wherever a citation could not be resolved or a claim needs your input.
- `outputs/<slug>.provenance.md` with papers found, selected and cited, identifiers that failed, verification and review status, and whether the project compiled.

If `latexmk` or `tectonic` is installed, Feynman compiles the project into `.feynman-build/` and reports the result.
