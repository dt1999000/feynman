---
name: related-work
description: Research prior work for a LaTeX paper project and write its related-work section and introduction with real BibTeX. Use when the user points at a LaTeX paper or template and asks for related work, an introduction, citations, or a bibliography.
---

# Related Work

Run the `/relwork` workflow with the path to the LaTeX project. The slash command expands the full workflow instructions in the active session; do not try to read a relative prompt-template path from the installed skill directory.

Agents used: `researcher`, `latex-writer`, `verifier`, `reviewer`

Tools: `feynman_bibtex` fetches BibTeX for DOIs and arXiv IDs from doi.org and merges it into the project's `.bib` file.

Output: section `.tex` files and `.bib` entries in the user's project; plan, research, and provenance files in `outputs/`.
