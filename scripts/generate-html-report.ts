// Standalone CLI: read a report-*.json produced by the eval runner and emit a
// self-contained HTML page with an interactive comparison chart. The page
// embeds the report data (minus retrievedContext, which is large and not used
// for charting) and pulls Chart.js from a CDN; no build step or server needed.
//
// Cohort shape rules:
//   • A global "Vary by" axis (dataset / prompt / judge) defines what's on
//     the X-axis of every chart.
//   • Each cohort pins values for the OTHER TWO dimensions. The first cohort
//     therefore locks the shape — subsequent cohorts use the same pinned-dim
//     dropdowns. Changing "Vary by" clears all cohorts (the shape changed).
//   • Multiple metrics can be picked; each renders its own chart, all sharing
//     the same cohort definitions.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const inputPath = process.argv[2];
if (!inputPath || inputPath === "--help" || inputPath === "-h") {
  process.stderr.write(
    [
      "Usage:",
      "  npm run report:html -- <path/to/report-*.json> [output.html]",
      "",
      "Generates a self-contained HTML page next to the input file (or at the",
      "given output path) that lets you build cohort comparisons interactively.",
    ].join("\n") + "\n",
  );
  process.exit(inputPath ? 0 : 1);
}

const inputAbs = resolve(inputPath);
const outputPath = process.argv[3]
  ? resolve(process.argv[3])
  : inputAbs.replace(/\.json$/, ".html");

const raw = JSON.parse(readFileSync(inputAbs, "utf-8")) as {
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

// Strip `retrievedContext` (tens of KB per row, unused by charts). Keep
// everything else — answer / question are useful for future drill-down even
// though the current chart doesn't surface them.
const slimRows = (raw.rows ?? []).map((r) => {
  const { retrievedContext: _, ...rest } = r;
  return rest;
});

const slimReport = {
  runAt: raw.runAt ?? null,
  runDurationMs: raw.runDurationMs ?? null,
  artifacts: raw.artifacts ?? null,
  config: raw.config ?? null,
  rows: slimRows,
};

// Embed-safe JSON: closes any accidental `</script>` and escapes line
// separators that older browsers reject inside <script> tags.
function embedJson(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const PAGE_TITLE = `Eval Report — ${slimReport.runAt ?? "unknown"}`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(PAGE_TITLE)}</title>
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
  select, button, input[type="checkbox"] { font: inherit; }
  select { padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; background: white; }
  button {
    padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px;
    background: white; cursor: pointer;
  }
  button:hover { background: #f0f0f0; }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.primary:hover { background: #1d4ed8; }
  button.remove { padding: 2px 8px; color: var(--muted); }
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
  <h1>Eval Report</h1>
  <div class="meta" id="meta"></div>
</header>

<main>
  <section>
    <h2>X-axis</h2>
    <label>Vary by:
      <select id="vary-by">
        <option value="datasetId">Dataset</option>
        <option value="promptId">Prompt</option>
        <option value="judgeId">Judge</option>
      </select>
    </label>
    <span class="footnote">Each cohort pins values for the other two dimensions. Changing this resets the cohort list.</span>
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

<script id="report-data" type="application/json">${embedJson(slimReport)}</script>

<script>
(() => {
  const REPORT = JSON.parse(document.getElementById("report-data").textContent);
  const ROWS = REPORT.rows || [];

  // ──────────────────────────────────────────────────────────────────────────
  // Distinct values per dimension
  // ──────────────────────────────────────────────────────────────────────────
  const DIM_LABELS = { promptId: "Prompt", datasetId: "Dataset", judgeId: "Judge" };
  const DIMS = ["promptId", "datasetId", "judgeId"];

  function distinctValues(dim) {
    const set = new Set();
    if (dim === "judgeId") {
      for (const r of ROWS) for (const s of (r.judgeScores || [])) set.add(s.judgeId);
    } else {
      for (const r of ROWS) set.add(r[dim]);
    }
    return Array.from(set).sort();
  }
  const VALUES = { promptId: distinctValues("promptId"), datasetId: distinctValues("datasetId"), judgeId: distinctValues("judgeId") };

  // ──────────────────────────────────────────────────────────────────────────
  // Metric definitions. Each takes a row set and an effective judgeId (which
  // may be null if no judge is in scope) and returns one number.
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
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Cohort filtering / aggregation
  // ──────────────────────────────────────────────────────────────────────────
  function filterByCohort(rows, cohort) {
    return rows.filter(r => {
      if (cohort.promptId != null && r.promptId !== cohort.promptId) return false;
      if (cohort.datasetId != null && r.datasetId !== cohort.datasetId) return false;
      // judgeId never excludes rows — it filters scores at metric time.
      return true;
    });
  }

  function effectiveJudgeId(cohort, varyBy, xValue) {
    if (cohort.judgeId != null) return cohort.judgeId;
    if (varyBy === "judgeId") return xValue;
    return null;
  }

  function dataForCohort(cohort, varyBy, metricKey) {
    const xValues = VALUES[varyBy];
    const yValues = xValues.map(xVal => {
      let rows = filterByCohort(ROWS, cohort);
      if (varyBy !== "judgeId") rows = rows.filter(r => r[varyBy] === xVal);
      const judgeId = effectiveJudgeId(cohort, varyBy, xVal);
      const v = METRICS[metricKey].compute(rows, judgeId);
      return Number.isFinite(v) ? v : null;
    });
    return { xValues, yValues };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────────────
  const state = {
    varyBy: "datasetId",
    cohorts: [], // [{ id, promptId?, datasetId?, judgeId? }]
    metrics: ["meanScore"],
    nextCohortId: 1,
  };

  function pinnedDimsFor(varyBy) {
    return DIMS.filter(d => d !== varyBy);
  }

  function newCohort() {
    const dims = pinnedDimsFor(state.varyBy);
    const id = state.nextCohortId++;
    const cohort = { id };
    // Default to the first available value for each pinned dim.
    for (const d of dims) cohort[d] = VALUES[d][0] ?? null;
    return cohort;
  }

  // Stable cohort colors.
  const COHORT_COLORS = [
    "#2563eb", "#dc2626", "#16a34a", "#ea580c",
    "#9333ea", "#0d9488", "#ca8a04", "#be185d",
  ];
  function cohortColor(cohort, idx) {
    return COHORT_COLORS[idx % COHORT_COLORS.length];
  }
  function cohortLabel(cohort) {
    const dims = pinnedDimsFor(state.varyBy);
    return dims.map(d => \`\${DIM_LABELS[d]}=\${cohort[d] ?? "?"}\`).join(" / ");
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Rendering
  // ──────────────────────────────────────────────────────────────────────────
  function renderMeta() {
    const m = document.getElementById("meta");
    const lines = [];
    if (REPORT.runAt) lines.push(\`<span class="row">run: \${escapeHtml(REPORT.runAt)} (duration \${formatDuration(REPORT.runDurationMs)})</span>\`);
    if (REPORT.config) {
      lines.push(\`<span class="row">model: \${escapeHtml(REPORT.config.model || "?")} | judge: \${escapeHtml(REPORT.config.judgeModel || "?")} | rows: \${ROWS.length}</span>\`);
    }
    if (REPORT.artifacts) {
      const a = REPORT.artifacts;
      const parts = [];
      const fmt = (group, label) => {
        if (!group) return "";
        const entries = Object.entries(group);
        if (!entries.length) return "";
        return \`\${label}: \${entries.map(([k, v]) => \`\${escapeHtml(k)} (\${escapeHtml(v)})\`).join(", ")}\`;
      };
      const p = fmt(a.prompts, "prompts");
      const j = fmt(a.judges, "judges");
      const d = fmt(a.datasets, "datasets");
      [p, j, d].filter(Boolean).forEach(s => lines.push(\`<span class="row">\${s}</span>\`));
    }
    m.innerHTML = lines.join("");
  }

  function renderCohorts() {
    const container = document.getElementById("cohorts");
    if (!state.cohorts.length) {
      container.innerHTML = '<div class="empty">No cohorts yet. Add one to start comparing.</div>';
      return;
    }
    const dims = pinnedDimsFor(state.varyBy);
    container.innerHTML = "";
    state.cohorts.forEach((cohort, idx) => {
      const row = document.createElement("div");
      row.className = "cohort-row";
      const color = cohortColor(cohort, idx);
      const dimSelects = dims.map(d => {
        const opts = VALUES[d].map(v => \`<option value="\${escapeHtml(v)}" \${cohort[d] === v ? "selected" : ""}>\${escapeHtml(v)}</option>\`).join("");
        return \`<label>\${DIM_LABELS[d]}: <select data-dim="\${d}">\${opts}</select></label>\`;
      }).join(" ");
      row.innerHTML = \`
        <span class="swatch" style="background: \${color}"></span>
        <span class="name">Cohort \${cohort.id}</span>
        \${dimSelects}
        <button class="remove" data-action="remove">×</button>
      \`;
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
      const id = "metric-" + key;
      const wrap = document.createElement("label");
      const checked = state.metrics.includes(key) ? "checked" : "";
      wrap.innerHTML = \`<input type="checkbox" id="\${id}" \${checked}> \${escapeHtml(def.label)}\`;
      wrap.querySelector("input").addEventListener("change", e => {
        if (e.target.checked) state.metrics.push(key);
        else state.metrics = state.metrics.filter(k => k !== key);
        renderCharts();
      });
      container.appendChild(wrap);
    });
  }

  const charts = new Map(); // metricKey → Chart instance
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

    // Reconcile: ensure one card per selected metric, in order.
    const desired = new Set(state.metrics);
    for (const [k, ch] of charts.entries()) {
      if (!desired.has(k)) {
        ch.destroy();
        charts.delete(k);
        const card = document.getElementById("card-" + k);
        if (card) card.remove();
      }
    }
    container.innerHTML = "";
    state.metrics.forEach(metricKey => {
      const card = document.createElement("div");
      card.className = "chart-card";
      card.id = "card-" + metricKey;
      const title = document.createElement("h3");
      title.textContent = METRICS[metricKey].label;
      card.appendChild(title);
      const canvas = document.createElement("canvas");
      card.appendChild(canvas);
      container.appendChild(card);

      const xValues = VALUES[state.varyBy];
      const datasets = state.cohorts.map((cohort, idx) => {
        const { yValues } = dataForCohort(cohort, state.varyBy, metricKey);
        const color = cohortColor(cohort, idx);
        return {
          label: cohortLabel(cohort),
          data: yValues,
          borderColor: color,
          backgroundColor: color + "33",
          tension: 0.15,
          spanGaps: true,
        };
      });

      if (charts.has(metricKey)) charts.get(metricKey).destroy();
      const ch = new Chart(canvas, {
        type: "line",
        data: { labels: xValues, datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { position: "bottom", labels: { boxWidth: 12 } },
            title: { display: false },
          },
          scales: {
            x: { title: { display: true, text: DIM_LABELS[state.varyBy] } },
            y: { title: { display: true, text: METRICS[metricKey].label }, beginAtZero: true },
          },
        },
      });
      charts.set(metricKey, ch);
    });
  }

  function destroyAllCharts() {
    for (const ch of charts.values()) ch.destroy();
    charts.clear();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Wire up
  // ──────────────────────────────────────────────────────────────────────────
  document.getElementById("vary-by").addEventListener("change", e => {
    state.varyBy = e.target.value;
    state.cohorts = []; // shape changed — reset
    renderCohorts();
    renderCharts();
  });
  document.getElementById("add-cohort").addEventListener("click", () => {
    state.cohorts.push(newCohort());
    renderCohorts();
    renderCharts();
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return "?";
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    const total = Math.round(ms / 1000);
    return Math.floor(total / 60) + "m" + (total % 60) + "s";
  }

  // Initial render: meta, no cohorts (user adds), default metric (meanScore).
  renderMeta();
  renderCohorts();
  renderMetricPicker();
  renderCharts();
})();
</script>
</body>
</html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c] ?? c,
  );
}

writeFileSync(outputPath, html);
process.stderr.write(`Wrote: ${outputPath}\n`);
process.stderr.write(`Open in a browser: file://${outputPath}\n`);
