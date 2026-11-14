# Knowledge files

Put trusted Age of Nations Markdown (guides, wiki exports) anywhere under this directory, in any sub-folder. The bot finds every `.md` file recursively and re-indexes automatically within about 30 seconds of a file being added or edited — no restart, no code change. `README.md` (this file) is not game knowledge and is skipped.

Tips for good retrieval:
- Use headings (`#`, `##`, `###`). Each passage is stored with its heading path and file name.
- Keep tables intact; long tables are split by rows with the header repeated.
- Arabic and English are both fine; mixed documents work.
- Optional front matter lowers or raises a file's ranking: `---` / `retrieval_weight: 0.35` / `---` (0–2, default 1). `00-glossary.md` uses it so slang↔wiki-term mappings help search without outranking real content. Add new slang there.
- Never put guesses in these files: everything here is treated as the official source for game mechanics.
