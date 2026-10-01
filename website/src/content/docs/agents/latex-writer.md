---
title: LaTeX Writer
description: The latex-writer agent writes thesis and paper sections as LaTeX, in English or German, inside your project.
section: Agents
order: 5
---

The latex-writer writes sections of your own thesis or paper, such as the introduction and related work, directly in your LaTeX project, in English or German. Its definition lives in `.feynman/agents/latex-writer.md`.

## What it does

Before writing, it reads your project: the root file and its `\input` files, the document class, the citation package (`natbib`, `biblatex`, or plain `\cite`), the bibliography file, your macros, and the existing abstract, method, and results. It matches your tense, spelling, and naming, and uses your macros instead of retyping method names.

An introduction moves from the problem to the gap existing work leaves, then to your idea and a contributions list that matches your results. Related work is grouped into themed paragraphs that each end by saying how your work differs.

It writes LaTeX, not Markdown, and does not edit your preamble, class, style files, or other sections. A section file that already contains your prose is never overwritten; the new text goes to `<section>.feynman.tex` next to it.

## Template guidance and language

When the workflow gives it a rubric built from your template's guidance, such as the questions a related-work chapter must answer, it answers each item explicitly and leaves the guidance text itself out. Template guidance and demo content in a chapter file count as placeholders: the file is backed up as `<name>.template.tex` and its body replaced.

In German it writes formal academic German, uses `enquote` when `csquotes` is loaded, and keeps established English technical terms where German has no common one. If your document's language option does not match, it tells you which preamble change to make instead of making it.

## Citations

Every `\cite` key comes from `feynman_bibtex`, which fetches BibTeX for DOIs and arXiv IDs from doi.org. The agent never writes a BibTeX entry itself. When a paper cannot be resolved, it leaves a `% TODO(feynman)` comment instead of a citation.

## Choosing its model

It uses your default model unless you pin one. To use your strongest writing model for it, set it in `~/.feynman/agent/settings.json`:

```json
{
  "subagents": {
    "agentOverrides": {
      "latex-writer": { "model": "anthropic/claude-opus-5-5" }
    }
  }
}
```

## Used by

The [`/relwork`](/docs/workflows/related-work) workflow.
