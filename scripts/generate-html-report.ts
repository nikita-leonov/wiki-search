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
//   • Multiple metrics → multiple charts; each shares the same cohort lines
//     and the same X-axis (the union of positions seen across cohorts).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const HELP = `Usage:
  npm run report:html -- [DIR] [--limit N] [--out PATH]

Reads all report-*.json files in DIR (default: evals/runs/), takes the N most
recent by runAt timestamp (default: 15), and writes a self-contained HTML
page that lets you build cohort-vs-cohort data-point comparisons.

Options:
  --limit N    Use only the N most recent reports (default 15).
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
  let limit = 15;
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root {
    --fg: #1a1a1a;
    --muted: #6b6b6b;
    --bg: #fafafa;
    --panel: #fff;
    --border: #e3e3e3;
    --accent: #2563eb;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: var(--fg);
    background: var(--bg);
  }
  header {
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
  }
  header h1 { margin: 0 0 4px 0; font-size: 18px; }
  header .meta { color: var(--muted); font-size: 12px; font-family: ui-monospace, "SF Mono", monospace; }
  header .meta .row { display: block; }
  main { padding: 24px; max-width: 1280px; margin: 0 auto; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
  section h2 { margin: 0 0 12px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  label { display: inline-flex; align-items: center; gap: 6px; }
  select, button, input { font: inherit; }
  select { padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; background: white; }
  button {
    padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px;
    background: white; cursor: pointer;
  }
  button:hover { background: #f0f0f0; }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.primary:hover { background: #1d4ed8; }
  button.remove { padding: 2px 8px; color: var(--muted); }
  .row-controls { display: flex; gap: 24px; flex-wrap: wrap; }
  .cohort-row {
    display: flex; align-items: center; gap: 12px;
    padding: 6px 0; border-bottom: 1px dashed var(--border);
    flex-wrap: wrap;
  }
  .cohort-row:last-child { border-bottom: none; }
  .cohort-row .swatch { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
  .cohort-row .name { font-weight: 600; min-width: 80px; }
  .metric-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 6px 16px;
  }
  .chart-card { padding: 12px 0; }
  .chart-card h3 { margin: 0 0 8px 0; font-size: 13px; color: var(--muted); }
  canvas { max-height: 360px; }
  .empty { color: var(--muted); font-style: italic; padding: 12px 0; }
  .footnote { color: var(--muted); font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>Eval Comparison</h1>
  <div class="meta" id="meta"></div>
</header>

<main>
  <section>
    <h2>Cohort shape</h2>
    <div class="row-controls" id="pin-controls">
      <label><input type="checkbox" data-dim="promptId" checked> Pin <strong>prompt</strong></label>
      <label><input type="checkbox" data-dim="datasetId" checked> Pin <strong>dataset</strong></label>
      <label><input type="checkbox" data-dim="judgeId" checked> Pin <strong>judge</strong></label>
    </div>
    <div class="footnote">Each cohort fixes the pinned dimensions (id + hash); unpinned dimensions are aggregated. Changing the pin set resets cohorts. A cohort only includes data from reports where the artifact hash of the pinned id matches — so accumulating across runs only happens when the pinned artifacts are byte-identical.</div>
  </section>

  <section>
    <h2>Granularity</h2>
    <div class="row-controls" id="granularity-controls">
      <label><input type="radio" name="granularity" value="iteration" checked> Per <strong>iteration</strong> (each item × iter is one point)</label>
      <label><input type="radio" name="granularity" value="item"> Per <strong>item</strong> (mean of iterations)</label>
    </div>
    <div class="footnote">Each X position aggregates all matching rows across qualifying reports as a mean.</div>
  </section>

  <section>
    <h2>Cohorts</h2>
    <div id="cohorts"></div>
    <button id="add-cohort" class="primary" style="margin-top: 8px;">+ Add cohort</button>
  </section>

  <section>
    <h2>Metrics</h2>
    <div id="metrics" class="metric-grid"></div>
  </section>

  <section>
    <h2>Charts</h2>
    <div id="charts"></div>
  </section>
</main>

<script id="reports-data" type="application/json">${embedJson(reports)}</script>

<script>
(() => {
  const REPORTS = JSON.parse(document.getElementById("reports-data").textContent);

  const DIM_LABELS = { promptId: "Prompt", datasetId: "Dataset", judgeId: "Judge" };
  const DIMS = ["promptId", "datasetId", "judgeId"];
  const DIM_TO_ARTIFACT_KEY = { promptId: "prompts", datasetId: "datasets", judgeId: "judges" };

  // ──────────────────────────────────────────────────────────────────────────
  // Distinct (id, hash) options per dim, gathered across all loaded reports.
  // The id list comes from rows; the hash comes from the report's artifacts
  // map for that dim. A dim id with two different hashes across reports
  // becomes two separate options (correctly so — they're not interchangeable).
  // ──────────────────────────────────────────────────────────────────────────
  function collectIdsInReport(report, dim) {
    const ids = new Set();
    for (const row of (report.rows || [])) {
      if (dim === "judgeId") {
        for (const s of (row.judgeScores || [])) ids.add(s.judgeId);
      } else if (dim === "promptId") {
        ids.add(row.promptId);
      } else if (dim === "datasetId") {
        ids.add(row.datasetId);
      }
    }
    return ids;
  }

  function distinctOptions(dim) {
    const seen = new Map();
    for (const r of REPORTS) {
      const idsInRows = collectIdsInReport(r, dim);
      const hashMap = (r.artifacts && r.artifacts[DIM_TO_ARTIFACT_KEY[dim]]) || {};
      for (const id of idsInRows) {
        const hash = hashMap[id] ?? null;
        const key = id + "|" + (hash ?? "");
        if (!seen.has(key)) seen.set(key, { id, hash, key });
      }
    }
    return Array.from(seen.values()).sort((a, b) =>
      a.id.localeCompare(b.id) || (a.hash ?? "").localeCompare(b.hash ?? ""));
  }

  const VALUES = {
    promptId: distinctOptions("promptId"),
    datasetId: distinctOptions("datasetId"),
    judgeId: distinctOptions("judgeId"),
  };

  function optionLabel(opt) {
    return opt.hash ? opt.id + " (" + opt.hash + ")" : opt.id + " (no hash)";
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Metric definitions
  // ──────────────────────────────────────────────────────────────────────────
  function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN; }
  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    if (sorted.length === 1) return sorted[0];
    const rank = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(rank), hi = Math.ceil(rank);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
  }
  function okRows(rows) { return rows.filter(r => !r.error); }
  function judgeScoresOf(rows, judgeId) {
    const out = [];
    for (const r of okRows(rows)) {
      for (const s of (r.judgeScores || [])) {
        if (judgeId == null || s.judgeId === judgeId) out.push(s);
      }
    }
    return out;
  }

  const METRICS = {
    meanScore: {
      label: "Mean score (0–1)",
      compute: (rows, judgeId) => mean(judgeScoresOf(rows, judgeId).map(s => s.score)),
    },
    passRate: {
      label: "Pass rate (judge.pass)",
      compute: (rows, judgeId) => {
        const ss = judgeScoresOf(rows, judgeId).filter(s => s.pass !== undefined);
        return ss.length ? ss.filter(s => s.pass).length / ss.length : NaN;
      },
    },
    p50LatencyMs: {
      label: "p50 latency (ms)",
      compute: (rows) => percentile(okRows(rows).map(r => r.latencyMs).sort((a, b) => a - b), 50),
    },
    p95LatencyMs: {
      label: "p95 latency (ms)",
      compute: (rows) => percentile(okRows(rows).map(r => r.latencyMs).sort((a, b) => a - b), 95),
    },
    meanInputTokens: {
      label: "Mean input tokens",
      compute: (rows) => mean(okRows(rows).map(r => (r.usage && r.usage.inputTokens) || 0)),
    },
    meanOutputTokens: {
      label: "Mean output tokens",
      compute: (rows) => mean(okRows(rows).map(r => (r.usage && r.usage.outputTokens) || 0)),
    },
    meanThinkTokens: {
      label: "Mean think tokens (approx)",
      compute: (rows) => mean(okRows(rows).map(r => (r.usage && r.usage.thinkTokensApprox) || 0)),
    },
    meanSearches: {
      label: "Mean searches per cell",
      compute: (rows) => mean(okRows(rows).map(r => r.searches || 0)),
    },
    meanCostUsd: {
      label: "Mean cost per cell ($)",
      compute: (rows, judgeId) => {
        return mean(okRows(rows).map(r => {
          const judgeCost = judgeId != null
            ? ((r.judgeScores || []).find(s => s.judgeId === judgeId)?.usage?.costUsd ?? 0)
            : (r.judgeCostUsd ?? 0);
          return (r.costUsd ?? 0) + judgeCost;
        }));
      },
    },
    errorRate: {
      label: "Error rate",
      compute: (rows) => rows.length ? rows.filter(r => r.error).length / rows.length : 0,
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────────────
  const state = {
    pin: { promptId: true, datasetId: true, judgeId: true },
    granularity: "iteration",
    cohorts: [], // { id, promptId?, promptHash?, datasetId?, datasetHash?, judgeId?, judgeHash? }
    metrics: ["meanScore"],
    nextCohortId: 1,
  };

  function pinnedDims() { return DIMS.filter(d => state.pin[d]); }

  function newCohort() {
    const cohort = { id: state.nextCohortId++ };
    for (const d of pinnedDims()) {
      const first = VALUES[d][0];
      if (first) {
        cohort[d] = first.id;
        cohort[d + "Hash"] = first.hash;
      }
    }
    return cohort;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hash-aware filtering: a report is "qualifying" for a cohort iff for every
  // pinned dim, the report's artifact hash for that id matches the cohort's
  // pinned hash. Non-qualifying reports contribute zero rows to the cohort.
  // ──────────────────────────────────────────────────────────────────────────
  function reportQualifies(cohort, report) {
    for (const d of DIMS) {
      if (!state.pin[d]) continue;
      if (cohort[d] == null) continue;
      const reportHash = (report.artifacts && report.artifacts[DIM_TO_ARTIFACT_KEY[d]] && report.artifacts[DIM_TO_ARTIFACT_KEY[d]][cohort[d]]) ?? null;
      const cohortHash = cohort[d + "Hash"] ?? null;
      if (reportHash !== cohortHash) return false;
    }
    return true;
  }

  function rowsFor(cohort) {
    const rows = [];
    for (const r of REPORTS) {
      if (!reportQualifies(cohort, r)) continue;
      for (const row of (r.rows || [])) {
        if (state.pin.promptId && cohort.promptId != null && row.promptId !== cohort.promptId) continue;
        if (state.pin.datasetId && cohort.datasetId != null && row.datasetId !== cohort.datasetId) continue;
        // judgeId never excludes rows (it filters scores in metric calc)
        rows.push(row);
      }
    }
    return rows;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Build (label → mean Y) per cohort according to granularity. Returns:
  //   { positions: string[], byPosition: Map<position, value|null> }
  // ──────────────────────────────────────────────────────────────────────────
  function dataPointsFor(cohort, metricKey) {
    const rows = rowsFor(cohort);
    const judgeId = state.pin.judgeId ? cohort.judgeId : null;

    const groups = new Map();
    for (const row of rows) {
      const key = state.granularity === "iteration"
        ? row.itemId + " #" + (row.iterationIdx + 1)
        : row.itemId;
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(row);
    }

    const byPosition = new Map();
    for (const [pos, groupRows] of groups) {
      const v = METRICS[metricKey].compute(groupRows, judgeId);
      byPosition.set(pos, Number.isFinite(v) ? v : null);
    }
    return { positions: Array.from(groups.keys()), byPosition };
  }

  // Sort key for positions: by item id (string), then by iteration number if present.
  function positionSortKey(pos) {
    const m = pos.match(/^(.+?) #(\\d+)$/);
    if (m) return [m[1], parseInt(m[2], 10)];
    return [pos, 0];
  }
  function comparePositions(a, b) {
    const [ai, ax] = positionSortKey(a);
    const [bi, bx] = positionSortKey(b);
    return ai.localeCompare(bi) || ax - bx;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────────────────────────────────
  const COHORT_COLORS = [
    "#2563eb", "#dc2626", "#16a34a", "#ea580c",
    "#9333ea", "#0d9488", "#ca8a04", "#be185d",
  ];
  function cohortColor(idx) { return COHORT_COLORS[idx % COHORT_COLORS.length]; }
  function cohortLabel(cohort) {
    const dims = pinnedDims();
    if (dims.length === 0) return "All rows";
    return dims.map(d => DIM_LABELS[d] + "=" + (cohort[d] ?? "?") + (cohort[d + "Hash"] ? "@" + cohort[d + "Hash"].slice(0, 6) : "")).join(" / ");
  }

  function renderMeta() {
    const m = document.getElementById("meta");
    const lines = [];
    if (REPORTS.length === 0) {
      lines.push('<span class="row">No reports loaded.</span>');
    } else {
      lines.push('<span class="row">' + REPORTS.length + ' report(s) loaded across the run directory; runs are not used as a chart axis</span>');
      const fmtOptions = (dim) => VALUES[dim].map(o => optionLabel(o)).join(", ") || "—";
      lines.push('<span class="row">prompts: ' + escapeHtml(fmtOptions("promptId")) + '</span>');
      lines.push('<span class="row">datasets: ' + escapeHtml(fmtOptions("datasetId")) + '</span>');
      lines.push('<span class="row">judges: ' + escapeHtml(fmtOptions("judgeId")) + '</span>');
    }
    m.innerHTML = lines.join("");
  }

  function renderCohorts() {
    const container = document.getElementById("cohorts");
    const dims = pinnedDims();
    if (state.cohorts.length === 0) {
      container.innerHTML = '<div class="empty">No cohorts yet. Add one to start comparing.</div>';
      return;
    }
    container.innerHTML = "";
    state.cohorts.forEach((cohort, idx) => {
      const row = document.createElement("div");
      row.className = "cohort-row";
      const color = cohortColor(idx);
      const dimSelects = dims.map(d => {
        const opts = VALUES[d].map(o => {
          const sel = (cohort[d] === o.id && (cohort[d + "Hash"] ?? null) === (o.hash ?? null)) ? " selected" : "";
          return '<option value="' + escapeHtml(o.key) + '"' + sel + ">" + escapeHtml(optionLabel(o)) + "</option>";
        }).join("");
        return '<label>' + DIM_LABELS[d] + ': <select data-dim="' + d + '">' + opts + '</select></label>';
      }).join(" ");
      row.innerHTML =
        '<span class="swatch" style="background: ' + color + '"></span>' +
        '<span class="name">Cohort ' + cohort.id + '</span>' +
        (dimSelects || '<span style="color: var(--muted); font-style: italic;">(all dims aggregated)</span>') +
        '<button class="remove" data-action="remove">×</button>';
      row.querySelectorAll("select").forEach(sel => {
        sel.addEventListener("change", e => {
          const dim = e.target.dataset.dim;
          const opt = VALUES[dim].find(o => o.key === e.target.value);
          if (opt) {
            cohort[dim] = opt.id;
            cohort[dim + "Hash"] = opt.hash;
          }
          renderCohorts(); // re-render to update the legend label
          renderCharts();
        });
      });
      row.querySelector('button[data-action="remove"]').addEventListener("click", () => {
        state.cohorts = state.cohorts.filter(c => c.id !== cohort.id);
        renderCohorts();
        renderCharts();
      });
      container.appendChild(row);
    });
  }

  function renderMetricPicker() {
    const container = document.getElementById("metrics");
    container.innerHTML = "";
    Object.entries(METRICS).forEach(([key, def]) => {
      const wrap = document.createElement("label");
      const checked = state.metrics.includes(key) ? "checked" : "";
      wrap.innerHTML = '<input type="checkbox" ' + checked + '> ' + escapeHtml(def.label);
      wrap.querySelector("input").addEventListener("change", e => {
        if (e.target.checked) state.metrics.push(key);
        else state.metrics = state.metrics.filter(k => k !== key);
        renderCharts();
      });
      container.appendChild(wrap);
    });
  }

  const charts = new Map();
  function destroyAllCharts() {
    for (const ch of charts.values()) ch.destroy();
    charts.clear();
  }

  function renderCharts() {
    const container = document.getElementById("charts");
    if (!state.cohorts.length) {
      container.innerHTML = '<div class="empty">Add at least one cohort to see charts.</div>';
      destroyAllCharts();
      return;
    }
    if (!state.metrics.length) {
      container.innerHTML = '<div class="empty">Pick at least one metric.</div>';
      destroyAllCharts();
      return;
    }

    container.innerHTML = "";
    destroyAllCharts();

    state.metrics.forEach(metricKey => {
      // Compute each cohort's (position → value) map.
      const cohortData = state.cohorts.map((cohort) => dataPointsFor(cohort, metricKey));

      // X-axis = union of positions across cohorts, sorted.
      const positionSet = new Set();
      cohortData.forEach(d => d.positions.forEach(p => positionSet.add(p)));
      const labels = Array.from(positionSet).sort(comparePositions);

      const card = document.createElement("div");
      card.className = "chart-card";
      const title = document.createElement("h3");
      title.textContent = METRICS[metricKey].label + " · " +
        (state.granularity === "iteration" ? "per iteration" : "per item") +
        " (n=" + labels.length + ")";
      card.appendChild(title);
      const canvas = document.createElement("canvas");
      card.appendChild(canvas);
      container.appendChild(card);

      if (labels.length === 0) {
        const note = document.createElement("div");
        note.className = "empty";
        note.textContent = "No matching data for this metric.";
        card.appendChild(note);
        return;
      }

      const datasets = state.cohorts.map((cohort, idx) => {
        const data = labels.map(p => cohortData[idx].byPosition.has(p) ? cohortData[idx].byPosition.get(p) : null);
        const color = cohortColor(idx);
        return {
          label: cohortLabel(cohort),
          data,
          borderColor: color,
          backgroundColor: color + "33",
          tension: 0.15,
          spanGaps: true,
        };
      });

      const ch = new Chart(canvas, {
        type: "line",
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { position: "bottom", labels: { boxWidth: 12 } },
          },
          scales: {
            x: {
              title: { display: true, text: state.granularity === "iteration" ? "Item × iteration" : "Item" },
              ticks: { autoSkip: true, maxRotation: 60, minRotation: 30 },
            },
            y: { title: { display: true, text: METRICS[metricKey].label }, beginAtZero: true },
          },
        },
      });
      charts.set(metricKey, ch);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Wire up
  // ──────────────────────────────────────────────────────────────────────────
  document.querySelectorAll('#pin-controls input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", e => {
      state.pin[e.target.dataset.dim] = e.target.checked;
      state.cohorts = []; // shape changed
      renderCohorts();
      renderCharts();
    });
  });
  document.querySelectorAll('#granularity-controls input[type="radio"]').forEach(rb => {
    rb.addEventListener("change", e => {
      if (e.target.checked) {
        state.granularity = e.target.value;
        renderCharts();
      }
    });
  });
  document.getElementById("add-cohort").addEventListener("click", () => {
    state.cohorts.push(newCohort());
    renderCohorts();
    renderCharts();
  });

  renderMeta();
  renderCohorts();
  renderMetricPicker();
  renderCharts();
})();
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
