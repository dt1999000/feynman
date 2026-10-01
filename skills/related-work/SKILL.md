---
name: related-work
description: Research prior work in English and German for a LaTeX thesis or paper, find the research gap, write the related work and introduction with real BibTeX, and score them against the template's guidance. Use when the user points at a LaTeX thesis, paper, or template and asks for related work, an introduction, a research gap, citations, or a bibliography.
---

# Related Work

Run the `/relwork` workflow with the path to the LaTeX project, plus `lang=en` or `lang=de` when the user names a language. The work's name, description, and seed papers come from `feynman-brief.md` in the project. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, `latex-writer`, `verifier`, `reviewer`

Tools: `feynman_bibtex` fetches BibTeX for DOIs and arXiv IDs from doi.org and merges it into the project's `.bib` file. `feynman_embed` ranks papers against the work description with a local multilingual model and caches every vector.

Output: chapter `.tex` files (originals backed up as `<name>.template.tex`) and `.bib` entries in the user's project; plan, rubric, gap, scorecard, and provenance files in `outputs/`.
