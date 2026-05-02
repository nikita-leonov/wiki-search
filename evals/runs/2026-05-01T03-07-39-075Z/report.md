# Eval report

- run at: `2026-05-01T03:07:39.076Z`
- duration: 18.70s
- model: `claude-haiku-4-5-20251001`
- judge model: `claude-sonnet-4-6`
- prompts: `v1`
- datasets: `factual`
- judges: `correctness`, `citation`
- iterations: 2
- thinking: off

## Overall

- rows: 14 (0 errors)
- mean score (across all judges): 1.00
- per-judge mean: correctness=1.00, citation=1.00
- mean latency: 3.21s (p50 3.01s, p95 4.22s)
- total tokens: 58,766
- mean cache hit rate: 0.0%
- mean searches/run: 1.00
- total estimated cost: $0.0707

---

# Report A — by Prompt → Dataset → Judge

Grouping: promptId → datasetId → judgeId



## prompt: v1

| n | errors | mean | citation | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

### dataset: factual

| n | errors | mean | citation | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

#### judge: correctness

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

#### judge: citation

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

---

# Report B — by Dataset → Judge → Prompt

Grouping: datasetId → judgeId → promptId



## dataset: factual

| n | errors | mean | citation | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

### judge: correctness

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

#### prompt: v1

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

### judge: citation

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

#### prompt: v1

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

---

# Report C — by Judge → Prompt → Dataset

Grouping: judgeId → promptId → datasetId



## judge: correctness

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

### prompt: v1

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

#### dataset: factual

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

## judge: citation

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

### prompt: v1

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |

#### dataset: factual

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 14 | 0 | 1.00 | 1.00 | 3.01s | 4.22s | 4197 | 1.0 | 3.0 | $0.0707 |