# The Improvement Loop

Lesson 7 finished the agent's tools. This lesson is not about a new technique. It is about *the loop you run when something is wrong*. By the end of this lesson the agent draws better diagrams, and the eval scores prove it. But the bigger thing you take away is the loop itself, because every lesson after this one is just another turn of the same wheel.

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

The whole job is staying honest about what each iteration actually changed. You will be wrong about your theory more than half the time. That is fine. The eval tells you when you are wrong and you go again. The trap is making three changes at once and then having no idea which one moved the score.

## Where we start

Three scorer files have been sitting in `evals/scorers/` since lesson 7, written but never wired into the eval registration. They were always going to be needed once we started measuring visual quality, and that is what this lesson is about. Open them and read the header comments:

- `evals/scorers/boundLabels.ts` measures whether each container shape has a text element with `containerId` pointing back at it
- `evals/scorers/boundArrows.ts` measures whether each arrow has both `startBinding` and `endBinding` set to ids that exist in the output
- `evals/scorers/connectivity.ts` measures whether shapes in connectivity prompts (the user said "flow", "sequence", "between") are reachable through the arrow graph

Wire them into `evals/diagram.eval.ts`:

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

Now run the eval:

```bash
npm run eval
```

You should see something like this in the Braintrust summary:

```
BoundArrows     88.24%
BoundLabels     81.16%
Connectivity    90.95%
LabelKeywords   94.54%
Schema         100.00%
Structure       64.67%
ToolChoice      95.24%
```

Most of those numbers look fine. The lesson is going to show you that two of them are lying.

## Iteration 1: the eval is lying (you just don't know it yet)

Open the live app in your browser, ask the agent to "make a diagram to show me how jwts work", and look at what shows up on the canvas.

You will see boxes. The boxes will be empty. There is no text inside any of them. The arrows are there, but every label is missing.

Now look at the eval score for `BoundLabels`. It is 81.16%. That number says "the agent labels its boxes 81% of the time." Your eyes say "the agent labels its boxes 0% of the time." Both cannot be true.

**Plan:** before changing anything in the agent, figure out why the eval and your eyes disagree. Read `evals/scorers/boundLabels.ts` and trace what it actually measures. Then read how the agent's output gets fed to the scorer.

The trail leads to two places:

1. **The schema teaches the wrong vocabulary.** `src/tools/element-schema.ts` defines arrow bindings as `startBinding` / `endBinding` and labels as `containerId` on a separate text element. Those are the *runtime* field names that exist on Excalidraw elements after they are rendered. They are NOT the field names that the `convertToExcalidrawElements` helper consumes when it produces those runtime elements. The helper wants `start: { id }` / `end: { id }` and `label: { text }` directly on the shape. When the agent emits the runtime field names the helper silently drops them. The live canvas has unbound arrows and unlabeled boxes.

2. **The eval simulator does not run the helper at all.** Look at `src/agent-core.ts` `runAgent`'s `addElements` execute:

   ```ts
   execute: async ({ elements }) => {
     for (const el of elements) sim.push({ ...(el as object) });
     return { elements };
   },
   ```

   The simulator just spreads the model's raw input into a flat array. The `BoundLabels` scorer reads that flat array and finds `containerId` set on the model's text elements. It credits the agent for labels that the live canvas would never actually render. **The eval is grading model claims, not rendered output.**

This is the most important thing you will learn this lesson. *Your eval simulator must produce the same data your live renderer produces, or your scorer is measuring a fiction.*

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

```
BoundArrows     0.00%   (-88.24)
BoundLabels     0.00%   (-81.16)
Connectivity   25.07%   (-65.88)
LabelKeywords  10.65%   (-83.89)
```

Every visual scorer collapsed. **This is the proof.** You made the live canvas better, and the eval got worse. The eval was lying in both directions: it was lying high before, and it is lying low now. Look at the canvas in the live app. The boxes are labeled. The arrows are bound. The product is healthier than it has ever been. The number is wrong.

**Second,** fix the simulator. Write a small node safe helper that mimics what `convertToExcalidrawElements` does for the fields the scorers care about: take `label: { text }` on a shape and produce a synthetic child text element with `containerId` plus `boundElements` on the parent. Take `start: { id }` / `end: { id }` on an arrow and produce `startBinding` / `endBinding` with `focus: 0` and `gap: 8`.

`@excalidraw/excalidraw` cannot be imported in node directly (it has a transitive dependency on `roughjs` whose `package.json` exports map breaks ESM resolution). So you write the helper yourself. The full implementation lives at `src/context/applySkeleton.ts`. The interesting part is small enough to read in one sitting:

**`src/context/applySkeleton.ts`** (excerpt):

```ts
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

Run the eval again.

```
BoundArrows    94.44%   (recovered + improved)
BoundLabels    81.88%   (recovered)
Connectivity   88.10%
LabelKeywords  93.43%
```

Every visual scorer is back. `BoundArrows` is actually *higher* than the original baseline because the new schema structurally enforces `start` / `end` on every arrow. `BoundLabels` is at 81.88%, almost exactly the same number it was at before (81.16%) — but **the meaning is completely different**. The first 81% was a lie. The second 81% is honest. Same number, totally different ground truth. *This is the lesson 8 money quote.* Your scorer's value is only as trustworthy as the parity between your eval simulator and your live renderer.

## Iteration 2: tighten the label requirement (a negative result)

`BoundLabels` at 82% means the model still fails to label about one in five shapes. The schema makes `label` nullable so the model can omit it. The obvious fix is to make `label` non nullable so the model literally cannot emit a container without a label.

**Plan:** make `label: labelSchema` (drop the `.nullable()`) on the three container shapes. Strengthen the system prompt to say "every container shape MUST have a non empty label.text."

Apply the change. Run the eval.

```
BoundLabels    81.88% → 81.88%   (no change)
```

It does not move. At all. Same number to two decimals.

This is more useful than a clean win, because you now have to figure out why the obvious fix did nothing. Add a temporary `console.log` to `boundLabels.ts` to dump the unlabeled shapes from each test case. Run the eval one more time and read the output.

You will see two patterns:

1. **Modify cases hallucinate scaffolding.** Test cases like `modify-01` ("make the login box red") have `seed.elements: []`. The model has no canvas to read from, so it creates `rect_login` and `rect_db` from scratch with `label: { text: "" }` to set up the scene before "modifying" them. Empty string passes the schema. `applySkeleton` drops empty text labels (the `text.length > 0` check) and the shape lands in `sim` with no child text element. The schema enforcement worked, the scorer is reading correctly, and the failure is in the dataset.

2. **Sequence diagram lifelines are intentionally unlabeled rectangles.** The system prompt teaches lifelines as 4px wide tall rectangles WITHOUT labels (the actor box above carries the label). The rule "every container must have a label" has a legitimate exception. The schema cannot encode "rectangles labeled as lifelines are exempt."

**Revert the schema and prompt change.** Do not be precious about it. This iteration is more valuable as a documented negative result than as a forced positive one. The lesson is: the obvious fix is not always the right fix, and the schema is not always the right place to enforce a rule. Some rules belong in the dataset. Some rules have legitimate exceptions and need a per case scorer carve out instead.

We will come back to the modify case dataset bug in iteration 4.

## Iteration 3: a layout scorer and an in loop feedback signal

Run the live app. Ask for a JWT diagram with several boxes. The boxes are now labeled, but they overlap each other and the labels collide. The eval doesn't know about layout because we never measured it.

**Plan:** add a `noOverlaps` scorer that detects intersecting elements. Same finding gets returned in the `addElements` tool result so the agent loop sees collisions immediately and can self correct via `updateElements` without a separate `queryCanvas` round trip.

Single shared implementation in `src/context/overlaps.ts` so the agent feedback signal and the eval scorer measure exactly the same thing. If they drifted you would get the worst of both worlds: an agent that addressed one signal but the eval still flagged it.

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
3. **Arrow labels** (text bound to an arrow or line): these sit ALONG the path, NOT inside anything. They can collide. *Do not skip them.* (We will come back to this in iteration 5 because we get it wrong the first time.)

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

> **Act on overlap feedback.** Every `addElements` result includes an `overlaps` array listing pairs of element ids whose bounding boxes collide on the canvas. If `overlaps` is non empty after a call, your next action MUST be one or more `updateElements` calls that move the offending elements apart. Do not leave overlaps in the final layout.

Run the eval. `NoOverlaps` comes in at 95.17%. Most existing dataset cases are small and clean enough that they do not stress layout much. We will fix that in iteration 4.

The agent feedback signal does not show up as a number on the eval but you can verify it works by opening the live app and asking for a diagram. You should see `addElements` followed by `updateElements` in the chat panel for any prompt that produces overlapping boxes. The model is reading the overlap pairs and acting on them.

## Iteration 4: bigger defaults and a bigger dataset

Two compounding problems:

1. The default rectangle size in the system prompt is 200x80, which is too narrow for two word labels like "Auth Server."
2. The dataset has 23 cases, mostly small/clean. `NoOverlaps` is at 95% partly because there is not much layout pressure to begin with.

**Plan:** bump the default sizing in the system prompt to 240x100 standard rectangle, 320px horizontal stride, 180px vertical stride. Then expand the golden dataset with cases that genuinely stress layout: long labels, sequence diagrams with many actors, ER diagrams, state machines, plus an explicit tight grid case that should NOT trip `NoOverlaps` (validates the 4px epsilon carve out).

While we are in the dataset, fix the modify case seeds we discovered in iteration 2. The current seeds use the OLD vocabulary (`text: "Login"` directly on rectangles) which the simulator pushes into `sim` unchanged, so the seed shapes count against `BoundLabels` forever. Rewrite each seed in runtime form (each labeled rect becomes a rect with `boundElements` plus a child text element with `containerId`, each connecting arrow becomes an arrow with `startBinding` / `endBinding`).

A small migration script to do both at once:

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

Run the eval.

```
BoundArrows    94.44% → 100.00%  (+5.56)
BoundLabels    81.88% →  96.77%  (+14.89)
LabelKwds      95.65% →  96.99%  (+1.34)
NoOverlaps    100.00% → 100.00%  (held flat under 35% larger dataset)
```

`BoundLabels` jumped 15 points because the modify seeds were structurally guaranteed to fail before. `NoOverlaps` held at 100% even with 5 explicit layout stress cases, which means the bigger sizing defaults are doing real work, not just clearing easy cases.

This is the lesson reinforcing itself: **your scorer can only catch what your dataset stresses.** Iteration 1 was about the eval simulator lying. This iteration is about the dataset lying. Same shape of bug, different layer.

## Iteration 5: smoke test the live app and find another lie

`NoOverlaps` is at 100%. The eval thinks layout is solved.

Open the live app. Ask the agent to "make a diagram to show me how jwts work". Look at it.

`API / Resource Server` overflows its box. Arrow labels collide near the central node. There is a free floating annotation block at the bottom. Multiple shapes are visually overlapping if you look closely.

The eval said 100%. Your eyes say no.

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

A label whose parent is a `rectangle` / `ellipse` / `diamond` is exempt. A label whose parent is an `arrow` / `line` is checked. While you are at it, also tighten the system prompt:

- Add a sizing heuristic: `width = max(240, 14 * label_text_length)`. The default of 240 fits about two short words; longer labels need more room and the model has to size up.
- Add an arrow label spacing rule: when arrow labels are present, stride at least 400px and prefer SHORT labels ("login") over long ones ("1. send login request to auth server").

Run the eval.

```
NoOverlaps    100.00% → 99.34%  (-0.66, FIVE regressions)
```

The score went DOWN. **This is the right direction.** Five test cases now show small overlap penalties that the broken carve out was hiding. The product did not get worse — the measurement got more honest.

Re run the live app smoke test. The diagram is dramatically better: every label fits inside its box, no annotation block at the bottom, layout is clean enough that the residual issues only show up on the most complex diagrams. Check the chat panel: you should see `addElements` followed by `updateElements` cycles, which means the agent received the overlap feedback signal and used it to reposition shapes.

There is one bug class left where three arrows fan into the same central node and their midpoint labels cluster on top of each other. Resolving that would need either more agent steps or a smarter feedback signal that suggests specific moves rather than just listing colliding pairs. Both are out of scope here.

## What you actually learned

Eight iterations. Five real code changes. Three of those iterations were about the eval lying in different ways (the simulator, the dataset, the scorer carve outs). You have now made every layer of the eval honest at least once. You have also seen one negative result revert and one improvement that did not show up as a number but did show up in the live product.

The pattern that holds across every iteration:

1. Run the eval.
2. Compare the numbers to the live product.
3. When they disagree, the eval is wrong first. Almost always. Your scorer, your simulator, your dataset, your assumption about what the model actually does — one of those is the lie. Find the lie and fix it BEFORE you change the agent.
4. Once the eval and the product agree, propose a change to the agent (schema, prompt, tool result, dataset).
5. Make ONE change. Re run.
6. If the number moved in the direction you expected, commit and write down what you learned.
7. If the number moved the wrong way or didn't move at all, the lie was somewhere else. Go back to step 3.

This is the loop. Every lesson after this one is just another turn of it. RAG is "the agent doesn't know enough domain facts, plan a retrieval system, measure whether retrieval moved the score." Human in the loop is "the agent is making destructive choices unsupervised, plan an approval flow, measure whether trust scores moved." Agent architectures is "the agent gets stuck in single step thinking, plan a planning step, measure whether complex diagram scores moved." Same loop, different lever.

## Two helpers we shipped pre built

We did not live code two pieces of plumbing that would have wasted workshop time. They are in the lesson 8 branch already and you import them:

- **`src/context/applySkeleton.ts`** is the node safe simulator we wrote in iteration 1. The interesting part is the shape and arrow transform; the boilerplate around it (null stripping, type narrowing) is in the file but you can read it later.
- **`src/context/cross-call-bindings.ts`** patches arrow bindings after `convertToExcalidrawElements` runs. The Excalidraw helper only resolves arrow start/end ids against elements in its own input batch, so when the agent splits a diagram across multiple `addElements` calls the second call's arrows lose their bindings. The util walks the new skeleton input and restores the bindings against `api.getSceneElements()`. Plumbing around an Excalidraw limitation, not interesting for the lesson.

Both files are short, well commented, and read top to bottom in a few minutes if you want to understand what they do.

## Known issues you may notice

`@cloudflare/ai-chat` 0.3.2 has three React errors that fire in the dev console: a `Maximum update depth exceeded` from the WebSocket message handler, a `duplicate key` warning from messages with the same id, and a `TypeError: Cannot read 'state' of undefined` at `Chat.makeRequest`. They reproduce on every commit on this branch and on the previous lesson 7 commits. They do not break the chat UI but they make the dev console noisy. See `KNOWN_ISSUES.md` at the repo root for details and possible workarounds.

`convertToExcalidrawElements` also logs `No element for start binding with id rect_X found` warnings when arrows are added in a separate call from their endpoints. The cross call binding helper above patches the runtime arrows so the visual result is correct, but the helper logs the warning during processing before the patch runs. Functionally harmless, just dev console noise.
