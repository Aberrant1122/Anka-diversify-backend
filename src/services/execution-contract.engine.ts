/**
 * Execution Contract Engine (Service Wrapper)
 *
 * Re-exports the authoritative implementation from src/ai/contracts/ExecutionContractBuilder.
 */

export {
  buildExecutionContract,
  detectCompoundIntent,
  detectReferenceCleanupIntent,
  CompoundIntentAnalysis,
  ExecutionContractOptions,
} from "../ai/contracts/ExecutionContractBuilder";
