import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fetchValueChain } from "./valueChain.mjs";

const PORT = process.env.PORT || 3001;

// Generation runs 1-3 minutes, which outlives the timeout of most tunnels
// and proxies (Cloudflare kills requests at ~100s). So POST starts a job and
// returns immediately; the frontend polls GET /api/value-chain/job/:id.
const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function startJob(company) {
  const id = randomUUID();
  jobs.set(id, { status: "running", company, startedAt: Date.now() });
  fetchValueChain(company)
    .then((result) => jobs.set(id, { status: "done", company, result }))
    .catch((err) =>
      jobs.set(id, { status: "error", company, error: String(err.message || err) }),
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

  if (req.method === "POST" && req.url === "/api/value-chain") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const company = (body.company || "").trim();
      if (!company) {
        send(res, 400, { error: "company is required" });
        return;
      }
      send(res, 202, { job_id: startJob(company) });
    } catch (err) {
      send(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  const jobMatch =
    req.method === "GET" && req.url.match(/^\/api\/value-chain\/job\/([\w-]+)$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      send(res, 404, { error: "job not found or expired" });
      return;
    }
    send(res, 200, job);
    return;
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Value-chain API listening on http://localhost:${PORT}`);
});
