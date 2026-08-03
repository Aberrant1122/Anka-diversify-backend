# ANKA OS AI CODING AGENT — REAL BENCHMARK RESULTS

**Run Date**: 2026-07-30T19:41:23.617Z  
**Total Tasks**: 5  
**Completed**: 5  
**Skipped**: 0  

---

## 📊 Summary Metrics

| Metric | Value | Note |
| :--- | :--- | :--- |
| **Build Success Rate** | **20.0%** | Tasks where npm run build passed |
| **Agent Success Rate** | **100.0%** | Tasks fully or partially completed |
| **Hallucination Rate** | **60.0%** | Tasks with broken imports or invented symbols |
| **Avg Response Time** | **114.5s** | Wall-clock agent latency per task |
| **Total Tokens Used** | **61,600** | Estimated across all tasks |
| **Est. API Cost** | **$0.5240** | Estimated at GPT-4o pricing |
| **Avg Confidence** | **0.0%** | Agent self-reported confidence |

> **⚠️ NOTE**: All metrics above are from REAL agent execution and REAL validation commands.
> No values are fabricated. If a task failed, it is recorded as failed.

---

## 🗂 Per-Task Results

| Task | Category | Status | Build | TSC | Halluc | Time | Files |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| api-001 | FEATURE_ADD | ⚠️ PARTIAL | ❌ | ✅ | ⚠️ | 126.3s | 2 files |
| bugfix-001 | BUG_FIX | ⚠️ PARTIAL | ✅ | ✅ | ⚠️ | 107.5s | 3 files |
| feature-001 | FEATURE_ADD | ⚠️ PARTIAL | ❌ | ✅ | ✓ | 114.6s | 2 files |
| feature-002 | FEATURE_ADD | ⚠️ PARTIAL | ❌ | ✅ | ⚠️ | 120.4s | 5 files |
| refactor-001 | REFACTOR | ⚠️ PARTIAL | ❌ | ❌ | ✓ | 103.9s | 6 files |

---

## 🔍 Detailed Failure Analysis

### api-001 — PARTIAL
**Prompt**: Add a new GET /api/projects/:projectId/stats endpoint. It should return: totalTasks, completedTasks, inProgressTasks, overdueTasks (tasks with dueDate < now and status != "done"), and sprintCount. Use

**Final Status**: Build: ✗ | TSC: ✓ | 0 compile errors

**Compile Errors** (first 5):
```
None
```

**Hallucination Details**:
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a StatsService"
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a StatsService"

**Agent Raw Error**: None

---
### bugfix-001 — PARTIAL
**Prompt**: Fix a bug: when creating a sprint, the API allows endDate to be before startDate. Add validation in the sprint creation endpoint to reject requests where endDate is earlier than or equal to startDate.

**Final Status**: Build passed but hallucinations detected

**Compile Errors** (first 5):
```
None
```

**Hallucination Details**:
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a DateValidationService"
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a DateValidationService"
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a DateValidationService"

**Agent Raw Error**: None

---
### feature-001 — PARTIAL
**Prompt**: Add a "Mark All Tasks Complete" button to the project tasks page. When clicked, it should set all tasks in the current project to status "done". The button should be in the top-right of the task list 

**Final Status**: Build: ✗ | TSC: ✓ | 0 compile errors

**Compile Errors** (first 5):
```
None
```

**Hallucination Details**:
None

**Agent Raw Error**: None

---
### feature-002 — PARTIAL
**Prompt**: Add a progress bar to each project card on the main dashboard. It should display the project's progress field (0-100). Use a visual bar, not just a number. Style it to match the existing card design.

**Final Status**: Build: ✗ | TSC: ✓ | 0 compile errors

**Compile Errors** (first 5):
```
None
```

**Hallucination Details**:
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a ProgressService"
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a ProgressService"
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a ProgressService"
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a ProgressService"
- Possible hallucination: Agent used "a" which the task spec warns against: "Creating a ProgressService"

**Agent Raw Error**: None

---
### refactor-001 — PARTIAL
**Prompt**: Refactor the sprint creation and update logic in the sprint service. Extract all date-related validation into a dedicated private validateSprintDates() method. This method should be called from both c

**Final Status**: Build: ✗ | TSC: ✗ | 0 compile errors

**Compile Errors** (first 5):
```
None
```

**Hallucination Details**:
None

**Agent Raw Error**: None


---

## 📦 Task Category Breakdown

| Category | Total | Success | Failed |
| :--- | :--- | :--- | :--- |
| FEATURE_ADD | 3 | 0 | 0 |
| BUG_FIX | 1 | 0 | 0 |
| REFACTOR | 1 | 0 | 0 |

---

## ⚠️ IMPORTANT CAVEATS

1. **Skipped tasks** mean `BENCHMARK_USER_ID` and `BENCHMARK_PROJECT_ID` were not set. Set them and re-run.
2. **Hallucination detection** is static — checks for broken relative imports in generated TypeScript. It does NOT use an LLM to judge hallucinations.
3. **Token usage is estimated** — the backend `AgentResponse` does not currently expose OpenAI token counts. Actual cost may differ.
4. **Build validation** copies the entire backend source into an isolated sandbox and runs `npm run build` there. It does NOT pollute the production workspace.
