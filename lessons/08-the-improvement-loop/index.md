# The Improvement Loop

Lesson 7 finished the agent's tools. This lesson is not about a new technique. It is about *the loop you run when something is wrong*. Every lesson after this one is just another turn of the same wheel.

A note before we start: the eval numbers in this lesson will not match yours exactly. Models drift, sampling is non deterministic, and the dataset is small enough that one flaky case moves a percentage point. This is also more art than science. What matters is the *direction* a number moves after a change, and whether it agrees with what your eyes see in the live app. Treat any specific score I mention as illustrative, not a target.

## What the loop is

```
run the eval
  → look at the numbers
  → look at the live product
  → form a theory about why they disagree
  → make ONE focused change
  → run the eval again
  → did the number move? did the product look better?
  → repeat
```

The whole job is staying honest about what each iteration actually changed. The first theory is wrong more than half the time. The trap is making three changes at once and then having no idea which one moved the score.

## Where we start

Three scorer files have been sitting in `evals/scorers/` since lesson 7, written but never registered. Wire them into `evals/diagram.eval.ts`:

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

```bash
npm run eval
```

Most numbers look fine. The lesson is going to show that two of them are lying.

## Iteration 1: the simulator is lying

**Hypothesis:** the live canvas is broken and the eval thinks it isn't.

Open the live app, ask for "a diagram showing how jwts work", and look at the canvas. Boxes are empty. Arrows have no labels. Now look at `BoundLabels` in the Braintrust summary. It says the agent labels its boxes most of the time. Your eyes say none of the time. Both cannot be true.

The eval is wrong before the agent is wrong. Two layers of lie:

1. The schema in `src/tools/element-schema.ts` teaches the model `containerId` / `startBinding` / `endBinding`. Those are the *runtime* field names that exist after Excalidraw renders. The `convertToExcalidrawElements` helper actually wants `label: { text }` and `start: { id }` / `end: { id }` as *input*. The helper silently drops the runtime field names. The canvas renders unbound, unlabeled shapes.
2. The eval simulator skips the helper entirely. `runAgent`'s `addElements` execute spreads the model's raw input straight into `sim`, so the scorer reads model claims and credits them as rendered output.

**An eval simulator must produce the same data the live renderer produces, or the scorer is measuring a fiction.**

### Fix the schema first

Rewrite `src/tools/element-schema.ts` as a `z.union` of per type variants so the model literally cannot put a label on an arrow or a binding on a rectangle. Use `z.union`, not `z.discriminatedUnion`: the discriminated form compiles to JSON Schema `oneOf`, which OpenAI strict mode rejects. `z.union` compiles to `anyOf`.

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

Update the `addElements` description so the example matches the new vocabulary:

```ts
export const addElements = tool({
  description: `Add new elements to the canvas. Use this for creating diagrams or adding to an existing one. Each element needs an id, type, position, and size.

To label a shape, set the shape's \`label\` field. Excalidraw centers the text inside the box automatically. Do NOT create a separate text element to label a shape. Standalone text elements are for floating annotations only.

To connect two shapes with an arrow, set \`start: { id: ... }\` and \`end: { id: ... }\` on the arrow. The shapes must exist in the same call or already be on the canvas.

Example: addElements({ elements: [
  { type: "rectangle", id: "rect_start", x: 100, y: 100, width: 200, height: 80, label: { text: "Start" } },
  { type: "rectangle", id: "rect_end",   x: 380, y: 100, width: 200, height: 80, label: { text: "End" } },
  { type: "arrow",     id: "arrow_start_end", x: 300, y: 140, width: 80, height: 0, start: { id: "rect_start" }, end: { id: "rect_end" } }
]})`,
  inputSchema: z.object({
    elements: z.array(elementSchema).describe("Array of new elements to add to the canvas"),
  }),
  strict: true,
});
```

Update the two vocabulary rules in the `agent-core.ts` system prompt:

```
1. **Label shapes via the `label` field on the shape itself.** To put text inside a rectangle, ellipse, or diamond, set the shape's `label: { text: "..." }` field. Do NOT create a separate text element for shape labels. Standalone text elements are for floating annotations only.
2. **Every connecting arrow must bind both ends.** An arrow that connects two shapes MUST set `start: { id: "..." }` to one shape's id and `end: { id: "..." }` to the other shape's id. The shapes must exist in the same call or already be on the canvas. Arrows without both bindings float free in space and are a bug.
```

And the matching DON'Ts and the worked example in the same prompt:

```
- Do NOT create a separate text element to label a shape. Use the shape's `label` field. A free floating text element placed visually on top of a box is NOT a label and will not move with the box.
- Do NOT create arrows for shape to shape connections without setting `start` and `end`.
- Do NOT create arrows where one or both endpoints reference an id that doesn't exist in this call or on the canvas. The arrow will float.

Worked example. User: "draw a User -> API -> Database flow." Five elements:
1. rect_user rectangle at (100, 100) 200x80, label.text="User"
2. rect_api  rectangle at (380, 100) 200x80, label.text="API"
3. rect_db   rectangle at (660, 100) 200x80, label.text="Database"
4. arrow_user_api arrow with start.id="rect_user", end.id="rect_api"
5. arrow_api_db   arrow with start.id="rect_api",  end.id="rect_db"
```

Make `App.tsx`'s `stripNulls` recursive so nested null fields like `label: { fontSize: null }` don't choke the helper:

```ts
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
```

Run the eval. The visual scorers should drop hard, possibly to near zero, possibly just a sharp dip. Whatever the magnitude, **the direction is the proof.** The live canvas just got better and the eval just got worse. The eval was lying high before. Now it might be lying low. Switch to the live app and confirm the boxes are labeled and the arrows are bound. The product is healthier than it has ever been. The number is wrong.

### Then fix the simulator

Hand write a node safe helper that mimics what `convertToExcalidrawElements` does for the fields the scorers care about. We can't import `@excalidraw/excalidraw` in node directly (transitive `roughjs` ESM resolution breaks).

`src/context/applySkeleton.ts`:

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

Run the eval. The visual scorers should recover. `BoundArrows` will likely land at or above its old baseline because the new schema structurally enforces `start` / `end`. `BoundLabels` should land somewhere close to where it started, but the meaning is now completely different. Possibly the same digits, totally different ground truth. **A scorer's value is only as trustworthy as the parity between the eval simulator and the live renderer.**

## Iteration 2: the obvious fix isn't always the right fix

**Hypothesis:** the model still ships unlabeled shapes because the schema lets it. Drop `.nullable()` on `label` and add a system prompt rule: every container MUST have a non empty `label.text`.

Apply the change. Run the eval. The score does not move.

Add a temporary `console.log` in `boundLabels.ts` to dump the unlabeled shapes per case. Run again. Two patterns surface:

1. **Modify cases hallucinate scaffolding.** `modify-01` ("make the login box red") has `seed.elements: []`. The model has no canvas to read from, so it conjures `rect_login` and `rect_db` with `label: { text: "" }` to set up the scene before "modifying" them. Empty string passes the schema. `applySkeleton` drops empty labels. The shape lands in `sim` with no child text. The schema enforcement worked. The scorer reads correctly. The failure is in the dataset.
2. **Sequence diagram lifelines are intentionally unlabeled rectangles.** The system prompt teaches lifelines as 4px wide tall rectangles WITHOUT labels (the actor box above carries the label). The rule "every container must have a label" has a legitimate exception. The schema cannot encode "rectangles labeled as lifelines are exempt."

Revert the schema and prompt change. **A negative result that explains itself is more valuable than a forced positive one.** The fix for the dataset bug lives in iteration 4. The lifeline exception stays unsolved here because the schema is the wrong place to encode it.

## Iteration 3: a layout scorer and an in loop feedback signal

**Hypothesis:** the eval doesn't measure layout, so the model has no pressure to avoid overlapping shapes. Add a `noOverlaps` scorer AND return the same overlap pairs from `addElements` so the agent can self correct without another `queryCanvas` round trip.

Single shared implementation in `src/context/overlaps.ts` so the agent and the eval measure the same thing. If they drifted there would be the worst of both worlds: an agent that addressed one signal but the eval still flagged it.

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

Three eligibility rules to think about up front, deciding which elements can collide and which can't:

1. Arrows and lines: their paths legitimately cross shapes when routing. Skip them.
2. Container labels (text bound to a rectangle/ellipse/diamond): supposed to sit inside the parent. Skip them.
3. **Arrow labels** (text bound to an arrow or line): sit ALONG the path, NOT inside anything, and routinely collide. *Do not skip them.* Iteration 5 catches this when the first version of the rule gets it wrong.

`evals/scorers/noOverlaps.ts`:

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

Wire `findOverlaps` into `runAgent`'s `addElements` execute (return `{ added, overlaps }`), `App.tsx`'s `addElements` client handler, and `serializeCanvasState` so `queryCanvas` reports overlaps. Add a behavioral rule to the system prompt:

> **Act on overlap feedback.** Every `addElements` result includes an `overlaps` array listing pairs of element ids whose bounding boxes collide. If `overlaps` is non empty after a call, the next action MUST be one or more `updateElements` calls that move the offending elements apart.

Run the eval. `NoOverlaps` should land high, possibly very high. The existing dataset cases are mostly small and clean, so there is not much layout pressure. Iteration 4 changes that.

Open the live app and ask for several connected boxes. The chat panel should show `addElements` followed by `updateElements` cycles. The agent is reading the overlap pairs and acting on them.

## Iteration 4: bigger defaults, honest dataset

**Hypothesis A:** the default rectangle in the system prompt is 200x80, too narrow for two word labels like "Auth Server." Bump the defaults in `agent-core.ts`:

```
- Standard rectangle: 240x100 (wide enough for two word labels like "Auth Server")
- Standard ellipse / diamond: 140x140
- Horizontal stride between adjacent nodes: 320px
- Vertical stride between adjacent rows: 180px

For a row of N nodes left to right: x = 100, 420, 740, 1060, 1380.
For a column of N nodes top to bottom: y = 100, 280, 460, 640.
```

**Hypothesis B:** the dataset is the lie this time. Two specific problems with `evals/datasets/golden.json`:

- The four `modify-*` cases ship seeds in the OLD vocabulary (`text: "Login"` directly on a rectangle). The simulator pushes seed shapes straight into `sim` unchanged, so those seed shapes count against `BoundLabels` forever. This is what iteration 2 found and deferred.
- 23 cases, mostly small. `NoOverlaps` is high partly because nothing stresses layout.

Don't edit the original dataset. Make a new one. `golden.json` is the baseline we've been comparing against since lesson 4 and we want it to stay frozen. Copy it to `evals/datasets/golden_2.json`, then make two kinds of edits to the copy.

First, rewrite each `modify-*` seed in runtime form: every labeled rect becomes a rect with `boundElements` plus a child text element with `containerId`, and every connecting arrow gets explicit `startBinding` / `endBinding`. Sample shape:

```json
{
  "id": "rect_login",
  "type": "rectangle",
  "x": 100, "y": 100, "width": 200, "height": 80,
  "boundElements": [{ "id": "rect_login_label", "type": "text" }]
},
{
  "id": "rect_login_label",
  "type": "text",
  "x": 100, "y": 100, "width": 200, "height": 80,
  "text": "login",
  "containerId": "rect_login"
}
```

Sample arrow:

```json
{
  "id": "arrow_1",
  "type": "arrow",
  "x": 300, "y": 140, "width": 200, "height": 0,
  "startBinding": { "elementId": "rect_login", "focus": 0, "gap": 8 },
  "endBinding":   { "elementId": "rect_db",    "focus": 0, "gap": 8 }
}
```

Second, append eight new layout stress cases: `create-architecture-jwt`, `create-sequence-oauth`, `create-flowchart-deploy`, `create-erd-blog`, `create-state-machine-order`, `create-long-labels`, `create-three-word-labels`, `create-tight-grid`. The tight grid case is deliberately packed and should NOT trip `NoOverlaps`, which validates that the 4px epsilon in `overlaps.ts` is doing what we want.

Point the eval at the new dataset:

```ts
const testCases: GoldenTestCase[] = JSON.parse(
  readFileSync(join("evals", "datasets", "golden_2.json"), "utf-8")
);
```

The full `golden_2.json` already lives in the repo so you don't have to type 800 lines of JSON in the workshop. Open it alongside `golden.json` and skim the differences.

Run the eval. `BoundLabels` should move up because four cases that were structurally guaranteed to fail are now passing. `NoOverlaps` should ideally hold close to where it was, even though the dataset is substantially larger and explicitly stresses layout. If it does, the bigger sizing defaults are doing real work and not just clearing easy cases. If it dips, that is also useful information: the new stress cases found pressure the old dataset never had. Your numbers will not match mine. Direction is what matters.

**A scorer can only catch what the dataset stresses.** Iteration 1 was the simulator lying. This iteration is the dataset lying. Same shape of bug, different layer.

## Iteration 5: smoke test the live app, find another lie

`NoOverlaps` is at or near 100%. The eval thinks layout is solved.

Open the live app. Ask for "a diagram showing how jwts work". `API / Resource Server` overflows its box. Arrow labels collide near the central node. Free floating annotation block at the bottom. The eval said 100%. Your eyes say no.

**Hypothesis:** the rule that skips bound text labels is too broad. The scorer skips any text element with `containerId` set, regardless of what KIND of element the parent is. Container labels (text inside a rectangle) are supposed to sit inside their parent. Arrow labels (text along an arrow path) are NOT inside anything and routinely collide.

```ts
function isContainerLabel(el, typeById) {
  if (el.type !== "text") return false;
  if (typeof el.containerId !== "string") return false;
  const parentType = typeById.get(el.containerId);
  return parentType === "rectangle" || parentType === "ellipse" || parentType === "diamond";
}
```

While editing, tighten the system prompt with two new rules:

```
**Sizing for long labels.** The default 240px width fits about two short words. For longer labels you MUST widen the shape and stretch the stride to match. Heuristic: `width = max(240, 14 * label_text_length)`. A label like "API / Resource Server" is 21 characters, so width = max(240, 294) = 294. When you widen a shape, also push every shape to its right by the same amount so the layout stays clean.

**Spacing for arrow labels.** Numbered messages like "1. Login request" sit on the arrow midpoint and extend in both directions. If you have arrow labels and your nodes are only 320px apart, the labels will collide with each other and with the boxes. For diagrams with arrow labels, increase the horizontal stride to at least 400px and prefer SHORT arrow labels ("login", "verify") over long ones ("1. send login request to auth server").
```

Run the eval. `NoOverlaps` may drop slightly because cases that the broken rule was hiding are now visible. **If the score goes down, that is the right direction.** The product did not get worse. The measurement got more honest.

Re run the live smoke test. Every label fits inside its box. Chat shows `addElements` followed by `updateElements` cycles, which confirms the agent is consuming the overlap signal. One bug class left: three arrows fanning into the same node still cluster their labels. That needs more agent steps or a smarter feedback signal. Out of scope for this lesson.

## What this lesson actually taught

Five iterations. Three of them were about the eval lying in different ways: the simulator (iteration 1), the dataset (iterations 2 and 4), and the scorer's eligibility rules (iteration 5). Every layer of the eval got made honest at least once.

The pattern that holds across every iteration:

1. Run the eval.
2. Compare numbers to the live product.
3. When they disagree, the eval is wrong first. Almost always. Find the lie BEFORE changing the agent.
4. Once eval and product agree, propose a change to the agent.
5. Make ONE change. Re run.
6. If the number moved in the direction expected, commit and write down what was learned.
7. If it moved the wrong way or did not move at all, the lie was somewhere else. Go back to step 3.

This is the loop. Every lesson after this one is just another turn of it. RAG is "the agent does not know enough domain facts, plan a retrieval system, measure whether retrieval moved the score." Human in the loop is "the agent is making destructive choices unsupervised, plan an approval flow, measure whether trust scores moved." Agent architectures is "the agent gets stuck in single step thinking, plan a planning step, measure whether complex diagram scores moved." Same loop, different lever.

## One helper that ships pre built

`src/context/cross-call-bindings.ts` already exists in the repo and is not part of the lesson. It patches arrow bindings after `convertToExcalidrawElements` runs, because the helper only resolves arrow start/end ids against elements in its own input batch. When the agent splits a diagram across multiple `addElements` calls, the second call's arrows lose bindings to shapes from the first call. The util walks the new skeleton input and restores those bindings against `api.getSceneElements()`.

## Known issues to expect

`@cloudflare/ai-chat` 0.3.2 has three React errors that fire in the dev console: a `Maximum update depth exceeded` from the WebSocket message handler, a `duplicate key` warning, and a `TypeError: Cannot read 'state' of undefined` at `Chat.makeRequest`. They reproduce on this branch and on lesson 7. They do not break the chat UI. See `KNOWN_ISSUES.md` at the repo root.

`convertToExcalidrawElements` also logs `No element for start binding with id rect_X found` warnings when arrows are added in a separate call from their endpoints. The cross call binding helper above patches the runtime arrows so the visual result is correct. Functionally harmless.
