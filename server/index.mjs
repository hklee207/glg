import { createServer } from "node:http";
import { fetchValueChain } from "./valueChain.mjs";

const PORT = process.env.PORT || 3001;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "POST" && req.url === "/api/value-chain") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const company = (body.company || "").trim();
      if (!company) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "company is required" }));
        return;
      }
      const result = await fetchValueChain(company);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`Value-chain API listening on http://localhost:${PORT}`);
});
