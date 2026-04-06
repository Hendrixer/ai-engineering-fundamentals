// The Diagram Agent eval. One eval definition (dataset + task + scorers)
// that we run many times as we improve the agent.
//
// Mental model:
//   - this file is the recipe (the benchmark)
//   - each meaningful agent change → run it → that's a new experiment in
//     Braintrust, identified by EXPERIMENT_NAME
//   - tweaks within one variant just add more runs under the same experiment
//
// EXPERIMENT_NAME comes from the env var so the file is stable across
// branches. Each branch's package.json sets it to whatever the current
// "saved comparison point" is (lesson-05-baseline, lesson-06-context-
// engineering, etc). To run an ad hoc variant without editing files,
// override on the command line:
//
//   EXPERIMENT_NAME=lesson-06-prompt-v2 npm run eval

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { Eval } from "braintrust";
import { createOpenAI } from "@ai-sdk/openai";

import { runAgent } from "../src/agent-core";
import { buildMessages, type GoldenTestCase } from "./buildMessages";
import { schemaScorer, type AgentOutput } from "./scorers/schema";
import { structureScorer } from "./scorers/structure";
import { preservationScorer } from "./scorers/preservation";
import { labelKeywordScorer } from "./scorers/labelKeyword";

config({ path: ".dev.vars" });

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-5.4-mini";

const EXPERIMENT_NAME = process.env.EXPERIMENT_NAME ?? "diagram-agent-wip";

const testCases: GoldenTestCase[] = JSON.parse(
  readFileSync(join("evals", "datasets", "golden.json"), "utf-8")
);

Eval<GoldenTestCase, AgentOutput, GoldenTestCase>("Diagram Agent", {
  experimentName: EXPERIMENT_NAME,
  metadata: {
    model: MODEL,
    experiment: EXPERIMENT_NAME,
  },

  data: () =>
    testCases.map((tc) => ({
      input: tc,
      expected: tc,
      metadata: {
        id: tc.id,
        difficulty: tc.difficulty,
        category: tc.category,
      },
    })),

  task: async (testCase) => {
    const result = await runAgent({
      model: openai(MODEL),
      messages: buildMessages(testCase),
    });
    return { text: result.text, elements: result.elements };
  },

  scores: [schemaScorer, structureScorer, preservationScorer, labelKeywordScorer],
});
