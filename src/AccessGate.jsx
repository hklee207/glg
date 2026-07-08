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
        background:
          "radial-gradient(ellipse 70% 55% at 50% 42%, rgba(43,70,224,0.22), transparent 65%), #0a0a0d",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Hanken Grotesk', 'Helvetica Neue', Arial, sans-serif",
        padding: 24,
      }}
    >
      <div style={{ position: "absolute", top: 20, left: 24, display: "flex", alignItems: "center", gap: 14, color: "#ffffff" }}>
        <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1 }}>GLG</span>
        <span style={{ width: 1, height: 18, background: "#3a3a44" }} />
        <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: 2.2, color: "#8f909b", textTransform: "uppercase" }}>
          Client Solutions
        </span>
      </div>
      <form
        onSubmit={submit}
        style={{
          width: 350,
          background: "#ffffff",
          borderRadius: 14,
          boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
          padding: "26px 26px 22px",
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 20, fontWeight: 600, color: "#121216", marginBottom: 4 }}>
          Value Chain Explorer
        </div>
        <div style={{ fontSize: 12, color: "#55555c", marginBottom: 16 }}>
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
            border: `1.5px solid ${error ? "#d64949" : "#ddd8cc"}`,
            outline: "none",
            marginBottom: 8,
          }}
        />
        {error && (
          <div style={{ fontSize: 11.5, color: "#d64949", marginBottom: 8 }}>
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
            background: busy || !code.trim() ? "#c9c5ba" : "#2b46e0",
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
