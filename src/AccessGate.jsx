import React, { useEffect, useState } from "react";
import { checkAccess, setAccessCode, getAccessCode } from "./api.js";

// Shown before the app when the server has an ACCESS_CODE set (deployed
// environments): asks once for the shared access code, verifies it against
// the free /api/health endpoint, and remembers it in localStorage so repeat
// visits go straight in. When the server has no code (local dev) — or can't
// be reached at all — the gate stays out of the way.
export default function AccessGate({ children }) {
  const [state, setState] = useState("checking"); // checking | locked | open
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    checkAccess()
      .then((h) => setState(!h.protected || h.ok ? "open" : "locked"))
      .catch(() => setState("open"));
  }, []);

  if (state === "open") return children;
  if (state === "checking") return null;

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(false);
    try {
      const h = await checkAccess(trimmed);
      if (h.ok) {
        setAccessCode(trimmed);
        setState("open");
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#fcfcfb",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 340,
          background: "#ffffff",
          border: "1px solid #d8d7d2",
          borderRadius: 14,
          boxShadow: "0 10px 30px rgba(0,0,0,0.10)",
          padding: "26px 26px 22px",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 700, color: "#0b0b0b", marginBottom: 4 }}>
          Value Chain Explorer
        </div>
        <div style={{ fontSize: 12, color: "#52514e", marginBottom: 16 }}>
          GLG Client Solutions — internal tool. Enter the access code you were given.
        </div>
        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          autoFocus
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontFamily: "inherit",
            fontSize: 14,
            padding: "9px 12px",
            borderRadius: 8,
            border: `1.5px solid ${error ? "#e34948" : "#cfcec8"}`,
            outline: "none",
            marginBottom: 8,
          }}
        />
        {error && (
          <div style={{ fontSize: 11.5, color: "#e34948", marginBottom: 8 }}>
            That code didn't work — check it and try again.
          </div>
        )}
        <button
          type="submit"
          disabled={busy || !code.trim()}
          style={{
            width: "100%",
            fontFamily: "inherit",
            fontSize: 13.5,
            fontWeight: 600,
            padding: "9px 0",
            borderRadius: 8,
            border: "none",
            background: busy || !code.trim() ? "#c9c8c2" : "#2a78d6",
            color: "#ffffff",
            cursor: busy || !code.trim() ? "default" : "pointer",
          }}
        >
          {busy ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}
