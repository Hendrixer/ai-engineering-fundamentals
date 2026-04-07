// The Diagram Agent eval. One eval definition (dataset + task + scorers)
// that we run many times as we improve the agent. Every run becomes a new
// experiment in Braintrust, automatically tagged with the current git
// branch, commit, dirty flag, and commit message — no manual naming needed.
// You compare experiments in the dashboard via the auto collected metadata.
//
// Run with:
//   npm run eval

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { Eval } from "braintrust";
import { createOpenAI } from "@ai-sdk/openai";

import { runAgent } from "../src/agent-core";
import { buildMessages, type GoldenTestCase } from "./buildMessages";
import { schemaScorer, type AgentOutput } from "./scorers/schema";
import { structureScorer } from "./scorers/structure";
import { toolChoiceScorer } from "./scorers/toolChoice";
import { labelKeywordScorer } from "./scorers/labelKeyword";
// boundArrowsScorer, boundLabelsScorer, connectivityScorer ship in
// evals/scorers/ but are deliberately not wired here. They measure visual
// artifact quality, which is lesson 8's subject. Lesson 8 starts by wiring
// them into this file.

config({ path: ".dev.vars" });

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const testCases: GoldenTestCase[] = JSON.parse(
  readFileSync(join("evals", "datasets", "golden_2.json"), "utf-8")
);

Eval<GoldenTestCase, AgentOutput, GoldenTestCase>("Diagram Agent", {
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
      model: openai("gpt-5.4-mini"),
      messages: buildMessages(testCase),
      // Eval simulates a browser canvas: the seed elements become the
      // initial sim state, and queryCanvas is overridden inside runAgent to
      // read from it. The worker doesn't pass this — it relies on the live
      // browser via the queryCanvas client tool.
      seedCanvas: testCase.seed?.elements ?? [],
      env: { TAVILY_API_KEY: process.env.TAVILY_API_KEY },
    });
    return { text: result.text, elements: result.elements, toolCalls: result.toolCalls };
  },

  scores: [
    schemaScorer,
    structureScorer,
    toolChoiceScorer,
    labelKeywordScorer,
  ],
});
