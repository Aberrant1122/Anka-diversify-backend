# AUTOMATED FEATURE VALIDATION PIPELINE REPORT

**Overall Status**: ❌ **REJECTED (FAILED)**  
**Total Attempts**: 2  
**Total Pipeline Latency**: 140.45 ms  
**Pipeline Pass Rate**: **0%**  

> [!CAUTION]
> **Primary Failure Cause**: Stage "compile" failed executing "node -e "console.error('src/services/MockService.ts(5,10): error TS2304: Cannot find name MissingType.'); process.exit(1)""

---

## 🏁 Stage Execution Breakdown

| Stage | Command | Status | Duration | Failure Log |
| :--- | :--- | :--- | :--- | :--- |
| `compile` | `node -e "console.error('src/services/MockService.ts(5,10): error TS2304: Cannot find name MissingType.'); process.exit(1)"` | ❌ FAIL | 61.9 ms | `Stage "compile" failed executing "node -e "console.error('sr` |
