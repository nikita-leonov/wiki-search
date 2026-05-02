# Eval report

- model: `claude-haiku-4-5-20251001`
- judge model: `claude-sonnet-4-6`
- prompts: `v1`
- datasets: `factual`
- judges: `correctness`, `citation`
- iterations: 3
- thinking: off

## Overall

- rows: 21 (0 errors)
- mean score (across all judges): 1.00
- per-judge mean: correctness=1.00, citation=1.00
- mean latency: 3.02s (p50 2.93s, p95 3.62s)
- total tokens: 87,959
- mean cache hit rate: 0.0%
- mean searches/run: 1.00
- total estimated cost: $0.1049

---

# Report A — by Prompt → Dataset → Judge

Grouping: promptId → datasetId → judgeId



## prompt: v1

| n | errors | mean | citation | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

### dataset: factual

| n | errors | mean | citation | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

#### judge: correctness

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

#### judge: citation

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

---

# Report B — by Dataset → Judge → Prompt

Grouping: datasetId → judgeId → promptId



## dataset: factual

| n | errors | mean | citation | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

### judge: correctness

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

#### prompt: v1

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

### judge: citation

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

#### prompt: v1

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

---

# Report C — by Judge → Prompt → Dataset

Grouping: judgeId → promptId → datasetId



## judge: correctness

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

### prompt: v1

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

#### dataset: factual

| n | errors | mean | correctness | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

## judge: citation

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

### prompt: v1

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |

#### dataset: factual

| n | errors | mean | citation | p50 latency | p95 latency | mean tokens | mean searches | mean cite | cost |
|---|---|---|---|---|---|---|---|---|---|
| 21 | 0 | 1.00 | 1.00 | 2.93s | 3.62s | 4188 | 1.0 | 2.4 | $0.1049 |