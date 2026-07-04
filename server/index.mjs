import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchValueChain,
  fetchBranchSignals,
  fetchNodeDetail,
  translateStrings,
} from "./valueChain.mjs";

const PORT = process.env.PORT || 3001;

// Generated results are cached on disk so a repeat lookup of the same
// company (or branch) within the TTL is served instantly instead of paying
// another 1-2 minute generation. News-signal freshness makes ~12h a sane cap.
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache");
mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function cachePath(kind, key) {
  return join(CACHE_DIR, `${kind}-${key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`);
}
function readCache(kind, key) {
  try {
    const { at, result } = JSON.parse(readFileSync(cachePath(kind, key), "utf8"));
    if (Date.now() - at < CACHE_TTL_MS) return result;
  } catch {}
  return null;
}
function writeCache(kind, key, result) {
  try {
    writeFileSync(cachePath(kind, key), JSON.stringify({ at: Date.now(), result }));
  } catch {}
}

// Generation runs 1-3 minutes, which outlives the timeout of most tunnels
// and proxies (Cloudflare kills requests at ~100s). So POST starts a job and
// returns immediately; the frontend polls GET /api/job/:id.
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function startJob(kind, work) {
  const id = randomUUID();
  jobs.set(id, { status: "running", kind, startedAt: Date.now() });
  work()
    .then((result) => jobs.set(id, { status: "done", kind, result }))
    .catch((err) =>
      jobs.set(id, { status: "error", kind, error: String(err.message || err) }),
    )
    .finally(() => setTimeout(() => jobs.delete(id), JOB_TTL_MS).unref());
  return id;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  let body = {};
  if (req.method === "POST") {
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      send(res, 400, { error: "invalid JSON body" });
      return;
    }
  }

  try {
    if (req.method === "POST" && req.url === "/api/value-chain") {
      const company = (body.company || "").trim();
      if (!company) return send(res, 400, { error: "company is required" });
      const cached = readCache("chain", company);
      if (cached) return send(res, 200, { result: cached });
      return send(res, 202, {
        job_id: startJob("generate", async () => {
          const result = await fetchValueChain(company);
          writeCache("chain", company, result);
          return result;
        }),
      });
    }

    if (req.method === "POST" && req.url === "/api/branch-signals") {
      const { anchor, node, direction, desc } = body;
      if (!anchor || !node || !direction)
        return send(res, 400, { error: "anchor, node, direction are required" });
      const key = `${anchor}|${node}|${direction}`;
      const cached = readCache("branch", key);
      if (cached) return send(res, 200, { result: cached });
      return send(res, 202, {
        job_id: startJob("branch", async () => {
          const result = await fetchBranchSignals({ anchor, node, direction, desc });
          writeCache("branch", key, result);
          return result;
        }),
      });
    }

    if (req.method === "POST" && req.url === "/api/translate") {
      const strings = body.strings;
      if (!strings || typeof strings !== "object")
        return send(res, 400, { error: "strings map is required" });
      return send(res, 202, {
        job_id: startJob("translate", () => translateStrings(strings)),
      });
    }

    // Fast, no web search — answered inline (well under tunnel timeouts).
    if (req.method === "POST" && req.url === "/api/node-detail") {
      const { anchor, node, desc, direction, lang, kind } = body;
      if (!anchor || !node)
        return send(res, 400, { error: "anchor and node are required" });
      const detail = await fetchNodeDetail({ anchor, node, desc, direction, lang, kind });
      return send(res, 200, { detail });
    }

    const jobMatch =
      req.method === "GET" &&
      req.url.match(/^\/api\/(?:job|value-chain\/job)\/([\w-]+)$/);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return send(res, 404, { error: "job not found or expired" });
      return send(res, 200, job);
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`Value-chain API listening on http://localhost:${PORT}`);
});
