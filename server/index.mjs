import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchValueChain,
  fetchBranchSignals,
  fetchNodeDetail,
  translateStrings,
} from "./valueChain.mjs";

const PORT = process.env.PORT || 3001;

// Every generation costs real API money, so when ACCESS_CODE is set (always
// in deployed environments) all /api routes demand a matching x-access-code
// header. The frontend collects the code once and stores it locally. Leave
// ACCESS_CODE unset for open local development.
const ACCESS_CODE = process.env.ACCESS_CODE || "";

// In production the same server also serves the built frontend from dist/,
// so one Render/Railway service hosts the whole app.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(ROOT, "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  if (!existsSync(DIST)) return false;
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  let filePath = normalize(join(DIST, urlPath));
  if (!filePath.startsWith(DIST)) return false;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // Extensionless page URLs (e.g. /briefing) resolve to their .html file;
    // everything else falls back to the SPA.
    filePath = existsSync(`${filePath}.html`) ? `${filePath}.html` : join(DIST, "index.html");
  }
  res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
  return true;
}

// Generated results are cached on disk so a repeat lookup of the same
// company (or branch) within the TTL is served instantly instead of paying
// another 1-2 minute generation. News-signal freshness makes ~12h a sane cap.
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), ".cache");
mkdirSync(CACHE_DIR, { recursive: true });
const CACHE_TTL_MS = (Number(process.env.CACHE_TTL_H) || 24) * 60 * 60 * 1000;

// Permanent english→korean dictionary shared across all datasets. Every
// string ever translated is answered from here instantly and for free;
// only genuinely new strings go to the model. Translations don't go stale
// the way news does, so no TTL.
const KO_DICT_PATH = join(CACHE_DIR, "ko-strings.json");
let koDict = {};
try {
  koDict = JSON.parse(readFileSync(KO_DICT_PATH, "utf8"));
} catch {}
function rememberKo(map) {
  Object.assign(koDict, map);
  try {
    writeFileSync(KO_DICT_PATH, JSON.stringify(koDict));
  } catch {}
}

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
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-access-code");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const isApi = req.url.startsWith("/api/");
  const codeOk = !ACCESS_CODE || req.headers["x-access-code"] === ACCESS_CODE;

  // Lets the frontend discover whether a code is needed / verify one without
  // triggering any paid work.
  if (req.method === "GET" && req.url === "/api/health") {
    return send(res, 200, { protected: !!ACCESS_CODE, ok: codeOk });
  }

  if (isApi && !codeOk) {
    return send(res, 401, { error: "invalid access code" });
  }

  if (req.method === "GET" && !isApi) {
    if (serveStatic(req, res)) return;
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
      // Serve known strings from the dictionary; only translate the rest.
      // Keys differ per dataset but values repeat (same segments, companies,
      // role hints), so the dictionary is keyed by the english VALUE.
      const known = {};
      const missing = {};
      for (const [key, value] of Object.entries(strings)) {
        if (typeof value === "string" && koDict[value] != null) known[key] = koDict[value];
        else missing[key] = value;
      }
      if (!Object.keys(missing).length) return send(res, 200, { result: known });
      return send(res, 202, {
        job_id: startJob("translate", async () => {
          const fresh = await translateStrings(missing);
          rememberKo(
            Object.fromEntries(
              Object.entries(fresh)
                .filter(([k]) => typeof missing[k] === "string" && typeof fresh[k] === "string")
                .map(([k, v]) => [missing[k], v]),
            ),
          );
          return { ...known, ...fresh };
        }),
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
