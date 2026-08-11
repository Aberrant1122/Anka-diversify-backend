import { AgentFileChange } from "../shared/types";
import { ValidationRunner } from "./ValidationRunner";

export class BuildValidator {
  static async validateBuild(
    changes: AgentFileChange[],
    localPath: string,
    commands: string[],
  ): Promise<{ success: boolean; errors: string }> {
    return ValidationRunner.validateWithShell(changes, localPath, commands);
  }
}
