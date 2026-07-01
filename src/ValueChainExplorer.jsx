import React from "react";

// ---------------------------------------------------------------------------
// Static placeholder data (RUN 2). Replaced by live API JSON in a later run.
// Shape mirrors what the backend derives from signals[].nodes.
// ---------------------------------------------------------------------------
const STATIC_TREE = {
  anchor: "SK Hynix",
  upstream: [
    {
      name: "Equipment",
      children: ["ASML", "Applied Materials", "Tokyo Electron"],
    },
    { name: "Materials", children: ["SUMCO", "Shin-Etsu"] },
  ],
  downstream: [
    { name: "AI Accelerators", children: ["Nvidia", "AMD"] },
    { name: "Hyperscalers", children: ["Microsoft", "Google", "Amazon"] },
  ],
};

// ---------------------------------------------------------------------------
// Layout — all positions computed from array lengths, never hardcoded.
// Tiers cap at the first 4 nodes so the tree can never overflow TREE_W.
// ---------------------------------------------------------------------------
const TREE_W = 680;
const TREE_H = 560;
const NODE_H = 30;
const SEG_GAP = 105; // anchor row -> segment row
const LEAF_GAP = 195; // anchor row -> leaf row
const MAX_PER_TIER = 4;

function nodeWidth(label, maxW = 150) {
  return Math.min(maxW, Math.max(68, label.length * 7.2 + 22));
}

// Trim a label with an ellipsis when its box is narrower than the full text.
function fitLabel(label, w) {
  const maxChars = Math.floor((w - 18) / 7.2);
  if (label.length <= maxChars) return label;
  return label.slice(0, Math.max(1, maxChars - 1)) + "…";
}

// Flattens one side (upstream or downstream) into positioned nodes + edges.
function layoutSide(segments, direction, anchorY) {
  const sign = direction === "upstream" ? -1 : 1;
  const segs = segments.slice(0, MAX_PER_TIER);
  const n = segs.length;
  const nodes = [];
  const edges = [];

  segs.forEach((seg, i) => {
    const segX = (TREE_W * (i + 1)) / (n + 1);
    const segY = anchorY + sign * SEG_GAP;
    const segId = `${direction}:${seg.name}`;
    nodes.push({
      id: segId,
      label: seg.name,
      x: segX,
      y: segY,
      level: 1,
      direction,
    });
    edges.push({ id: `anchor->${segId}`, from: "anchor", to: segId, direction });

    // Leaves sit inside their parent's horizontal slot, so siblings from
    // different segments can never collide or push past the SVG edge.
    const slotW = TREE_W / n;
    const slotX0 = slotW * i;
    const leaves = seg.children.slice(0, MAX_PER_TIER);
    // Cap each leaf's box below the center-to-center spacing so siblings
    // always keep a visible gap.
    const leafMaxW = slotW / (leaves.length + 1) - 8;
    leaves.forEach((leaf, j) => {
      const leafX = slotX0 + (slotW * (j + 1)) / (leaves.length + 1);
      const leafY = anchorY + sign * LEAF_GAP;
      const leafId = `${direction}:${seg.name}:${leaf}`;
      nodes.push({
        id: leafId,
        label: leaf,
        x: leafX,
        y: leafY,
        level: 2,
        direction,
        parent: segId,
        maxW: leafMaxW,
      });
      edges.push({ id: `${segId}->${leafId}`, from: segId, to: leafId, direction });
    });
  });

  return { nodes, edges };
}

function computeLayout(tree) {
  const anchorY = TREE_H / 2;
  const anchor = {
    id: "anchor",
    label: tree.anchor,
    x: TREE_W / 2,
    y: anchorY,
    level: 0,
    direction: "anchor",
  };
  const up = layoutSide(tree.upstream, "upstream", anchorY);
  const down = layoutSide(tree.downstream, "downstream", anchorY);
  return {
    nodes: [anchor, ...up.nodes, ...down.nodes],
    edges: [...up.edges, ...down.edges],
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const COLORS = {
  upstream: "#2a78d6",
  downstream: "#1baf7a",
  anchor: "#0b0b0b",
  ink: "#0b0b0b",
  inkSoft: "#52514e",
  surface: "#fcfcfb",
  nodeFill: "#ffffff",
};

function edgePath(from, to) {
  // Vertical cubic curve between node edges (not centers).
  const fromEdgeY = to.y > from.y ? from.y + NODE_H / 2 : from.y - NODE_H / 2;
  const toEdgeY = to.y > from.y ? to.y - NODE_H / 2 : to.y + NODE_H / 2;
  const midY = (fromEdgeY + toEdgeY) / 2;
  return `M ${from.x} ${fromEdgeY} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${toEdgeY}`;
}

function TreeNode({ node }) {
  const w = nodeWidth(node.label, node.maxW);
  const isAnchor = node.level === 0;
  const accent = COLORS[node.direction];
  return (
    <g>
      <rect
        x={node.x - w / 2}
        y={node.y - NODE_H / 2}
        width={w}
        height={NODE_H}
        rx={6}
        fill={isAnchor ? COLORS.anchor : COLORS.nodeFill}
        stroke={accent}
        strokeWidth={isAnchor ? 0 : node.level === 1 ? 2 : 1.25}
      />
      <text
        x={node.x}
        y={node.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={node.level === 2 ? 11.5 : 12.5}
        fontWeight={node.level < 2 ? 600 : 400}
        fill={isAnchor ? "#ffffff" : COLORS.ink}
      >
        {fitLabel(node.label, w)}
        <title>{node.label}</title>
      </text>
    </g>
  );
}

export function ValueChainTree({ tree }) {
  const { nodes, edges } = computeLayout(tree);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  return (
    <svg
      width={TREE_W}
      height={TREE_H}
      viewBox={`0 0 ${TREE_W} ${TREE_H}`}
      role="img"
      aria-label={`Value chain tree for ${tree.anchor}`}
      style={{ background: COLORS.surface, borderRadius: 8 }}
    >
      {/* Tier captions */}
      <text x={12} y={20} fontSize={11} fill={COLORS.inkSoft} fontWeight={600}>
        UPSTREAM — suppliers / equipment / materials
      </text>
      <text
        x={12}
        y={TREE_H - 10}
        fontSize={11}
        fill={COLORS.inkSoft}
        fontWeight={600}
      >
        DOWNSTREAM — customers / channel
      </text>

      {/* Edges under nodes */}
      {edges.map((e) => (
        <path
          key={e.id}
          d={edgePath(byId[e.from], byId[e.to])}
          fill="none"
          stroke={COLORS[e.direction]}
          strokeWidth={1.5}
          opacity={0.55}
        />
      ))}
      {nodes.map((n) => (
        <TreeNode key={n.id} node={n} />
      ))}
    </svg>
  );
}

export default function ValueChainExplorer() {
  return (
    <div
      style={{
        fontFamily:
          "'Helvetica Neue', Arial, system-ui, -apple-system, sans-serif",
        color: COLORS.ink,
        padding: "20px 24px",
      }}
    >
      <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>
        Value Chain Explorer
      </h1>
      <p style={{ fontSize: 12, color: COLORS.inkSoft, margin: "0 0 16px" }}>
        GLG Client Solutions — BD prep (internal)
      </p>
      <ValueChainTree tree={STATIC_TREE} />
    </div>
  );
}
