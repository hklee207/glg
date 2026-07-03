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
          "name": "string",
          "desc": "max ~14 plain-English words: what it does and how it ties to the anchor",
          "level": 1,
          "parent": "string | null",
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

function buildPrompt(company) {
  return `You are a BD research assistant for GLG Korea Client Solutions (an expert network). For the anchor company ${company}, use web_search to find EXACTLY 8 material recent news signals (last ~6 months): capex/capacity, M&A, leadership, supply/customer deals, pricing/demand, tech roadmap. Ignore routine PR. If fewer than 8 clearly material stories exist, fill the remainder with the next most relevant recent developments so the array always has 8 entries.

For EACH signal:
- Classify direction: upstream (suppliers/equipment/materials), downstream (customers/channel/demand), or anchor (M&A/strategy/leadership).
- Write a short title, 2-4 key_points bullets, why_it_matters (concrete effect on the anchor's revenue/cost/risk/strategy), chain_link (how it ties into the anchor's value chain), and the stakeholders with a direct stake.
- Score impact_score 0-100: how hard this signal hits the anchor company, weighted up when coverage is broad (many independent outlets = higher news_volume). Order the signals array from highest to lowest impact_score.
- Build the value-chain nodes this signal implies, as a 2-level tree: level-1 = a segment or key company on that side of the chain; level-2 = specific sub-players under it (set parent to the level-1 name). Upstream examples: equipment makers (ASML, Applied Materials, Tokyo Electron), materials (SUMCO, Shin-Etsu). Downstream examples: customers (Nvidia, AMD, hyperscalers).
- Give every node a "desc": max ~14 plain-English words a non-expert understands, saying what the company/segment does AND how it links to ${company} (e.g. "Makes the lithography machines ${company} needs to print advanced chips").
- For each node, list the experts GLG would want there, and for each expert produce Mosaic FREE-TEXT search keywords (substring match, so prefer SHORT broad terms, ordered broad→specific): company (expand along the chain, not just the anchor), title (3-5 synonyms), industry (2-3), job_function (2-3), region (where those experts actually work).

Return ONLY valid JSON in this schema (no preamble, no markdown fences):

${SCHEMA_TEXT}

If a claim isn't grounded in a search result, omit it — never invent figures, deals, or sources.`;
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
  return runSearchRequest(buildPrompt(company));
}

// Extra signals scoped to one branch of the anchor's chain. Level-1 of every
// returned node is pinned to the branch name so the frontend's merged tree
// simply grows new leaves under the existing segment.
export async function fetchBranchSignals({ anchor, node, direction, desc }) {
  const prompt = `You are a BD research assistant for GLG Korea Client Solutions (an expert network). The anchor company is ${anchor}. Focus ONLY on this part of its value chain: "${node}" (${direction}${desc ? ` — ${desc}` : ""}).

Use web_search to find 3-4 recent news signals (last ~6 months) specifically about ${node} and its relationship to ${anchor}'s value chain — deals, capacity, pricing, technology, leadership moves that flow through this branch. Ignore routine PR.

Follow the exact same rules and JSON schema as below, with these constraints:
- Every signal's direction must be "${direction}".
- Every signal's nodes must stay inside this branch: level-1 must be exactly "${node}", level-2 = specific sub-players under it.
- Ids should be "R1", "R2", ...

Return ONLY valid JSON in this schema (no preamble, no markdown fences):

${SCHEMA_TEXT}

If a claim isn't grounded in a search result, omit it — never invent figures, deals, or sources.`;
  return runSearchRequest(prompt, { maxTokens: 16000, maxSearches: 5 });
}

// Classic positioning-statement ("For X who Y, Z is a...") for one node.
// No web search — fast enough to answer a click directly.
export async function fetchNodeDetail({ anchor, node, desc, direction, lang }) {
  const prompt = `You are a BD research assistant for GLG Korea Client Solutions. Explain "${node}"${desc ? ` (${desc})` : ""} — a ${direction === "anchor" ? "corporate/strategy" : direction} node in ${anchor}'s value chain — using the classic positioning formula, for a generalist who doesn't know the industry.

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
