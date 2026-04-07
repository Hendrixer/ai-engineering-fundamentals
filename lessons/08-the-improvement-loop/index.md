# The Improvement Loop

Lesson 7 finished the agent's tools. This lesson is not about a new technique. It is about *the loop you run when something is wrong*. By the end of the lesson the agent draws better diagrams and the eval scores reflect it. The bigger thing to take away is the loop itself, because every lesson after this one is just another turn of the same wheel.

## What the loop is

```
run the eval
  → look at the numbers
  → look at the live product
  → form a theory about why they disagree
  → make ONE focused change
  → run the eval again
  → did the number move? did the product look better? did one move and not the other?
  → repeat
```

The whole job is staying honest about what each iteration actually changed. The first theory is wrong more than half the time. That is fine. The eval points at the wrong theory and the next attempt gets closer. The trap is making three changes at once and then having no idea which one moved the score.

## Where we start

Three scorer files have been sitting in `evals/scorers/` since lesson 7, written but never wired into the eval registration. They were always going to be needed once visual quality became the subject, and that is what this lesson is about. Open them and read the header comments first:

- `evals/scorers/boundLabels.ts` measures whether each container shape has a text element with `containerId` pointing back at it
- `evals/scorers/boundArrows.ts` measures whether each arrow has both `startBinding` and `endBinding` set to ids that exist in the output
- `evals/scorers/connectivity.ts` measures whether shapes in connectivity prompts (the user said "flow", "sequence", "between") are reachable through the arrow graph

Wire all three into `evals/diagram.eval.ts`:

```ts
import { boundLabelsScorer } from "./scorers/boundLabels";
import { boundArrowsScorer } from "./scorers/boundArrows";
import { connectivityScorer } from "./scorers/connectivity";

// ...

scores: [
  schemaScorer,
  structureScorer,
  toolChoiceScorer,
  labelKeywordScorer,
  boundArrowsScorer,
  connectivityScorer,
  boundLabelsScorer,
],
```

Run the eval:

```bash
npm run eval
```

The Braintrust summary now reports BoundArrows, BoundLabels, and Connectivity alongside the lesson 7 scorers. Most of those numbers will look fine. The lesson is going to show that two of them are lying.

## Iteration 1: the eval is lying (it just looks fine)

Open the live app in the browser, ask the agent for "a diagram showing how jwts work", and look at the canvas.

The diagram has boxes. The boxes are empty. There is no text inside any of them. The arrows are there, but every label is missing.

Now look back at the BoundLabels score in the Braintrust summary. That number says the agent labels its boxes most of the time. The eyes say the agent labels its boxes none of the time. Both cannot be true.

**Plan:** before changing anything in the agent, figure out why the eval and the canvas disagree. Read `evals/scorers/boundLabels.ts` and trace what it actually measures. Then read how the agent's output gets fed to the scorer.

The trail leads to two places:

1. **The schema teaches the wrong vocabulary.** `src/tools/element-schema.ts` defines arrow bindings as `startBinding` / `endBinding` and labels as `containerId` on a separate text element. Those are the *runtime* field names that exist on Excalidraw elements after they are rendered. They are NOT the field names that the `convertToExcalidrawElements` helper consumes when it produces those runtime elements. The helper wants `start: { id }` / `end: { id }` and `label: { text }` directly on the shape. When the agent emits the runtime field names the helper silently drops them. The live canvas has unbound arrows and unlabeled boxes.

2. **The eval simulator does not run the helper at all.** Look at `src/agent-core.ts` in `runAgent`'s `addElements` execute:

   ```ts
   execute: async ({ elements }) => {
     for (const el of elements) sim.push({ ...(el as object) });
     return { elements };
   },
   ```

   The simulator spreads the model's raw input into a flat array. The `BoundLabels` scorer reads that flat array and finds `containerId` set on the model's text elements. It credits the agent for labels that the live canvas would never actually render. **The eval is grading model claims, not rendered output.**

This is the most important point in the lesson. *An eval simulator must produce the same data the live renderer produces, or the scorer is measuring a fiction.*

### Make the change

Two fixes, applied in this order so the score movement tells a clean story.

**First,** rewrite the schema to match what `convertToExcalidrawElements` actually consumes. Drop `containerId`, `startBinding`, `endBinding`, `points`. Add `label: { text }` on shapes and `start: { id }` / `end: { id }` on arrows. Make it a `z.union` of per type variants so the model literally cannot put a label on an arrow or a binding on a rectangle.

Use `z.union`, not `z.discriminatedUnion`. The latter compiles to JSON Schema `oneOf`, which OpenAI strict mode rejects with `Invalid schema for function 'addElements': 'oneOf' is not permitted`. `z.union` compiles to `anyOf`, which strict mode accepts. The model still picks the right branch by the `type` literal.

**`src/tools/element-schema.ts`** (full rewrite):

```ts
import { z } from "zod";

const styling = {
  strokeColor: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).nullable(),
  strokeWidth: z.number().nullable(),
  roughness: z.number().nullable(),
  opacity: z.number().nullable(),
};

const labelSchema = z.object({
  text: z.string(),
  fontSize: z.number().nullable(),
  textAlign: z.enum(["left", "center", "right"]).nullable(),
});

const baseFields = {
  id: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
};

const rectangleSchema = z.object({
  type: z.literal("rectangle"),
  ...baseFields,
  label: labelSchema.nullable(),
  ...styling,
});

const ellipseSchema = z.object({
  type: z.literal("ellipse"),
  ...baseFields,
  label: labelSchema.nullable(),
  ...styling,
});

const diamondSchema = z.object({
  type: z.literal("diamond"),
  ...baseFields,
  label: labelSchema.nullable(),
  ...styling,
});

const endpointSchema = z.object({ id: z.string() });

const arrowSchema = z.object({
  type: z.literal("arrow"),
  ...baseFields,
  start: endpointSchema.nullable(),
  end: endpointSchema.nullable(),
  label: labelSchema.nullable(),
  ...styling,
});

const lineSchema = z.object({
  type: z.literal("line"),
  ...baseFields,
  start: endpointSchema.nullable(),
  end: endpointSchema.nullable(),
  ...styling,
});

const textSchema = z.object({
  type: z.literal("text"),
  ...baseFields,
  text: z.string(),
  fontSize: z.number().nullable(),
  textAlign: z.enum(["left", "center", "right"]).nullable(),
  ...styling,
});

export const elementSchema = z.union([
  rectangleSchema,
  ellipseSchema,
  diamondSchema,
  arrowSchema,
  lineSchema,
  textSchema,
]);
```

Update the `addElements` tool description and the `agent-core.ts` system prompt to use the new vocabulary (`label.text`, `start.id`, `end.id`). Update `App.tsx`'s `stripNulls` to recurse into nested objects so `label: { fontSize: null }` does not choke the helper.

Run the eval.

Every visual scorer collapses to near zero. **This is the proof.** The live canvas got better and the eval got worse. The eval was lying in both directions: it was lying high before, and it is lying low now. Switch over to the live app and look at the canvas. The boxes are labeled. The arrows are bound. The product is healthier than it has ever been. The number is wrong.

**Second,** fix the simulator. Write a small node safe helper that mimics what `convertToExcalidrawElements` does for the fields the scorers care about: take `label: { text }` on a shape and produce a synthetic child text element with `containerId` plus `boundElements` on the parent. Take `start: { id }` / `end: { id }` on an arrow and produce `startBinding` / `endBinding` with `focus: 0` and `gap: 8`.

`@excalidraw/excalidraw` cannot be imported in node directly (it has a transitive dependency on `roughjs` whose `package.json` exports map breaks ESM resolution). The helper has to be hand written. The full implementation is short:

**`src/context/applySkeleton.ts`**:

```ts
type SkeletonElement = Record<string, unknown>;
type RuntimeElement = Record<string, unknown>;

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

export function applySkeleton(skeletons: SkeletonElement[]): RuntimeElement[] {
  const cleaned = skeletons.map((el) => stripNulls(el) as Record<string, unknown>);
  const out: RuntimeElement[] = [];

  for (const el of cleaned) {
    const type = el.type as string;

    if (type === "rectangle" || type === "ellipse" || type === "diamond") {
      const { label, ...shapeFields } = el;
      const shape: RuntimeElement = { ...shapeFields };
      if (label && typeof label === "object") {
        const labelObj = label as Record<string, unknown>;
        const text = labelObj.text;
        if (typeof text === "string" && text.length > 0) {
          const childId = `${el.id}_label`;
          shape.boundElements = [{ id: childId, type: "text" }];
          out.push(shape);
          out.push({
            id: childId,
            type: "text",
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            text,
            containerId: el.id,
          });
          continue;
        }
      }
      out.push(shape);
      continue;
    }

    if (type === "arrow" || type === "line") {
      const { start, end, ...arrowFields } = el;
      const arrow: RuntimeElement = { ...arrowFields };
      if (start && typeof start === "object") {
        const startId = (start as Record<string, unknown>).id;
        if (typeof startId === "string") {
          arrow.startBinding = { elementId: startId, focus: 0, gap: 8 };
        }
      }
      if (end && typeof end === "object") {
        const endId = (end as Record<string, unknown>).id;
        if (typeof endId === "string") {
          arrow.endBinding = { elementId: endId, focus: 0, gap: 8 };
        }
      }
      out.push(arrow);
      continue;
    }

    out.push(el);
  }

  return out;
}
```

Wire it into `runAgent`'s `addElements` execute:

```ts
import { applySkeleton } from "./context/applySkeleton";

// ...

addElements: tool({
  description: baseTools.addElements.description,
  inputSchema: baseTools.addElements.inputSchema as never,
  execute: async ({ elements }: { elements: unknown[] }) => {
    const runtime = applySkeleton(elements as Record<string, unknown>[]);
    for (const el of runtime) sim.push({ ...el });
    return { added: runtime.length };
  },
}),
```

Run the eval again. Every visual scorer recovers. `BoundArrows` lands above its original baseline because the new schema structurally enforces `start` / `end` on every arrow. `BoundLabels` lands roughly where it started numerically — but **the meaning is completely different**. The old number was a lie. The new number is honest. Same digits, totally different ground truth. A scorer's value is only as trustworthy as the parity between the eval simulator and the live renderer.

## Iteration 2: tighten the label requirement (a negative result)

`BoundLabels` is honest but not perfect. The model still fails to label some shapes. The schema makes `label` nullable so the model can omit it. The obvious fix is to make `label` non nullable so the model literally cannot emit a container without a label.

**Plan:** make `label: labelSchema` (drop the `.nullable()`) on the three container shapes. Strengthen the system prompt to say "every container shape MUST have a non empty label.text."

Apply the change. Run the eval.

The score does not move. This is more useful than a clean win, because the next step is figuring out why the obvious fix did nothing. Add a temporary `console.log` to `boundLabels.ts` to dump the unlabeled shapes from each test case. Run the eval one more time and read the output.

Two patterns surface:

1. **Modify cases hallucinate scaffolding.** Test cases like `modify-01` ("make the login box red") have `seed.elements: []`. The model has no canvas to read from, so it creates `rect_login` and `rect_db` from scratch with `label: { text: "" }` to set up the scene before "modifying" them. Empty string passes the schema. `applySkeleton` drops empty text labels (the `text.length > 0` check) and the shape lands in `sim` with no child text element. The schema enforcement worked, the scorer is reading correctly, and the failure is in the dataset.

2. **Sequence diagram lifelines are intentionally unlabeled rectangles.** The system prompt teaches lifelines as 4px wide tall rectangles WITHOUT labels (the actor box above carries the label). The rule "every container must have a label" has a legitimate exception. The schema cannot encode "rectangles labeled as lifelines are exempt."

**Revert the schema and prompt change.** Do not be precious about it. This iteration is more valuable as a documented negative result than as a forced positive one. The lesson is: the obvious fix is not always the right fix, and the schema is not always the right place to enforce a rule. Some rules belong in the dataset. Some rules have legitimate exceptions and need a per case scorer carve out instead.

Iteration 4 comes back to the modify case dataset bug.

## Iteration 3: a layout scorer and an in loop feedback signal

Run the live app. Ask for a JWT diagram with several boxes. The boxes are now labeled, but they overlap each other and the labels collide. The eval does not know about layout because nothing has measured it.

**Plan:** add a `noOverlaps` scorer that detects intersecting elements. Same finding gets returned in the `addElements` tool result so the agent loop sees collisions immediately and can self correct via `updateElements` without a separate `queryCanvas` round trip.

Single shared implementation in `src/context/overlaps.ts` so the agent feedback signal and the eval scorer measure exactly the same thing. If they drifted there would be the worst of both worlds: an agent that addressed one signal but the eval still flagged it.

**`src/context/overlaps.ts`** (the meat of it):

```ts
const EPSILON = 4;

function intersects(a, b) {
  return (
    a.x + EPSILON < b.x + b.w &&
    a.x + a.w > b.x + EPSILON &&
    a.y + EPSILON < b.y + b.h &&
    a.y + a.h > b.y + EPSILON
  );
}

export function findOverlaps(elements) {
  const els = elements;
  const typeById = buildTypeIndex(els);

  const eligible = [];
  for (const el of els) {
    if (!isEligible(el, typeById)) continue;
    eligible.push({ id: el.id, b: box(el) });
  }

  const pairs = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (intersects(eligible[i].b, eligible[j].b)) {
        const a = eligible[i].id;
        const c = eligible[j].id;
        pairs.push(a < c ? [a, c] : [c, a]);
      }
    }
  }
  return pairs;
}
```

Carve outs to think about up front:

1. Arrow and line elements: their paths legitimately cross shapes when routing between them. Skip them.
2. Container labels (text element bound to a rectangle/ellipse/diamond): the label is supposed to sit inside the shape. Skip them.
3. **Arrow labels** (text bound to an arrow or line): these sit ALONG the path, NOT inside anything. They can collide. *Do not skip them.* Iteration 5 catches this when the first carve out gets it wrong.

The scorer:

**`evals/scorers/noOverlaps.ts`**:

```ts
import { findOverlaps, countOverlapEligiblePairs } from "../../src/context/overlaps";

export const noOverlapsScorer = ({ output }) => {
  const elements = output.elements ?? [];
  const totalPairs = countOverlapEligiblePairs(elements);
  if (totalPairs === 0) return null;

  const overlapping = findOverlaps(elements);
  return {
    name: "NoOverlaps",
    score: 1 - overlapping.length / totalPairs,
    metadata: {
      overlapping_pairs: overlapping,
      total_pairs: totalPairs,
      passed: overlapping.length === 0,
    },
  };
};
```

Register it in `evals/diagram.eval.ts`. Wire `findOverlaps` into:

- `runAgent`'s `addElements` execute, returning `{ added, overlaps }`
- `App.tsx`'s `addElements` client handler, also returning `{ added, overlaps }`
- `serializeCanvasState` so `queryCanvas` reports overlaps in its summary

Add a behavioral rule to the system prompt:

> **Act on overlap feedback.** Every `addElements` result includes an `overlaps` array listing pairs of element ids whose bounding boxes collide on the canvas. If `overlaps` is non empty after a call, the next action MUST be one or more `updateElements` calls that move the offending elements apart. Do not leave overlaps in the final layout.

Run the eval. `NoOverlaps` lands in the high 90s. Most existing dataset cases are small and clean enough that they do not stress layout much. Iteration 4 changes that.

The agent feedback signal does not show up as a number on the eval but it does show up in the live app. Open the chat panel and ask for a diagram with several connected boxes. The chat should show `addElements` followed by `updateElements` for any prompt that produces overlapping boxes. The model is reading the overlap pairs and acting on them.

## Iteration 4: bigger defaults and a bigger dataset

Two compounding problems:

1. The default rectangle size in the system prompt is 200x80, which is too narrow for two word labels like "Auth Server."
2. The dataset has 23 cases, mostly small/clean. `NoOverlaps` is high partly because there is not much layout pressure to begin with.

**Plan:** bump the default sizing in the system prompt to 240x100 standard rectangle, 320px horizontal stride, 180px vertical stride. Then expand the golden dataset with cases that genuinely stress layout: long labels, sequence diagrams with many actors, ER diagrams, state machines, plus an explicit tight grid case that should NOT trip `NoOverlaps` (validates the 4px epsilon carve out).

While editing the dataset, fix the modify case seeds discovered in iteration 2. The current seeds use the OLD vocabulary (`text: "Login"` directly on rectangles) which the simulator pushes into `sim` unchanged, so the seed shapes count against `BoundLabels` forever. Rewrite each seed in runtime form (each labeled rect becomes a rect with `boundElements` plus a child text element with `containerId`, each connecting arrow becomes an arrow with `startBinding` / `endBinding`).

A small migration script handles both at once:

**`scripts/update-golden.mjs`**:

```js
function labeledRect(rect) {
  const childId = `${rect.id}_label`;
  const shape = { ...rect };
  delete shape.text;
  shape.boundElements = [{ id: childId, type: "text" }];
  const child = {
    id: childId,
    type: "text",
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    text: rect.text,
    containerId: rect.id,
  };
  return [shape, child];
}

function boundArrow(arrow, startId, endId) {
  return {
    ...arrow,
    startBinding: { elementId: startId, focus: 0, gap: 8 },
    endBinding: { elementId: endId, focus: 0, gap: 8 },
  };
}
```

Use these helpers to rewrite the four modify cases, then append the new layout stress cases (`create-architecture-jwt`, `create-sequence-oauth`, `create-flowchart-deploy`, `create-erd-blog`, `create-state-machine-order`, `create-long-labels`, `create-three-word-labels`, `create-tight-grid`). Read the script in the repo for the full list.

Run the eval. `BoundLabels` jumps significantly because the modify seeds were structurally guaranteed to fail before. `NoOverlaps` holds even though the dataset is now substantially larger and includes explicit layout stress cases, which means the bigger sizing defaults are doing real work, not just clearing easy cases.

This is the lesson reinforcing itself: **a scorer can only catch what the dataset stresses.** Iteration 1 was about the eval simulator lying. This iteration is about the dataset lying. Same shape of bug, different layer.

## Iteration 5: smoke test the live app and find another lie

`NoOverlaps` is at 100%. The eval thinks layout is solved.

Open the live app. Ask the agent for "a diagram showing how jwts work". Look at it.

`API / Resource Server` overflows its box. Arrow labels collide near the central node. There is a free floating annotation block at the bottom. Multiple shapes are visually overlapping if you look closely.

The eval said 100%. The eyes say no.

**Plan:** open `src/context/overlaps.ts` and re read the carve outs. The scorer skips bound text labels (text element with `containerId` set) without checking what KIND of element the container is. Container labels (text inside a rectangle) are intentionally inside their parent and should be skipped. Arrow labels (text along the path of an arrow) are NOT inside anything visually and routinely collide. The carve out is wrong.

Distinguish them:

```ts
function isContainerLabel(el, typeById) {
  if (el.type !== "text") return false;
  if (typeof el.containerId !== "string") return false;
  const parentType = typeById.get(el.containerId);
  return parentType === "rectangle" || parentType === "ellipse" || parentType === "diamond";
}
```

A label whose parent is a `rectangle` / `ellipse` / `diamond` is exempt. A label whose parent is an `arrow` / `line` is checked. While editing the file, also tighten the system prompt:

- Add a sizing heuristic: `width = max(240, 14 * label_text_length)`. The default of 240 fits about two short words; longer labels need more room and the model has to size up.
- Add an arrow label spacing rule: when arrow labels are present, stride at least 400px and prefer SHORT labels ("login") over long ones ("1. send login request to auth server").

Run the eval. `NoOverlaps` drops slightly. Several test cases now show small overlap penalties that the broken carve out was hiding. **The score going down is the right direction.** The product did not get worse — the measurement got more honest.

Re run the live app smoke test. The diagram is dramatically better: every label fits inside its box, no annotation block at the bottom, layout is clean enough that the residual issues only show up on the most complex diagrams. Check the chat panel: `addElements` should be followed by `updateElements` cycles, which means the agent received the overlap feedback signal and used it to reposition shapes.

There is one bug class left where three arrows fan into the same central node and their midpoint labels cluster on top of each other. Resolving that needs either more agent steps or a smarter feedback signal that suggests specific moves rather than just listing colliding pairs. Both are out of scope for this lesson.

## What this lesson actually taught

Five iterations. Three of them were about the eval lying in different ways: the simulator (iteration 1), the dataset (iteration 4), and the scorer carve outs (iteration 5). Every layer of the eval got made honest at least once. There was also one negative result that got reverted and one improvement that did not show up as a number but did show up in the live product.

The pattern that holds across every iteration:

1. Run the eval.
2. Compare the numbers to the live product.
3. When they disagree, the eval is wrong first. Almost always. The scorer, the simulator, the dataset, or the assumption about what the model actually does — one of those is the lie. Find the lie and fix it BEFORE changing the agent.
4. Once the eval and the product agree, propose a change to the agent (schema, prompt, tool result, dataset).
5. Make ONE change. Re run.
6. If the number moved in the direction expected, commit and write down what was learned.
7. If the number moved the wrong way or did not move at all, the lie was somewhere else. Go back to step 3.

This is the loop. Every lesson after this one is just another turn of it. RAG is "the agent does not know enough domain facts, plan a retrieval system, measure whether retrieval moved the score." Human in the loop is "the agent is making destructive choices unsupervised, plan an approval flow, measure whether trust scores moved." Agent architectures is "the agent gets stuck in single step thinking, plan a planning step, measure whether complex diagram scores moved." Same loop, different lever.

## One helper that ships pre built

`src/context/cross-call-bindings.ts` already exists in the repo. It is not part of the lesson — students do not write it during the workshop. It patches arrow bindings after `convertToExcalidrawElements` runs, because the helper only resolves arrow start/end ids against elements in its own input batch. When the agent splits a diagram across multiple `addElements` calls the second call's arrows lose their bindings to shapes from the first call. The util walks the new skeleton input and restores those bindings against `api.getSceneElements()`. Plumbing around an Excalidraw limitation, not interesting for the lesson.

The file is short, well commented, and reads top to bottom in a few minutes for anyone who wants to know how it works.

## Known issues to expect

`@cloudflare/ai-chat` 0.3.2 has three React errors that fire in the dev console: a `Maximum update depth exceeded` from the WebSocket message handler, a `duplicate key` warning from messages with the same id, and a `TypeError: Cannot read 'state' of undefined` at `Chat.makeRequest`. They reproduce on every commit on this branch and on the previous lesson 7 commits. They do not break the chat UI but they make the dev console noisy. See `KNOWN_ISSUES.md` at the repo root for details and possible workarounds.

`convertToExcalidrawElements` also logs `No element for start binding with id rect_X found` warnings when arrows are added in a separate call from their endpoints. The cross call binding helper above patches the runtime arrows so the visual result is correct, but the helper logs the warning during processing before the patch runs. Functionally harmless, just dev console noise.
