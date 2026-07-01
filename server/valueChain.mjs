import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6";

const SCHEMA_TEXT = `{
  "anchor_company": "string",
  "signals": [
    {
      "id": "string",
      "signal": "string",
      "date": "YYYY-MM",
      "source": "publication + URL",
      "materiality": "high | medium | low",
      "direction": "upstream | downstream | anchor",
      "nodes": [
        {
          "name": "string",
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
  return `You are a BD research assistant for GLG Korea Client Solutions (an expert network). For the anchor company ${company}, use web_search to find 5-8 material recent news signals (last ~6 months): capex/capacity, M&A, leadership, supply/customer deals, pricing/demand, tech roadmap. Ignore routine PR.

For EACH signal:
- Classify direction: upstream (suppliers/equipment/materials), downstream (customers/channel/demand), or anchor (M&A/strategy/leadership).
- Build the value-chain nodes this signal implies, as a 2-level tree: level-1 = a segment or key company on that side of the chain; level-2 = specific sub-players under it (set parent to the level-1 name). Upstream examples: equipment makers (ASML, Applied Materials, Tokyo Electron), materials (SUMCO, Shin-Etsu). Downstream examples: customers (Nvidia, AMD, hyperscalers).
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

export async function fetchValueChain(company) {
  const client = new Anthropic();

  let messages = [{ role: "user", content: buildPrompt(company) }];
  let response;

  // Server-side web_search runs a sampling loop that may pause with
  // stop_reason "pause_turn"; re-send the transcript to let it resume.
  for (let attempt = 0; attempt < 6; attempt++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
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

  return extractJson(text);
}
