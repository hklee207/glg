import React, { useMemo, useState } from "react";
import data from "./data/skhynix.json";

// ---------------------------------------------------------------------------
// Colors (validated dataviz palette; text always wears ink, never series hue)
// ---------------------------------------------------------------------------
const COLORS = {
  upstream: "#2a78d6",
  downstream: "#1baf7a",
  anchor: "#0b0b0b",
  ink: "#0b0b0b",
  inkSoft: "#52514e",
  surface: "#fcfcfb",
  nodeFill: "#ffffff",
  dim: 0.18,
};
const MATERIALITY = {
  high: { bg: "#e34948", fg: "#ffffff" },
  medium: { bg: "#eda100", fg: "#0b0b0b" },
  low: { bg: "#e4e3de", fg: "#52514e" },
};

// ---------------------------------------------------------------------------
// Merge every signal's nodes into one tree. Node ids are stable across the
// tree and the signals so click-to-highlight can match them:
//   level-1  ->  `${direction}:${name}`
//   level-2  ->  `${direction}:${parent}:${name}`
// ---------------------------------------------------------------------------
function nodeId(direction, node) {
  return node.level === 1
    ? `${direction}:${node.name}`
    : `${direction}:${node.parent}:${node.name}`;
}

function buildMergedTree(apiData) {
  const sides = { upstream: new Map(), downstream: new Map(), anchor: new Map() };
  for (const signal of apiData.signals) {
    const side = sides[signal.direction] || sides.anchor;
    for (const node of signal.nodes) {
      if (node.level === 1) {
        if (!side.has(node.name)) side.set(node.name, new Set());
      } else {
        if (!side.has(node.parent)) side.set(node.parent, new Set());
        side.get(node.parent).add(node.name);
      }
    }
  }
  const toList = (m) =>
    [...m.entries()].map(([name, kids]) => ({ name, children: [...kids] }));
  return {
    anchor: apiData.anchor_company,
    upstream: toList(sides.upstream),
    downstream: toList(sides.downstream),
    anchorChains: toList(sides.anchor),
  };
}

// ---------------------------------------------------------------------------
// Layout. Width is computed from tier sizes (minimum 680) so every node from
// every signal fits without overlap. Vertical bands, top to bottom:
//   expert band (up) / leaf row (up) / segment row (up) / anchor row
//   / segment row (down) / leaf row (down) / expert band (down)
// Expert cards live only in the outer bands, so they can never collide with
// node boxes.
// ---------------------------------------------------------------------------
const NODE_H = 30;
const EXPERT_BAND_H = 215;
const ROW_GAP = 95;
const Y = {
  leafUp: EXPERT_BAND_H + 55,
  segUp: EXPERT_BAND_H + 55 + ROW_GAP,
  anchor: EXPERT_BAND_H + 55 + ROW_GAP * 2,
  segDown: EXPERT_BAND_H + 55 + ROW_GAP * 3,
  leafDown: EXPERT_BAND_H + 55 + ROW_GAP * 4,
};
const TREE_H = Y.leafDown + 55 + EXPERT_BAND_H;

function nodeWidth(label, maxW = 150) {
  return Math.min(maxW, Math.max(58, label.length * 6.6 + 20));
}
function fitLabel(label, w) {
  const maxChars = Math.floor((w - 14) / 6.6);
  if (label.length <= maxChars) return label;
  return label.slice(0, Math.max(1, maxChars - 1)) + "…";
}

function layoutSide(segments, direction, width, out) {
  const segY = direction === "upstream" ? Y.segUp : Y.segDown;
  const leafY = direction === "upstream" ? Y.leafUp : Y.leafDown;
  const n = segments.length;
  // Caps sit below the center-to-center spacing so neighbors keep a gap.
  const segMaxW = width / (n + 1) - 10;

  // All leaves of a side share one evenly-spaced row (ordered by parent, so
  // edges stay mostly parallel) — this gives each box the most room.
  const leaves = segments.flatMap((seg) =>
    seg.children.map((leaf) => ({ leaf, parent: seg.name })),
  );
  const leafMaxW = width / (leaves.length + 1) - 8;

  segments.forEach((seg, i) => {
    const id = `${direction}:${seg.name}`;
    out.nodes.push({
      id,
      label: seg.name,
      x: (width * (i + 1)) / (n + 1),
      y: segY,
      level: 1,
      direction,
      maxW: segMaxW,
    });
    out.edges.push({ id: `anchor->${id}`, from: "anchor", to: id, direction });
  });
  leaves.forEach(({ leaf, parent }, j) => {
    const id = `${direction}:${parent}:${leaf}`;
    const parentId = `${direction}:${parent}`;
    out.nodes.push({
      id,
      label: leaf,
      x: (width * (j + 1)) / (leaves.length + 1),
      y: leafY,
      level: 2,
      direction,
      parent: parentId,
      maxW: leafMaxW,
    });
    out.edges.push({ id: `${parentId}->${id}`, from: parentId, to: id, direction });
  });
}

// Anchor-direction chains (M&A / strategy / leadership) extend horizontally
// from the anchor on its own row, alternating right and left.
function layoutAnchorChains(chains, width, out) {
  const cx = width / 2;
  chains.forEach((chain, i) => {
    const dir = i % 2 === 0 ? 1 : -1;
    const rank = Math.floor(i / 2);
    const segX = cx + dir * (170 + rank * 330);
    const segId = `anchor:${chain.name}`;
    out.nodes.push({
      id: segId,
      label: chain.name,
      x: segX,
      y: Y.anchor,
      level: 1,
      direction: "anchor",
      maxW: 160,
      horizontal: true,
    });
    out.edges.push({
      id: `anchor->${segId}`,
      from: "anchor",
      to: segId,
      direction: "anchor",
      horizontal: true,
    });
    chain.children.forEach((leaf, j) => {
      const leafId = `anchor:${chain.name}:${leaf}`;
      out.nodes.push({
        id: leafId,
        label: leaf,
        x: segX + dir * (175 + j * 165),
        y: Y.anchor,
        level: 2,
        direction: "anchor",
        parent: segId,
        maxW: 150,
        horizontal: true,
      });
      out.edges.push({
        id: `${segId}->${leafId}`,
        from: segId,
        to: leafId,
        direction: "anchor",
        horizontal: true,
      });
    });
  });
}

function computeLayout(tree) {
  const maxTier = Math.max(
    tree.upstream.length,
    tree.downstream.length,
    tree.upstream.reduce((a, s) => a + s.children.length, 0),
    tree.downstream.reduce((a, s) => a + s.children.length, 0),
  );
  const width = Math.max(680, Math.min(1250, maxTier * 128));
  const out = { nodes: [], edges: [], width };
  out.nodes.push({
    id: "anchor",
    label: tree.anchor,
    x: width / 2,
    y: Y.anchor,
    level: 0,
    direction: "anchor",
    maxW: 160,
  });
  layoutSide(tree.upstream, "upstream", width, out);
  layoutSide(tree.downstream, "downstream", width, out);
  layoutAnchorChains(tree.anchorChains, width, out);
  return out;
}

function edgePath(from, to, horizontal) {
  if (horizontal) {
    const fw = nodeWidth(from.label, from.maxW);
    const tw = nodeWidth(to.label, to.maxW);
    const x1 = to.x > from.x ? from.x + fw / 2 : from.x - fw / 2;
    const x2 = to.x > from.x ? to.x - tw / 2 : to.x + tw / 2;
    return `M ${x1} ${from.y} L ${x2} ${to.y}`;
  }
  const y1 = to.y > from.y ? from.y + NODE_H / 2 : from.y - NODE_H / 2;
  const y2 = to.y > from.y ? to.y - NODE_H / 2 : to.y + NODE_H / 2;
  const midY = (y1 + y2) / 2;
  return `M ${from.x} ${y1} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${y2}`;
}

// ---------------------------------------------------------------------------
// Tree rendering with highlight / dim states
// ---------------------------------------------------------------------------
function TreeNode({ node, state }) {
  const w = nodeWidth(node.label, node.maxW);
  const isAnchor = node.level === 0;
  const accent = COLORS[node.direction];
  const highlighted = state === "highlight";
  const fill = isAnchor
    ? COLORS.anchor
    : highlighted
      ? accent
      : COLORS.nodeFill;
  const textFill = isAnchor || highlighted ? "#ffffff" : COLORS.ink;
  return (
    <g opacity={state === "dim" ? COLORS.dim : 1}>
      <rect
        x={node.x - w / 2}
        y={node.y - NODE_H / 2}
        width={w}
        height={NODE_H}
        rx={6}
        fill={fill}
        stroke={accent}
        strokeWidth={highlighted ? 3 : node.level === 1 ? 2 : 1.25}
      />
      <text
        x={node.x}
        y={node.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={node.level === 2 ? 10.5 : 11.5}
        fontWeight={node.level < 2 || highlighted ? 600 : 400}
        fill={textFill}
      >
        {fitLabel(node.label, w)}
        <title>{node.label}</title>
      </text>
    </g>
  );
}

// A single Mosaic keyword chip. Click copies the term to the clipboard —
// this is what the manager pastes into Mosaic's free-text search.
function MosaicChip({ term }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(term);
    } catch {
      // Fallback for non-secure contexts
      const ta = document.createElement("textarea");
      ta.value = term;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1100);
  };
  return (
    <button
      onClick={copy}
      title={copied ? "Copied!" : `Copy "${term}"`}
      style={{
        fontFamily: "inherit",
        fontSize: 8.5,
        lineHeight: 1.5,
        padding: "0 5px",
        margin: 0,
        borderRadius: 999,
        border: `1px solid ${copied ? "#008300" : "#c9c8c2"}`,
        background: copied ? "#e2f2e2" : "#f4f3ef",
        color: copied ? "#008300" : COLORS.ink,
        cursor: "pointer",
        whiteSpace: "nowrap",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {copied ? "✓ copied" : term}
    </button>
  );
}

// One expert feature card, rendered inside the outer band via foreignObject.
// Every Mosaic keyword is a click-to-copy chip; long sets scroll in place.
function ExpertCard({ expert, x, y, w }) {
  const f = expert.mosaic_filters;
  const rows = [
    ["Company", f.company],
    ["Title", f.title],
    ["Industry", f.industry],
    ["Function", f.job_function],
    ["Region", f.region],
  ];
  return (
    <foreignObject x={x - w / 2} y={y} width={w} height={EXPERT_BAND_H - 14}>
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        style={{
          border: "1.5px solid #d8d7d2",
          borderRadius: 8,
          background: "#ffffff",
          padding: "6px 8px",
          height: "100%",
          boxSizing: "border-box",
          overflowY: "auto",
          fontSize: 9.5,
          lineHeight: 1.35,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        }}
      >
        <div
          style={{
            fontWeight: 700,
            fontSize: 10.5,
            color: COLORS.ink,
            marginBottom: 4,
          }}
          title={expert.role_hint}
        >
          {expert.role_hint}
        </div>
        {rows.map(([label, terms]) => (
          <div key={label} style={{ marginBottom: 3 }}>
            <span
              style={{
                fontWeight: 600,
                fontSize: 8.5,
                color: COLORS.inkSoft,
                textTransform: "uppercase",
                marginRight: 4,
              }}
            >
              {label}
            </span>
            <span
              style={{
                display: "inline-flex",
                flexWrap: "wrap",
                gap: 3,
                verticalAlign: "middle",
              }}
            >
              {(terms || []).map((t) => (
                <MosaicChip key={t} term={t} />
              ))}
            </span>
          </div>
        ))}
      </div>
    </foreignObject>
  );
}

export function ValueChainTree({ tree, selectedSignal }) {
  const { nodes, edges, width } = useMemo(() => computeLayout(tree), [tree]);
  const byId = useMemo(
    () => Object.fromEntries(nodes.map((n) => [n.id, n])),
    [nodes],
  );

  // Ids belonging to the selected signal + its experts, keyed to band + node.
  const { highlightIds, experts } = useMemo(() => {
    if (!selectedSignal) return { highlightIds: null, experts: [] };
    const ids = new Set(["anchor"]);
    const ex = [];
    for (const node of selectedSignal.nodes) {
      const id = nodeId(selectedSignal.direction, node);
      ids.add(id);
      for (const e of node.experts || []) ex.push({ ...e, nodeId: id });
    }
    return { highlightIds: ids, experts: ex };
  }, [selectedSignal]);

  const nodeState = (n) =>
    !highlightIds ? "base" : highlightIds.has(n.id) ? "highlight" : "dim";
  const edgeState = (e) =>
    !highlightIds ? "base" : highlightIds.has(e.to) ? "highlight" : "dim";

  // Experts go to the band on the signal's own side of the chain (anchor
  // signals use the upper band). Evenly spaced across the width.
  const band = selectedSignal?.direction === "downstream" ? "down" : "up";
  const bandY = band === "down" ? TREE_H - EXPERT_BAND_H : 6;
  const cardW = Math.min(220, width / Math.max(experts.length, 1) - 10);
  const cardX = (i) => (width * (i + 1)) / (experts.length + 1);
  const connectorY = band === "down" ? bandY : EXPERT_BAND_H - 6;

  return (
    <svg
      width={width}
      height={TREE_H}
      viewBox={`0 0 ${width} ${TREE_H}`}
      role="img"
      aria-label={`Value chain tree for ${tree.anchor}`}
      style={{ background: COLORS.surface, borderRadius: 8, flexShrink: 0 }}
    >
      <text x={12} y={EXPERT_BAND_H + 16} fontSize={10.5} fill={COLORS.inkSoft} fontWeight={600}>
        UPSTREAM — suppliers / equipment / materials
      </text>
      <text x={12} y={TREE_H - EXPERT_BAND_H - 8} fontSize={10.5} fill={COLORS.inkSoft} fontWeight={600}>
        DOWNSTREAM — customers / channel
      </text>

      {edges.map((e) => {
        const st = edgeState(e);
        return (
          <path
            key={e.id}
            d={edgePath(byId[e.from], byId[e.to], e.horizontal)}
            fill="none"
            stroke={COLORS[e.direction]}
            strokeWidth={st === "highlight" ? 3 : 1.5}
            opacity={st === "dim" ? COLORS.dim : st === "highlight" ? 0.9 : 0.55}
          />
        );
      })}
      {nodes.map((n) => (
        <TreeNode key={n.id} node={n} state={nodeState(n)} />
      ))}

      {/* Expert connectors: dashed line from card edge to its tree node */}
      {experts.map((e, i) => {
        const target = byId[e.nodeId];
        if (!target) return null;
        const ty =
          band === "down" ? target.y + NODE_H / 2 : target.y - NODE_H / 2;
        return (
          <path
            key={`conn-${i}`}
            d={`M ${cardX(i)} ${connectorY} C ${cardX(i)} ${(connectorY + ty) / 2}, ${target.x} ${(connectorY + ty) / 2}, ${target.x} ${ty}`}
            fill="none"
            stroke={COLORS.inkSoft}
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.6}
          />
        );
      })}
      {experts.map((e, i) => (
        <ExpertCard key={`card-${i}`} expert={e} x={cardX(i)} y={bandY} w={cardW} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Left panel — clickable signal cards
// ---------------------------------------------------------------------------
function SignalCard({ signal, selected, onClick }) {
  const badge = MATERIALITY[signal.materiality] || MATERIALITY.low;
  const accent = COLORS[signal.direction] || COLORS.anchor;
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected ? "#eef4fc" : "#ffffff",
        border: `1.5px solid ${selected ? accent : "#d8d7d2"}`,
        borderLeft: `5px solid ${accent}`,
        borderRadius: 8,
        padding: "8px 10px",
        marginBottom: 8,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 11.5, color: COLORS.ink, lineHeight: 1.4 }}>
        {signal.signal}
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginTop: 6,
          fontSize: 10,
          color: COLORS.inkSoft,
        }}
      >
        <span>{signal.date}</span>
        <span
          style={{
            background: badge.bg,
            color: badge.fg,
            borderRadius: 999,
            padding: "1px 8px",
            fontWeight: 700,
            textTransform: "uppercase",
            fontSize: 9,
          }}
        >
          {signal.materiality}
        </span>
        <span style={{ textTransform: "capitalize" }}>{signal.direction}</span>
      </div>
    </button>
  );
}

export default function ValueChainExplorer() {
  const [selectedId, setSelectedId] = useState(null);
  const tree = useMemo(() => buildMergedTree(data), []);
  const selectedSignal =
    data.signals.find((s) => s.id === selectedId) || null;

  return (
    <div
      style={{
        fontFamily:
          "'Helvetica Neue', Arial, system-ui, -apple-system, sans-serif",
        color: COLORS.ink,
        padding: "16px 20px",
      }}
    >
      <h1 style={{ fontSize: 18, margin: "0 0 2px" }}>Value Chain Explorer</h1>
      <p style={{ fontSize: 12, color: COLORS.inkSoft, margin: "0 0 12px" }}>
        GLG Client Solutions — BD prep (internal). Click a signal to highlight
        its branch and show the expert profiles for it.
      </p>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ width: 300, flexShrink: 0 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: COLORS.inkSoft,
              margin: "0 0 8px",
              textTransform: "uppercase",
            }}
          >
            Signals — {data.anchor_company}
          </div>
          <div style={{ maxHeight: TREE_H, overflowY: "auto", paddingRight: 4 }}>
            {data.signals.map((s) => (
              <SignalCard
                key={s.id}
                signal={s}
                selected={s.id === selectedId}
                onClick={() =>
                  setSelectedId((cur) => (cur === s.id ? null : s.id))
                }
              />
            ))}
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <ValueChainTree tree={tree} selectedSignal={selectedSignal} />
        </div>
      </div>
    </div>
  );
}
