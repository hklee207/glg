import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import initialData from "./data/skhynix.json";

const FONT = "'Helvetica Neue', Arial, system-ui, -apple-system, sans-serif";

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

const QUICK_START = [
  { label: "SK Hynix (sample)", type: "sample" },
  { label: "Samsung Electronics", type: "search" },
  { label: "TSMC", type: "search" },
];

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
// node boxes. The whole thing is rendered at native size and scaled/panned
// by PanZoomViewport, so it behaves like a zoomable canvas.
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
function shortHeadline(text, max = 92) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return cut.slice(0, lastSpace > 40 ? lastSpace : max) + "…";
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
// Pan / zoom viewport. Wraps the SVG in a plain div and scales/translates it
// with a CSS transform, so the tree behaves like a full-page canvas: wheel
// to zoom (centered on the cursor), drag to pan, buttons for +/-/fit.
// ---------------------------------------------------------------------------
function PanZoomViewport({ contentWidth, contentHeight, children }) {
  const outerRef = useRef(null);
  const dragRef = useRef(null);
  const [t, setT] = useState({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);

  const fit = useCallback(() => {
    const el = outerRef.current;
    if (!el) return;
    const cw = el.clientWidth || 800;
    const ch = el.clientHeight || 600;
    const scale = Math.max(
      0.15,
      Math.min(1.4, Math.min((cw - 48) / contentWidth, (ch - 48) / contentHeight)),
    );
    setT({
      x: (cw - contentWidth * scale) / 2,
      y: (ch - contentHeight * scale) / 2,
      scale,
    });
  }, [contentWidth, contentHeight]);

  useEffect(() => {
    fit();
  }, [fit]);

  // ResizeObserver (not just window resize) so the view re-fits whenever the
  // container itself changes size for any reason — window resize, sidebar
  // toggling, a sibling banner appearing/disappearing above it, etc.
  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Non-passive native listener so preventDefault reliably stops page scroll.
  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setT((prev) => {
        const factor = Math.exp(-e.deltaY * 0.0016);
        const scale = Math.max(0.1, Math.min(4, prev.scale * factor));
        const wx = (cx - prev.x) / prev.scale;
        const wy = (cy - prev.y) / prev.scale;
        return { scale, x: cx - wx * scale, y: cy - wy * scale };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor) => {
    const el = outerRef.current;
    const cw = el ? el.clientWidth : 800;
    const ch = el ? el.clientHeight : 600;
    setT((prev) => {
      const scale = Math.max(0.1, Math.min(4, prev.scale * factor));
      const cx = cw / 2;
      const cy = ch / 2;
      const wx = (cx - prev.x) / prev.scale;
      const wy = (cy - prev.y) / prev.scale;
      return { scale, x: cx - wx * scale, y: cy - wy * scale };
    });
  };

  // Pointer capture is deferred until real movement is detected. Capturing
  // eagerly on every pointerdown hijacks the browser's click synthesis, so a
  // plain click on a node (no movement) would never reach its onClick.
  const DRAG_THRESHOLD = 4;
  const onPointerDown = (e) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: t.x,
      origY: t.y,
      captured: false,
      pointerId: e.pointerId,
    };
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.captured) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      d.captured = true;
      e.currentTarget.setPointerCapture(d.pointerId);
      setDragging(true);
    }
    setT((prev) => ({ ...prev, x: d.origX + dx, y: d.origY + dy }));
  };
  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const btnStyle = {
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "1px solid #dcdbd5",
    background: "#ffffff",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    color: COLORS.ink,
    lineHeight: 1,
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
  };

  return (
    <div
      ref={outerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: COLORS.surface,
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`,
          transformOrigin: "0 0",
        }}
      >
        {children}
      </div>

      <div
        style={{
          position: "absolute",
          right: 14,
          bottom: 14,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <button onClick={() => zoomBy(1.25)} style={btnStyle} title="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(0.8)} style={btnStyle} title="Zoom out">
          −
        </button>
        <button onClick={fit} style={{ ...btnStyle, fontSize: 9.5 }} title="Fit to screen">
          fit
        </button>
      </div>
      <div
        style={{
          position: "absolute",
          left: 14,
          bottom: 14,
          fontSize: 10,
          color: COLORS.inkSoft,
          background: "#ffffffcc",
          padding: "3px 9px",
          borderRadius: 999,
        }}
      >
        {Math.round(t.scale * 100)}% — scroll to zoom, drag to pan
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree rendering with highlight / dim states
// ---------------------------------------------------------------------------
function TreeNode({ node, state, onSelect }) {
  const w = nodeWidth(node.label, node.maxW);
  const isAnchor = node.level === 0;
  const accent = COLORS[node.direction];
  const highlighted = state === "highlight";
  const fill = isAnchor ? COLORS.anchor : highlighted ? accent : COLORS.nodeFill;
  const textFill = isAnchor || highlighted ? "#ffffff" : COLORS.ink;
  return (
    <g
      opacity={state === "dim" ? COLORS.dim : 1}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.id);
      }}
      style={{ cursor: "pointer" }}
    >
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
        <title>{node.label} (click for full name)</title>
      </text>
    </g>
  );
}

// Floating label shown when a node is clicked — reveals the full,
// untruncated name. Placed on the side toward the anchor row so it never
// collides with an open expert band, which always sits on the outer edge.
function NodeLabelBubble({ node }) {
  const toward = node.direction === "downstream" ? -1 : 1; // downstream: up; else: down
  const w = 260;
  const h = 64;
  const y = toward > 0 ? node.y + NODE_H / 2 + 8 : node.y - NODE_H / 2 - 8 - h;
  return (
    <foreignObject x={node.x - w / 2} y={y} width={w} height={h} style={{ pointerEvents: "none" }}>
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        style={{
          background: "#0b0b0b",
          color: "#ffffff",
          borderRadius: 8,
          padding: "7px 11px",
          fontSize: 11.5,
          lineHeight: 1.4,
          textAlign: "center",
          wordBreak: "break-word",
          boxShadow: "0 6px 18px rgba(0,0,0,0.28)",
        }}
      >
        {node.label}
      </div>
    </foreignObject>
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

// One column per involved node (not per expert): every expert tied to that
// node is stacked inside the same card, and the card sits directly above or
// below the node's own x position. That makes the connector a straight
// vertical line — no more crossing diagonals.
function ExpertColumn({ group, x, y, width }) {
  const rowsFor = (expert) => [
    ["Company", expert.mosaic_filters.company],
    ["Title", expert.mosaic_filters.title],
    ["Industry", expert.mosaic_filters.industry],
    ["Function", expert.mosaic_filters.job_function],
    ["Region", expert.mosaic_filters.region],
  ];
  return (
    <foreignObject x={x - width / 2} y={y} width={width} height={EXPERT_BAND_H - 14}>
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
            fontSize: 9,
            color: COLORS.inkSoft,
            textTransform: "uppercase",
            marginBottom: 5,
            paddingBottom: 4,
            borderBottom: "1px solid #eee",
          }}
        >
          {group.node.label}
        </div>
        {group.experts.map((expert, i) => (
          <div
            key={i}
            style={{
              marginBottom: i < group.experts.length - 1 ? 8 : 0,
              paddingBottom: i < group.experts.length - 1 ? 8 : 0,
              borderBottom: i < group.experts.length - 1 ? "1px dashed #eee" : "none",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 10.5, color: COLORS.ink, marginBottom: 4 }}>
              {expert.role_hint}
            </div>
            {rowsFor(expert).map(([label, terms]) => (
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
                <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 3, verticalAlign: "middle" }}>
                  {(terms || []).map((t) => (
                    <MosaicChip key={t} term={t} />
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </foreignObject>
  );
}

export function ValueChainTree({ tree, selectedSignal }) {
  const { nodes, edges, width } = useMemo(() => computeLayout(tree), [tree]);
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);
  const [expandedNodeId, setExpandedNodeId] = useState(null);

  useEffect(() => {
    setExpandedNodeId(null);
  }, [tree]);

  // Experts grouped by the node they belong to (not flattened per-expert),
  // sorted left-to-right by node x so columns never have to cross.
  const { highlightIds, grouped } = useMemo(() => {
    if (!selectedSignal) return { highlightIds: null, grouped: [] };
    const ids = new Set(["anchor"]);
    const map = new Map();
    for (const node of selectedSignal.nodes) {
      const id = nodeId(selectedSignal.direction, node);
      ids.add(id);
      const target = byId[id];
      if (!target) continue;
      if (!map.has(id)) map.set(id, { node: target, experts: [] });
      for (const e of node.experts || []) map.get(id).experts.push(e);
    }
    return { highlightIds: ids, grouped: [...map.values()].sort((a, b) => a.node.x - b.node.x) };
  }, [selectedSignal, byId]);

  const nodeState = (n) => (!highlightIds ? "base" : highlightIds.has(n.id) ? "highlight" : "dim");
  const edgeState = (e) => (!highlightIds ? "base" : highlightIds.has(e.to) ? "highlight" : "dim");

  const band = selectedSignal?.direction === "downstream" ? "down" : "up";
  const bandY = band === "down" ? TREE_H - EXPERT_BAND_H : 6;
  const connectorY = band === "down" ? bandY : EXPERT_BAND_H - 6;

  // Column width capped below the gap to its nearest involved neighbor, so
  // adjacent cards never overlap even when their nodes sit close together.
  const columns = useMemo(
    () =>
      grouped.map((g, i) => {
        const leftGap = i > 0 ? g.node.x - grouped[i - 1].node.x : Infinity;
        const rightGap = i < grouped.length - 1 ? grouped[i + 1].node.x - g.node.x : Infinity;
        const gap = Math.min(leftGap, rightGap);
        const w = Number.isFinite(gap) ? Math.max(120, Math.min(230, gap - 16)) : 240;
        return { ...g, width: w };
      }),
    [grouped],
  );

  const expandedNode = expandedNodeId ? byId[expandedNodeId] : null;

  return (
    <PanZoomViewport contentWidth={width} contentHeight={TREE_H}>
      <svg
        width={width}
        height={TREE_H}
        role="img"
        aria-label={`Value chain tree for ${tree.anchor}`}
        style={{ display: "block" }}
      >
        <rect
          x={0}
          y={0}
          width={width}
          height={TREE_H}
          fill={COLORS.surface}
          onClick={() => setExpandedNodeId(null)}
        />
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
          <TreeNode
            key={n.id}
            node={n}
            state={nodeState(n)}
            onSelect={(id) => setExpandedNodeId((cur) => (cur === id ? null : id))}
          />
        ))}

        {/* Straight connector: card column sits directly above/below its node */}
        {columns.map((col) => {
          const ty = band === "down" ? col.node.y + NODE_H / 2 : col.node.y - NODE_H / 2;
          return (
            <line
              key={`conn-${col.node.id}`}
              x1={col.node.x}
              y1={connectorY}
              x2={col.node.x}
              y2={ty}
              stroke={COLORS.inkSoft}
              strokeWidth={1.25}
              strokeDasharray="3 3"
              opacity={0.6}
            />
          );
        })}
        {columns.map((col) => (
          <ExpertColumn key={`col-${col.node.id}`} group={col} x={col.node.x} y={bandY} width={col.width} />
        ))}

        {expandedNode && <NodeLabelBubble node={expandedNode} />}
      </svg>
    </PanZoomViewport>
  );
}

// ---------------------------------------------------------------------------
// Left panel — compact, clickable signal cards
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
        border: `1.5px solid ${selected ? accent : "#e2e1db"}`,
        borderLeft: `4px solid ${accent}`,
        borderRadius: 8,
        padding: "8px 10px",
        marginBottom: 6,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 11.5, color: COLORS.ink, lineHeight: 1.4, fontWeight: selected ? 600 : 400 }}>
        {shortHeadline(signal.signal)}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 5, fontSize: 9.5, color: COLORS.inkSoft }}>
        <span>{signal.date}</span>
        <span
          style={{
            background: badge.bg,
            color: badge.fg,
            borderRadius: 999,
            padding: "1px 7px",
            fontWeight: 700,
            textTransform: "uppercase",
            fontSize: 8.5,
          }}
        >
          {signal.materiality}
        </span>
        <span style={{ textTransform: "capitalize" }}>{signal.direction}</span>
      </div>
    </button>
  );
}

// Full text for the selected signal. Rendered in normal document flow above
// the tree (not overlaid on it), so it can never cover the expert-card band
// regardless of whether that band is on the top or bottom of the canvas.
function SignalDetailPanel({ signal, onClose }) {
  if (!signal) return null;
  const badge = MATERIALITY[signal.materiality] || MATERIALITY.low;
  return (
    <div
      style={{
        flexShrink: 0,
        background: "#fbfbfa",
        borderBottom: "1px solid #e6e5e0",
        padding: "10px 16px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: COLORS.ink }}>{signal.signal}</div>
        <button
          onClick={onClose}
          title="Close"
          style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 15, color: COLORS.inkSoft, flexShrink: 0 }}
        >
          ✕
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, fontSize: 10, color: COLORS.inkSoft, flexWrap: "wrap" }}>
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
        {signal.source && (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Source: {signal.source}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Landing / search screen — the entry point before any company is generated
// ---------------------------------------------------------------------------
function LandingScreen({ company, setCompany, onSearch, loading, error, onQuickStart }) {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
        fontFamily: FONT,
        color: COLORS.ink,
        background: COLORS.surface,
      }}
    >
      <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: -0.5, marginBottom: 10 }}>
        Value Chain Explorer
      </div>
      <div
        style={{
          fontSize: 13.5,
          color: COLORS.inkSoft,
          maxWidth: 560,
          textAlign: "center",
          marginBottom: 26,
          lineHeight: 1.55,
        }}
      >
        A GLG Client Solutions BD-prep tool. Type any company and it searches recent
        news, maps its upstream and downstream value chain, and matches each signal
        to the GLG experts worth calling — with ready-to-paste Mosaic keywords.
      </div>

      <div style={{ width: "100%", maxWidth: 620 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "#ffffff",
            border: "1.5px solid #dcdbd5",
            borderRadius: 999,
            padding: "12px 20px",
            boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
          }}
        >
          <span style={{ fontSize: 15, opacity: 0.6 }}>🔍</span>
          <input
            autoFocus
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
            placeholder="Search a company, e.g. SK Hynix"
            disabled={loading}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              fontSize: 14.5,
              fontFamily: "inherit",
              background: "transparent",
              color: COLORS.ink,
            }}
          />
          <button
            onClick={onSearch}
            disabled={loading || !company.trim()}
            style={{
              border: "none",
              borderRadius: 999,
              padding: "8px 18px",
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: "inherit",
              background: loading ? "#c9c8c2" : COLORS.upstream,
              color: "#ffffff",
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "…" : "Generate"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 14, flexWrap: "wrap" }}>
          {QUICK_START.map((q) => (
            <button
              key={q.label}
              onClick={() => onQuickStart(q)}
              disabled={loading}
              style={{
                fontSize: 11.5,
                padding: "5px 12px",
                borderRadius: 999,
                border: "1px solid #dcdbd5",
                background: "#ffffff",
                color: COLORS.inkSoft,
                cursor: loading ? "default" : "pointer",
                fontFamily: "inherit",
              }}
            >
              {q.label}
            </button>
          ))}
        </div>

        {loading && (
          <div style={{ marginTop: 18, textAlign: "center", fontSize: 12.5, color: COLORS.inkSoft }}>
            Searching recent news and building the value chain — this usually takes 1–3 minutes…
          </div>
        )}
        {error && (
          <div
            style={{
              marginTop: 18,
              textAlign: "center",
              fontSize: 12.5,
              color: "#a12b2a",
              background: "#fbeaea",
              border: "1px solid #e34948",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            Generate failed: {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explorer screen — signals sidebar + full-page zoomable tree
// ---------------------------------------------------------------------------
function ExplorerScreen({
  data,
  tree,
  company,
  setCompany,
  onGenerate,
  loading,
  error,
  selectedId,
  setSelectedId,
  selectedSignal,
  onHome,
}) {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: FONT, color: COLORS.ink }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "10px 16px",
          borderBottom: "1px solid #e6e5e0",
          flexShrink: 0,
        }}
      >
        <button
          onClick={onHome}
          title="Back to search"
          style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 15, fontWeight: 700, color: COLORS.ink, fontFamily: "inherit" }}
        >
          ← Value Chain Explorer
        </button>
        <span style={{ fontSize: 11, color: COLORS.inkSoft }}>GLG Client Solutions — BD prep</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onGenerate()}
            placeholder="New search…"
            disabled={loading}
            style={{ fontSize: 12, padding: "6px 10px", border: "1.5px solid #dcdbd5", borderRadius: 7, width: 200, fontFamily: "inherit" }}
          />
          <button
            onClick={onGenerate}
            disabled={loading || !company.trim()}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 14px",
              border: "none",
              borderRadius: 7,
              background: loading ? "#c9c8c2" : COLORS.upstream,
              color: "#ffffff",
              cursor: loading ? "default" : "pointer",
              fontFamily: "inherit",
            }}
          >
            {loading ? "…" : "Generate"}
          </button>
        </div>
      </div>

      {(loading || error) && (
        <div
          style={{
            padding: "6px 16px",
            fontSize: 11.5,
            color: error ? "#a12b2a" : COLORS.inkSoft,
            background: error ? "#fbeaea" : "#eef4fc",
            borderBottom: "1px solid #e6e5e0",
            flexShrink: 0,
          }}
        >
          {error
            ? `Generate failed: ${error}`
            : "Searching recent news and building the value chain — this usually takes 1–3 minutes…"}
        </div>
      )}

      <SignalDetailPanel signal={selectedSignal} onClose={() => setSelectedId(null)} />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ width: 290, flexShrink: 0, borderRight: "1px solid #e6e5e0", padding: 12, overflowY: "auto" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.inkSoft, marginBottom: 8, textTransform: "uppercase" }}>
            Signals — {data.anchor_company} ({data.signals.length})
          </div>
          {data.signals.map((s) => (
            <SignalCard
              key={s.id}
              signal={s}
              selected={s.id === selectedId}
              onClick={() => setSelectedId((cur) => (cur === s.id ? null : s.id))}
            />
          ))}
        </div>
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <ValueChainTree tree={tree} selectedSignal={selectedSignal} />
        </div>
      </div>
    </div>
  );
}

export default function ValueChainExplorer() {
  const [mode, setMode] = useState("landing"); // "landing" | "explorer"
  const [selectedId, setSelectedId] = useState(null);
  const [data, setData] = useState(initialData);
  const [company, setCompany] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const tree = useMemo(() => buildMergedTree(data), [data]);
  const selectedSignal = data.signals.find((s) => s.id === selectedId) || null;

  // Generation takes 1-3 minutes, longer than most proxy/tunnel timeouts
  // allow a single request to live — so the backend runs it as a job and we
  // poll for the result with short requests.
  async function generate(nameOverride) {
    const name = (nameOverride ?? company).trim();
    if (!name || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/value-chain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: name }),
      });
      const started = await res.json();
      if (!res.ok) throw new Error(started.error || `HTTP ${res.status}`);
      if (!started.job_id) throw new Error("Malformed response");

      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const poll = await fetch(`/api/value-chain/job/${started.job_id}`);
        const job = await poll.json();
        if (!poll.ok) throw new Error(job.error || `HTTP ${poll.status}`);
        if (job.status === "error") throw new Error(job.error);
        if (job.status === "done") {
          if (!Array.isArray(job.result?.signals)) throw new Error("Malformed response");
          setSelectedId(null);
          setData(job.result);
          setMode("explorer");
          return;
        }
      }
      throw new Error("Timed out after 10 minutes");
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setLoading(false);
    }
  }

  function loadSample() {
    setSelectedId(null);
    setData(initialData);
    setCompany(initialData.anchor_company);
    setMode("explorer");
  }

  function quickStart(q) {
    if (q.type === "sample") {
      loadSample();
      return;
    }
    setCompany(q.label);
    generate(q.label);
  }

  return (
    <>
      <style>{`html, body, #root { margin: 0; height: 100%; } body { overflow: hidden; }`}</style>
      {mode === "landing" ? (
        <LandingScreen
          company={company}
          setCompany={setCompany}
          onSearch={() => generate()}
          loading={loading}
          error={error}
          onQuickStart={quickStart}
        />
      ) : (
        <ExplorerScreen
          data={data}
          tree={tree}
          company={company}
          setCompany={setCompany}
          onGenerate={() => generate()}
          loading={loading}
          error={error}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedSignal={selectedSignal}
          onHome={() => setMode("landing")}
        />
      )}
    </>
  );
}
