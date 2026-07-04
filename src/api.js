// Thin client for the job-based backend. Long work (generation, branch
// signals, translation) runs as a server job polled with short requests so
// no tunnel/proxy timeout can kill it; small work (node detail) is direct.

async function parseJson(res) {
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export async function runJob(path, body, { timeoutMs = 12 * 60 * 1000 } = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const started = await parseJson(res);
  // Server-side cache hits are answered inline instead of starting a job.
  if (started.result) return started.result;
  if (!started.job_id) throw new Error("Malformed response");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetch(`/api/job/${started.job_id}`);
    const job = await parseJson(poll);
    if (job.status === "error") throw new Error(job.error);
    if (job.status === "done") return job.result;
  }
  throw new Error("Timed out");
}

export async function postDirect(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson(res);
}
