# PERSISTENT REPOSITORY GRAPH BENCHMARK REPORT

**Run Date**: 2026-07-30T20:20:59.550Z  
**Codebase Size**: 100 files  
**Indexed Graph Size**: 235 nodes, 724 edges  

---

## ⚡ Performance Summary

| Operation | Latency | Target Standard | Status |
| :--- | :--- | :--- | :--- |
| **Initial Full Graph Build** | **8.64 ms** | $< 100	ext{ ms}$ | ✅ **PASSED** |
| **Incremental Re-Index** | **1.65 ms** | $< 10	ext{ ms}$ | ✅ **100% Cache Hits** |
| **Query: Who calls function?** | **0.002 ms (2.3mu	ext{s})** | $< 1	ext{ ms}$ | ✅ **OPTIMAL** |
| **Query: What breaks if renamed?** | **0.004 ms (3.9mu	ext{s})** | $< 1	ext{ ms}$ | ✅ **OPTIMAL** |
| **Query: Which routes use service?** | **0.012 ms (12.3mu	ext{s})** | $< 1	ext{ ms}$ | ✅ **OPTIMAL** |
| **Query: Where component rendered?** | **0.001 ms (1.4mu	ext{s})** | $< 1	ext{ ms}$ | ✅ **OPTIMAL** |
| **Query: Which APIs touch model?** | **0.006 ms (6.2mu	ext{s})** | $< 1	ext{ ms}$ | ✅ **OPTIMAL** |
| **Persistent Storage Size** | **189.2 KB** | $< 10	ext{ MB}$ | ✅ **LIGHTWEIGHT** |

---

## 🧠 Entity & Relationship Matrix

### Supported Node Entities (11 Types)
`repository`, `file`, `symbol`, `function`, `class`, `component`, `route`, `api`, `service`, `controller`, `prisma_model`

### Supported Edges / Relationships (8 Types)
`imports`, `exports`, `calls`, `renders`, `owns`, `depends_on`, `implements`, `uses`
