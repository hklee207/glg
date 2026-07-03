import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import initialData from "./data/skhynix.json";
import { I18nContext, makeT, useI18n } from "./i18n.js";
import { runJob, postDirect } from "./api.js";
import GeneratingOverlay, { WorkingToast } from "./GeneratingOverlay.jsx";
import NodePopover from "./NodePopover.jsx";

const FONT = "'Helvetica Neue', Arial, system-ui, -apple-system, sans-serif";

// ---------------------------------------------------------------------------
// Colors (validated dataviz palette; text always wears ink, never series hue)
// ---------------------------------------------------------------------------
const COLORS = {
  upstream: "#2a78d6",
  downstream: "#1baf7a",
  corporate: "#4a3aa7",
  anchor: "#0b0b0b",
  ink: "#0b0b0b",
  inkSoft: "#52514e",
  surface: "#fcfcfb",
  nodeFill: "#ffffff",
  dim: 0.18,
};
// Sector/segment boxes wear a tinted fill so they read as a different kind of
// thing than company boxes (white). Corporate/strategy nodes are violet.
const TINTS = { upstream: "#e3eefb", downstream: "#e0f4ec", anchor: "#eae7f8" };
function dirColor(direction) {
  return direction === "anchor" ? COLORS.corporate : COLORS[direction];
}
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

// tx translates display strings (labels via `l:`, descriptions via `d:`)
// while ids keep the original English names, so highlighting and history
// survive a language switch.
function buildMergedTree(apiData, tx = (_k, fb) => fb) {
  const sides = { upstream: new Map(), downstream: new Map(), anchor: new Map() };
  const descs = {};
  for (const signal of apiData.signals) {
    const dir = sides[signal.direction] ? signal.direction : "anchor";
    const side = sides[dir];
    for (const node of signal.nodes) {
      const id = nodeId(dir, node);
      if (node.desc && !descs[id]) descs[id] = node.desc;
      if (node.level === 1) {
        if (!side.has(node.name)) side.set(node.name, new Set());
      } else {
        if (!side.has(node.parent)) side.set(node.parent, new Set());
        side.get(node.parent).add(node.name);
      }
    }
  }
  const entry = (dir, name, parent) => {
    const id = parent ? `${dir}:${parent}:${name}` : `${dir}:${name}`;
    const rawDesc = descs[id];
    return {
      name,
      display: tx(`l:${name}`, name),
      desc: rawDesc ? tx(`d:${id}`, rawDesc) : undefined,
      rawDesc,
    };
  };
  const toList = (m, dir) =>
    [...m.entries()].map(([name, kids]) => ({
      ...entry(dir, name),
      children: [...kids].map((k) => entry(dir, k, name)),
    }));
  return {
    anchor: apiData.anchor_company,
    upstream: toList(sides.upstream, "upstream"),
    downstream: toList(sides.downstream, "downstream"),
    anchorChains: toList(sides.anchor, "anchor"),
  };
}

// ---------------------------------------------------------------------------
// Layout. Width is computed from tier sizes so every node fits without
// overlap. Vertical bands, top to bottom:
//   expert band (up) / leaf row (up) / segment row (up) / anchor row
//   / segment row (down) / leaf row (down) / expert band (down)
// Corporate (anchor-direction) chains stack in their own labeled column to
// the right of the anchor — never inline on the anchor row, so they can't
// collide with each other or stretch into a confusing straight line.
// ---------------------------------------------------------------------------
const NODE_H = 38;
const EXPERT_BAND_H = 215;
const ROW_GAP = 100;
const CHAIN_ROW_H = 46;

// CJK glyphs are ~1.7x the width of latin glyphs at the same font size, so
// width estimates count "units" rather than characters.
function textUnits(s) {
  let u = 0;
  for (const ch of s) u += ch.codePointAt(0) > 0x2e80 ? 1.72 : 1;
  return u;
}

// Nodes render up to two lines of text, so a long label only needs a box
// wide enough for roughly half its units.
function nodeWidth(label, maxW = 150) {
  const units = textUnits(label);
  const oneLine = units * 6.6 + 22;
  const needed = oneLine <= maxW ? oneLine : (units / 2) * 6.6 + 30;
  return Math.min(maxW, Math.max(64, needed));
}
// Split a label into 1-2 lines that fit the box; ellipsis only if even two
// lines can't hold it.
function wrapLabel(label, w, fontSize) {
  const unitW = fontSize * 0.58;
  const maxUnits = Math.max(4, (w - 10) / unitW);
  if (textUnits(label) <= maxUnits) return [label];
  const chars = [...label];
  let acc = 0;
  let idx = chars.length;
  for (let i = 0; i < chars.length; i++) {
    acc += chars[i].codePointAt(0) > 0x2e80 ? 1.72 : 1;
    if (acc > maxUnits) {
      idx = i;
      break;
    }
  }
  let brk = label.lastIndexOf(" ", idx);
  if (brk < idx * 0.4) brk = idx;
  const line1 = label.slice(0, brk).trim();
  let line2 = label.slice(brk).trim();
  if (textUnits(line2) > maxUnits) {
    const c2 = [...line2];
    let a2 = 0;
    let cut = c2.length;
    for (let i = 0; i < c2.length; i++) {
      a2 += c2[i].codePointAt(0) > 0x2e80 ? 1.72 : 1;
      if (a2 > maxUnits - 1) {
        cut = i;
        break;
      }
    }
    line2 = c2.slice(0, Math.max(1, cut)).join("") + "…";
  }
  return [line1, line2];
}
function shortHeadline(text, max = 92) {
  if (!text) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return cut.slice(0, lastSpace > 40 ? lastSpace : max) + "…";
}

// ---------------------------------------------------------------------------
// Impact scoring & source parsing
// ---------------------------------------------------------------------------
function impactScore(signal) {
  if (typeof signal.impact_score === "number") return signal.impact_score;
  return { high: 85, medium: 55, low: 25 }[signal.materiality] ?? 25;
}
function sortByImpact(signals) {
  return [...signals].sort(
    (a, b) => impactScore(b) - impactScore(a) || (b.date || "").localeCompare(a.date || ""),
  );
}
function extractUrls(text) {
  if (!text) return [];
  return text.match(/https?:\/\/[^\s|,)]+/g) || [];
}
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function signalNodeIds(signal) {
  return new Set(signal.nodes.map((n) => nodeId(signal.direction, n)));
}
function relatedSignals(signal, all) {
  const ids = signalNodeIds(signal);
  return all
    .filter((s) => s.id !== signal.id)
    .map((s) => {
      const shared = [...signalNodeIds(s)].filter((id) => ids.has(id)).length;
      return { signal: s, shared, sameDir: s.direction === signal.direction };
    })
    .filter((r) => r.shared > 0 || r.sameDir)
    .sort((a, b) => b.shared - a.shared || impactScore(b.signal) - impactScore(a.signal))
    .slice(0, 4);
}

// Every dynamic string the Korean view needs, as a flat {key: english} map.
// Keys line up with tx() lookups: s:* signal fields, l:* node labels,
// d:* node descriptions, r:* expert role hints.
function collectKoStrings(data) {
  const out = {};
  for (const s of data.signals) {
    if (s.title) out[`s:${s.id}:title`] = s.title;
    if (s.signal) out[`s:${s.id}:signal`] = s.signal;
    (s.key_points || []).forEach((p, i) => (out[`s:${s.id}:kp:${i}`] = p));
    if (s.why_it_matters) out[`s:${s.id}:why`] = s.why_it_matters;
    if (s.chain_link) out[`s:${s.id}:chain`] = s.chain_link;
    const counters = {};
    for (const n of s.nodes) {
      const dir = ["upstream", "downstream", "anchor"].includes(s.direction)
        ? s.direction
        : "anchor";
      const id = nodeId(dir, n);
      if (n.level === 1) out[`l:${n.name}`] = n.name;
      if (n.desc) out[`d:${id}`] = n.desc;
      (n.experts || []).forEach((e) => {
        const c = (counters[id] = counters[id] ?? 0);
        if (e.role_hint) out[`r:${id}:${c}`] = e.role_hint;
        counters[id] = c + 1;
      });
    }
  }
  return out;
}
// Maps each expert object to its role-hint translation key, mirroring the
// counter logic in collectKoStrings.
function buildRoleKeyMap(data) {
  const m = new WeakMap();
  for (const s of data.signals) {
    const counters = {};
    const dir = ["upstream", "downstream", "anchor"].includes(s.direction)
      ? s.direction
      : "anchor";
    for (const n of s.nodes) {
      const id = nodeId(dir, n);
      (n.experts || []).forEach((e) => {
        const c = (counters[id] = counters[id] ?? 0);
        m.set(e, `r:${id}:${c}`);
        counters[id] = c + 1;
      });
    }
  }
  return m;
}

function layoutSide(segments, direction, width, geo, out) {
  const segY = direction === "upstream" ? geo.ySegUp : geo.ySegDown;
  const leafY = direction === "upstream" ? geo.yLeafUp : geo.yLeafDown;
  const n = segments.length;
  const segMaxW = width / (n + 1) - 10;

  const leaves = segments.flatMap((seg) =>
    seg.children.map((child) => ({ child, parent: seg.name })),
  );
  const leafMaxW = width / (leaves.length + 1) - 8;

  segments.forEach((seg, i) => {
    const id = `${direction}:${seg.name}`;
    out.nodes.push({
      id,
      name: seg.name,
      label: seg.display,
      desc: seg.desc,
      rawDesc: seg.rawDesc,
      x: (width * (i + 1)) / (n + 1),
      y: segY,
      level: 1,
      direction,
      maxW: segMaxW,
    });
    out.edges.push({ id: `anchor->${id}`, from: "anchor", to: id, direction });
  });
  leaves.forEach(({ child, parent }, j) => {
    const id = `${direction}:${parent}:${child.name}`;
    const parentId = `${direction}:${parent}`;
    out.nodes.push({
      id,
      name: child.name,
      label: child.display,
      desc: child.desc,
      rawDesc: child.rawDesc,
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

// Corporate / strategy chains: a vertically-stacked, labeled column to the
// right of the anchor. Each chain gets its segment box plus its company
// boxes on their own rows, so nothing can overlap however many chains the
// model returns.
function chainStackHeight(chains) {
  const rows = chains.reduce((a, c) => a + Math.max(1, c.children.length), 0);
  return rows * CHAIN_ROW_H + Math.max(0, chains.length - 1) * 12;
}
function layoutCorporateColumn(chains, mainW, geo, out) {
  if (!chains.length) return;
  const segX = mainW + 160;
  const leafX = segX + 245;
  out.width = leafX + 130;
  const stackH = chainStackHeight(chains);
  let y = geo.yAnchor - stackH / 2;
  out.corpCaption = { x: segX - 105, y: y - 20 };
  for (const chain of chains) {
    const rows = Math.max(1, chain.children.length);
    const ys = Array.from({ length: rows }, (_, i) => y + i * CHAIN_ROW_H + CHAIN_ROW_H / 2);
    const segY = ys.reduce((a, b) => a + b, 0) / ys.length;
    const segId = `anchor:${chain.name}`;
    out.nodes.push({
      id: segId,
      name: chain.name,
      label: chain.display,
      desc: chain.desc,
      rawDesc: chain.rawDesc,
      x: segX,
      y: segY,
      level: 1,
      direction: "anchor",
      maxW: 215,
    });
    out.edges.push({ id: `anchor->${segId}`, from: "anchor", to: segId, direction: "anchor", hcurve: true });
    chain.children.forEach((child, j) => {
      const leafId = `anchor:${chain.name}:${child.name}`;
      out.nodes.push({
        id: leafId,
        name: child.name,
        label: child.display,
        desc: child.desc,
        rawDesc: child.rawDesc,
        x: leafX,
        y: ys[j],
        level: 2,
        direction: "anchor",
        parent: segId,
        maxW: 205,
      });
      out.edges.push({ id: `${segId}->${leafId}`, from: segId, to: leafId, direction: "anchor", hcurve: true });
    });
    y += rows * CHAIN_ROW_H + 12;
  }
}

function computeLayout(tree) {
  // The middle zone stretches when the corporate column is tall, so the
  // column never bleeds into the segment rows above/below it.
  const stackH = chainStackHeight(tree.anchorChains);
  const gapAnchor = Math.max(ROW_GAP, stackH / 2 + 64);

  const geo = {};
  geo.yLeafUp = EXPERT_BAND_H + 55;
  geo.ySegUp = geo.yLeafUp + ROW_GAP;
  geo.yAnchor = geo.ySegUp + gapAnchor;
  geo.ySegDown = geo.yAnchor + gapAnchor;
  geo.yLeafDown = geo.ySegDown + ROW_GAP;
  geo.height = geo.yLeafDown + 55 + EXPERT_BAND_H;
  geo.expertBandH = EXPERT_BAND_H;

  const maxTier = Math.max(
    tree.upstream.length,
    tree.downstream.length,
    tree.upstream.reduce((a, s) => a + s.children.length, 0),
    tree.downstream.reduce((a, s) => a + s.children.length, 0),
  );
  // No upper cap: the canvas is zoomable, so give every tier the room its
  // boxes actually need instead of truncating labels to fit a fixed width.
  const mainW = Math.max(760, maxTier * 170);
  const out = { nodes: [], edges: [], width: mainW, geo };
  out.nodes.push({
    id: "anchor",
    name: tree.anchor,
    label: tree.anchor,
    x: mainW / 2,
    y: geo.yAnchor,
    level: 0,
    direction: "anchor",
    maxW: 170,
  });
  layoutSide(tree.upstream, "upstream", mainW, geo, out);
  layoutSide(tree.downstream, "downstream", mainW, geo, out);
  layoutCorporateColumn(tree.anchorChains, mainW, geo, out);

  // Edge nodes and expert cards (up to 260px) hang around their node — grow
  // the canvas to the true bounding box instead of clipping.
  const PAD = 24;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const n of out.nodes) {
    const half = Math.max(nodeWidth(n.label, n.maxW) / 2, 132);
    minX = Math.min(minX, n.x - half);
    maxX = Math.max(maxX, n.x + half);
  }
  const shift = PAD - minX;
  for (const n of out.nodes) n.x += shift;
  if (out.corpCaption) out.corpCaption.x += shift;
  out.width = maxX + shift + PAD;
  return out;
}

function edgePath(from, to, hcurve) {
  if (hcurve) {
    const fw = nodeWidth(from.label, from.maxW);
    const tw = nodeWidth(to.label, to.maxW);
    const x1 = to.x > from.x ? from.x + fw / 2 : from.x - fw / 2;
    const x2 = to.x > from.x ? to.x - tw / 2 : to.x + tw / 2;
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${x2} ${to.y}`;
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
  const { t } = useI18n();
  const outerRef = useRef(null);
  const dragRef = useRef(null);
  const [tf, setTf] = useState({ x: 0, y: 0, scale: 1 });
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
    setTf({
      x: (cw - contentWidth * scale) / 2,
      y: (ch - contentHeight * scale) / 2,
      scale,
    });
  }, [contentWidth, contentHeight]);

  useEffect(() => {
    fit();
  }, [fit]);

  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setTf((prev) => {
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
    setTf((prev) => {
      const scale = Math.max(0.1, Math.min(4, prev.scale * factor));
      const cx = cw / 2;
      const cy = ch / 2;
      const wx = (cx - prev.x) / prev.scale;
      const wy = (cy - prev.y) / prev.scale;
      return { scale, x: cx - wx * scale, y: cy - wy * scale };
    });
  };

  const DRAG_THRESHOLD = 4;
  const onPointerDown = (e) => {
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: tf.x,
      origY: tf.y,
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
    setTf((prev) => ({ ...prev, x: d.origX + dx, y: d.origY + dy }));
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
          transform: `translate(${tf.x}px, ${tf.y}px) scale(${tf.scale})`,
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
        {Math.round(tf.scale * 100)}% — {t("zoomHint")}
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
  const isSegment = node.level === 1;
  const accent = isAnchor ? COLORS.anchor : dirColor(node.direction);
  const highlighted = state === "highlight";
  const fill = isAnchor
    ? COLORS.anchor
    : highlighted
      ? accent
      : isSegment
        ? TINTS[node.direction]
        : COLORS.nodeFill;
  const textFill = isAnchor || highlighted ? "#ffffff" : COLORS.ink;
  const fontSize = node.level === 2 ? 10 : 11;
  const lines = wrapLabel(node.label, w, fontSize);
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
        rx={isSegment ? 9 : 6}
        fill={fill}
        stroke={accent}
        strokeWidth={highlighted ? 3 : isSegment ? 2 : 1.25}
      />
      <text
        x={node.x}
        y={node.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={fontSize}
        fontWeight={node.level < 2 || highlighted ? 600 : 400}
        fill={textFill}
      >
        {lines.map((line, i) => (
          <tspan
            key={i}
            x={node.x}
            dy={i === 0 ? (lines.length === 1 ? 0 : -(fontSize * 0.62)) : fontSize * 1.24}
          >
            {line}
          </tspan>
        ))}
        <title>{node.desc ? `${node.label} — ${node.desc}` : node.label}</title>
      </text>
    </g>
  );
}

// Plain-language caption under a highlighted node: what it does / how it ties
// to the anchor, straight from the signal data. Rendered toward the anchor
// row (below upstream boxes, above downstream boxes) where there is always
// free space, so captions can't hit the expert band.
function DescCaption({ node }) {
  if (!node.desc) return null;
  const w = Math.min(235, (node.maxW || 150) + 70);
  const lines = wrapLabel(node.desc, w, 9);
  const below = node.direction !== "downstream";
  const y0 = below
    ? node.y + NODE_H / 2 + 14
    : node.y - NODE_H / 2 - 10 - (lines.length - 1) * 11;
  return (
    <text x={node.x} y={y0} textAnchor="middle" fontSize={9} fill={COLORS.inkSoft} pointerEvents="none">
      {lines.map((l, i) => (
        <tspan key={i} x={node.x} dy={i === 0 ? 0 : 11}>
          {l}
        </tspan>
      ))}
    </text>
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
// below the node's own x position.
function ExpertColumn({ group, x, y, width }) {
  const { txRole } = useI18n();
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
              {txRole(expert, expert.role_hint)}
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
                  {(terms || []).map((term) => (
                    <MosaicChip key={term} term={term} />
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

export function ValueChainTree({
  tree,
  selectedSignal,
  ghost,
  onGhostBack,
  busy,
  detailCache,
  onFetchDetail,
  onBranch,
  onExplore,
}) {
  const { t, lang } = useI18n();
  const layout = useMemo(() => computeLayout(tree), [tree]);
  const { nodes, edges, geo } = layout;
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);
  const [openNodeId, setOpenNodeId] = useState(null);

  useEffect(() => {
    setOpenNodeId(null);
  }, [tree]);

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
  const bandY = band === "down" ? geo.height - EXPERT_BAND_H : 6;
  const connectorY = band === "down" ? bandY : EXPERT_BAND_H - 6;

  const COL_W = 215;
  const columns = useMemo(() => {
    const cols = grouped.map((g) => ({ ...g, width: COL_W, colX: g.node.x }));
    const minGap = COL_W + 14;
    for (let i = 1; i < cols.length; i++) {
      cols[i].colX = Math.max(cols[i].colX, cols[i - 1].colX + minGap);
    }
    return cols;
  }, [grouped]);

  const svgWidth = Math.max(layout.width, ...columns.map((c) => c.colX + COL_W / 2 + 16), 0);

  const openNode = openNodeId ? byId[openNodeId] : null;
  const anchorNode = byId["anchor"];
  const ghostTop = ghost && ghost.side !== "upstream";
  const ghostY = ghost ? (ghostTop ? 30 : geo.height - 30) : 0;

  return (
    <PanZoomViewport contentWidth={svgWidth} contentHeight={geo.height}>
      <svg
        width={svgWidth}
        height={geo.height}
        role="img"
        aria-label={`Value chain tree for ${tree.anchor}`}
        style={{ display: "block" }}
      >
        <rect
          x={0}
          y={0}
          width={svgWidth}
          height={geo.height}
          fill={COLORS.surface}
          onClick={() => setOpenNodeId(null)}
        />
        <text x={12} y={EXPERT_BAND_H + 16} fontSize={10.5} fill={COLORS.inkSoft} fontWeight={600}>
          {t("upstreamCaption")}
        </text>
        <text x={12} y={geo.height - EXPERT_BAND_H - 8} fontSize={10.5} fill={COLORS.inkSoft} fontWeight={600}>
          {t("downstreamCaption")}
        </text>
        {layout.corpCaption && (
          <text
            x={layout.corpCaption.x}
            y={layout.corpCaption.y}
            fontSize={10.5}
            fill={COLORS.corporate}
            fontWeight={700}
          >
            {t("corporateCaption")}
          </text>
        )}

        {edges.map((e) => {
          const st = edgeState(e);
          return (
            <path
              key={e.id}
              d={edgePath(byId[e.from], byId[e.to], e.hcurve)}
              fill="none"
              stroke={dirColor(e.direction)}
              strokeWidth={st === "highlight" ? 3 : 1.5}
              opacity={st === "dim" ? COLORS.dim : st === "highlight" ? 0.9 : 0.55}
            />
          );
        })}

        {/* Ghost link back to the previous anchor after an explore */}
        {ghost && anchorNode && (
          <g style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); onGhostBack(); }}>
            <path
              d={`M ${anchorNode.x} ${ghostY + (ghostTop ? 16 : -16)} C ${anchorNode.x} ${(ghostY + anchorNode.y) / 2}, ${anchorNode.x} ${(ghostY + anchorNode.y) / 2}, ${anchorNode.x} ${ghostTop ? anchorNode.y - NODE_H / 2 : anchorNode.y + NODE_H / 2}`}
              fill="none"
              stroke="#9b9a93"
              strokeWidth={1.5}
              strokeDasharray="5 5"
              opacity={0.45}
            />
            <foreignObject x={anchorNode.x - 130} y={ghostY - 16} width={260} height={32} style={{ overflow: "visible" }}>
              <div
                xmlns="http://www.w3.org/1999/xhtml"
                style={{
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    background: "#ffffff",
                    border: "1.5px dashed #9b9a93",
                    borderRadius: 999,
                    padding: "5px 14px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: COLORS.inkSoft,
                    opacity: 0.85,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: 250,
                  }}
                  title={t("ghostBack", { name: ghost.label })}
                >
                  {t("ghostBack", { name: ghost.label })}
                </div>
              </div>
            </foreignObject>
          </g>
        )}

        {nodes.map((n) => (
          <TreeNode
            key={n.id}
            node={n}
            state={nodeState(n)}
            onSelect={(id) => setOpenNodeId((cur) => (cur === id ? null : id))}
          />
        ))}

        {/* Plain-language captions for the highlighted branch */}
        {highlightIds &&
          nodes
            .filter((n) => n.level > 0 && n.direction !== "anchor" && n.desc && highlightIds.has(n.id))
            .map((n) => <DescCaption key={`cap-${n.id}`} node={n} />)}

        {columns.map((col) => {
          const ty = band === "down" ? col.node.y + NODE_H / 2 : col.node.y - NODE_H / 2;
          return (
            <line
              key={`conn-${col.node.id}`}
              x1={col.colX}
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
          <ExpertColumn key={`col-${col.node.id}`} group={col} x={col.colX} y={bandY} width={col.width} />
        ))}

        {openNode && (
          <NodePopover
            node={openNode}
            anchor={tree.anchor}
            svgWidth={svgWidth}
            svgHeight={geo.height}
            detail={detailCache[`${openNode.id}|${lang}`]}
            onFetchDetail={onFetchDetail}
            onBranch={(n) => {
              setOpenNodeId(null);
              onBranch(n);
            }}
            onExplore={(n) => {
              setOpenNodeId(null);
              onExplore(n);
            }}
            busy={busy}
            onClose={() => setOpenNodeId(null)}
          />
        )}
      </svg>
    </PanZoomViewport>
  );
}

// ---------------------------------------------------------------------------
// Left panel — compact, clickable signal cards
// ---------------------------------------------------------------------------
function SignalCard({ signal, rank, selected, onClick }) {
  const { t, tx } = useI18n();
  const badge = MATERIALITY[signal.materiality] || MATERIALITY.low;
  const accent = dirColor(signal.direction) || COLORS.anchor;
  const score = impactScore(signal);
  const headline =
    tx(`s:${signal.id}:title`, signal.title) || shortHeadline(tx(`s:${signal.id}:signal`, signal.signal));
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        background: selected ? "#eef4fc" : "#ffffff",
        borderTop: `1.5px solid ${selected ? accent : "#e2e1db"}`,
        borderRight: `1.5px solid ${selected ? accent : "#e2e1db"}`,
        borderBottom: `1.5px solid ${selected ? accent : "#e2e1db"}`,
        borderLeft: `6px solid ${badge.bg}`,
        borderRadius: 8,
        padding: "8px 10px",
        marginBottom: 6,
        cursor: "pointer",
        fontFamily: "inherit",
      }}
    >
      <div style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.inkSoft, flexShrink: 0 }}>
          #{rank}
        </span>
        <span style={{ fontSize: 11.5, color: COLORS.ink, lineHeight: 1.4, fontWeight: selected ? 600 : 400 }}>
          {shortHeadline(headline)}
        </span>
      </div>
      {signal.branchOf && (
        <div style={{ marginTop: 4 }}>
          <span
            style={{
              fontSize: 8.5,
              fontWeight: 700,
              color: COLORS.corporate,
              background: "#eae7f8",
              borderRadius: 999,
              padding: "1px 8px",
            }}
          >
            {t("relatedTag", { name: signal.branchOf })}
          </span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        <div style={{ flex: 1, height: 4, borderRadius: 999, background: "#efeee9" }}>
          <div
            style={{
              width: `${Math.max(4, Math.min(100, score))}%`,
              height: "100%",
              borderRadius: 999,
              background: badge.bg,
            }}
          />
        </div>
        <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.inkSoft, flexShrink: 0 }}>
          {score}
        </span>
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
        <span style={{ textTransform: "capitalize", color: accent, fontWeight: 600 }}>
          {signal.direction}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail panel for the selected signal — a horizontal band above the tree.
// ---------------------------------------------------------------------------
function DetailHeading({ children }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        color: COLORS.inkSoft,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 5,
      }}
    >
      {children}
    </div>
  );
}

function SourceRow({ url, label, date, userAdded }) {
  const { t } = useI18n();
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      style={{
        display: "block",
        padding: "5px 9px",
        marginBottom: 4,
        borderRadius: 7,
        border: `1px solid ${userAdded ? "#bcd7f2" : "#e4e3de"}`,
        background: userAdded ? "#f2f8fe" : "#ffffff",
        textDecoration: "none",
      }}
    >
      <div style={{ fontSize: 11.5, fontWeight: 600, color: COLORS.upstream, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label || hostOf(url)} ↗
      </div>
      <div style={{ fontSize: 9.5, color: COLORS.inkSoft, marginTop: 1 }}>
        {hostOf(url)}
        {date ? ` · ${date}` : ""}
        {userAdded ? ` · ${t("addedByYou")}` : ""}
      </div>
    </a>
  );
}

function SignalDetailPanel({
  signal,
  rank,
  allSignals,
  onSelectSignal,
  onClose,
  onExplore,
  userSources,
  onAddSource,
  loading,
}) {
  const { t, tx } = useI18n();
  const [newUrl, setNewUrl] = useState("");
  const [newDate, setNewDate] = useState("");
  useEffect(() => {
    setNewUrl("");
    setNewDate("");
  }, [signal?.id]);
  if (!signal) return null;

  const badge = MATERIALITY[signal.materiality] || MATERIALITY.low;
  const accent = dirColor(signal.direction) || COLORS.anchor;
  const score = impactScore(signal);
  const urls = extractUrls(signal.source);
  const pubLabel = (signal.source || "").split(/https?:\/\//)[0].replace(/[—\-|:\s]+$/, "").trim();
  const related = relatedSignals(signal, allSignals);
  const stakeholders = signal.stakeholders?.length
    ? signal.stakeholders
    : signal.nodes.map((n) => n.name);
  const title =
    tx(`s:${signal.id}:title`, signal.title) ||
    shortHeadline(tx(`s:${signal.id}:signal`, signal.signal), 110);

  const addSource = () => {
    const url = newUrl.trim();
    if (!url) return;
    onAddSource(signal.id, { url: /^https?:\/\//.test(url) ? url : `https://${url}`, date: newDate });
    setNewUrl("");
    setNewDate("");
  };

  const inputStyle = {
    fontSize: 11,
    padding: "5px 8px",
    border: "1px solid #dcdbd5",
    borderRadius: 6,
    fontFamily: "inherit",
    boxSizing: "border-box",
    background: "#ffffff",
    color: COLORS.ink,
  };
  const colStyle = { flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 14 };

  return (
    <div
      style={{
        flexShrink: 0,
        background: "#fbfbfa",
        borderBottom: "1px solid #e6e5e0",
        borderTop: `3px solid ${badge.bg}`,
        padding: "12px 16px 14px",
        display: "flex",
        gap: 18,
        maxHeight: 265,
        boxSizing: "border-box",
      }}
    >
      {/* Column 1 — title, badges, key points */}
      <div style={{ ...colStyle, flex: 1.25 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span
            title="Estimated impact on the anchor company (0-100)"
            style={{
              background: badge.bg,
              color: badge.fg,
              borderRadius: 8,
              padding: "4px 9px",
              fontWeight: 700,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            {score}
          </span>
          <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.35, color: COLORS.ink }}>
            {title}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 7, fontSize: 10.5, color: COLORS.inkSoft, flexWrap: "wrap" }}>
          <span>{t("impactRank", { n: rank })}</span>
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
          <span style={{ textTransform: "capitalize", color: accent, fontWeight: 700 }}>{signal.direction}</span>
          <span>{signal.date}</span>
        </div>
        {signal.key_points?.length ? (
          <ul style={{ margin: "9px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: COLORS.ink }}>
            {signal.key_points.map((p, i) => (
              <li key={i} style={{ marginBottom: 3 }}>
                {tx(`s:${signal.id}:kp:${i}`, p)}
              </li>
            ))}
          </ul>
        ) : (
          <div style={{ marginTop: 9, fontSize: 12.5, lineHeight: 1.6, color: COLORS.ink }}>
            {tx(`s:${signal.id}:signal`, signal.signal)}
          </div>
        )}
      </div>

      {/* Column 2 — why it matters, chain link, stakeholders */}
      <div style={{ ...colStyle, borderLeft: "1px solid #eceae4", paddingLeft: 16 }}>
        {signal.why_it_matters && (
          <div style={{ marginBottom: 10 }}>
            <DetailHeading>{t("why")}</DetailHeading>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: COLORS.ink }}>
              {tx(`s:${signal.id}:why`, signal.why_it_matters)}
            </div>
          </div>
        )}
        {signal.chain_link && (
          <div style={{ marginBottom: 10 }}>
            <DetailHeading>{t("chainLink")}</DetailHeading>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: COLORS.ink }}>
              {tx(`s:${signal.id}:chain`, signal.chain_link)}
            </div>
          </div>
        )}
        <DetailHeading>{t("stakeholders")}</DetailHeading>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {stakeholders.map((name) => (
            <button
              key={name}
              onClick={() => onExplore(name, signal.direction)}
              disabled={loading}
              title={`Generate a new value-chain map centered on ${name}`}
              style={{
                fontSize: 10.5,
                padding: "3px 10px",
                borderRadius: 999,
                border: `1px solid ${accent}`,
                background: "#ffffff",
                color: accent,
                fontWeight: 600,
                cursor: loading ? "default" : "pointer",
                fontFamily: "inherit",
                opacity: loading ? 0.5 : 1,
              }}
            >
              {name} ↗
            </button>
          ))}
        </div>
      </div>

      {/* Column 3 — sources + related signals */}
      <div style={{ ...colStyle, maxWidth: 320, borderLeft: "1px solid #eceae4", paddingLeft: 16, paddingRight: 0 }}>
        <DetailHeading>{t("sources")}</DetailHeading>
        {pubLabel && <div style={{ fontSize: 10, color: COLORS.inkSoft, marginBottom: 5 }}>{pubLabel}</div>}
        {urls.map((u) => (
          <SourceRow key={u} url={u} date={signal.date} />
        ))}
        {(userSources || []).map((s, i) => (
          <SourceRow key={`user-${i}`} url={s.url} date={s.date} userAdded />
        ))}
        <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
          <input
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSource()}
            placeholder={t("addSourcePlaceholder")}
            style={{ ...inputStyle, flex: 1, minWidth: 0 }}
          />
          <input
            type="month"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            title="Source date"
            style={{ ...inputStyle, width: 118 }}
          />
          <button
            onClick={addSource}
            disabled={!newUrl.trim()}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "5px 12px",
              border: "none",
              borderRadius: 6,
              background: newUrl.trim() ? COLORS.upstream : "#c9c8c2",
              color: "#ffffff",
              cursor: newUrl.trim() ? "pointer" : "default",
              fontFamily: "inherit",
            }}
          >
            {t("add")}
          </button>
        </div>

        {related.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <DetailHeading>{t("related")}</DetailHeading>
            {related.map(({ signal: r, shared }) => (
              <button
                key={r.id}
                onClick={() => onSelectSignal(r.id)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "#ffffff",
                  borderTop: "1px solid #e4e3de",
                  borderRight: "1px solid #e4e3de",
                  borderBottom: "1px solid #e4e3de",
                  borderLeft: `4px solid ${(MATERIALITY[r.materiality] || MATERIALITY.low).bg}`,
                  borderRadius: 7,
                  padding: "5px 9px",
                  marginBottom: 4,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                <div style={{ fontSize: 10.5, color: COLORS.ink, lineHeight: 1.4 }}>
                  {shortHeadline(tx(`s:${r.id}:title`, r.title) || tx(`s:${r.id}:signal`, r.signal), 72)}
                </div>
                <div style={{ fontSize: 9, color: COLORS.inkSoft, marginTop: 2 }}>
                  {shared > 0 ? `${shared} ${shared > 1 ? t("sharedNodes") : t("sharedNode")}` : t("sameSide")} ·{" "}
                  {r.direction} · {t("impact")} {impactScore(r)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={onClose}
        title="Close"
        style={{
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: 15,
          color: COLORS.inkSoft,
          flexShrink: 0,
          alignSelf: "flex-start",
          padding: 2,
        }}
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Language toggle — EN | 한국어
// ---------------------------------------------------------------------------
function LangToggle({ lang, setLang }) {
  const opt = (value, label) => (
    <button
      onClick={() => setLang(value)}
      style={{
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: lang === value ? 700 : 400,
        padding: "4px 10px",
        border: "none",
        borderRadius: 999,
        background: lang === value ? COLORS.ink : "transparent",
        color: lang === value ? "#ffffff" : COLORS.inkSoft,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      style={{
        display: "inline-flex",
        gap: 2,
        border: "1px solid #dcdbd5",
        borderRadius: 999,
        padding: 2,
        background: "#ffffff",
        flexShrink: 0,
      }}
    >
      {opt("en", "EN")}
      {opt("ko", "한국어")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Landing / search screen — the entry point before any company is generated
// ---------------------------------------------------------------------------
function LandingScreen({ company, setCompany, onSearch, loading, error, onQuickStart, lang, setLang }) {
  const { t } = useI18n();
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
        position: "relative",
      }}
    >
      <div style={{ position: "absolute", top: 16, right: 16 }}>
        <LangToggle lang={lang} setLang={setLang} />
      </div>
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
        {t("landingSubtitle")}
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
            placeholder={t("searchPlaceholder")}
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
            {loading ? "…" : t("generate")}
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
            {t("errPrefix")}
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview overlay — shown on the canvas when no signal is selected.
// ---------------------------------------------------------------------------
function OverviewOverlay({ data, sorted }) {
  const { t, tx } = useI18n();
  const counts = {
    high: data.signals.filter((s) => s.materiality === "high").length,
    upstream: data.signals.filter((s) => s.direction === "upstream").length,
    downstream: data.signals.filter((s) => s.direction === "downstream").length,
  };
  const top = sorted[0];
  const stat = (value, label) => (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: COLORS.ink }}>{value}</div>
      <div style={{ fontSize: 8.5, color: COLORS.inkSoft, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
    </div>
  );
  const legendDot = (color, label) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: COLORS.inkSoft }}>
      <span style={{ width: 9, height: 9, borderRadius: 3, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
  const legendBox = (fill, stroke, label) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: COLORS.inkSoft }}>
      <span
        style={{
          width: 14,
          height: 10,
          borderRadius: 3,
          background: fill,
          border: `1.5px solid ${stroke}`,
          display: "inline-block",
          boxSizing: "border-box",
        }}
      />
      {label}
    </span>
  );
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        width: 260,
        background: "#ffffffee",
        border: "1px solid #e4e3de",
        borderRadius: 10,
        padding: "12px 14px",
        boxShadow: "0 2px 10px rgba(0,0,0,0.07)",
        fontFamily: FONT,
        pointerEvents: "none",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.ink, marginBottom: 9 }}>
        {t("overviewTitle", { name: data.anchor_company })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        {stat(data.signals.length, t("statSignals"))}
        {stat(counts.high, t("statHigh"))}
        {stat(counts.upstream, t("statUp"))}
        {stat(counts.downstream, t("statDown"))}
      </div>
      {top && (
        <div style={{ fontSize: 10, color: COLORS.inkSoft, lineHeight: 1.5, marginBottom: 9, paddingBottom: 9, borderBottom: "1px solid #eceae4" }}>
          <b style={{ color: COLORS.ink }}>{t("topSignal")}</b>{" "}
          {shortHeadline(tx(`s:${top.id}:title`, top.title) || tx(`s:${top.id}:signal`, top.signal), 80)}
        </div>
      )}
      {/* Box kinds: tinted = sector/segment, white = company */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        {legendBox(TINTS.upstream, COLORS.upstream, t("legendSector"))}
        {legendBox("#ffffff", COLORS.upstream, t("legendCompany"))}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 7 }}>
        {legendDot(COLORS.upstream, t("statUp"))}
        {legendDot(COLORS.downstream, t("statDown"))}
        {legendDot(COLORS.corporate, t("legendCorporate"))}
        {legendDot(COLORS.anchor, t("legendAnchor"))}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
        {legendDot(MATERIALITY.high.bg, t("legendHigh"))}
        {legendDot(MATERIALITY.medium.bg, t("legendMedium"))}
        {legendDot(MATERIALITY.low.bg, t("legendLow"))}
      </div>
      <div style={{ fontSize: 9.5, color: COLORS.inkSoft, lineHeight: 1.5 }}>{t("overviewHint")}</div>
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
  onExploreName,
  onExploreNode,
  onBranch,
  loading,
  busy,
  error,
  selectedId,
  setSelectedId,
  selectedSignal,
  userSources,
  onAddSource,
  onHome,
  lang,
  setLang,
  ghost,
  onGhostBack,
  detailCache,
  onFetchDetail,
}) {
  const { t } = useI18n();
  const sorted = useMemo(() => sortByImpact(data.signals), [data.signals]);
  const rankOf = useMemo(
    () => Object.fromEntries(sorted.map((s, i) => [s.id, i + 1])),
    [sorted],
  );
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
        <span style={{ fontSize: 11, color: COLORS.inkSoft }}>{t("tagline")}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <LangToggle lang={lang} setLang={setLang} />
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onGenerate()}
            placeholder={t("newSearch")}
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
            {loading ? "…" : t("generate")}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "6px 16px",
            fontSize: 11.5,
            color: "#a12b2a",
            background: "#fbeaea",
            borderBottom: "1px solid #e6e5e0",
            flexShrink: 0,
          }}
        >
          {t("errPrefix")}
          {error}
        </div>
      )}

      <SignalDetailPanel
        signal={selectedSignal}
        rank={selectedSignal ? rankOf[selectedSignal.id] : null}
        allSignals={sorted}
        onSelectSignal={setSelectedId}
        onClose={() => setSelectedId(null)}
        onExplore={onExploreName}
        userSources={selectedSignal ? userSources[selectedSignal.id] : null}
        onAddSource={onAddSource}
        loading={loading}
      />

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ width: 290, flexShrink: 0, borderRight: "1px solid #e6e5e0", padding: 12, overflowY: "auto" }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.inkSoft, marginBottom: 2, textTransform: "uppercase" }}>
            {t("signals")} — {data.anchor_company} ({data.signals.length})
          </div>
          <div style={{ fontSize: 9, color: COLORS.inkSoft, marginBottom: 8 }}>
            {t("orderNote", { name: data.anchor_company })}
          </div>
          {sorted.map((s, i) => (
            <SignalCard
              key={s.id}
              signal={s}
              rank={i + 1}
              selected={s.id === selectedId}
              onClick={() => setSelectedId((cur) => (cur === s.id ? null : s.id))}
            />
          ))}
        </div>
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          <ValueChainTree
            tree={tree}
            selectedSignal={selectedSignal}
            ghost={ghost}
            onGhostBack={onGhostBack}
            busy={!!busy}
            detailCache={detailCache}
            onFetchDetail={onFetchDetail}
            onBranch={onBranch}
            onExplore={onExploreNode}
          />
          {!selectedSignal && <OverviewOverlay data={data} sorted={sorted} />}
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
  // One job at a time: {kind: "generate"|"branch"|"translate", startedAt, label}
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [userSources, setUserSources] = useState({});
  const [lang, setLang] = useState("en");
  // Flat {key: korean} map for the current dataset (see collectKoStrings).
  const [koPack, setKoPack] = useState(null);
  // Explore history for the ghost back-link: each entry is a full snapshot.
  const [history, setHistory] = useState([]);
  const [ghost, setGhost] = useState(null);
  // Positioning-formula details per `${nodeId}|${lang}`.
  const [detailCache, setDetailCache] = useState({});
  const relSeq = useRef(1);

  const t = useMemo(() => makeT(lang), [lang]);
  const tx = useCallback(
    (key, fb) => (lang === "ko" && koPack && koPack[key] != null ? koPack[key] : fb),
    [lang, koPack],
  );
  const roleKeys = useMemo(() => buildRoleKeyMap(data), [data]);
  const txRole = useCallback(
    (expert, fb) => {
      const k = roleKeys.get(expert);
      return lang === "ko" && koPack && k && koPack[k] != null ? koPack[k] : fb;
    },
    [lang, koPack, roleKeys],
  );
  const i18nValue = useMemo(() => ({ lang, t, tx, txRole }), [lang, t, tx, txRole]);

  const addUserSource = (signalId, source) =>
    setUserSources((cur) => ({ ...cur, [signalId]: [...(cur[signalId] || []), source] }));

  const tree = useMemo(() => buildMergedTree(data, tx), [data, tx]);
  const selectedSignal = data.signals.find((s) => s.id === selectedId) || null;

  const loadingGenerate = busy?.kind === "generate";

  // Long work runs as backend jobs polled with short requests, so no
  // tunnel/proxy timeout can kill it (see api.js).
  async function generate(nameOverride, { pushHistory = false, side = "downstream" } = {}) {
    const name = (nameOverride ?? company).trim();
    if (!name || busy) return;
    setBusy({ kind: "generate", startedAt: Date.now(), label: name });
    setError(null);
    const prev = { data, koPack, company, ghost, history };
    try {
      const result = await runJob("/api/value-chain", { company: name });
      if (!Array.isArray(result?.signals)) throw new Error("Malformed response");
      setSelectedId(null);
      setUserSources({});
      setDetailCache({});
      setData(result);
      setKoPack(null);
      setCompany(name);
      if (pushHistory) {
        setHistory([...prev.history, prev]);
        setGhost({ label: prev.data.anchor_company, side });
      } else {
        setHistory([]);
        setGhost(null);
      }
      setMode("explorer");
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(null);
    }
  }

  // Korean view: translate whatever the current dataset is missing. Runs when
  // the user switches to KO or when new data/branch signals arrive while KO.
  useEffect(() => {
    if (lang !== "ko" || busy) return;
    const strings = collectKoStrings(data);
    const missing = Object.keys(strings).filter((k) => !(koPack || {})[k]);
    if (!missing.length) return;
    let cancelled = false;
    (async () => {
      setBusy({ kind: "translate", startedAt: Date.now() });
      try {
        const subset = Object.fromEntries(missing.map((k) => [k, strings[k]]));
        const map = await runJob("/api/translate", { strings: subset });
        if (!cancelled) setKoPack((p) => ({ ...(p || {}), ...map }));
      } catch (err) {
        if (!cancelled) setError(String(err.message || err));
      } finally {
        // Always release the gate — even if this run was superseded by a
        // language/data change while the job was in flight.
        setBusy((b) => (b?.kind === "translate" ? null : b));
      }
    })();
    return () => {
      cancelled = true;
    };
    // koPack/busy intentionally omitted: re-run only on language or data change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, data]);

  // Extra signals scoped to one branch; appended to the current dataset.
  async function branchSignals(node) {
    if (busy) return;
    setBusy({ kind: "branch", startedAt: Date.now(), label: node.label });
    setError(null);
    try {
      const result = await runJob("/api/branch-signals", {
        anchor: data.anchor_company,
        node: node.name,
        direction: node.direction,
        desc: node.rawDesc,
      });
      const fresh = (result?.signals || []).map((s) => ({
        ...s,
        id: `rel${relSeq.current++}`,
        branchOf: node.name,
      }));
      if (!fresh.length) throw new Error("No related signals found for this branch");
      setData((d) => ({ ...d, signals: [...d.signals, ...fresh] }));
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(null);
    }
  }

  // Positioning-formula detail for one node (fast direct call, cached per lang).
  async function fetchDetail(node) {
    const key = `${node.id}|${lang}`;
    setDetailCache((c) => ({ ...c, [key]: { status: "loading" } }));
    try {
      const { detail } = await postDirect("/api/node-detail", {
        anchor: data.anchor_company,
        node: node.name,
        desc: node.rawDesc,
        direction: node.direction,
        lang,
      });
      setDetailCache((c) => ({ ...c, [key]: { status: "done", data: detail } }));
    } catch {
      setDetailCache((c) => ({ ...c, [key]: { status: "error" } }));
    }
  }

  function loadSample() {
    setSelectedId(null);
    setUserSources({});
    setDetailCache({});
    setData(initialData);
    setKoPack(null);
    setHistory([]);
    setGhost(null);
    setCompany(initialData.anchor_company);
    setMode("explorer");
  }

  // Explore from a leaf node (double-confirmed in the popover) or from a
  // stakeholder chip: re-anchor with history + ghost back-link.
  function exploreNode(node) {
    const side = node.direction === "upstream" ? "upstream" : "downstream";
    generate(node.name, { pushHistory: true, side });
  }
  function exploreName(name, direction) {
    const side = direction === "upstream" ? "upstream" : "downstream";
    generate(name, { pushHistory: true, side });
  }

  function goBack() {
    setHistory((h) => {
      const last = h[h.length - 1];
      if (!last) return h;
      setData(last.data);
      setKoPack(last.koPack);
      setCompany(last.company);
      setGhost(last.ghost);
      setSelectedId(null);
      setUserSources({});
      return h.slice(0, -1);
    });
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
    <I18nContext.Provider value={i18nValue}>
      <style>{`html, body, #root { margin: 0; height: 100%; } body { overflow: hidden; }`}</style>
      {mode === "landing" ? (
        <LandingScreen
          company={company}
          setCompany={setCompany}
          onSearch={() => generate()}
          loading={loadingGenerate}
          error={error}
          onQuickStart={quickStart}
          lang={lang}
          setLang={setLang}
        />
      ) : (
        <ExplorerScreen
          data={data}
          tree={tree}
          company={company}
          setCompany={setCompany}
          onGenerate={() => generate()}
          onExploreName={exploreName}
          onExploreNode={exploreNode}
          onBranch={branchSignals}
          loading={loadingGenerate}
          busy={busy}
          error={error}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          selectedSignal={selectedSignal}
          userSources={userSources}
          onAddSource={addUserSource}
          onHome={() => setMode("landing")}
          lang={lang}
          setLang={setLang}
          ghost={ghost}
          onGhostBack={goBack}
          detailCache={detailCache}
          onFetchDetail={fetchDetail}
        />
      )}
      {busy?.kind === "generate" && (
        <GeneratingOverlay companyLabel={busy.label} startedAt={busy.startedAt} />
      )}
      {busy?.kind === "branch" && (
        <WorkingToast textKey="branchWorking" name={busy.label} startedAt={busy.startedAt} />
      )}
      {busy?.kind === "translate" && (
        <WorkingToast textKey="translateWorking" startedAt={busy.startedAt} />
      )}
    </I18nContext.Provider>
  );
}
