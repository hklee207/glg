import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5";

const SCHEMA_TEXT = `{
  "anchor_company": "string",
  "signals": [
    {
      "id": "string",
      "title": "short headline, max ~80 chars",
      "signal": "string (full one-paragraph description)",
      "key_points": ["2-4 crisp bullet facts, each grounded in a source"],
      "why_it_matters": "1-2 sentences: concrete impact on the anchor company (revenue, cost, risk, strategy)",
      "chain_link": "1 sentence: how this signal connects to the anchor's upstream/downstream value chain",
      "stakeholders": ["companies or entities with a direct stake in this signal"],
      "impact_score": "integer 0-100",
      "news_volume": "high | medium | low",
      "date": "YYYY-MM",
      "source": "publication + URL",
      "materiality": "high | medium | low",
      "direction": "upstream | downstream | anchor",
      "nodes": [
        {
          "name": "SEGMENT name (a category, never a company), e.g. Lithography Equipment",
          "desc": "max ~14 plain-English words: what this segment does and how it ties to the anchor",
          "level": 1,
          "parent": null,
          "experts": []
        },
        {
          "name": "COMPANY name inside that segment, e.g. ASML",
          "desc": "max ~14 plain-English words: what it does and how it ties to the anchor",
          "level": 2,
          "parent": "the level-1 segment name, e.g. Lithography Equipment",
          "experts": [
            {
              "role_hint": "string",
              "mosaic_filters": {
                "company": ["string"],
                "title": ["string"],
                "industry": ["string"],
                "job_function": ["string"],
                "region": ["string"]
              }
            }
          ]
        }
      ]
    }
  ]
}`;

// Shared per-signal rules used by every generation prompt. `nodeScope` swaps
// in direction-specific instructions for what a node is allowed to represent
// (see ANCHOR_NODE_SCOPE below — anchor signals otherwise re-derive the same
// suppliers/customers that the upstream/downstream slices already cover).
function signalRules(company, nodeScope) {
  return `For EACH signal:
- Write a short title, 2-4 key_points bullets, why_it_matters (concrete effect on the anchor's revenue/cost/risk/strategy), chain_link (how it ties into the anchor's value chain), and the stakeholders with a direct stake.
- Score impact_score 0-100: how hard this signal hits the anchor company, weighted up when coverage is broad (many independent outlets = higher news_volume). Order the signals array from highest to lowest impact_score.
- Build the value-chain nodes this signal implies, as a STRICT 2-level tree. Level-1 = a SEGMENT (a category, NEVER a specific company). Level-2 = specific named COMPANIES/ENTITIES inside that segment, with parent set to the segment name. Never put a company name at level-1 and never put a segment/category at level-2. HARD RULE: every level-1 segment MUST be followed by 1-3 level-2 entity nodes under it — a nodes array containing only level-1 entries is invalid output. Put the experts on the level-2 nodes (and on a level-1 node only when the expert is truly segment-wide).
${nodeScope}
- Give every node a "desc": max ~14 plain-English words a non-expert understands, saying what the entity/segment does AND how it links to ${company} (e.g. "Makes the lithography machines ${company} needs to print advanced chips").
- For each node, list the experts GLG would want there, and for each expert produce Mosaic FREE-TEXT search keywords (substring match, so prefer SHORT broad terms, ordered broad→specific): company (expand along the chain, not just the anchor), title (3-5 synonyms), industry (2-3), job_function (2-3), region (where those experts actually work).

Return ONLY valid JSON in this schema (no preamble, no markdown fences):

${SCHEMA_TEXT}

If a claim isn't grounded in a search result, omit it — never invent figures, deals, or sources.`;
}

const CHAIN_NODE_SCOPE = (kind) =>
  `- Segments/entities here must be real ${kind} value-chain participants, e.g. ${
    kind === "upstream"
      ? '"Lithography Equipment" (segment) with ASML (company); "Materials Supply" with Shin-Etsu, SUMCO'
      : '"Fabless AI Chip Designers" (segment) with NVIDIA (company); "Hyperscale Cloud Customers" with Google, AWS'
  }.`;

// Anchor signals are about the company's OWN corporate life (M&A, financing,
// leadership, capex decisions) — NOT a re-listing of its suppliers or
// customers, which the upstream/downstream slices already own. Without this
// constraint the model tends to rebuild "Equipment Suppliers" or "Hyperscale
// Customers" segments here too, duplicating those slices under a misleading
// "corporate/strategy" label.
const ANCHOR_NODE_SCOPE = (company) =>
  `- Segments/entities here must be about ${company}'s OWN corporate structure or actions, e.g. "Executive Leadership & Board", "Investment Banks & Underwriters", "Institutional Investors", "M&A Targets & Subsidiaries", "Capital Projects & Facilities", "Regulators & Government Bodies". Do NOT create nodes for equipment/materials suppliers, customers, or competitors (e.g. ASML, NVIDIA, Google, Samsung) even if the signal mentions them in passing — name them only in "stakeholders", never as a value-chain node here. If a signal has no genuine corporate-only entity, still pick the closest fit from the categories above rather than mislabeling a supplier or customer as corporate.`;

// Generation is split into three direction-scoped requests that run
// concurrently (see fetchValueChain), so each prompt covers one slice of the
// chain and pins the direction instead of asking the model to classify.
const DIRECTION_SPECS = {
  upstream: {
    count: 3,
    scope:
      "its UPSTREAM value chain: suppliers, equipment makers, materials, components and other manufacturing inputs",
    nodeScope: CHAIN_NODE_SCOPE("upstream"),
  },
  downstream: {
    count: 3,
    scope:
      "its DOWNSTREAM value chain: customers, sales channels, end-market demand, pricing and supply deals",
    nodeScope: CHAIN_NODE_SCOPE("downstream"),
  },
  anchor: {
    count: 2,
    scope:
      "the company itself: M&A, capex/capacity, financing, leadership changes, strategy and technology roadmap",
    nodeScope: ANCHOR_NODE_SCOPE,
  },
};

function buildDirectionPrompt(company, direction) {
  const spec = DIRECTION_SPECS[direction];
  const nodeScope =
    typeof spec.nodeScope === "function" ? spec.nodeScope(company) : spec.nodeScope;
  return `You are a BD research assistant for GLG Korea Client Solutions (an expert network). For the anchor company ${company}, use web_search to find EXACTLY ${spec.count} material recent news signals (last ~6 months) about ${spec.scope}. Ignore routine PR. If fewer than ${spec.count} clearly material stories exist, fill the remainder with the next most relevant recent developments so the array always has ${spec.count} entries.

Every signal's "direction" must be "${direction}".

${signalRules(company, nodeScope)}`;
}

// Pull the JSON object out of the model's text output. The prompt forbids
// preamble/fences, but web-search turns sometimes emit commentary text blocks,
// so take everything between the first "{" and the last "}".
function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in model output");
  }
  return JSON.parse(text.slice(start, end + 1));
}

// Web-search responses sometimes embed citation markup (<cite index="...">)
// inside the JSON string values — strip it everywhere before serving.
export function stripCites(value) {
  if (typeof value === "string") return value.replace(/<\/?cite[^>]*>/g, "").trim();
  if (Array.isArray(value)) return value.map(stripCites);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripCites(v)]));
  return value;
}

// One search-enabled request with the pause_turn resume loop, returning the
// parsed JSON from the final text output.
async function runSearchRequest(prompt, { maxTokens = 32000, maxSearches = 8 } = {}) {
  const client = new Anthropic();
  let messages = [{ role: "user", content: prompt }];
  let response;
  for (let attempt = 0; attempt < 6; attempt++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      // Auto-cache the transcript so each pause_turn resume re-reads the
      // prior rounds at ~0.1x input price instead of re-paying full price.
      cache_control: { type: "ephemeral" },
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: maxSearches },
      ],
      messages,
    });
    response = await stream.finalMessage();
    if (response.stop_reason !== "pause_turn") break;
    messages = [messages[0], { role: "assistant", content: response.content }];
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return stripCites(extractJson(text));
}

// A plain no-tools request for fast auxiliary calls (node details, translation).
async function runPlainRequest(prompt, { maxTokens = 4000 } = {}) {
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const response = await stream.finalMessage();
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return extractJson(text);
}

export async function fetchValueChain(company) {
  // Three direction-scoped requests run in parallel, so wall time is the
  // slowest slice (~60-90s) instead of one big sequential 8-signal request
  // (~2-3 min). A slice that fails is dropped rather than failing the run.
  const dirs = ["upstream", "downstream", "anchor"];
  const settled = await Promise.allSettled(
    dirs.map((d) =>
      runSearchRequest(buildDirectionPrompt(company, d), {
        maxTokens: 16000,
        maxSearches: 4,
      }),
    ),
  );
  const failures = [];
  const signals = [];
  let anchorName = null;
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      failures.push(`${dirs[i]}: ${s.reason?.message || s.reason}`);
      return;
    }
    anchorName = anchorName || s.value?.anchor_company;
    for (const sig of s.value?.signals || []) {
      // Re-id per direction so the three slices can't collide, and pin the
      // direction in case the model drifted.
      signals.push({
        ...sig,
        direction: dirs[i],
        id: `${dirs[i][0].toUpperCase()}${signals.length + 1}`,
      });
    }
  });
  if (!signals.length) {
    throw new Error(`Generation failed (${failures.join("; ") || "no signals returned"})`);
  }
  signals.sort((a, b) => (b.impact_score ?? 0) - (a.impact_score ?? 0));
  return { anchor_company: anchorName || company, signals: dedupeAnchorNodes(signals) };
}

// Belt-and-suspenders for the anchor-direction node-scope prompt rule: since
// the three slices are generated independently, the anchor slice can still
// re-invent a company already covered by upstream/downstream (e.g. naming
// NVIDIA under a "corporate" segment when it's already a downstream
// customer). Strip those company nodes from anchor signals, then drop any
// segment left with no children so the tree stays a valid 2-level shape.
function dedupeAnchorNodes(signals) {
  const chainCompanies = new Set();
  for (const s of signals) {
    if (s.direction === "anchor") continue;
    for (const n of s.nodes || []) {
      if (n.level === 2) chainCompanies.add(n.name.trim().toLowerCase());
    }
  }
  if (!chainCompanies.size) return signals;
  return signals.map((s) => {
    if (s.direction !== "anchor") return s;
    const kept = (s.nodes || []).filter(
      (n) => n.level !== 2 || !chainCompanies.has(n.name.trim().toLowerCase()),
    );
    const segmentsWithKids = new Set(
      kept.filter((n) => n.level === 2).map((n) => n.parent),
    );
    const nodes = kept.filter((n) => n.level !== 1 || segmentsWithKids.has(n.name));
    return { ...s, nodes };
  });
}

// Extra signals scoped to one branch of the anchor's chain. Level-1 of every
// returned node is pinned to the branch name so the frontend's merged tree
// simply grows new leaves under the existing segment.
export async function fetchBranchSignals({ anchor, node, direction, desc }) {
  const prompt = `You are a BD research assistant for GLG Korea Client Solutions (an expert network). The anchor company is ${anchor}. Focus ONLY on this part of its value chain: "${node}" (${direction}${desc ? ` — ${desc}` : ""}).

Use web_search to find 3-4 recent news signals (last ~6 months) specifically about ${node} and its relationship to ${anchor}'s value chain — deals, capacity, pricing, technology, leadership moves that flow through this branch. Ignore routine PR.

Follow the exact same rules and JSON schema as below, with these constraints:
- Every signal's direction must be "${direction}".
- Every signal's nodes must stay inside this branch: level-1 must be exactly "${node}", level-2 = specific named companies under it (never sub-categories).
- Ids should be "R1", "R2", ...

Return ONLY valid JSON in this schema (no preamble, no markdown fences):

${SCHEMA_TEXT}

If a claim isn't grounded in a search result, omit it — never invent figures, deals, or sources.`;
  return runSearchRequest(prompt, { maxTokens: 16000, maxSearches: 5 });
}

// Classic positioning-statement ("For X who Y, Z is a...") for one node.
// No web search — fast enough to answer a click directly.
export async function fetchNodeDetail({ anchor, node, desc, direction, lang, kind }) {
  const what =
    kind === "segment"
      ? `the business segment "${node}" (a category of companies, not a single company — describe the segment as a whole)`
      : `the company "${node}"`;
  const prompt = `You are a BD research assistant for GLG Korea Client Solutions. Explain ${what}${desc ? ` (${desc})` : ""} — a ${direction === "anchor" ? "corporate/strategy" : direction} node in ${anchor}'s value chain — using the classic positioning formula, for a generalist who doesn't know the industry.

Return ONLY valid JSON (no preamble, no fences):
{
  "for": "target customer",
  "who": "has this need/problem",
  "is_a": "market category",
  "that": "delivers this one key benefit",
  "unlike": "main competitor/alternative",
  "differentiator": "key differentiator",
  "chain_role": "1 short sentence: its specific role in ${anchor}'s value chain"
}

${lang === "ko" ? "Write every value in natural business Korean (company names stay in English)." : "Write every value in plain English."}
Keep each value short (under 15 words). If unsure about specifics, stay general rather than inventing facts.`;
  return runPlainRequest(prompt, { maxTokens: 1200 });
}

// Translate a flat {key: english} map to Korean, preserving keys. Used for
// on-demand Korean view of a generated dataset.
export async function translateStrings(strings) {
  const entries = Object.entries(strings || {});
  if (!entries.length) return {};
  // Chunk to keep each request comfortably inside output limits.
  const CHUNK = 60;
  const out = {};
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = Object.fromEntries(entries.slice(i, i + CHUNK));
    const prompt = `Translate the VALUES of this JSON object from English to natural business Korean. Keep company names, product names, model numbers, and acronyms in English. Do not translate keys. Return ONLY a JSON object with the identical keys and translated values (no preamble, no fences):

${JSON.stringify(chunk)}`;
    const translated = await runPlainRequest(prompt, { maxTokens: 16000 });
    Object.assign(out, translated);
  }
  return out;
}
