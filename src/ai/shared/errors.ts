export class AiPipelineError extends Error {
  constructor(message: string, public readonly stage?: string) {
    super(message);
    this.name = "AiPipelineError";
  }
}

export class ContractViolationError extends AiPipelineError {
  constructor(message: string, public readonly violations: string[]) {
    super(message, "CONTRACT_ENFORCEMENT");
    this.name = "ContractViolationError";
  }
}

export class ValidationFailedError extends AiPipelineError {
  constructor(message: string, public readonly errors: string[]) {
    super(message, "VALIDATION");
    this.name = "ValidationFailedError";
  }
}
