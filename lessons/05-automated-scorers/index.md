# Automated Scorers

In lesson 4 you built a custom eval harness from scratch. You ran every test case through the agent and got raw JSON results. The point was to feel what an eval *is*: a dataset, a run loop, a scoring rubric. You also felt what's painful about doing it by hand: editing JSON to score, no UI, no comparison between runs, the dataset only really exercises "create from scratch" cases.

In this lesson we throw away the custom harness and adopt the real tools the industry uses: **`braintrust`** (the SDK and dashboard). Along the way we expand the agent so the eval and the worker share one source of truth, expand the dataset to cover modify and domain cases, and write code based scorers that actually measure the things lessons 6 through 11 will improve.

## Why Migrate Now

You could keep building the custom harness. Add a tiny web UI to read results, add comparison logic, add automated scorers, add database persistence... and now you've built a worse version of Braintrust.

The reason we built our own first wasn't to use it forever. It was to make sure when we install a framework, every piece of its API maps to a concept you already understand.

| Our custom harness | Braintrust |
|--------------------|------------|
| `for` loop over test cases in `run.ts` | `Eval()` block |
| Loading `golden.json` | `data: () => [...]` |
| Calling `generateText` for each case | `task: async (input) => ...` |
| Manually editing scores in JSON | scorer functions in `scores: [...]` |
| Reading `evals/results/<timestamp>.json` | the Braintrust dashboard |
| Eyeballing two JSON files | the dashboard's run history and comparison view |
| `npm run eval` (custom tsx script) | `braintrust eval evals/diagram.eval.ts` |

## Free Signup

Braintrust has a free tier. Sign up at [braintrust.dev](https://www.braintrust.dev), go to Settings → API keys, create a key, and add it to your `.dev.vars`:

```
BRAINTRUST_API_KEY=sk-bt-your-key-here
```

The dashboard URL prints in the terminal after every eval run. Click it and you'll see the results.

## Install

```bash
npm install --save-dev braintrust dotenv dotenv-cli
```

We aren't pulling in `autoevals` here. Their LLM judges (`Factuality`, `ClosedQA`, etc) are great for text shaped outputs but our outputs are structured element arrays, and an LLM judge over JSON is both slow and noisy. We'll write four small deterministic scorers in code instead. If a future lesson needs an LLM judge for some qualitative dimension, we can add `autoevals` then.

### Update `.dev.vars.example`

```
OPENAI_API_KEY=your-openai-api-key-here

# Free signup at https://www.braintrust.dev — used in lesson 5 for the eval dashboard
BRAINTRUST_API_KEY=your-braintrust-api-key-here
```

## Expanding the dataset

Lesson 4's dataset only covered "create a brand new diagram from a text prompt." That's half the agent's surface area. The other half is **modifying** an existing canvas, which the agent will completely fail at today (it has no canvas state in context yet — that's lesson 6) but which we want to measure right now so the lesson 6 lift is visible.

We also want **domain knowledge** cases (OAuth flow, Kubernetes pod/service/deployment, AWS three tier) that the agent should hallucinate plausibly today and then nail after lesson 8 (RAG).

The new dataset is 23 cases broken into four categories:

| Category | Count | Today's score | Lifted by |
|----------|-------|---------------|-----------|
| `create` | 14 | high | baseline, lesson 6 prompt work |
| `modify` | 4 | very low | lesson 6 (canvas state in context) |
| `domain` | 3 | low | lesson 8 (RAG) |
| `edge` | 2 | mixed | trip wire |

The whole point of putting categories in the dataset that score badly today is so future lessons have something to lift. If you only score what already works, every improvement looks like a 2 percent bump and nobody believes the eval matters.

### Modify case shape

A modify case can't just be "make the login box red" — the agent has no idea what login box you're talking about. The test case carries a `seed` block that describes what the canvas already had on it before the user's modify request:

```json
{
  "id": "modify-01",
  "input": "make the login box red",
  "seed": {
    "userPrompt": "draw two rectangles labeled login and database",
    "assistantConfirmation": "Done. Login on the left, database on the right.",
    "elements": [
      { "id": "rect_login", "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 80, "text": "login" },
      { "id": "rect_db", "type": "rectangle", "x": 500, "y": 100, "width": 200, "height": 80, "text": "database" }
    ]
  },
  "expectedCharacteristics": ["rect_login still exists", "rect_login backgroundColor changed", "rect_db unchanged"],
  "preservedIds": ["rect_login", "rect_db"],
  "difficulty": "simple",
  "category": "modify"
}
```

The eval doesn't pass that JSON to the agent directly. It builds a fake conversation history that looks exactly like what the agent would see mid session: the original user request, the agent's tool call producing those seed elements, the matching tool result, the agent's confirmation, then the new user turn. The agent should not be able to tell the difference between this fake history and a real session it lived through.

### `evals/buildMessages.ts`

The helper that converts a test case into a `ModelMessage[]`. Create cases get one user turn. Modify cases get the full fake history.

```ts
import type { ModelMessage } from "ai";

export interface SeedData {
  userPrompt: string;
  assistantConfirmation: string;
  elements: unknown[];
}

export interface GoldenTestCase {
  id: string;
  input: string;
  seed?: SeedData;
  expectedCharacteristics: string[];
  expectedKeywords?: string[];
  preservedIds?: string[];
  difficulty: "simple" | "medium" | "hard" | "edge";
  category: "create" | "modify" | "domain" | "edge";
}

export function buildMessages(tc: GoldenTestCase): ModelMessage[] {
  if (!tc.seed) {
    return [{ role: "user", content: tc.input }];
  }

  const callId = `seed_${tc.id}`;
  return [
    { role: "user", content: tc.seed.userPrompt },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "generateDiagram",
          input: { elements: tc.seed.elements },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "generateDiagram",
          output: { type: "json", value: { elements: tc.seed.elements as never } },
        },
      ],
    },
    { role: "assistant", content: tc.seed.assistantConfirmation },
    { role: "user", content: tc.input },
  ];
}
```

`tool-call` and `tool-result` are the AI SDK v6 part shapes. The `output: { type: "json", value: ... }` wrapping is how v6 distinguishes JSON tool results from text or error variants.

## Sharing the agent between worker and eval

Right now the worker (`src/agent.ts`) and the lesson 4 eval harness both call `generateText` / `streamText` with the same `tools`, the same `SYSTEM_PROMPT`, the same `stepCountIs(5)`. Two copies. They will drift the moment we touch one and forget the other, and the whole point of the eval is to measure the **same** agent that ships.

We pull the shared bits into one file.

### `src/agent-core.ts`

```ts
import {
  generateText,
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { tools } from "./tools";

export const SYSTEM_PROMPT = `You are a diagram design assistant. ...`;

interface AgentArgs {
  model: LanguageModel;
  messages: ModelMessage[];
  system?: string;
  maxSteps?: number;
}

// Streaming variant. Used by the worker for the live chat experience.
export function streamAgent({ model, messages, system = SYSTEM_PROMPT, maxSteps = 5 }: AgentArgs) {
  return streamText({ model, system, messages, tools, stopWhen: stepCountIs(maxSteps) });
}

// Non streaming variant. Used by the eval so we can collect the full result
// and pull out elements for scoring.
export async function runAgent({ model, messages, system = SYSTEM_PROMPT, maxSteps = 5 }: AgentArgs) {
  const result = await generateText({ model, system, messages, tools, stopWhen: stepCountIs(maxSteps) });
  return { text: result.text, elements: extractElements(result.steps), steps: result.steps };
}

interface StepLike {
  toolResults?: { toolName: string; output: unknown }[];
}

export function extractElements(steps: StepLike[]): unknown[] {
  const elements: unknown[] = [];
  for (const step of steps) {
    for (const toolResult of step.toolResults ?? []) {
      if (toolResult.toolName === "generateDiagram") {
        const output = toolResult.output as { elements?: unknown[] };
        if (Array.isArray(output?.elements)) elements.push(...output.elements);
      }
    }
  }
  return elements;
}
```

Two things to notice:

1. **`model` is a parameter**, not constructed inside. The worker gets its API key from `env.OPENAI_API_KEY` (Cloudflare binding). The eval gets it from `process.env.OPENAI_API_KEY` (dotenv). Two different worlds. Keep model construction at the edge.
2. **Two functions, not one with a flag**. `streamAgent` and `runAgent` differ only in the SDK call. The shared parts (prompt, tools, step limit, element extraction) are what we're factoring out.

### Refactor `src/agent.ts`

The worker's chat agent shrinks to almost nothing.

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { streamAgent } from "./agent-core";

interface Env extends Cloudflare.Env {
  OPENAI_API_KEY: string;
}

export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const result = streamAgent({
      model: openai("gpt-5.4-mini"),
      messages: await convertToModelMessages(this.messages),
    });
    return result.toUIMessageStreamResponse();
  }
}
```

Delete `src/system-prompt.ts` — its constant moved into `agent-core.ts`.

## Code based scorers

For our shape (Excalidraw element arrays) we write four code scorers. No LLM calls, no judge prompts, no autoevals. Each one returns either a `{ name, score, metadata }` object, a number, or `null` (which tells Braintrust to skip the case for that scorer).

The `null` return is the trick that lets a single scorer apply only to the cases that make sense for it. The preservation scorer no ops on cases without `preservedIds`. The labelKeyword scorer no ops on cases without `expectedKeywords`. So one set of scorers covers the whole dataset without dragging unrelated categories into each metric.

### `evals/scorers/schema.ts`

The simplest scorer: did the agent produce valid Excalidraw element data? Every element needs `id`, `type`, `x`, `y`, `width`, `height`, and a recognized type. This catches the worst class of failures (no elements, garbage shape, missing fields):

```ts
import type { EvalScorer } from "braintrust";
import type { GoldenTestCase } from "../buildMessages";

const REQUIRED_FIELDS = ["id", "type", "x", "y", "width", "height"] as const;
const VALID_TYPES = ["rectangle", "ellipse", "diamond", "text", "arrow", "line"];

export interface AgentOutput {
  text: string;
  elements: unknown[];
}

export const schemaScorer: EvalScorer<GoldenTestCase, AgentOutput, GoldenTestCase> = ({ output }) => {
  if (!Array.isArray(output.elements) || output.elements.length === 0) {
    return { name: "Schema", score: 0, metadata: { reason: "no elements" } };
  }
  for (const element of output.elements) {
    if (!element || typeof element !== "object") {
      return { name: "Schema", score: 0, metadata: { reason: "element is not an object" } };
    }
    const el = element as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (!(field in el)) {
        return { name: "Schema", score: 0, metadata: { reason: `${el.id} missing ${field}` } };
      }
    }
    if (typeof el.type !== "string" || !VALID_TYPES.includes(el.type)) {
      return { name: "Schema", score: 0, metadata: { reason: `${el.id} invalid type ${el.type}` } };
    }
  }
  return { name: "Schema", score: 1, metadata: { elementCount: output.elements.length } };
};
```

A Braintrust scorer is a function that takes `{ input, output, expected, metadata }` and returns a score. The `name` shows up in the dashboard as the column header. The `metadata` appears in the per case detail view so you can see why something scored low.

### `evals/scorers/structure.ts`

A more interesting check: does the output match the test case's expected structure? We parse the `expectedCharacteristics` strings looking for patterns like "3 rectangle elements" or "2 arrow elements", count the actual elements by type, and score by how close we are. (Code omitted for brevity — it's a 60 line file in `evals/scorers/structure.ts`. The pattern is: extract expected counts from the characteristics list, count actual elements by type, score by proportional difference.)

### `evals/scorers/preservation.ts`

For modify cases, every element id the test case declares as "should still be there" must still exist in the agent's output. This is the deterministic measure of "did the agent patch the canvas or did it nuke it and start over."

```ts
import type { EvalScorer } from "braintrust";
import type { AgentOutput } from "./schema";
import type { GoldenTestCase } from "../buildMessages";

export const preservationScorer: EvalScorer<GoldenTestCase, AgentOutput, GoldenTestCase> = ({
  output,
  expected,
}) => {
  const preservedIds = expected?.preservedIds;
  if (!preservedIds || preservedIds.length === 0) {
    return null; // skip cases that don't care about preservation
  }

  const outputIds = new Set(
    output.elements
      .filter((el): el is { id: string } => !!el && typeof el === "object" && "id" in el)
      .map((el) => el.id)
  );

  let kept = 0;
  const missing: string[] = [];
  for (const id of preservedIds) {
    if (outputIds.has(id)) kept += 1;
    else missing.push(id);
  }

  return {
    name: "Preservation",
    score: kept / preservedIds.length,
    metadata: { kept, missing, total: preservedIds.length },
  };
};
```

(The shipped version also checks that the element's `type` survived, so an agent that "preserves" `rect_login` by changing it to an ellipse gets penalized.)

### `evals/scorers/labelKeyword.ts`

For domain cases (and any case with `expectedKeywords`), we check whether the right vocabulary appears anywhere in the agent's text response or in element labels. Concatenate everything, lowercase, count matches.

```ts
import type { EvalScorer } from "braintrust";
import type { AgentOutput } from "./schema";
import type { GoldenTestCase } from "../buildMessages";

export const labelKeywordScorer: EvalScorer<GoldenTestCase, AgentOutput, GoldenTestCase> = ({
  output,
  expected,
}) => {
  const keywords = expected?.expectedKeywords;
  if (!keywords || keywords.length === 0) return null;

  const haystack = [output.text, ...output.elements.flatMap((el) => {
    if (!el || typeof el !== "object") return [];
    const e = el as Record<string, unknown>;
    return [e.text, e.label].filter((v) => typeof v === "string") as string[];
  })].join(" ").toLowerCase();

  const matched = keywords.filter((kw) => haystack.includes(kw.toLowerCase()));
  return {
    name: "LabelKeywords",
    score: matched.length / keywords.length,
    metadata: { matched, missing: keywords.filter((k) => !matched.includes(k)) },
  };
};
```

This scorer is intentionally dumb. It doesn't know what "OAuth" means or that "client" and "user agent" are related. When the agent eventually has RAG and starts returning the right canonical terms, the score climbs. When it doesn't, it doesn't.

## `evals/diagram.eval.ts`

Now the whole eval in one short file. Braintrust's `Eval()` ties the dataset, the task, and the scorers together.

```ts
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

const testCases: GoldenTestCase[] = JSON.parse(
  readFileSync(join("evals", "datasets", "golden.json"), "utf-8")
);

Eval<GoldenTestCase, AgentOutput, GoldenTestCase>("Diagram Agent", {
  data: () =>
    testCases.map((tc) => ({
      input: tc,
      expected: tc,
      metadata: { id: tc.id, difficulty: tc.difficulty, category: tc.category },
    })),

  task: async (testCase) => {
    const result = await runAgent({
      model: openai("gpt-5.4-mini"),
      messages: buildMessages(testCase),
    });
    return { text: result.text, elements: result.elements };
  },

  scores: [schemaScorer, structureScorer, preservationScorer, labelKeywordScorer],
});
```

Notice we pass the **whole test case** as both `input` and `expected`. The scorers reach into whichever fields they care about. That's simpler than mapping the dataset onto a flat shape and then fighting Braintrust's generic types.

Compare this to the 100+ line `run.ts` we wrote in lesson 4. The agent invocation is one line (`runAgent`). The boilerplate is gone. Braintrust handles the loop, the timing, the dashboard upload, and the result storage.

### Update `package.json`

```json
"scripts": {
  "eval": "dotenv -e .dev.vars -- braintrust eval evals/diagram.eval.ts"
}
```

We wrap the command in `dotenv -e .dev.vars --` because the `braintrust eval` CLI checks for `BRAINTRUST_API_KEY` in the environment **before** it loads our eval file. By the time `dotenv` inside the file runs, braintrust has already errored. The `dotenv-cli` package handles the loading earlier in the chain so braintrust sees the keys when it boots. The `dotenv` import inside the file is still useful as a safety net if you ever run the file directly with `tsx`.

### Delete the old harness

```bash
rm evals/run.ts evals/types.ts
```

The shape they covered now lives in `evals/buildMessages.ts` (test case type) and the Braintrust `Eval` (run loop). Two files for the price of zero.

## Running the eval

```bash
npm run eval
```

You'll see something like:

```
Processing 1 evaluator...
▶ Experiment lesson-5-1775458424 is running at https://www.braintrust.dev/...
██████████ Diagram Agent  100% 23/23 0s

  LabelKeywords  92.87%
  Schema         91.30%
  Structure      63.04%
  Preservation   25.00%
```

Click the URL. The dashboard shows:

- **Each test case as a row** with input, output, and the score from each scorer
- **An overall composite** for the entire run
- **Run history** comparing this run against previous ones with deltas
- **Trace view** for each case showing the LLM calls, tool calls, and tokens used
- **Filtering by metadata** (difficulty, category) so you can isolate where things go wrong

This is the workflow you want for the rest of the course. Each improvement lesson is "make a change → save → re-run → look at the dashboard → see if scores went up." No more JSON editing, no more manual scoring.

## Reading your first real baseline

Your numbers will vary, but the shape should look something like:

```
Schema:        90s    (mostly valid, occasional shape failures on hard cases)
LabelKeywords: 90s    (agent uses the obvious terms when prompted)
Structure:    ~60     (counts often off on medium and hard cases)
Preservation: ~25     (modify cases mostly fail — agent has no canvas state)
```

The 25 percent on Preservation is the headline. It is **not a bug**. The agent has no idea what's on the canvas — the only context it has is the fake message history we constructed. Real production behavior post lesson 6 (where canvas state gets serialized into the system prompt) should bring this much closer to 1.

Specifically, here's where you'd expect each lesson to lift things:

| Lesson | Expected lift |
|--------|---------------|
| **6 — Context engineering** | Preservation up dramatically (canvas state in context). Structure and LabelKeywords up across the board (better system prompt). |
| **7 — Advanced tools** | Structure score up significantly. Smaller, focused tools mean fewer counting mistakes. |
| **8 — RAG** | LabelKeywords up on `domain` cases. The agent finally knows the canonical terms for OAuth, AWS three tier, Kubernetes. |
| **11 — Planning mode** | Hard `create` cases up. Org charts and complex flows benefit most from a planning step. |

If you don't see these lifts when you make those changes, something is wrong. That's the whole point of evals.

## Adding a human review score

Code scorers cover correctness but not aesthetics. "Did the agent produce valid elements?" is different from "would I be embarrassed to show this to a coworker?" For the second one we want a human in the loop, and Braintrust has a first class workflow for it.

In the dashboard, open your project's settings and find **Human review scores**. Click **Create human review score**. You'll get a modal asking for:

- **Score name**: `Visual Quality`
- **Description**: 
  ```
  Rate the diagram's visual quality as a human would judge it. Consider:
  - Are elements positioned sensibly (no overlaps, reasonable spacing)?
  - Do arrows actually connect the things they should?
  - Are labels readable and on the right elements?
  - Would you be embarrassed to show this to a coworker?
  ```
- **Type**: Options (categorical)
- **Options**:
  - `Great` → 1.0
  - `Acceptable` → 0.66
  - `Rough but usable` → 0.33
  - `Broken` → 0.0
- Leave **Write to expected field** unchecked (you're scoring runs, not correcting the dataset)
- Leave **Allow multiple choice** unchecked

Why categorical instead of a slider? Humans are bad at "give this a 0.7." They're good at picking from three or four buckets. Faster to grade, more consistent across raters.

Why four options instead of pass/fail? It gives you signal on "the agent is improving even if it's not perfect yet," which is the whole point of running evals across lessons.

Once created, the score appears in every experiment row in the dashboard. Open a run, click into a row, pick an option, repeat. After scoring 23 cases (about 5 minutes) you've got a baseline `Visual Quality` number alongside the four code scorers. Re run the eval after lesson 6, score the new run, compare the deltas in the run history view.

You don't need to score every row of every run. A representative sample (say all the modify cases plus a couple of hard create cases) is plenty to know whether your agent got prettier.

## What is next

You have a real eval pipeline now. From here on, every improvement lesson follows the same loop: read the technique → make the change → run `npm run eval` → look at the dashboard → see if the numbers moved.

In the next lesson we start the second half of the course: **context engineering**. You'll redesign the system prompt, serialize the canvas state into the agent's context, add chat compaction for long conversations, and add image upload for multimodal context. Then re-run this eval and watch Preservation in particular climb out of the basement.
