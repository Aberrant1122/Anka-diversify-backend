import {
  SubTask,
  SubTaskExecutionResult,
  FileManifest,
  AgentFileChange,
  ExecutionContract,
  ValidationError,
} from "../types";
import { ManifestGenerator } from "./manifest-generator";
import { ManifestValidator } from "./manifest-validator";

export class SubTaskExecutor {
  private generator: ManifestGenerator;

  constructor(generator?: ManifestGenerator) {
    this.generator = generator || new ManifestGenerator();
  }

  /**
   * Executes a single sub-task in isolation with manifest generation & validation.
   */
  public async executeSubTask(
    subTask: SubTask,
    completedSubTasks: Map<string, SubTaskExecutionResult>,
    repositoryContext: { existingFiles?: string[]; repoSnapshot?: any },
    contract: ExecutionContract
  ): Promise<SubTaskExecutionResult> {
    // 1. Check if all required dependencies completed successfully
    for (const depId of subTask.dependencies || []) {
      const depResult = completedSubTasks.get(depId);
      if (!depResult || !depResult.success) {
        return {
          subTaskId: subTask.id,
          success: false,
          manifest: { files: [], totalFiles: 0, manifestVersion: "1.0.0" },
          changes: [],
          errors: [`Dependency sub-task '${depId}' failed or was skipped.`],
        };
      }
    }

    // 2. Build isolated sub-task context
    const scopedContext = this.buildSubTaskContext(subTask, completedSubTasks, repositoryContext);

    // 3. Generate manifest for this sub-task scope
    const manifest = await this.generator.generateManifest(
      subTask.description,
      scopedContext,
      contract,
      subTask
    );

    // 4. Validate sub-task manifest
    const validator = new ManifestValidator(contract, scopedContext.existingFiles);
    const validationResult = validator.validate(manifest, { isSubTask: true });

    if (!validationResult.valid) {
      const errorMsgs = validationResult.errors.map((e) => `[${e.type}] ${e.message}`);
      return {
        subTaskId: subTask.id,
        success: false,
        manifest,
        changes: [],
        errors: errorMsgs,
      };
    }

    // 5. Produce file blueprint changes matching manifest
    const changes: AgentFileChange[] = manifest.files.map((file) => ({
      path: file.path,
      content: `// Blueprint content for ${file.path} (${subTask.category})\n// ${file.description}`,
      description: file.description,
      action: file.action,
      isDeleted: file.action === "delete",
    }));

    return {
      subTaskId: subTask.id,
      success: true,
      manifest,
      changes,
    };
  }

  /**
   * Builds context specific to a sub-task, bounded by a 15K token budget limit.
   */
  public buildSubTaskContext(
    subTask: SubTask,
    completedSubTasks: Map<string, SubTaskExecutionResult>,
    repositoryContext: { existingFiles?: string[]; repoSnapshot?: any }
  ): { existingFiles: string[]; repoSnapshot?: any } {
    const contextFiles = new Set<string>(repositoryContext.existingFiles || []);

    // Add generated files from completed dependency sub-tasks
    for (const depId of subTask.dependencies || []) {
      const depResult = completedSubTasks.get(depId);
      if (depResult && depResult.changes) {
        depResult.changes.forEach((c) => contextFiles.add(c.path));
      }
    }

    // Add target files for this sub-task
    subTask.targetFiles.forEach((tf) => contextFiles.add(tf));

    const existingFilesArr = Array.from(contextFiles);

    return {
      existingFiles: existingFilesArr,
      repoSnapshot: repositoryContext.repoSnapshot,
    };
  }

  /**
   * Aggregates individual sub-task execution results into a unified final output.
   */
  public aggregateResults(results: Map<string, SubTaskExecutionResult>): {
    success: boolean;
    aggregateManifest: FileManifest;
    changes: AgentFileChange[];
    errors: string[];
  } {
    const allManifestFilesMap = new Map<string, any>();
    const allChangesMap = new Map<string, AgentFileChange>();
    const errors: string[] = [];
    let overallSuccess = true;

    for (const [subTaskId, res] of results.entries()) {
      if (!res.success) {
        overallSuccess = false;
        if (res.errors) errors.push(...res.errors);
      }

      if (res.manifest && Array.isArray(res.manifest.files)) {
        res.manifest.files.forEach((f) => {
          allManifestFilesMap.set(f.path, f);
        });
      }

      if (Array.isArray(res.changes)) {
        res.changes.forEach((c) => {
          allChangesMap.set(c.path, c);
        });
      }
    }

    const aggregatedFiles = Array.from(allManifestFilesMap.values());
    const aggregateManifest: FileManifest = {
      files: aggregatedFiles,
      totalFiles: aggregatedFiles.length,
      manifestVersion: "1.0.0",
    };

    return {
      success: overallSuccess,
      aggregateManifest,
      changes: Array.from(allChangesMap.values()),
      errors,
    };
  }
}
