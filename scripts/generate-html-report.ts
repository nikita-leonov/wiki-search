// Standalone CLI: read every report-*.json under a directory and emit a
// self-contained HTML page that compares cohort metrics ACROSS runs. With a
// single report the chart would be one data point per cohort; over many runs
// you get a meaningful time series.
//
// Cohort shape rules:
//   • A "Pin" panel chooses which dimensions (prompt / dataset / judge) each
//     cohort pins. Unpinned dims are aggregated within each report. The first
//     cohort therefore locks the shape; changing the pin set clears the
//     cohort list (the shape changed).
//   • Each cohort pins specific values for the pinned dims. So you can't
//     compare a (prompt, dataset) cohort against a (judge, dataset) cohort —
//     all cohorts share the same pin set.
//   • Multiple metrics can be picked; each renders its own chart, all
//     sharing the same cohort lines and the same X-axis (report timestamps,
//     oldest -> newest).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const HELP = `Usage:
  npm run report:html -- [DIR] [--limit N] [--out PATH]

Reads all report-*.json files in DIR (default: evals/runs/), takes the N most
recent by runAt timestamp (default: 15), and writes a self-contained HTML
page that lets you build cohort-vs-cohort time-series comparisons.

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

  // Most recent first; take limit; then return chronological for charting.
  all.sort((a, b) => b.runAt.localeCompare(a.runAt));
  const chosen = all.slice(0, limit);
  chosen.sort((a, b) => a.runAt.localeCompare(b.runAt));
  return chosen;
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
  .pin-row { display: flex; gap: 24px; }
  .cohort-row {
    display: flex; align-items: center; gap: 12px;
    padding: 6px 0; border-bottom: 1px dashed var(--border);
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
  canvas { max-height: 320px; }
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
    <div class="pin-row" id="pin-controls">
      <label><input type="checkbox" data-dim="promptId" checked> Pin <strong>prompt</strong></label>
      <label><input type="checkbox" data-dim="datasetId" checked> Pin <strong>dataset</strong></label>
      <label><input type="checkbox" data-dim="judgeId" checked> Pin <strong>judge</strong></label>
    </div>
    <div class="footnote">Each cohort fixes the pinned dimensions; unpinned dimensions are aggregated within each report. Changing the pin set resets the cohort list.</div>
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

  function distinctValues(dim) {
    const set = new Set();
    for (const rep of REPORTS) {
      for (const r of (rep.rows || [])) {
        if (dim === "judgeId") {
          for (const s of (r.judgeScores || [])) set.add(s.judgeId);
        } else {
          set.add(r[dim]);
        }
      }
    }
    return Array.from(set).sort();
  }
  const VALUES = {
    promptId: distinctValues("promptId"),
    datasetId: distinctValues("datasetId"),
    judgeId: distinctValues("judgeId"),
  };

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
  function judgeScores(rows, judgeId) {
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
      compute: (rows, judgeId) => mean(judgeScores(rows, judgeId).map(s => s.score)),
    },
    passRate: {
      label: "Pass rate (judge.pass)",
      compute: (rows, judgeId) => {
        const ss = judgeScores(rows, judgeId).filter(s => s.pass !== undefined);
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
    rowCount: {
      label: "Row count (n)",
      compute: (rows) => rows.length,
    },
  };

  const state = {
    pin: { promptId: true, datasetId: true, judgeId: true },
    cohorts: [],
    metrics: ["meanScore"],
    nextCohortId: 1,
  };

  function pinnedDims() { return DIMS.filter(d => state.pin[d]); }

  function newCohort() {
    const cohort = { id: state.nextCohortId++ };
    for (const d of pinnedDims()) cohort[d] = VALUES[d][0] ?? null;
    return cohort;
  }

  function metricFor(cohort, report, metricKey) {
    let rows = report.rows || [];
    if (state.pin.promptId && cohort.promptId != null) rows = rows.filter(r => r.promptId === cohort.promptId);
    if (state.pin.datasetId && cohort.datasetId != null) rows = rows.filter(r => r.datasetId === cohort.datasetId);
    const judgeId = state.pin.judgeId ? cohort.judgeId : null;
    const v = METRICS[metricKey].compute(rows, judgeId);
    return Number.isFinite(v) ? v : null;
  }

  const COHORT_COLORS = [
    "#2563eb", "#dc2626", "#16a34a", "#ea580c",
    "#9333ea", "#0d9488", "#ca8a04", "#be185d",
  ];
  function cohortColor(idx) { return COHORT_COLORS[idx % COHORT_COLORS.length]; }
  function cohortLabel(cohort) {
    const dims = pinnedDims();
    if (dims.length === 0) return "All rows";
    return dims.map(d => DIM_LABELS[d] + "=" + (cohort[d] ?? "?")).join(" / ");
  }

  function renderMeta() {
    const m = document.getElementById("meta");
    const lines = [];
    if (REPORTS.length === 0) {
      lines.push('<span class="row">No reports loaded.</span>');
    } else {
      lines.push('<span class="row">' + REPORTS.length + ' report(s) loaded · runs from ' + escapeHtml(REPORTS[0].runAt) + ' to ' + escapeHtml(REPORTS[REPORTS.length - 1].runAt) + '</span>');
      const sample = REPORTS[0].config || {};
      lines.push('<span class="row">latest config: model=' + escapeHtml(sample.model || "?") + ' · judge=' + escapeHtml(sample.judgeModel || "?") + '</span>');
      lines.push('<span class="row">prompts: ' + (VALUES.promptId.map(escapeHtml).join(", ") || "—") + '</span>');
      lines.push('<span class="row">datasets: ' + (VALUES.datasetId.map(escapeHtml).join(", ") || "—") + '</span>');
      lines.push('<span class="row">judges: ' + (VALUES.judgeId.map(escapeHtml).join(", ") || "—") + '</span>');
    }
    m.innerHTML = lines.join("");
  }

  function renderCohorts() {
    const container = document.getElementById("cohorts");
    const dims = pinnedDims();
    if (state.cohorts.length === 0) {
      container.innerHTML = '<div class="empty">No cohorts yet. Add one to start comparing across runs.</div>';
      return;
    }
    container.innerHTML = "";
    state.cohorts.forEach((cohort, idx) => {
      const row = document.createElement("div");
      row.className = "cohort-row";
      const color = cohortColor(idx);
      const dimSelects = dims.map(d => {
        const opts = VALUES[d].map(v => '<option value="' + escapeHtml(v) + '"' + (cohort[d] === v ? " selected" : "") + ">" + escapeHtml(v) + "</option>").join("");
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
          cohort[dim] = e.target.value;
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

  function shortenRunAt(iso) {
    const m = iso.match(/^\\d{4}-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})/);
    return m ? m[1] + "-" + m[2] + " " + m[3] + ":" + m[4] : iso;
  }

  function renderCharts() {
    const container = document.getElementById("charts");
    if (REPORTS.length < 2) {
      container.innerHTML = '<div class="empty">Need at least 2 reports for a meaningful time series. Add more eval runs and re-generate.</div>';
      destroyAllCharts();
      return;
    }
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

    const labels = REPORTS.map(r => shortenRunAt(r.runAt));
    const fullLabels = REPORTS.map(r => r.runAt);

    state.metrics.forEach(metricKey => {
      const card = document.createElement("div");
      card.className = "chart-card";
      const title = document.createElement("h3");
      title.textContent = METRICS[metricKey].label;
      card.appendChild(title);
      const canvas = document.createElement("canvas");
      card.appendChild(canvas);
      container.appendChild(card);

      const datasets = state.cohorts.map((cohort, idx) => {
        const data = REPORTS.map(rep => metricFor(cohort, rep, metricKey));
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
            tooltip: {
              callbacks: {
                title: (items) => items[0] ? fullLabels[items[0].dataIndex] : "",
              },
            },
          },
          scales: {
            x: { title: { display: true, text: "Run (oldest → newest)" } },
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

  document.querySelectorAll('#pin-controls input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", e => {
      state.pin[e.target.dataset.dim] = e.target.checked;
      state.cohorts = []; // shape changed
      renderCohorts();
      renderCharts();
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
