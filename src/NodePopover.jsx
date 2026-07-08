import React, { useEffect, useState } from "react";
import { useI18n } from "./i18n.js";

const W = 320;
const H = 350;

// Click-a-node popover: full name, plain-language description, and actions —
// positioning-formula detail (all nodes), branch signals (segments), explore
// as new anchor with double confirmation (companies).
export default function NodePopover({
  node,
  anchor,
  svgWidth,
  svgHeight,
  detail,
  onFetchDetail,
  onBranch,
  onExplore,
  busy,
  onClose,
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setConfirming(false), [node?.id]);
  if (!node) return null;

  const halfW = Math.max(60, (node.maxW || 150) / 2);
  let x = node.x + halfW + 14;
  if (x + W > svgWidth - 8) x = node.x - halfW - 14 - W;
  x = Math.max(8, Math.min(x, svgWidth - W - 8));
  const y = Math.max(8, Math.min(node.y - H / 2, svgHeight - H - 8));

  const isSegment = node.level === 1;
  const isCompany = node.level === 2;

  const btn = (label, onClick, { primary = false, disabled = false, danger = false } = {}) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      style={{
        fontFamily: "inherit",
        fontSize: 11.5,
        fontWeight: 600,
        padding: "6px 11px",
        borderRadius: 7,
        border: primary || danger ? "none" : "1px solid #ddd8cc",
        background: disabled ? "#e7e3d8" : danger ? "#d64949" : primary ? "#2b46e0" : "#ffffff",
        color: disabled ? "#9b9a93" : primary || danger ? "#ffffff" : "#121216",
        cursor: disabled ? "default" : "pointer",
        width: "100%",
        textAlign: "left",
        marginBottom: 6,
      }}
    >
      {label}
    </button>
  );

  const d = detail?.data;
  const formulaLine = (lead, value, boldValue = false) =>
    value ? (
      <div style={{ marginBottom: 2 }}>
        <span style={{ color: "#55555c" }}>{lead} </span>
        <span style={{ fontWeight: boldValue ? 700 : 400 }}>{value}</span>
      </div>
    ) : null;

  return (
    <foreignObject x={x} y={y} width={W} height={H} style={{ overflow: "visible" }}>
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          width: W - 2,
          maxHeight: H,
          overflowY: "auto",
          background: "#ffffff",
          border: "1px solid #ddd8cc",
          borderRadius: 12,
          boxShadow: "0 10px 30px rgba(0,0,0,0.22)",
          padding: "11px 13px",
          fontSize: 12,
          lineHeight: 1.5,
          color: "#121216",
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 5 }}>
          <div style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>
            {node.label}
            {node.level > 0 && (
              <span
                style={{
                  marginLeft: 7,
                  fontSize: 8.5,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  color: isSegment ? "#4a3aa7" : "#55555c",
                  background: isSegment ? "#ece8f9" : "#f1eee6",
                  borderRadius: 999,
                  padding: "2px 8px",
                  verticalAlign: "middle",
                  whiteSpace: "nowrap",
                }}
              >
                {t(isSegment ? "segmentTag" : "companyTag")}
              </span>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, color: "#55555c", padding: 0 }}
          >
            ✕
          </button>
        </div>

        <div style={{ fontSize: 11.5, color: node.desc ? "#121216" : "#8a8983", marginBottom: 9 }}>
          {node.desc || t("noDesc")}
        </div>

        {/* Positioning-formula detail */}
        {!detail || detail.status === "idle" ? (
          btn(`ⓘ ${t(isSegment ? "whatIsSegment" : "whatIsCompany")}`, () => onFetchDetail(node))
        ) : detail.status === "loading" ? (
          <div style={{ fontSize: 11.5, color: "#55555c", margin: "4px 0 8px" }}>◐ {t("detailLoading")}</div>
        ) : detail.status === "error" ? (
          btn(`⚠ ${t("detailError")}`, () => onFetchDetail(node))
        ) : (
          <div
            style={{
              background: "#f5f3ee",
              border: "1px solid #e5e1d6",
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 11.5,
              marginBottom: 8,
            }}
          >
            {formulaLine("For", d.for)}
            {formulaLine("who", d.who)}
            {formulaLine(`${node.label} is`, d.is_a, true)}
            {formulaLine("that", d.that)}
            {formulaLine("Unlike", d.unlike)}
            {formulaLine("it", d.differentiator, true)}
            {d.chain_role && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px dashed #ddd", color: "#55555c" }}>
                <b style={{ color: "#121216" }}>{t("chainRole")}:</b> {d.chain_role}
              </div>
            )}
          </div>
        )}

        {isSegment && node.direction !== "anchor" &&
          btn(`🔎 ${t("moreSignals")}`, () => onBranch(node), { disabled: busy })}

        {isCompany &&
          (confirming ? (
            <div
              style={{
                background: "#faf1de",
                border: "1px solid #e8a13d",
                borderRadius: 8,
                padding: "8px 10px",
                marginBottom: 6,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 11.5, marginBottom: 3 }}>
                {t("exploreConfirmTitle", { name: node.label })}
              </div>
              <div style={{ fontSize: 11, color: "#55555c", marginBottom: 7 }}>
                {t("exploreConfirmBody", { name: node.label, prev: anchor })}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onExplore(node);
                  }}
                  disabled={busy}
                  style={{
                    fontFamily: "inherit",
                    fontSize: 11.5,
                    fontWeight: 700,
                    padding: "6px 12px",
                    borderRadius: 7,
                    border: "none",
                    background: busy ? "#c9c5ba" : "#2b46e0",
                    color: "#ffffff",
                    cursor: busy ? "default" : "pointer",
                    flex: 1,
                  }}
                >
                  {t("yesExplore")}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirming(false);
                  }}
                  style={{
                    fontFamily: "inherit",
                    fontSize: 11.5,
                    padding: "6px 12px",
                    borderRadius: 7,
                    border: "1px solid #ddd8cc",
                    background: "#ffffff",
                    color: "#121216",
                    cursor: "pointer",
                  }}
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          ) : (
            btn(`🧭 ${t("explore")}`, () => setConfirming(true), { disabled: busy })
          ))}
      </div>
    </foreignObject>
  );
}
