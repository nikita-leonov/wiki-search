// Standalone CLI: read every report-*.json under a directory and emit a
// self-contained HTML page where each chart point is a comparable data point
// — not a run. Run dates do not appear on the X-axis.
//
// Model:
//   • A "Pin" panel chooses which dimensions (prompt / dataset / judge) each
//     cohort pins. Unpinned dims are aggregated. Toggling Pin clears cohorts.
//   • For each pinned dim, a cohort picks an (id, hash) pair. The hash makes
//     cohorts hash-aware: only rows from reports whose artifact hash for that
//     id matches are included. So data accumulates across runs only when the
//     pinned dims are byte-identical.
//   • Granularity picker controls the data-point grain:
//       - "Per iteration": each (item, iteration) tuple is one X position;
//         Y is the mean of the matching rows across all qualifying reports.
//       - "Per item":      each item id is one X position; Y is the mean of
//         all matching rows for that item across reports.
//   • A single metric is selected via dropdown; the chart updates
//     immediately. (Multi-metric overlays were removed — one chart at a
//     time keeps the comparison reading uncluttered.)

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const HELP = `Usage:
  npm run report:html -- [DIR] [--limit N] [--out PATH]

Reads all report-*.json files in DIR (default: evals/runs/), takes the N most
recent by runAt timestamp (default: 50), and writes a self-contained HTML
page that lets you build cohort-vs-cohort data-point comparisons.

Options:
  --limit N    Use only the N most recent reports (default 50).
  --out PATH   Output HTML path (default: <DIR>/comparison.html).
  --help, -h   Show this help.
`;

type RawReport = {
  runAt?: string;
  runDurationMs?: number;
  artifacts?: {
    prompts?: Record<string, string>;
    judges?: Record<string, string>;
    datasets?: Record<string, string>;
  };
  config?: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
};

type SlimReport = {
  sourcePath: string;
  runAt: string;
  runDurationMs: number | null;
  artifacts: RawReport["artifacts"] | null;
  config: RawReport["config"] | null;
  rows: Array<Record<string, unknown>>;
};

function parseArgs(argv: string[]): {
  dir: string;
  limit: number;
  out?: string;
} {
  let dir: string | undefined;
  let limit = 50;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === "--limit") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 1) {
        process.stderr.write(`--limit must be a positive integer\n`);
        process.exit(1);
      }
      limit = v;
    } else if (a === "--out") {
      out = argv[++i];
    } else if (a.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${a}\n`);
      process.exit(1);
    } else if (dir === undefined) {
      dir = a;
    } else {
      process.stderr.write(`Unexpected positional argument: ${a}\n`);
      process.exit(1);
    }
  }
  return { dir: resolve(dir ?? "evals/runs"), limit, out };
}

function slimReport(raw: RawReport, path: string): SlimReport {
  const slimRows = (raw.rows ?? []).map((r) => {
    const { retrievedContext: _drop, ...rest } = r;
    return rest;
  });
  return {
    sourcePath: basename(path),
    runAt: raw.runAt!,
    runDurationMs: raw.runDurationMs ?? null,
    artifacts: raw.artifacts ?? null,
    config: raw.config ?? null,
    rows: slimRows,
  };
}

function loadReports(dir: string, limit: number): SlimReport[] {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith("report-") && f.endsWith(".json"))
      .map((f) => join(dir, f));
  } catch (err) {
    process.stderr.write(
      `Failed to read directory ${dir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  if (files.length === 0) {
    process.stderr.write(`No report-*.json files found in ${dir}\n`);
    process.exit(1);
  }

  const all = files
    .map((path) => {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as RawReport;
        if (typeof raw.runAt !== "string") return null;
        return slimReport(raw, path);
      } catch {
        return null;
      }
    })
    .filter((r): r is SlimReport => r !== null);

  // Sort by runAt desc, take N most recent. (Order in the embedded array
  // is not used as a chart axis — the chart never plots runs.)
  all.sort((a, b) => b.runAt.localeCompare(a.runAt));
  return all.slice(0, limit);
}

function embedJson(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] ?? c,
  );
}

function buildHtml(reports: SlimReport[]): string {
  const title = `Eval Comparison — ${reports.length} run${reports.length === 1 ? "" : "s"}`;
  // The HTML is React + Babel-standalone matching the design handoff. All
  // application logic runs in the browser against the embedded REPORTS data.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: oklch(99% 0.003 240);
    --panel: #ffffff;
    --border: oklch(92% 0.005 240);
    --border-strong: oklch(86% 0.008 240);
    --text: oklch(22% 0.01 240);
    --text-muted: oklch(55% 0.01 240);
    --text-faint: oklch(70% 0.008 240);
    --accent: oklch(55% 0.18 260);
    --accent-soft: oklch(96% 0.02 260);
    --hover: oklch(96% 0.005 240);
    --active: oklch(93% 0.008 240);
    --c1: oklch(58% 0.18 260);
    --c2: oklch(62% 0.18 25);
    --c3: oklch(60% 0.16 155);
    --c4: oklch(64% 0.16 80);
    --shadow-sm: 0 1px 2px rgba(15,23,42,0.04);
    --shadow-md: 0 4px 12px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04);
    --shadow-lg: 0 12px 32px rgba(15,23,42,0.10), 0 2px 6px rgba(15,23,42,0.05);
    --radius: 6px;
    --radius-lg: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 13px;
    color: var(--text);
    background: var(--bg);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    letter-spacing: -0.005em;
  }
  .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
  button { font-family: inherit; font-size: inherit; color: inherit; }
  #root { min-height: 100vh; display: flex; flex-direction: column; }
</style>
</head>
<body>
<div id="root"></div>

<script src="https://unpkg.com/react@18.3.1/umd/react.development.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js" crossorigin="anonymous"></script>

<script id="reports-data" type="application/json">${embedJson(reports)}</script>

<script type="text/babel" data-presets="react">
// ---------------------------------------------------------------------------
// Data prep: derive PROMPTS / DATASETS / JUDGES (each as { id, label, hash }
// where id = composite "label|hash" key) from the embedded reports. METRICS
// includes per-metric range/group so the chart can pick a sensible Y range
// without auto-scaling.
// ---------------------------------------------------------------------------
const REPORTS = JSON.parse(document.getElementById('reports-data').textContent);

const DIM_TO_ARTIFACT_KEY = { prompt: 'prompts', dataset: 'datasets', judge: 'judges' };

function distinctOptions(dim) {
  const out = new Map();
  for (const r of REPORTS) {
    const ids = new Set();
    for (const row of r.rows || []) {
      if (dim === 'judge') for (const s of row.judgeScores || []) ids.add(s.judgeId);
      else if (dim === 'prompt') ids.add(row.promptId);
      else ids.add(row.datasetId);
    }
    const hashMap = (r.artifacts && r.artifacts[DIM_TO_ARTIFACT_KEY[dim]]) || {};
    for (const label of ids) {
      const hash = hashMap[label] ?? null;
      const id = label + '|' + (hash ?? '');
      if (!out.has(id)) out.set(id, { id, label, hash });
    }
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label) || (a.hash ?? '').localeCompare(b.hash ?? ''));
}

const PROMPTS = distinctOptions('prompt');
const DATASETS = distinctOptions('dataset');
const JUDGES = distinctOptions('judge');

// ---------------------------------------------------------------------------
// Metrics: id, label, group, unit (display only), range (Y-axis hint), and
// compute(rows, judgeId) for one row OR many.
// ---------------------------------------------------------------------------
function meanArr(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN; }
function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}
function okRows(rows) { return rows.filter(r => !r.error); }
function judgeScoresIn(rows, judgeId) {
  const out = [];
  for (const r of okRows(rows)) {
    for (const s of r.judgeScores || []) {
      if (judgeId == null || s.judgeId === judgeId) out.push(s);
    }
  }
  return out;
}

const METRICS = [
  { id: 'meanScore', label: 'Mean score', unit: '0–1', range: [0, 1], group: 'Quality',
    compute: (rows, j) => meanArr(judgeScoresIn(rows, j).map(s => s.score)) },
  { id: 'passRate', label: 'Pass rate (judge)', unit: '%', range: [0, 1], group: 'Quality',
    compute: (rows, j) => {
      const ss = judgeScoresIn(rows, j).filter(s => s.pass !== undefined);
      return ss.length ? ss.filter(s => s.pass).length / ss.length : NaN;
    } },
  { id: 'p50LatencyMs', label: 'p50 latency', unit: 'ms', range: [0, 5000], group: 'Performance',
    compute: (rows) => percentile(okRows(rows).map(r => r.latencyMs).sort((a, b) => a - b), 50) },
  { id: 'p95LatencyMs', label: 'p95 latency', unit: 'ms', range: [0, 12000], group: 'Performance',
    compute: (rows) => percentile(okRows(rows).map(r => r.latencyMs).sort((a, b) => a - b), 95) },
  { id: 'meanInputTokens', label: 'Mean input tokens', unit: 'tok', range: [0, 8000], group: 'Cost',
    compute: (rows) => meanArr(okRows(rows).map(r => (r.usage && r.usage.inputTokens) || 0)) },
  { id: 'meanOutputTokens', label: 'Mean output tokens', unit: 'tok', range: [0, 4000], group: 'Cost',
    compute: (rows) => meanArr(okRows(rows).map(r => (r.usage && r.usage.outputTokens) || 0)) },
  { id: 'meanThinkTokens', label: 'Mean think tokens (approx)', unit: 'tok', range: [0, 1000], group: 'Cost',
    compute: (rows) => meanArr(okRows(rows).map(r => (r.usage && r.usage.thinkTokensApprox) || 0)) },
  { id: 'meanSearches', label: 'Mean searches per call', unit: '', range: [0, 6], group: 'Cost',
    compute: (rows) => meanArr(okRows(rows).map(r => r.searches || 0)) },
  { id: 'meanCostUsd', label: 'Mean cost per call', unit: '\\u0024', range: [0, 0.2], group: 'Cost',
    compute: (rows, j) => meanArr(okRows(rows).map(r => {
      const jc = j != null
        ? ((r.judgeScores || []).find(s => s.judgeId === j)?.usage?.costUsd ?? 0)
        : (r.judgeCostUsd ?? 0);
      return (r.costUsd ?? 0) + jc;
    })) },
  { id: 'errorRate', label: 'Error rate', unit: '%', range: [0, 0.2], group: 'Reliability',
    compute: (rows) => rows.length ? rows.filter(r => r.error).length / rows.length : 0 },
];

// ---------------------------------------------------------------------------
// Chart series: walk reports newest-first, qualify by hash, compute per-row
// metric values, then bucket into mean-of-N for up to MAX_POINTS chart points.
// ---------------------------------------------------------------------------
const MAX_POINTS = 25;

function parseOptionId(compositeId) {
  if (compositeId == null) return { label: null, hash: null };
  const idx = compositeId.indexOf('|');
  if (idx < 0) return { label: compositeId, hash: null };
  const hash = compositeId.slice(idx + 1);
  return { label: compositeId.slice(0, idx), hash: hash === '' ? null : hash };
}

function reportQualifies(cohort, report) {
  for (const dim of ['prompt', 'dataset', 'judge']) {
    const composite = cohort[dim];
    if (composite == null) continue; // unpinned
    const { label, hash } = parseOptionId(composite);
    const reportHash = (report.artifacts && report.artifacts[DIM_TO_ARTIFACT_KEY[dim]] && report.artifacts[DIM_TO_ARTIFACT_KEY[dim]][label]) ?? null;
    if (reportHash !== hash) return false;
  }
  return true;
}

function rawValuesFor(cohort, metricId) {
  const metric = METRICS.find(m => m.id === metricId);
  if (!metric) return [];
  const promptLabel = parseOptionId(cohort.prompt).label;
  const datasetLabel = parseOptionId(cohort.dataset).label;
  const judgeLabel = parseOptionId(cohort.judge).label;
  const values = [];
  for (const r of REPORTS) {
    if (!reportQualifies(cohort, r)) continue;
    for (const row of r.rows || []) {
      if (cohort.prompt != null && row.promptId !== promptLabel) continue;
      if (cohort.dataset != null && row.datasetId !== datasetLabel) continue;
      const v = metric.compute([row], judgeLabel);
      if (Number.isFinite(v)) values.push(v);
    }
  }
  return values;
}

function bucketRawValues(values, sampleSize) {
  const out = [];
  for (let i = 0; i < values.length && out.length < MAX_POINTS; i += sampleSize) {
    const bucket = values.slice(i, i + sampleSize);
    if (!bucket.length) break;
    out.push(bucket.reduce((a, b) => a + b, 0) / bucket.length);
  }
  return out;
}

function generateSeries(cohort, metricId, sampleSize) {
  const raw = rawValuesFor(cohort, metricId);
  return bucketRawValues(raw, Math.max(1, sampleSize));
}

window.EvalData = { REPORTS, PROMPTS, DATASETS, JUDGES, METRICS, MAX_POINTS, generateSeries, parseOptionId };
</script>

<script type="text/babel" data-presets="react">
const { useState, useRef, useEffect, useLayoutEffect } = React;

function Popover({ open, onClose, anchorRef, children, align = 'start', offset = 6 }) {
  const popRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !popRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const p = popRef.current.getBoundingClientRect();
    let left = r.left;
    if (align === 'end') left = r.right - p.width;
    if (align === 'center') left = r.left + r.width / 2 - p.width / 2;
    let top = r.bottom + offset;
    const margin = 8;
    if (left + p.width > window.innerWidth - margin) left = window.innerWidth - margin - p.width;
    if (left < margin) left = margin;
    if (top + p.height > window.innerHeight - margin) top = r.top - offset - p.height;
    setPos({ top, left });
  }, [open, align, offset, anchorRef]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (popRef.current?.contains(e.target)) return;
      if (anchorRef.current?.contains(e.target)) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);
  if (!open) return null;
  return (
    <div ref={popRef} style={{
      position: 'fixed', top: pos.top, left: pos.left, zIndex: 100,
      background: 'var(--panel)', border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)',
      minWidth: 220, overflow: 'hidden', animation: 'pop-in 120ms ease-out',
    }}>{children}</div>
  );
}

function InfoTip({ children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  return (
    <span ref={ref}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{ display: 'inline-flex', alignItems: 'center', position: 'relative', cursor: 'help' }}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color: 'var(--text-faint)' }}>
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="5.2" r="0.8" fill="currentColor" />
        <path d="M8 7.5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      {open && (
        <span style={{
          position: 'absolute', top: '100%', left: '50%',
          transform: 'translate(-50%, 6px)',
          background: 'oklch(22% 0.01 240)', color: 'oklch(96% 0.005 240)',
          padding: '8px 10px', borderRadius: 6, fontSize: 12, lineHeight: 1.45,
          width: 260, zIndex: 200, fontWeight: 400, letterSpacing: 0,
          textTransform: 'none', pointerEvents: 'none', boxShadow: 'var(--shadow-md)',
        }}>{children}</span>
      )}
    </span>
  );
}

const chipBase = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  height: 28, padding: '0 10px',
  background: 'var(--panel)', border: '1px solid var(--border)',
  borderRadius: 6, cursor: 'pointer', fontSize: 13, color: 'var(--text)',
  transition: 'background 80ms, border-color 80ms', whiteSpace: 'nowrap',
};

function SectionLabel({ children, info }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      textTransform: 'uppercase', letterSpacing: '0.06em',
      fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginRight: 8,
    }}>
      {children}
      {info && <InfoTip>{info}</InfoTip>}
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = 1, width = 64 }) {
  return (
    <input type="number" value={value} min={min} max={max} step={step}
      onChange={e => onChange(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, Number(e.target.value) || 0)))}
      style={{
        height: 26, width, border: '1px solid var(--border)', borderRadius: 6,
        padding: '0 8px', fontFamily: 'inherit', fontSize: 13,
        color: 'var(--text)', background: 'var(--panel)', outline: 'none',
      }}
      onFocus={e => e.target.style.borderColor = 'var(--accent)'}
      onBlur={e => e.target.style.borderColor = 'var(--border)'}
    />
  );
}

const styleEl = document.createElement('style');
styleEl.textContent = \`
  @keyframes pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
  ::selection { background: var(--accent-soft); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
\`;
document.head.appendChild(styleEl);

Object.assign(window, { Popover, InfoTip, SectionLabel, NumberInput, chipBase });
</script>

<script type="text/babel" data-presets="react">
const { useState: useStateT, useRef: useRefT, useMemo: useMemoT } = React;

function ListPopover({ open, onClose, anchorRef, items, value, onSelect, includeAny }) {
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} align="start">
      <div style={{ padding: 4, maxHeight: 320, overflowY: 'auto', minWidth: 240 }}>
        {includeAny && (
          <button
            onClick={() => { onSelect(null); onClose(); }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              padding: '7px 10px', background: value == null ? 'var(--accent-soft)' : 'transparent',
              border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 13, textAlign: 'left',
              color: 'var(--text)', fontStyle: 'italic',
            }}
            onMouseEnter={e => { if (value != null) e.currentTarget.style.background = 'var(--hover)'; }}
            onMouseLeave={e => { if (value != null) e.currentTarget.style.background = 'transparent'; }}
          >
            <span>any (aggregate)</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>—</span>
          </button>
        )}
        {items.map(item => {
          const selected = item.id === value;
          return (
            <button key={item.id}
              onClick={() => { onSelect(item.id); onClose(); }}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                padding: '7px 10px', background: selected ? 'var(--accent-soft)' : 'transparent',
                border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 13, textAlign: 'left', color: 'var(--text)',
              }}
              onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--hover)'; }}
              onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
            >
              <span>{item.label}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{item.hash || 'no hash'}</span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

function CohortDimChip({ items, value, onChange, onClear, mode, dimLabel, dimFull }) {
  const [open, setOpen] = useStateT(false);
  const ref = useRefT(null);
  const item = items.find(i => i.id === value);
  const isAny = mode === 'any';
  const showClear = mode === 'set' && onClear;
  return (
    <>
      <button ref={ref}
        onClick={() => setOpen(o => !o)}
        title={isAny ? \`Set \${dimFull.toLowerCase()}\` : \`Change \${dimFull.toLowerCase()}\`}
        style={{
          ...chipBase, height: 26, padding: showClear ? '0 4px 0 8px' : '0 8px',
          fontSize: 12.5, gap: 5,
          background: isAny ? 'transparent' : 'var(--panel)',
          borderColor: 'var(--border)', borderStyle: isAny ? 'dashed' : 'solid',
          color: isAny ? 'var(--text-muted)' : 'var(--text)',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = isAny ? 'transparent' : 'var(--panel)'; }}
      >
        <span style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)', fontWeight: 600 }}>{dimLabel}</span>
        <span style={{ fontWeight: 500, fontStyle: isAny ? 'italic' : 'normal' }}>
          {isAny ? 'any' : item?.label}
        </span>
        {!showClear && (
          <svg width="9" height="9" viewBox="0 0 10 10" style={{ color: 'var(--text-faint)', marginLeft: 1 }}>
            <path d="M2 4 L5 7 L8 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
        {showClear && (
          <span role="button" onClick={(e) => { e.stopPropagation(); onClear(); }}
            title={\`Clear \${dimFull.toLowerCase()} pin\`}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 16, height: 16, marginLeft: 2, borderRadius: 3, color: 'var(--text-faint)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--active)'; e.currentTarget.style.color = 'var(--text)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-faint)'; }}
          >
            <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </span>
        )}
      </button>
      <ListPopover open={open} onClose={() => setOpen(false)} anchorRef={ref}
        items={items} value={value} onSelect={onChange} includeAny={mode === 'any' || mode === 'set'} />
    </>
  );
}

function CohortRow({ cohort, idx, color, isBase, pinnedDims, onChange, onClearDim, onRemove, canRemove }) {
  const { PROMPTS, DATASETS, JUDGES } = window.EvalData;
  const DIMS = [
    { key: 'prompt', items: PROMPTS, label: 'P', full: 'Prompt' },
    { key: 'dataset', items: DATASETS, label: 'D', full: 'Dataset' },
    { key: 'judge', items: JUDGES, label: 'J', full: 'Judge' },
  ];
  const visibleDims = isBase ? DIMS : DIMS.filter(d => pinnedDims.includes(d.key));
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      height: 30, padding: '0 4px 0 8px',
      background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8,
    }}>
      <span style={{ width: 8, height: 8, borderRadius: 99, background: color, flexShrink: 0, marginRight: 4 }} />
      <span style={{ fontWeight: 500, fontSize: 12, color: 'var(--text-muted)', marginRight: 2 }}>
        C{idx + 1}
      </span>
      {isBase && (
        <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint)', fontWeight: 600, marginRight: 2 }}>
          base
        </span>
      )}
      <span style={{ width: 1, height: 14, background: 'var(--border)', margin: '0 2px' }} />
      {visibleDims.map(d => {
        const v = cohort[d.key];
        const mode = isBase ? (v == null ? 'any' : 'set') : 'follower';
        return (
          <CohortDimChip key={d.key}
            items={d.items} value={v} mode={mode}
            dimLabel={d.label} dimFull={d.full}
            onChange={val => onChange({ ...cohort, [d.key]: val })}
            onClear={isBase && v != null ? () => onClearDim(d.key) : null}
          />
        );
      })}
      {canRemove && !isBase && (
        <button onClick={onRemove} title="Remove cohort"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 22, height: 22, marginLeft: 2,
            background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer', color: 'var(--text-faint)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)'; e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-faint)'; }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
        </button>
      )}
    </div>
  );
}

function MetricSelect({ value, onChange }) {
  const { METRICS } = window.EvalData;
  const [open, setOpen] = useStateT(false);
  const ref = useRefT(null);
  const current = METRICS.find(m => m.id === value);
  const groups = useMemoT(() => {
    const map = new Map();
    for (const m of METRICS) {
      if (!map.has(m.group)) map.set(m.group, []);
      map.get(m.group).push(m);
    }
    return [...map.entries()];
  }, []);
  return (
    <>
      <button ref={ref} onClick={() => setOpen(o => !o)}
        style={{
          ...chipBase, height: 30, padding: '0 12px',
          background: 'oklch(22% 0.01 240)', color: 'white', borderColor: 'oklch(22% 0.01 240)',
          fontWeight: 500, gap: 8,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path d="M2 11 L5 7 L8 9 L12 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {current?.label}
        <span style={{ opacity: 0.55, fontSize: 11, fontFamily: 'JetBrains Mono, monospace' }}>{current?.unit}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" style={{ opacity: 0.6, marginLeft: 2 }}>
          <path d="M2 4 L5 7 L8 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align="end">
        <div style={{ padding: 4, minWidth: 280 }}>
          {groups.map(([groupName, list]) => (
            <div key={groupName} style={{ marginBottom: 4 }}>
              <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-faint)', fontWeight: 600, padding: '8px 10px 4px' }}>{groupName}</div>
              {list.map(m => {
                const sel = m.id === value;
                return (
                  <button key={m.id} onClick={() => { onChange(m.id); setOpen(false); }}
                    style={{
                      width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '7px 10px', background: sel ? 'var(--accent-soft)' : 'transparent',
                      border: 'none', borderRadius: 5, cursor: 'pointer', textAlign: 'left',
                      fontSize: 13, color: 'var(--text)', gap: 12,
                    }}
                    onMouseEnter={e => { if (!sel) e.currentTarget.style.background = 'var(--hover)'; }}
                    onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span>{m.label}</span>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>{m.unit}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

function AddCohortButton({ onClick }) {
  return (
    <button onClick={onClick}
      style={{ ...chipBase, height: 30, padding: '0 10px', borderStyle: 'dashed', color: 'var(--text-muted)', gap: 5 }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--hover)'; e.currentTarget.style.color = 'var(--text)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--panel)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
    >
      <svg width="11" height="11" viewBox="0 0 11 11"><path d="M5.5 1.5 V9.5 M1.5 5.5 H9.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
      Add cohort
    </button>
  );
}

function Toolbar({ state, dispatch }) {
  const { sampleSize, metric, cohorts } = state;
  const cohortColors = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];
  const base = cohorts[0];
  const pinnedDims = ['prompt', 'dataset', 'judge'].filter(k => base[k] != null);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '10px 18px', background: 'var(--panel)', borderBottom: '1px solid var(--border)',
      flexWrap: 'wrap', rowGap: 10,
    }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <SectionLabel info="Each chart point is the mean of sample-size consecutive raw values, gathered newest-first across qualifying reports. 1 = individual values; up to 25 points are shown per cohort.">
          Sample
        </SectionLabel>
        <NumberInput value={sampleSize} onChange={v => dispatch({ type: 'setSampleSize', value: v })} min={1} max={50} width={56} />
      </div>
      <Divider />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <SectionLabel>Metric</SectionLabel>
        <MetricSelect value={metric} onChange={v => dispatch({ type: 'setMetric', value: v })} />
      </div>
      <Divider />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', rowGap: 6 }}>
        <SectionLabel info="The first cohort is the base. Set fields to pin them across all cohorts. Unset fields are aggregated. Subsequent cohorts can only override pinned fields.">
          Cohorts
        </SectionLabel>
        {cohorts.map((c, i) => (
          <CohortRow key={c._id} cohort={c} idx={i}
            color={cohortColors[i % cohortColors.length]}
            isBase={i === 0} pinnedDims={pinnedDims}
            canRemove={cohorts.length > 1}
            onChange={next => dispatch({ type: 'updateCohort', id: c._id, cohort: next })}
            onClearDim={dim => dispatch({ type: 'clearBaseDim', dim })}
            onRemove={() => dispatch({ type: 'removeCohort', id: c._id })}
          />
        ))}
        {cohorts.length < 4 && pinnedDims.length > 0 && (
          <AddCohortButton onClick={() => dispatch({ type: 'addCohort' })} />
        )}
      </div>
    </div>
  );
}

function Divider() {
  return <span style={{ width: 1, height: 22, background: 'var(--border)' }} />;
}

Object.assign(window, { Toolbar });
</script>

<script type="text/babel" data-presets="react">
const { useMemo: useMemoC, useState: useStateC, useRef: useRefC, useEffect: useEffectC } = React;

function fmt(v, unit) {
  if (unit === '\\u0024') return '\\u0024' + v.toFixed(3);
  if (unit === '%') return (v * 100).toFixed(1) + '%';
  if (unit === 'ms') return Math.round(v) + ' ms';
  if (unit === 'tok') return Math.round(v).toLocaleString() + ' tok';
  if (unit === '0–1') return v.toFixed(3);
  return v.toFixed(2) + (unit ? ' ' + unit : '');
}

function Chart({ state }) {
  const { metric, cohorts, sampleSize } = state;
  const { METRICS, generateSeries, PROMPTS, DATASETS, JUDGES, MAX_POINTS } = window.EvalData;
  const metricDef = METRICS.find(m => m.id === metric);
  const [hoverIdx, setHoverIdx] = useStateC(null);
  const wrapRef = useRefC(null);
  const [size, setSize] = useStateC({ w: 1200, h: 520 });

  useEffectC(() => {
    if (!wrapRef.current) return;
    let raf = 0;
    const update = () => {
      if (!wrapRef.current) return;
      const cr = wrapRef.current.getBoundingClientRect();
      setSize(prev => {
        const nw = Math.max(600, Math.round(cr.width));
        const nh = Math.max(360, Math.round(cr.height));
        if (Math.abs(prev.w - nw) < 2 && Math.abs(prev.h - nh) < 2) return prev;
        return { w: nw, h: nh };
      });
    };
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(update); });
    ro.observe(wrapRef.current);
    update();
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  const cohortColors = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];

  const series = useMemoC(() => {
    return cohorts.map((c, i) => ({
      id: c._id,
      color: cohortColors[i % cohortColors.length],
      cohort: c,
      points: generateSeries(c, metric, sampleSize),
    }));
  }, [cohorts, metric, sampleSize]);

  const longest = Math.max(0, ...series.map(s => s.points.length));
  const N = Math.max(1, longest);

  const padding = { top: 28, right: 32, bottom: 56, left: 64 };
  const W = size.w;
  const H = size.h;
  const innerW = W - padding.left - padding.right;
  const innerH = H - padding.top - padding.bottom;

  const allVals = series.flatMap(s => s.points);
  let yMin = metricDef.range[0];
  let yMax = metricDef.range[1];
  if (allVals.length) {
    const dataMin = Math.min(...allVals);
    const dataMax = Math.max(...allVals);
    const span = dataMax - dataMin;
    if (span < (yMax - yMin) * 0.5 && span > 0) {
      const pad = span * 0.3;
      yMin = Math.max(metricDef.range[0], dataMin - pad);
      yMax = Math.min(metricDef.range[1], dataMax + pad);
    }
    if (yMax === yMin) { yMin = Math.max(0, yMin - 0.01); yMax = yMax + 0.01; }
  }

  const xAt = (i) => padding.left + (N === 1 ? innerW / 2 : (i / (N - 1)) * innerW);
  const yAt = (v) => padding.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  const yTicks = useMemoC(() => {
    const ticks = [];
    for (let i = 0; i <= 4; i++) ticks.push(yMin + (i / 4) * (yMax - yMin));
    return ticks;
  }, [yMin, yMax]);

  const xTicks = useMemoC(() => {
    const out = [];
    const step = N <= 10 ? 1 : N <= 25 ? 5 : 10;
    for (let i = 0; i < N; i += step) out.push(i);
    if (out[out.length - 1] !== N - 1) out.push(N - 1);
    return out;
  }, [N]);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < padding.left || px > W - padding.right) { setHoverIdx(null); return; }
    const t = (px - padding.left) / innerW;
    const idx = Math.round(t * (N - 1));
    setHoverIdx(Math.max(0, Math.min(N - 1, idx)));
  };

  const labelFor = (c) => {
    const p = c.prompt != null ? PROMPTS.find(x => x.id === c.prompt) : null;
    const d = c.dataset != null ? DATASETS.find(x => x.id === c.dataset) : null;
    const j = c.judge != null ? JUDGES.find(x => x.id === c.judge) : null;
    const parts = [p?.label, d?.label, j?.label].filter(Boolean);
    return parts.length ? parts.join(' · ') : 'all data';
  };

  return (
    <div style={{
      flex: 1, minHeight: 0, position: 'relative', padding: '20px',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 4px 14px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>{metricDef.label}</h2>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            {metricDef.unit} · {sampleSize === 1 ? 'individual values' : \`mean of \${sampleSize}\`} · longest {longest}/\${MAX_POINTS} pts
          </span>
        </div>
      </div>

      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {longest === 0 ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13, fontStyle: 'italic' }}>
            No matching data — pinned hashes filter all reports out, or no rows match the chosen cohort.
          </div>
        ) : (
          <svg width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}
            style={{ display: 'block', userSelect: 'none', position: 'absolute', top: 0, left: 0 }}>
            {yTicks.map((v, i) => (
              <g key={i}>
                <line x1={padding.left} x2={W - padding.right} y1={yAt(v)} y2={yAt(v)}
                  stroke="var(--border)" strokeDasharray={i === 0 ? '0' : '2 4'} strokeWidth={1} />
                <text x={padding.left - 10} y={yAt(v) + 4} textAnchor="end" fontSize="11"
                  fill="var(--text-muted)" fontFamily="JetBrains Mono, monospace">{fmt(v, metricDef.unit)}</text>
              </g>
            ))}
            {xTicks.map(i => (
              <text key={i} x={xAt(i)} y={H - padding.bottom + 18} textAnchor="middle" fontSize="11"
                fill="var(--text-muted)" fontFamily="JetBrains Mono, monospace">{i + 1}</text>
            ))}
            <text x={padding.left + innerW / 2} y={H - padding.bottom + 38} textAnchor="middle"
              fontSize="10" fill="var(--text-faint)" fontFamily="Inter"
              style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              data point (newest-first, sample-size mean)
            </text>
            <text x={-(padding.top + innerH / 2)} y={16} transform="rotate(-90)" textAnchor="middle"
              fontSize="10" fill="var(--text-faint)" fontFamily="Inter"
              style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {metricDef.label} ({metricDef.unit})
            </text>
            {hoverIdx !== null && (
              <line x1={xAt(hoverIdx)} x2={xAt(hoverIdx)} y1={padding.top} y2={H - padding.bottom}
                stroke="var(--border-strong)" strokeWidth="1" />
            )}
            {series.map(s => {
              if (s.points.length === 0) return null;
              const path = s.points.map((v, i) => \`\${i === 0 ? 'M' : 'L'} \${xAt(i).toFixed(2)} \${yAt(v).toFixed(2)}\`).join(' ');
              return (
                <g key={s.id}>
                  <path d={path} fill="none" stroke={s.color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                  {s.points.map((v, i) => (
                    <circle key={i} cx={xAt(i)} cy={yAt(v)} r={hoverIdx === i ? 4 : 2.2}
                      fill={s.color} stroke="var(--panel)" strokeWidth={hoverIdx === i ? 1.5 : 0} />
                  ))}
                </g>
              );
            })}
          </svg>
        )}
        {hoverIdx !== null && longest > 0 && (
          <div style={{
            position: 'absolute', left: Math.min(W - 240, xAt(hoverIdx) + 12), top: padding.top + 8,
            background: 'var(--panel)', border: '1px solid var(--border-strong)', borderRadius: 8,
            boxShadow: 'var(--shadow-md)', padding: '10px 12px', minWidth: 220, pointerEvents: 'none', fontSize: 12,
          }}>
            <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, color: 'var(--text-faint)', marginBottom: 8 }}>
              Sample {hoverIdx + 1}
            </div>
            {series.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: s.color, flexShrink: 0 }} />
                <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 11.5 }}>{labelFor(s.cohort)}</span>
                <span className="mono" style={{ fontWeight: 500, color: 'var(--text)' }}>
                  {Number.isFinite(s.points[hoverIdx]) ? fmt(s.points[hoverIdx], metricDef.unit) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', gap: 16, padding: '14px 4px 0',
        borderTop: '1px solid var(--border)', marginTop: 4, flexWrap: 'wrap', flexShrink: 0,
      }}>
        {series.map((s, i) => {
          const valid = s.points.filter(v => Number.isFinite(v));
          const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : NaN;
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ width: 10, height: 2, background: s.color, borderRadius: 1 }} />
              <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>C{i + 1}</span>
              <span>{labelFor(s.cohort)}</span>
              <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                {valid.length} pt{valid.length === 1 ? '' : 's'}{valid.length > 0 ? \` · avg \${fmt(mean, metricDef.unit)}\` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { Chart });
</script>

<script type="text/babel" data-presets="react">
const { useReducer } = React;
const { PROMPTS: PROMPTS_A, DATASETS: DATASETS_A, JUDGES: JUDGES_A, METRICS: METRICS_A, REPORTS: REPORTS_A } = window.EvalData;

function pickInitialCohorts() {
  const baseCohort = { _id: 1 };
  if (PROMPTS_A.length > 0) baseCohort.prompt = PROMPTS_A[0].id;
  if (DATASETS_A.length > 0) baseCohort.dataset = DATASETS_A[0].id;
  const llmJudge = JUDGES_A.find(j => j.hash) ?? JUDGES_A[0];
  if (llmJudge) baseCohort.judge = llmJudge.id;

  if (PROMPTS_A.length >= 2) {
    const second = { _id: 2 };
    second.prompt = PROMPTS_A[1].id;
    if (baseCohort.dataset) second.dataset = baseCohort.dataset;
    if (baseCohort.judge) second.judge = baseCohort.judge;
    return [baseCohort, second];
  }
  return [baseCohort];
}

const INITIAL = {
  sampleSize: 1,
  metric: 'meanScore',
  cohorts: pickInitialCohorts(),
  _nextId: 3,
};

function reshapeCohorts(cohorts) {
  if (cohorts.length === 0) return cohorts;
  const base = cohorts[0];
  const pinnedDims = ['prompt', 'dataset', 'judge'].filter(k => base[k] != null);
  return cohorts.map((c, i) => {
    if (i === 0) return c;
    const next = { _id: c._id };
    for (const k of pinnedDims) next[k] = c[k] != null ? c[k] : base[k];
    return next;
  });
}

function reducer(state, action) {
  switch (action.type) {
    case 'setSampleSize': return { ...state, sampleSize: action.value };
    case 'setMetric': return { ...state, metric: action.value };
    case 'updateCohort': {
      const cohorts = state.cohorts.map(c => c._id === action.id ? { ...action.cohort, _id: c._id } : c);
      return { ...state, cohorts: reshapeCohorts(cohorts) };
    }
    case 'clearBaseDim': {
      const base = { ...state.cohorts[0], [action.dim]: null };
      const cohorts = [base, ...state.cohorts.slice(1)];
      return { ...state, cohorts: reshapeCohorts(cohorts) };
    }
    case 'addCohort': {
      const base = state.cohorts[0];
      const pinnedDims = ['prompt', 'dataset', 'judge'].filter(k => base[k] != null);
      const next = { _id: state._nextId };
      for (const k of pinnedDims) next[k] = base[k];
      return { ...state, cohorts: [...state.cohorts, next], _nextId: state._nextId + 1 };
    }
    case 'removeCohort':
      return { ...state, cohorts: state.cohorts.filter(c => c._id !== action.id) };
    default: return state;
  }
}

function Header() {
  const stats = [
    { label: 'reports', value: REPORTS_A.length },
    { label: 'prompts', value: PROMPTS_A.length },
    { label: 'datasets', value: DATASETS_A.length },
    { label: 'judges', value: JUDGES_A.length },
  ];
  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 18px', borderBottom: '1px solid var(--border)', background: 'var(--panel)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6, background: 'oklch(22% 0.01 240)',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M2 11 L5 7 L8 9 L12 3" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h1 style={{ margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.005em' }}>Eval Comparison</h1>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <div style={{ display: 'flex', gap: 14 }}>
          {stats.map(s => (
            <div key={s.label} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, fontSize: 12 }}>
              <span className="mono" style={{ fontWeight: 500 }}>{s.value}</span>
              <span style={{ color: 'var(--text-faint)' }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>/run/comparison</span>
      </div>
    </header>
  );
}

function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  return (
    <>
      <Header />
      <Toolbar state={state} dispatch={dispatch} />
      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Chart state={state} />
      </main>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
</script>
</body>
</html>`;
}

const { dir, limit, out } = parseArgs(process.argv.slice(2));
const reports = loadReports(dir, limit);
const outputPath = out ? resolve(out) : join(dir, "comparison.html");
writeFileSync(outputPath, buildHtml(reports));
process.stderr.write(
  `Wrote: ${outputPath} (${reports.length} report${reports.length === 1 ? "" : "s"} — last ${reports.length} by runAt)\n`,
);
process.stderr.write(`Open in a browser: file://${outputPath}\n`);
