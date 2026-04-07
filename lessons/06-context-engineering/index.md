# Context Engineering

This is the first real "improvement" lesson. The theme is **context engineering**: deciding what goes into the model's context window, in what shape, on every turn. Two pieces:

1. **Rewrite the system prompt** to be more thorough and add few shot examples (zero shot to multi shot).
2. **Serialize the canvas state** into the system prompt at request time, so the agent finally knows what exists.

Context engineering is "put the right information in front of the model in the right shape at the right time." It is the lowest hanging fruit in any agentic system, and most teams skip straight to fine tuning when they should just be putting better context in their prompts.

## Set a baseline first

Before changing anything, run the eval to capture a baseline so we have something to compare against at the end.

```bash
npm run eval
```

A new experiment shows up in Braintrust, tagged with the current branch and commit. Note the four scores. If you've already captured a baseline for this branch and want a fresh one, delete the old experiment from the Braintrust dashboard first.

## Rewriting `SYSTEM_PROMPT`

The current prompt is a short bullet list with no examples, no rules about how Excalidraw actually works, and no layout guidance. The model is left to invent everything. The result is the diagrams you saw in lesson 5: floating arrows, unlabeled boxes, overlapping elements, the model setting `text` on a rectangle and expecting it to render as a label inside the box (it doesn't). All of these failures trace back to the prompt not telling the model what's true about the medium it's working in.

We rewrite the prompt to do six things, in this order:

1. **Pick a niche.** "Diagram design assistant" is too broad. We narrow to **technical diagrams**: architecture, sequence, flowchart, state machine, ER. A narrow niche lets us be opinionated about layout and structure.
2. **Move from zero shot to few shot.** Zero shot prompts ask the model to figure out the right behavior from a description alone. They're fine for trivial tasks and brittle for anything that requires a judgment call. Few shot examples teach a decision boundary by example. We add a worked example showing the exact element list for a real diagram.
3. **Add hard rules.** Numbered, non negotiable. These describe the *medium*: how Excalidraw labels work (separate text elements, not a `text` field on a rectangle), how arrows connect to shapes (`startBinding` and `endBinding`, not raw points), what counts as a degenerate element. The model can't infer these from the schema alone.
4. **Add a layout grid.** Models are bad at coordinates. Give them an explicit grid: standard sizes, standard strides, fixed origin. Layout becomes "follow the rule" instead of "guess the number."
5. **Add a pattern library.** Since the niche is technical diagrams, name the patterns. "Architecture" looks like X. "Sequence" looks like Y. When the user asks for "the OAuth2 flow," the model recognizes it as a sequence diagram and reaches for that template.
6. **Add negative prompts.** Explicit "do NOT do X" lines targeting the specific failure modes we've seen. Counter intuitively, these work very well on language models, especially for failures the model is statistically prone to (like setting `text` on a rectangle because every other diagramming tool works that way).

### The new prompt structure

**`src/agent-core.ts`**:

```ts
export const SYSTEM_PROMPT = `# Role

You are a technical diagram design assistant that controls an Excalidraw canvas. Your niche is technical diagrams: architecture, sequence, flowchart, state machine, ER. You translate the user's request into precise tool calls that produce a working diagram. You are not a chat bot. You are a tool using agent.

# Tools

- **generateDiagram(elements)** produce a list of Excalidraw elements. Use when the canvas is empty or the diagram needs to be replaced from scratch.
- **modifyDiagram(elementId, updates)** change a single existing element by id. Element ids come from the canvas state in this prompt.

# Hard rules

These are not suggestions. Violating any of them produces a broken diagram.

1. **Labels are SEPARATE text elements.** Setting \`text\` on a rectangle, ellipse, or diamond does NOT render anything inside the box. To label a shape, create the shape AND a separate text element positioned over the shape's center.
2. **Every connecting arrow must bind both ends.** An arrow that connects two shapes MUST set \`startBinding.elementId\` and \`endBinding.elementId\` to ids that exist in the same call or already on the canvas. Arrows without both bindings float free in space.
3. **No degenerate elements.** Width and height at least 20. No empty text.
4. **No overlapping elements.** Use the layout grid.
5. **Pick concise meaningful ids.** \`rect_user\`, never \`element_42\`.

# Layout grid

- Standard rectangle: 200x80. Standard ellipse / diamond: 120x120.
- Horizontal stride: 280px. Vertical stride: 160px. Origin: (100, 100).
- Row of N nodes: x = 100, 380, 660, 940, 1220.
- Column of N nodes: y = 100, 260, 420, 580.
- Text labels go at the same x, y, w, h as the shape they label.

# Diagram patterns

- **Architecture**: rectangles for services, arrows for calls. Left to right.
- **Sequence**: actors as labeled rectangles across the top. Vertical lifelines drop straight down. Numbered arrows between adjacent lifelines.
- **Flowchart**: rectangles for steps, diamonds for decisions, arrows top to bottom. Decisions branch with "yes"/"no" arrows.
- **State machine**: ellipses for states, arrows labeled with transitions.
- **ER**: rectangles for entities, lines labeled with cardinality.

# Negative prompts

- Do NOT put \`text\` on a rectangle and expect it to render as a label inside the box. It will not.
- Do NOT create arrows with raw \`points\` arrays for shape to shape connections.
- Do NOT create arrows where bindings reference an id that doesn't exist.
- Do NOT place two elements at the same coordinates.

# Worked example: a labeled flow

User: "draw a flow from User to API to Database"

1. \`rect_user\` rectangle at (100, 100) 200x80
2. \`text_user\` text at (100, 100) 200x80, text="User"
3. \`rect_api\` rectangle at (380, 100) 200x80
4. \`text_api\` text at (380, 100) 200x80, text="API"
5. \`rect_db\` rectangle at (660, 100) 200x80
6. \`text_db\` text at (660, 100) 200x80, text="Database"
7. \`arrow_user_api\` arrow with startBinding="rect_user", endBinding="rect_api"
8. \`arrow_api_db\` arrow with startBinding="rect_api", endBinding="rect_db"

Three boxes, three labels (one per box, same coords, same size), two bound arrows. That is a working diagram.`;
```

(Full version is in `src/agent-core.ts`, including modify examples and behavioral guidelines. The block above is the new content; everything else carried over.)

### Why negative prompts work

Negative prompts feel wrong to people who learned that "telling the model what to do is more effective than telling it what not to do." That advice exists because vague positive instructions ("be concise") tend to land better than vague negative ones ("don't be verbose"). But for **specific, recurring failure modes**, negative prompts are a sharper tool. The model has a strong prior that pulls it toward the failure (every other diagramming tool puts text inside the rectangle, so the model assumes Excalidraw does too). A positive instruction like "use a separate text element with the same coordinates" doesn't fight that prior. A negative instruction like "do NOT put text on a rectangle and expect it to render" names the prior and overrides it.

Use negative prompts for:
- A failure mode you observed in evals or in production
- A behavior the model has a strong prior for that you specifically want to suppress
- API quirks that contradict a sensible default (like `text` on a rectangle in Excalidraw)

Don't use negative prompts for:
- General style guidance (positive framing wins)
- Long lists of "don't do X, don't do Y, don't do Z" — over a handful, the model starts ignoring them. Be selective.

## Canvas state in context

We're going to let the model "see" the canvas by sending it along with every user message and dropping a serialized version into the system prompt.

### Serializing the canvas

Raw Excalidraw JSON is huge. Every element has dozens of fields and the model doesn't need most of them. We have to pick a serialization format and what to include.

#### Why not JSON

The obvious move is "just send the JSON." Don't. A few reasons:

1. **Token cost.** JSON's structural characters (quotes, braces, brackets, commas, repeated keys on every object) are pure overhead. For tabular data this can be **40 to 60 percent** of the tokens before you've encoded a single value. Multiply that by every turn and the canvas alone eats your context budget.
2. **Model preference.** JSON inside a prompt reads to the model as "data I might need to echo back," which is the opposite of what we want when the data is context, not output.
3. **There are better formats.** People measured their JSON token bills and built alternatives. **TOON** (Token Oriented Object Notation), YAML, and various shorthand notations consistently come in 30 to 50 percent cheaper than JSON for the same payload, with equal or better task accuracy.

The principle: **JSON is a wire format for machines, not a context format for language models.** Use it at API boundaries, transform it to something denser before it hits the prompt.

For our canvas we go with [TOON](https://toonformat.dev). Our elements are an array of objects with the same shape, which is the exact case TOON is built for.

#### The serializer

```bash
npm install @toon-format/toon
```

**`src/context/canvas-state.ts`**:

```ts
import { encode } from "@toon-format/toon";
import type { ExcalidrawElement } from "../schemas";

export function serializeCanvasState(elements: ExcalidrawElement[]): string {
  if (!elements.length) return "canvas: empty";

  const rows = elements.map((el) => ({
    id: el.id,
    type: el.type,
    x: Math.round(el.x),
    y: Math.round(el.y),
    w: Math.round(el.width),
    h: Math.round(el.height),
    label: el.type === "text" ? el.text : "",
    from: el.type === "arrow" ? el.startBinding?.elementId ?? "" : "",
    to: el.type === "arrow" ? el.endBinding?.elementId ?? "" : "",
  }));

  return encode(
    { elements: rows },
    { indent: 2, delimiter: ",", keyFolding: "off", flattenDepth: Infinity }
  );
}
```

### Wiring it through `agent-core`

Both the worker (live chat) and the eval (batch generateText) need canvas state. Instead of duplicating the assembly logic, we add a `canvasState` parameter to `streamAgent` / `runAgent` in `src/agent-core.ts` and they handle the system prompt assembly internally.

**`src/agent-core.ts`**:

```ts
interface AgentArgs {
  model: LanguageModel;
  messages: ModelMessage[];
  canvasState?: unknown[];
  system?: string;
  maxSteps?: number;
}

function buildSystem(base: string, canvasState: unknown[] | undefined): string {
  return `${base}\n\n# Current canvas state\n\n${serializeCanvasState(canvasState ?? [])}`;
}

export function streamAgent({ model, messages, canvasState, system = SYSTEM_PROMPT, maxSteps = 5 }: AgentArgs) {
  return streamText({
    model,
    system: buildSystem(system, canvasState),
    messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
  });
}
```

Now any caller that has elements just passes them in. `runAgent` does the same thing.

### Browser side: data part on the user message

The Cloudflare AI Chat protocol only sends `UIMessage` objects over the WebSocket. There's no sidecar channel. The way to attach extra payload to a turn is to ride along on the user's message itself, via a **custom data part**. The AI SDK reserves part types prefixed with `data-` for this. They're arbitrary JSON the SDK passes through untouched, and they're dropped before the model ever sees them.

Wrap `sendMessage` so every outgoing user message gets a `data-canvas-state` part appended:

**`src/App.tsx`**:

```ts
const sendWithCanvas = useMemo(
  () => (msg: { role: "user"; parts: { type: "text"; text: string }[] }) => {
    const elements = excalidrawAPI?.getSceneElements() ?? [];
    sendMessage({
      ...msg,
      parts: [
        ...msg.parts,
        { type: "data-canvas-state", data: { elements } } as never,
      ],
    });
  },
  [sendMessage, excalidrawAPI]
);
```

Then pass `sendWithCanvas` to `<ChatPanel>` instead of the raw `sendMessage`. `ChatPanel` doesn't know about canvas state, it just calls the function it's given.

### Worker side: read it back

`onChatMessage` runs because the user just sent a message, so the last entry in `this.messages` is always that user turn. Read its `data-canvas-state` part, hand it to `streamAgent`, done.

**`src/agent.ts`**:

```ts
import type { UIMessage } from "ai";
import type { ExcalidrawElement } from "./schemas";

type CanvasStatePart = { type: "data-canvas-state"; data: { elements: ExcalidrawElement[] } };

function extractCanvasState(messages: UIMessage[]): ExcalidrawElement[] {
  const last = messages.at(-1);
  const part = last?.parts.find((p): p is CanvasStatePart => p.type === "data-canvas-state");
  return part?.data.elements ?? [];
}

export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai("gpt-5.4-mini");

    const canvasState = extractCanvasState(this.messages);
    const messages = await convertToModelMessages(this.messages);

    const result = streamAgent({ model, messages, canvasState });
    return result.toUIMessageStreamResponse();
  }
}
```

Each turn rebuilds the system prompt fresh from the canvas data part on that turn's user message. Old canvas state never accumulates.
## Re-run the eval

```bash
npm run eval
```

Compare against the baseline. Things to watch for:

- **Preservation** is the headline metric for this lesson. It should jump because canvas state in the prompt lets the model find existing ids before modifying.
- **Schema, Structure, LabelKeywords** should hold steady or improve slightly. The new prompt is stricter and the worked example shows clean output, but they aren't the core point of this lesson.

The current scorers can't see whether the diagram is *visually* working. Schema passes when every element has the required fields. Structure passes when the count is right. LabelKeywords passes when the words appear anywhere. None of them notice when arrows float free of the boxes they're supposed to connect, or when shapes have no labels because the model put `text` on a rectangle. Lesson 7 adds three new scorers (BoundArrows, Connectivity, BoundLabels) that catch exactly those failures, after we've finished the tool and schema work that lets the model fix them.

LLMs are non deterministic at temperature > 0 and there's run to run noise even on the same code. Direction and which scorers move matters more than specific digits.

## A note on scorers and what they're really measuring

Improving the agent isn't the only thing we do in this loop. We also improve the evals. Scorers fall into two buckets and the distinction matters more as the agent evolves.

**Output based scorers** look at the final canvas (or final answer, or some end state) and don't care how the agent got there. For us that's Schema, LabelKeywords, and Structure. These tend to survive architecture changes. A regression here means something actually got worse, regardless of which lesson you're on. Invest real care in these.

**Tool coupled scorers** are shaped by the specific tools that exist right now. Their meaning is tied to a particular tool surface, so when the tools change they have to be rewritten or retired.

Preservation is in the second bucket, and honestly it's fundamentally broken in its current form. The two questions we wanted it to answer are "did the agent leave the elements it shouldn't have touched alone?" and "did the agent actually apply the requested change?" It doesn't really answer either of them well. Once `extractElements` simulates the canvas headlessly, any run that doesn't call `generateDiagram` passes Preservation, even one that called `modifyDiagram` with the wrong id or no useful update at all. The scorer became "did the agent avoid regenerating from scratch," which is a useful signal but not what the name promises.

We're leaving it as is. Lesson 7 replaces these tools entirely, which means a new tool surface and a chance to redesign the modify side scoring against the real surface. Fixing a scorer that's about to die one lesson from now is sunk cost.

This brings up the subtlety worth naming. Even when a scorer is imperfect, as long as the **before** and **after** numbers come from the **same** scorer, the **trend is still honest** even if the absolute number is questionable. That's enough to validate the change you made in this lesson. The Preservation jump tells us "putting canvas state in the prompt moved the metric in the right direction." It does not tell us "the agent now preserves canvases X percent of the time" in some absolute sense. Trust the direction, hold the absolute number loosely, and be ready to retire the scorer when the world it was measuring goes away.

## What is next

Lesson 7: **advanced tool use**. The single giant `generateDiagram` tool is too coarse. We'll break it into smaller, focused tools (`addElement`, `updateElement`, `removeElement`, `alignElements`, `queryCanvas`). Each tool does one thing well, the agent makes more, smaller calls, and Structure scores climb because the model isn't doing all its layout math in a single JSON blob anymore.

We'll also introduce a real **client side tool**, `queryCanvas`, that doesn't pay the token cost of serializing the whole canvas every turn. The agent calls it when it actually needs to know about the canvas, and the browser executes the query against the live Excalidraw state.
