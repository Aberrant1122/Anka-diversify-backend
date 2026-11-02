import { LLMStructuredCallOptions } from "../../ai/gateway/LLMGateway";
import { PipelineStages } from "../../ai/gateway/PipelineStage";
import { WorkspaceProvider } from "../generation-service";

// Only imported by explicit synthetic tests/rehearsals, never production routes.
export class FixtureWorkspaceProvider implements WorkspaceProvider {
  calls: LLMStructuredCallOptions[] = [];
  available() {
    return true;
  }
  async generate(options: LLMStructuredCallOptions) {
    this.calls.push(options);
    const context = JSON.parse(String(options.messages[1].content));
    let content: any;
    if (options.stage === PipelineStages.DOCUMENTATION_PLANNING) {
      const prior = context.main;
      content = prior
        ? { ...prior }
        : {
            purpose: context.brief,
            requirements: [
              {
                id: "REQ-001",
                description: "Maintain the project note in README.md.",
                acceptanceCriteria: [
                  {
                    id: "AC-001",
                    description: "README.md contains approved note.",
                  },
                ],
              },
            ],
            features: [
              { id: "FEATURE-NOTE", description: "Version the project note" },
            ],
            journeys: [
              {
                id: "JOURNEY-NOTE",
                description:
                  "Owner approves a bounded change and reviews evidence",
              },
            ],
            constraints: ["No repository commands or provider tools"],
            exclusions: ["Deployment is a separate release step"],
            questions: [],
            decisions: [],
          };
      delete content.schemaVersion;
      delete content.brief;
      delete content.legacySources;
    } else if (options.stage === PipelineStages.ARCHITECTURE_PLANNING) {
      const repo = context.repositories[0];
      content = {
        overview:
          "Maintain a single project note under owner document authority.",
        components: [
          { id: "COMP-NOTE", description: "README holds the project note" },
        ],
        dataMigrations: [],
        interfaces: [],
        security: ["Owner-only access and isolated file mutation"],
        operations: ["Review exact diff; deployment is separate"],
        repositories: [{ id: repo.id, baseline: repo.currentIndexedCommit }],
        units: [
          {
            id: "UNIT-NOTE",
            title: "Update README note",
            requirementIds: [context.main.requirements[0].id],
            dependsOn: [],
            repositoryId: repo.id,
            commands: [],
            files: [{ path: "README.md", action: "modify" }],
            checks: [
              {
                id: "CHECK-NOTE",
                criterionId:
                  context.main.requirements[0].acceptanceCriteria[0].id,
                type: "contains",
                path: "README.md",
                expected: "approved note",
              },
            ],
          },
        ],
        questions: [],
      };
    } else {
      content = {
        scopeChangeRequired: false,
        reason: "Implement the approved note requirement.",
        changes: context.preimages.map((p: any) => ({
          repositoryId: p.repositoryId,
          path: p.path,
          action: p.action,
          content: p.action === "delete" ? null : "approved note\n",
        })),
      };
    }
    const valid = options.schema.validate(content);
    if (!valid.valid)
      throw new Error("Fixture output invalid: " + valid.errors?.join(","));
    return {
      content,
      audit: {
        provider: "SYNTHETIC_FIXTURE",
        stage: options.stage,
        paidCall: false,
      },
    };
  }
}
