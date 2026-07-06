# GLG Value Chain Explorer

Internal BD-prep tool for GLG Client Solutions. Type an anchor company, hit
**Generate**, and the app searches recent news (via the Anthropic API with
web search), builds a value-chain tree around it, scores each news signal by
impact, and maps each signal to the GLG expert profiles worth calling for
it — with click-to-copy Mosaic search keywords.

## Run

```bash
npm install

# 1. backend (port 3001)
ANTHROPIC_API_KEY=sk-... npm run server

# 2. frontend (port 5173, proxies /api to the backend)
npx vite
```

Open http://localhost:5173. The app boots with a bundled SK Hynix dataset;
Generate replaces it with live results (typically ~1-2 minutes per company,
faster on a cache hit — see below).

## CLI

Fetch the raw JSON for any company without the UI:

```bash
ANTHROPIC_API_KEY=sk-... npm run fetch -- "SK Hynix"
```

## Deploy (Render)

`render.yaml` defines a single web service that builds the frontend
(`npm run build`) and runs the Node server, which serves both the site (from
`dist/`) and the API. In the Render dashboard set two environment variables:

- `ANTHROPIC_API_KEY` — the Anthropic API key.
- `ACCESS_CODE` — a shared password; when set, the app shows an access-code
  screen and every `/api/*` call requires it (each generation costs real API
  money, so don't deploy without one). Leave it unset for open local dev.

## How generation works

- **Model**: `claude-haiku-4-5` with the `web_search_20250305` tool.
- A single "generate" call is split into **three direction-scoped requests
  run in parallel** — upstream, downstream, and anchor (the company's own
  corporate/strategy activity) — each asking for a fixed number of signals
  (3 + 3 + 2 = 8 total). This keeps wall time to the slowest single slice
  (~60-90s) instead of one long sequential call, and a slice that fails is
  dropped rather than failing the whole run.
- Every value-chain node is a strict 2-level tree: **level-1 = a business
  SEGMENT** (a category, e.g. "Lithography Equipment"), **level-2 = a named
  COMPANY** inside it (e.g. ASML). Experts and Mosaic keywords are attached
  only to level-2 company nodes — segments never carry experts directly,
  which keeps every expert card tied to a real company.
- Each node also gets a plain-English `desc` (~14 words) explaining what it
  is and how it connects to the anchor, for non-experts.
- Results are **cached on disk** in `server/.cache/` for 12 hours (gitignored)
  — a repeat lookup of the same company, or the same branch/segment, is
  served instantly instead of re-running the search.

### Job-based API (works behind slow tunnels)

Generation, branch-signal search, and Korean translation all run 30s-2min,
which outlives most proxy/tunnel timeouts (e.g. Cloudflare quick tunnels cut
requests around ~100s). So these `POST` endpoints don't block: they either
return a cached `{ result }` immediately, or start a background job and
return `{ job_id }`, which the frontend polls via `GET /api/job/:id` every
few seconds until it reports `status: "done"` or `"error"`. Only the fast,
no-search `/api/node-detail` call answers directly.

| Endpoint | Behavior |
|---|---|
| `POST /api/value-chain {company}` | Full generation for a new anchor company (job or cache hit) |
| `POST /api/branch-signals {anchor, node, direction, desc}` | 3-4 extra signals scoped to one segment/branch (job or cache hit) |
| `POST /api/translate {strings}` | Translates a flat `{key: english}` string map to Korean (job) |
| `POST /api/node-detail {anchor, node, desc, direction, lang, kind}` | Plain-language "positioning formula" for one node (direct, no search) |
| `GET /api/job/:id` | Poll a job's status/result |

## Frontend features

- **Interactive SVG tree**: pan/zoom diagram with the anchor company in the
  center, upstream segments/companies above, downstream below, and a
  separate labeled column for the anchor's own corporate/strategy chains
  (so those never collide with the supplier/customer rows). Segments render
  as tinted "hull" pills; companies are white boxes; the anchor is black.
- **Signal panel**: every signal is a clickable card ordered by impact score;
  clicking one highlights its chain on the diagram and shows expert cards
  for every company involved. Highlighted segments stay tinted with a
  thicker outline (never solid), so segment vs. company stays visually
  distinct even when a signal is selected. Expert cards only appear for
  nodes that actually have experts — there are no empty or segment-titled
  cards.
- **Node popover**: click any box for its plain-language description, an
  on-demand "what does this do?" button (positioning-formula detail, no
  search needed), a "find more signals for this branch" button on segments,
  and "explore as new anchor" on companies (double-confirmation, since it
  replaces the whole diagram).
- **Explore / ghost back-link**: exploring a company node re-anchors the
  whole map on it and pushes the previous anchor onto a history stack; a
  faint dashed "← back to {prev anchor}" pill lets you return without
  re-generating.
- **Generating overlay**: a full-screen progress view (elapsed timer, staged
  checklist, a skeleton diagram that builds itself) shown while a job runs,
  so the user isn't staring at a blank screen for the ~1-2 minutes.
- **Korean toggle**: switches all UI chrome instantly (`src/i18n.js`), and
  translates the current dataset's dynamic content (descriptions, labels,
  role hints) on demand via `/api/translate`, cached so it only runs once
  per dataset/language.

## Pieces

| Path | What it is |
|---|---|
| `server/valueChain.mjs` | Anthropic API calls (prompts, schema, JSON extraction, citation stripping) |
| `server/index.mjs` | HTTP server: job runner, disk cache, all `/api/*` routes |
| `src/ValueChainExplorer.jsx` | Main app: tree layout/rendering, signal panel, state management |
| `src/NodePopover.jsx` | Click-a-node popover (description, detail, branch/explore actions) |
| `src/GeneratingOverlay.jsx` | Full-screen generation progress view + background job toast |
| `src/i18n.js` | EN/KO UI string tables and the translation-pack lookup |
| `src/api.js` | Job-polling client (`runJob`) and direct-call client (`postDirect`) |
| `src/data/skhynix.json` | Bundled sample (real fetched data) used as the initial view |
| `scripts/test-fetch.mjs` | CLI wrapper around `fetchValueChain` for `npm run fetch` |
