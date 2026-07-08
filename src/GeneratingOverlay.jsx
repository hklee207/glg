import React, { useEffect, useState } from "react";
import { useI18n } from "./i18n.js";

// Full-screen progress experience shown while a value chain is being
// generated. There is no real telemetry from the single model call, so the
// storyboard advances on elapsed time, matched to what the backend actually
// does in order: search -> read/score -> map up -> map down -> experts ->
// assemble. A skeleton diagram "builds itself" stage by stage so the user
// watches the map take shape instead of staring at a spinner.
const STAGE_AT = [0, 12, 30, 45, 60, 75]; // seconds each stage begins
const ETA_S = 90;

function useElapsed(startedAt) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function mmss(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Skeleton boxes appear with the stages: anchor first, then upstream rows,
// then downstream rows, then expert cards.
function SkeletonDiagram({ stage }) {
  const box = (x, y, w, h, delay, tone) => (
    <rect
      key={`${x}-${y}`}
      x={x}
      y={y}
      width={w}
      height={h}
      rx={6}
      fill={tone}
      className="vc-skel"
      style={{ animationDelay: `${delay}s` }}
    />
  );
  const up = "#c8d2f5";
  const down = "#c2e5d8";
  const gray = "#e5e1d6";
  const els = [];
  // anchor
  els.push(box(270, 132, 100, 30, 0, "#121216"));
  if (stage >= 2) {
    // upstream segments + leaves
    [80, 220, 360, 500].forEach((x, i) => els.push(box(x, 76, 84, 26, i * 0.18, up)));
    [40, 150, 260, 370, 480, 560].forEach((x, i) => els.push(box(x, 22, 72, 22, 0.5 + i * 0.14, up)));
  }
  if (stage >= 3) {
    [110, 260, 410, 520].forEach((x, i) => els.push(box(x, 192, 84, 26, i * 0.18, down)));
    [60, 170, 285, 400, 505].forEach((x, i) => els.push(box(x, 246, 72, 22, 0.5 + i * 0.14, down)));
  }
  if (stage >= 4) {
    [30, 200, 380, 540].forEach((x, i) => els.push(box(x, 288, 96, 40, i * 0.22, gray)));
  }
  // connectors fade in with their rows
  const lines = [];
  if (stage >= 2)
    [122, 262, 402, 542].forEach((x, i) =>
      lines.push(
        <line key={`u${i}`} x1={320} y1={132} x2={x} y2={102} stroke={up} strokeWidth={1.5} className="vc-skel" style={{ animationDelay: `${i * 0.18}s` }} />,
      ),
    );
  if (stage >= 3)
    [152, 302, 452, 562].forEach((x, i) =>
      lines.push(
        <line key={`d${i}`} x1={320} y1={162} x2={x} y2={192} stroke={down} strokeWidth={1.5} className="vc-skel" style={{ animationDelay: `${i * 0.18}s` }} />,
      ),
    );
  return (
    <svg width={660} height={340} style={{ maxWidth: "100%" }} aria-hidden="true">
      {lines}
      {els}
    </svg>
  );
}

export default function GeneratingOverlay({ companyLabel, startedAt }) {
  const { t } = useI18n();
  const elapsed = useElapsed(startedAt);
  const stage = STAGE_AT.reduce((acc, s, i) => (elapsed >= s ? i : acc), 0);
  const pct = Math.min(96, Math.round((elapsed / ETA_S) * 100));

  const stageRow = (i) => {
    const state = i < stage ? "done" : i === stage ? "active" : "todo";
    return (
      <div
        key={i}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "4px 0",
          fontSize: 12.5,
          color: state === "todo" ? "#b3b1a8" : state === "active" ? "#121216" : "#55555c",
          fontWeight: state === "active" ? 600 : 400,
        }}
      >
        <span style={{ width: 16, textAlign: "center", flexShrink: 0 }}>
          {state === "done" ? "✓" : state === "active" ? <span className="vc-spin">◐</span> : "·"}
        </span>
        {t(`stage${i}`)}
      </div>
    );
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "#f5f3eef5",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
        fontFamily: "'Hanken Grotesk', 'Helvetica Neue', Arial, sans-serif",
      }}
    >
      <style>{`
        .vc-skel { animation: vcPulse 1.6s ease-in-out infinite; }
        @keyframes vcPulse { 0%,100% { opacity: 0.35; } 50% { opacity: 0.9; } }
        .vc-spin { display: inline-block; animation: vcSpin 1.1s linear infinite; }
        @keyframes vcSpin { to { transform: rotate(360deg); } }
      `}</style>
      <div
        style={{
          fontFamily: "'Source Serif 4', Georgia, serif",
          fontSize: 24,
          fontWeight: 600,
          color: "#121216",
          marginBottom: 4,
        }}
      >
        {t("buildingTitle", { name: companyLabel })}
      </div>
      <div style={{ fontSize: 12.5, color: "#55555c", marginBottom: 16 }}>
        {t("buildingEta")}
      </div>

      <div style={{ width: "100%", maxWidth: 560, marginBottom: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#55555c", marginBottom: 4 }}>
          <span>
            {t("elapsed")} {mmss(elapsed)}
          </span>
          <span>~1–2 min</span>
        </div>
        <div style={{ height: 6, borderRadius: 999, background: "#ebe7dc", overflow: "hidden" }}>
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              borderRadius: 999,
              background: "#2b46e0",
              transition: "width 1s linear",
            }}
          />
        </div>
      </div>

      <div style={{ width: "100%", maxWidth: 560, margin: "10px 0 6px" }}>
        {[0, 1, 2, 3, 4, 5].map(stageRow)}
      </div>

      {elapsed > 150 && (
        <div style={{ fontSize: 12, color: "#a15c00", background: "#faf1de", border: "1px solid #e8a13d", borderRadius: 8, padding: "6px 12px", marginBottom: 10 }}>
          {t("takingLonger")}
        </div>
      )}

      <SkeletonDiagram stage={stage} />
    </div>
  );
}

// Small corner toast for background jobs that shouldn't block the UI
// (branch signals, translation).
export function WorkingToast({ textKey, name, startedAt }) {
  const { t } = useI18n();
  const elapsed = useElapsed(startedAt);
  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 70,
        background: "#121216dd",
        color: "#ffffff",
        borderRadius: 10,
        padding: "9px 14px",
        fontSize: 12,
        display: "flex",
        alignItems: "center",
        gap: 9,
        boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
        maxWidth: 380,
      }}
    >
      <span className="vc-spin" style={{ fontSize: 13 }}>
        ◐
      </span>
      <style>{`.vc-spin { display: inline-block; animation: vcSpin 1.1s linear infinite; } @keyframes vcSpin { to { transform: rotate(360deg); } }`}</style>
      <span>
        {t(textKey, { name })} ({mmss(elapsed)})
      </span>
    </div>
  );
}
