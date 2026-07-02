# GLG Value Chain Explorer

Internal BD-prep tool for GLG Client Solutions. Type an anchor company,
hit **Generate**, and the app searches recent news (via the Anthropic API
with web search), builds a two-level value-chain tree (upstream suppliers
up, downstream customers down), and maps each news signal to the branch it
affects. Clicking a signal highlights its branch and shows the GLG expert
profiles for it, with click-to-copy Mosaic search keywords.

## Run

```bash
npm install

# 1. backend (port 3001)
ANTHROPIC_API_KEY=sk-... npm run server

# 2. frontend (port 5173, proxies /api to the backend)
npx vite
```

Open http://localhost:5173. The app boots with a bundled SK Hynix dataset;
Generate replaces it with live results (takes 1–3 minutes per company).

## CLI

Fetch the raw JSON for any company without the UI:

```bash
ANTHROPIC_API_KEY=sk-... npm run fetch -- "SK Hynix"
```

## Pieces

| Path | What it is |
|---|---|
| `server/valueChain.mjs` | Anthropic API call (claude-sonnet-4-6 + `web_search_20250305`), prompt, JSON extraction |
| `server/index.mjs` | HTTP server: `POST /api/value-chain {company}` |
| `src/ValueChainExplorer.jsx` | The whole view: signals panel, SVG tree, expert bands |
| `src/data/skhynix.json` | Bundled sample (real fetched data) used as the initial view |
