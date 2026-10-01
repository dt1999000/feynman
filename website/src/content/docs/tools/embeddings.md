---
title: Embeddings
description: Rank papers against your work with a local multilingual embedding model whose vectors are computed once and reused.
section: Tools
order: 5
---

`feynman_embed` ranks papers or passages by how close their meaning is to a query, usually your work description. It runs `paraphrase-multilingual-MiniLM-L12-v2` on your CPU, so it needs no API key, and it matches papers across about 50 languages: an English query finds German papers on the same topic.

## Actions

- `rank` orders up to 500 items (`{id, title, text}`, inline or from a `.json`/`.jsonl` file) by similarity to the query. Near-duplicates, such as an English paper and its German report, are marked `nearDuplicateOf`.
- `search` finds the closest papers among everything embedded in earlier runs.

Scores are cosine similarities. They rank; they do not prove relevance. Only the first 800 characters of each text are embedded, which is the title and the start of an abstract.

## Embedded once, looked up later

Each text is hashed. If the library already holds the hash, the stored vector is used and the model is not loaded. New vectors are quantized to 8-bit integers (384 bytes per paper) and appended to:

```
~/.feynman/embeddings/Xenova_paraphrase-multilingual-MiniLM-L12-v2/
  vectors.i8    one 384-byte row per text
  index.tsv     text hash, row, paper ID, title
~/.feynman/embeddings/models/   the model, downloaded once (about 120 MB)
```

Set `FEYNMAN_EMBEDDINGS_DIR` to keep the library somewhere else. The first call in a session loads the model, which takes a few seconds; texts already in the library take milliseconds.

## Requirements

The model runs through the optional package `@huggingface/transformers`, which a normal install includes. If you installed with `--omit=optional`, the tool says so and how to add it.
