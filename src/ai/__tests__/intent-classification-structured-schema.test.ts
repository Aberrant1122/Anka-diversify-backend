import { IntentClassifier } from "../classification/IntentClassifier";

function completion(content: unknown) {
  return {
    choices: [{
      finish_reason: "stop",
      index: 0,
      message: { content: JSON.stringify(content) },
    }],
  };
}

describe("intent classification structured-output contract", () => {
  test("uses a strict provider schema and accepts nullable optional stage fields", async () => {
    const create = jest.fn().mockResolvedValue(completion({
      taskType: "REFACTOR",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "REFACTOR",
      targetPath: null,
      confidence: 0.94,
      requiresClarification: false,
      question: null,
      options: null,
      reasoning: "Remove one deprecated component and its references.",
      successCondition: "DETERMINISTIC_STATE",
      stages: [{
        id: "stage-1",
        taskType: "REFACTOR",
        goal: "Remove the deprecated component and clean its references.",
        successCondition: null,
        targetPath: null,
        dependsOn: [],
      }],
    }));

    const result = await IntentClassifier.classifyIntentAndAmbiguity(
      "Remove the deprecated component and clean every reference to it.",
      {},
      ["src/components/LegacyComponent.tsx", "src/App.tsx"],
      { chat: { completions: { create } } },
    );

    expect(result.outcome).not.toBe("TECHNICAL_FAILURE");
    expect(result.taskType).toBe("REFACTOR");
    expect(result.stages).toEqual([expect.objectContaining({
      id: "stage-1",
      taskType: "REFACTOR",
      targetPath: undefined,
      dependsOn: [],
    })]);

    const responseFormat = create.mock.calls[0][0].response_format;
    expect(responseFormat.json_schema.strict).toBe(true);
    expect(responseFormat.json_schema.schema.required).toEqual(
      expect.arrayContaining(["targetPath", "question", "options", "successCondition", "stages"]),
    );
    const stageSchema = responseFormat.json_schema.schema.properties.stages.anyOf[0].items;
    expect(stageSchema.properties.taskType.enum).toEqual(expect.arrayContaining([
      "DELETE_FILE",
      "REFACTOR",
      "BUG_FIX",
    ]));
    expect(stageSchema.required).toEqual(
      expect.arrayContaining(["successCondition", "targetPath", "dependsOn"]),
    );
  });

  test("still fails closed when a stage uses an undeclared task type", async () => {
    const create = jest.fn().mockResolvedValue(completion({
      taskType: "REFACTOR",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "REFACTOR",
      targetPath: null,
      confidence: 0.94,
      requiresClarification: false,
      question: null,
      options: null,
      reasoning: "Remove one deprecated component and its references.",
      successCondition: "DETERMINISTIC_STATE",
      stages: [{
        id: "stage-1",
        taskType: "MODIFY",
        goal: "Remove the deprecated component and clean its references.",
        successCondition: null,
        targetPath: null,
        dependsOn: [],
      }],
    }));

    const result = await IntentClassifier.classifyIntentAndAmbiguity(
      "Remove the deprecated component and clean every reference to it.",
      {},
      ["src/components/LegacyComponent.tsx", "src/App.tsx"],
      { chat: { completions: { create } } },
    );

    expect(result.taskType).toBe("UNKNOWN");
    expect(result.intent).toBe("CLASSIFICATION_FAILED");
    expect(result.outcome).toBe("TECHNICAL_FAILURE");
    expect(result.reasoning).toContain("invalid taskType 'MODIFY'");
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("repairs an invalid stage decomposition once instead of failing the run", async () => {
    const invalid = {
      taskType: "REFACTOR",
      risk: "MEDIUM",
      estimatedComplexity: "MEDIUM",
      intent: "REFACTOR",
      targetPath: null,
      confidence: 0.94,
      requiresClarification: false,
      question: null,
      options: null,
      reasoning: "Remove one deprecated component and its references.",
      successCondition: "DETERMINISTIC_STATE",
      stages: [{
        id: "stage-1",
        taskType: "REFACTOR",
        goal: "Remove the deprecated component and clean its references.",
        successCondition: null,
        targetPath: null,
        dependsOn: ["stage-1"],
      }],
    };
    const corrected = {
      ...invalid,
      stages: [{ ...invalid.stages[0], dependsOn: [] }],
    };
    const create = jest.fn()
      .mockResolvedValueOnce(completion(invalid))
      .mockResolvedValueOnce(completion(corrected));

    const result = await IntentClassifier.classifyIntentAndAmbiguity(
      "Remove the deprecated component and clean every reference to it.",
      {},
      ["src/components/LegacyComponent.tsx", "src/App.tsx"],
      { chat: { completions: { create } } },
    );

    expect(result.outcome).not.toBe("TECHNICAL_FAILURE");
    expect(result.taskType).toBe("REFACTOR");
    expect(result.stages?.[0].dependsOn).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);

    const repairMessages = create.mock.calls[1][0].messages;
    expect(repairMessages.at(-1)?.content).toContain("Stage 1 cannot depend on itself");
    expect(repairMessages.at(-1)?.content).toContain("INTENT CLASSIFICATION CORRECTION INSTRUCTIONS");
    expect(repairMessages.at(-1)?.content).not.toContain("For MODIFY actions");
  });
});
