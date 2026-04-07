# Advanced Tool Use

Lesson 6 fixed the agent's context. This lesson fixes its tools. We replace the two coarse tools from lesson 2 (`generateDiagram`, `modifyDiagram`) with a small set of focused CRUD tools, all running client side, plus a server side `searchWeb` tool that hits a real external API. The tool surface is part of the prompt: the model can only do what its tools let it do.

## Three changes

1. **Split into focused tools**: `addElements`, `updateElements`, `removeElements`. CRUD on the canvas.
2. **All canvas tools are client side**: no `execute` on the worker. The browser fulfills them via `useAgentChat`'s `onToolCall`. That includes `queryCanvas`, the read tool the agent calls on demand instead of paying the canvas serialization tax in the system prompt every turn.
3. **Add `searchWeb` via Tavily**: a real external API call from a server side tool.

## 1. The element schema

Both `addElements` and (a nullable variant of) `updateElements` use the same shape. The schema is more than validation: **field descriptions are part of the prompt the model reads**. Use them to teach the model how Excalidraw actually works, especially the gotchas it would otherwise get wrong.

The two big gotchas this schema teaches:

- **Labels need `containerId`.** A text element with `containerId` set to a shape's id renders inside that shape and is automatically centered. Without `containerId`, the text floats free. The lesson 6 system prompt told the model this in prose; now we make the schema enforce it by adding the field and describing it explicitly.
- **Arrows need both bindings.** `startBinding.elementId` and `endBinding.elementId` reference shapes by id. The descriptions on these fields say "REQUIRED for arrows that connect two shapes" and "if the id is wrong or missing, the arrow floats free in space, which is always a bug." The model reads these descriptions when it loads the tool.

**`src/tools/element-schema.ts`**:

```ts
import { z } from "zod";

export const elementSchema = z.object({
  id: z.string().describe(
    "Unique identifier. Pick concise meaningful ids like 'rect_login' or 'arrow_login_db'. Other elements (text labels, arrow bindings) reference shapes by id, so the id must be unique within the canvas and stable across calls."
  ),
  type: z.enum(["rectangle", "ellipse", "diamond", "text", "arrow", "line"]).describe(
    "Element type. rectangle/ellipse/diamond are container shapes, text is a label, arrow is a directed connection, line is an undirected connection."
  ),
  x: z.number().describe("X position in pixels"),
  y: z.number().describe("Y position in pixels"),
  width: z.number().describe("Width in pixels. Must be at least 20."),
  height: z.number().describe("Height in pixels. Must be at least 20."),

  strokeColor: z.string().nullable().describe("Stroke color (hex). Null for default '#1e1e1e'."),
  backgroundColor: z.string().nullable().describe("Fill color. Null for default 'transparent'."),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).nullable(),
  strokeWidth: z.number().nullable(),
  roughness: z.number().nullable().describe("0 for clean, 1 for sketchy. Null for default."),
  opacity: z.number().nullable(),

  text: z.string().nullable().describe(
    "REQUIRED for text elements (the label content). FORBIDDEN on rectangle/ellipse/diamond: setting text on a shape does NOT render anything inside the box, you must create a separate text element with containerId pointing to the shape's id. Null for non text elements."
  ),
  fontSize: z.number().nullable(),
  fontFamily: z.number().nullable().describe("1=Virgil, 2=Helvetica, 3=Cascadia. Null for default."),
  textAlign: z.enum(["left", "center", "right"]).nullable(),
  containerId: z.string().nullable().describe(
    "TEXT elements only. Set this to the id of the rectangle, ellipse, or diamond this label belongs INSIDE. The shape must exist in the same addElements call or already on the canvas. When containerId is set, Excalidraw automatically centers the text inside the container. This is the ONLY way to label a shape. Null for shapes and standalone text."
  ),

  points: z.array(z.array(z.number())).nullable().describe(
    "Arrow/line shape only. Array of [x,y] points relative to the element's x,y. Usually you can leave this null and let the bindings determine the path. Null for non line shapes."
  ),
  startBinding: z.object({
    elementId: z.string().describe(
      "Id of the shape this arrow starts at. The shape must exist in the same call or already on the canvas. If the id is wrong or missing, the arrow floats free in space, which is always a bug."
    ),
    focus: z.number().describe("0 for center attach. Use 0 unless you have a reason."),
    gap: z.number().describe("Pixels of gap between the arrow and the shape edge. Use 8."),
  }).nullable().describe(
    "REQUIRED for arrows that connect two shapes. Set both startBinding AND endBinding for any connecting arrow. Null for lines and standalone arrows."
  ),
  endBinding: z.object({
    elementId: z.string().describe("Id of the shape this arrow ends at."),
    focus: z.number().describe("0 for center attach."),
    gap: z.number().describe("8 for normal spacing."),
  }).nullable().describe("REQUIRED for arrows that connect two shapes. Pair with startBinding."),
});
```

Two things this schema does that the previous one didn't:

1. **Adds `containerId`**, the field that makes text elements bind to shapes. Without it, the lesson 6 hard rule "labels are separate text elements" was theory; now it's enforceable.
2. **Writes descriptions that name the failure modes.** "REQUIRED for arrows that connect two shapes," "FORBIDDEN on rectangle/ellipse/diamond," "if the id is wrong or missing the arrow floats free in space, which is always a bug." The model reads these when it loads the tool. They're prompt content.

Note **nullable, not optional**. OpenAI's strict mode requires every field present in every call. Null means "not applicable for this element type." Optional fields fail strict mode.

Speaking of strict mode: the AI SDK exposes it as a per tool flag, [documented here](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling). We pass `strict: true` on every canvas tool. With strict mode plus a fully nullable schema, OpenAI's structured outputs are constrained to schemas that validate exactly, which means the model can never produce a malformed call.

### Schema descriptions are prompt content

This is the meta point of section 1, and it's worth saying out loud. When you call `tool({ description, inputSchema })`, the AI SDK serializes the inputSchema (including every `.describe()` you wrote) into the JSON Schema that gets sent to the model alongside the tool's top level description. Every word in those descriptions is paying for itself in tokens **and** is influencing the model's behavior. Treat them like the system prompt: precise, opinionated, and pointed at specific failure modes.

A couple of patterns worth noting:

- **Use REQUIRED / FORBIDDEN in caps** when a field is conditional on the element type. Models pay attention to caps in schema descriptions, and the contrast with the surrounding lowercase prose makes them stand out.
- **Name the bug.** "If the id is wrong or missing, the arrow floats free in space, which is always a bug" is a better description than "Id of the target shape" because it tells the model what the failure looks like, not just what the field is.
- **Reference other fields by name.** "Pair with startBinding" on `endBinding` reinforces that they go together. The model picks up these cross references.

These are small edits to a file that already existed. They cost nothing at runtime. They move the BoundLabels and BoundArrows scorers more than any system prompt change does, because the model loads tool schemas with high priority.

## 2. Client side CRUD tools

A client side tool is just a tool with **no `execute` function**. The AI SDK pauses the agent loop on the call, streams the call to the browser, the browser does whatever it wants, sends a result back, and the agent continues.

**`src/tools/add-elements.ts`**:

```ts
import { tool } from "ai";
import { z } from "zod";
import { elementSchema } from "./element-schema";

export const addElements = tool({
  description: `Add new elements to the canvas. Each element needs an id, type, position, and size.

Example: addElements({ elements: [
  { id: "rect_start", type: "rectangle", x: 100, y: 100, width: 160, height: 80, text: "Start" },
  { id: "rect_end", type: "rectangle", x: 360, y: 100, width: 160, height: 80, text: "End" },
  { id: "arrow_start_end", type: "arrow", x: 260, y: 140, width: 100, height: 0, startBinding: { elementId: "rect_start", focus: 0, gap: 8 }, endBinding: { elementId: "rect_end", focus: 0, gap: 8 } }
]})`,
  inputSchema: z.object({
    elements: z.array(elementSchema),
  }),
  strict: true,
});
```

The few shot example lives **inside the description**. It travels with the tool. When the model loads this tool's schema it sees the example right next to the parameter list.

**`src/tools/update-elements.ts`**:

```ts
const updateFields = z.object({
  x: z.number().nullable(),
  y: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  text: z.string().nullable(),
  fontSize: z.number().nullable(),
  textAlign: z.enum(["left", "center", "right"]).nullable(),
  strokeColor: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).nullable(),
  strokeWidth: z.number().nullable(),
  roughness: z.number().nullable(),
  opacity: z.number().nullable(),
});

export const updateElements = tool({
  description: `Update one or more existing elements by id. Pass null for any field you don't want to change.

Example: updateElements({ updates: [
  { id: "rect_login", fields: { backgroundColor: "#fa5252", x: null, y: null, ... } }
]})`,
  inputSchema: z.object({
    updates: z.array(z.object({ id: z.string(), fields: updateFields })),
  }),
  strict: true,
});
```

`updateElements` is **batch**: one tool call can update many elements. The lesson 2 `modifyDiagram` was one element per call.

**`src/tools/remove-elements.ts`**:

```ts
export const removeElements = tool({
  description: `Remove elements from the canvas by id. Call queryCanvas first if you don't know what's there.

Example: removeElements({ ids: ["rect_old", "arrow_stale"] })`,
  inputSchema: z.object({
    ids: z.array(z.string()),
  }),
  strict: true,
});
```

## 3. queryCanvas (also client side)

**`src/tools/query-canvas.ts`**:

```ts
export const queryCanvas = tool({
  description: `Read the current contents of the canvas. Call this when you need to know what elements already exist before adding, modifying, or removing anything. Returns a summary of every element with its id, type, position, and label.

Example: queryCanvas({})`,
  inputSchema: z.object({}),
});
```

The model only fetches canvas state when it actually needs to. Empty canvas + "draw a flowchart"? No `queryCanvas` call. "Make the login box red"? One `queryCanvas`, then one `updateElements`.

## 4. Browser side: fulfill all four with onToolCall

Two patterns to know up front:

- **Use `addToolOutput` to submit results**, per the [Cloudflare Agents docs](https://developers.cloudflare.com/agents/api-reference/chat-agents/#client-side-tools). The chat protocol pauses on the tool call, you call `addToolOutput({ toolCallId, output })`, and the loop resumes.
- **Strip null fields before handing data to Excalidraw.** Our schemas use nullable rather than optional, so the agent always sends every field. Excalidraw expects `undefined` for "use the default," not `null`, and a `points: null` on a rectangle (or `startBinding: null` on a non arrow) will crash `convertToExcalidrawElements`. If `onToolCall` throws, the tool call never gets a result, and the chat library cascades into a duplicate key + infinite update mess.

A small helper takes care of the second one:

```ts
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) out[k] = v;
  }
  return out;
}
```

**`src/App.tsx`**:

```tsx
const { messages, sendMessage, status } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    const api = excalidrawAPIRef.current;
    if (!api) {
      addToolOutput({ toolCallId: toolCall.toolCallId, output: { error: "canvas not ready" } });
      return;
    }

    if (toolCall.toolName === "queryCanvas") {
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: { summary: serializeCanvasState(api.getSceneElements() as unknown[]) },
      });
      return;
    }

    if (toolCall.toolName === "addElements") {
      const { elements } = toolCall.input as { elements: Record<string, unknown>[] };
      const cleaned = elements.map(stripNulls);
      // regenerateIds: false so the agent's chosen ids survive.
      const newOnes = convertToExcalidrawElements(cleaned as never, { regenerateIds: false });
      const next = [...api.getSceneElements(), ...newOnes];
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      api.scrollToContent(next, { fitToContent: true });
      addToolOutput({ toolCallId: toolCall.toolCallId, output: { added: newOnes.length } });
      return;
    }

    if (toolCall.toolName === "updateElements") {
      const { updates } = toolCall.input as {
        updates: { id: string; fields: Record<string, unknown> }[];
      };
      const byId = new Map(updates.map((u) => [u.id, stripNulls(u.fields)]));
      const next = api.getSceneElements().map((el) => {
        const fields = byId.get(el.id);
        return fields && Object.keys(fields).length > 0
          ? newElementWith(el, fields as never)
          : el;
      });
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      addToolOutput({ toolCallId: toolCall.toolCallId, output: { updated: byId.size } });
      return;
    }

    if (toolCall.toolName === "removeElements") {
      const { ids } = toolCall.input as { ids: string[] };
      const remove = new Set(ids);
      const next = api.getSceneElements().filter((el) => !remove.has(el.id));
      api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      addToolOutput({ toolCallId: toolCall.toolCallId, output: { removed: remove.size } });
      return;
    }
  },
});
```

That's all of it. The tool **is** the apply, and the apply returns a real result the agent can read on its next step. If `removeElements` was called on an id that didn't exist, the agent finds out from the result and can react.

### The lesson 6 plumbing goes away

Lesson 6 attached canvas state to every user message via a `data-canvas-state` part, then watched tool result messages on the client to apply them to the scene. With everything client side, both halves disappear. Here's what `App.tsx`, `agent.ts`, and `agent-core.ts` look like after the cleanup. Replace the old contents with these.

**`src/App.tsx`** (full file):

```tsx
import { useState, useCallback, useEffect, useRef } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  convertToExcalidrawElements,
  CaptureUpdateAction,
  newElementWith,
} from "@excalidraw/excalidraw";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import Canvas from "./components/Canvas";
import ChatPanel from "./components/chat/ChatPanel";
import { serializeCanvasState } from "./context/canvas-state";
import "./App.css";

const sessionId = crypto.randomUUID();

function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

export default function App() {
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null);
  useEffect(() => {
    excalidrawAPIRef.current = excalidrawAPI;
  }, [excalidrawAPI]);

  const handleApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawAPI(api);
  }, []);

  const agent = useAgent({ agent: "design-agent", name: sessionId });

  const { messages, sendMessage, status } = useAgentChat({
    agent,
    onToolCall: async ({ toolCall, addToolOutput }) => {
      const api = excalidrawAPIRef.current;
      if (!api) {
        addToolOutput({ toolCallId: toolCall.toolCallId, output: { error: "canvas not ready" } });
        return;
      }

      if (toolCall.toolName === "queryCanvas") {
        addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: { summary: serializeCanvasState(api.getSceneElements() as unknown[]) },
        });
        return;
      }

      if (toolCall.toolName === "addElements") {
        const { elements } = toolCall.input as { elements: Record<string, unknown>[] };
        const cleaned = elements.map(stripNulls);
        const newOnes = convertToExcalidrawElements(cleaned as never, { regenerateIds: false });
        const next = [...api.getSceneElements(), ...newOnes];
        api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        api.scrollToContent(next, { fitToContent: true });
        addToolOutput({ toolCallId: toolCall.toolCallId, output: { added: newOnes.length } });
        return;
      }

      if (toolCall.toolName === "updateElements") {
        const { updates } = toolCall.input as {
          updates: { id: string; fields: Record<string, unknown> }[];
        };
        const byId = new Map(updates.map((u) => [u.id, stripNulls(u.fields)]));
        const next = api.getSceneElements().map((el) => {
          const fields = byId.get(el.id);
          return fields && Object.keys(fields).length > 0
            ? newElementWith(el, fields as never)
            : el;
        });
        api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        addToolOutput({ toolCallId: toolCall.toolCallId, output: { updated: byId.size } });
        return;
      }

      if (toolCall.toolName === "removeElements") {
        const { ids } = toolCall.input as { ids: string[] };
        const remove = new Set(ids);
        const next = api.getSceneElements().filter((el) => !remove.has(el.id));
        api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        addToolOutput({ toolCallId: toolCall.toolCallId, output: { removed: remove.size } });
        return;
      }
    },
  });

  return (
    <div className={`app ${theme}`}>
      <div className="canvas-container">
        <Canvas onApiReady={handleApiReady} onThemeChange={setTheme} />
      </div>
      <ChatPanel
        messages={messages}
        sendMessage={sendMessage}
        status={status}
      />
      <a href="#viewer" className="viewer-launch" title="Open diagram viewer for human scoring">
        viewer
      </a>
    </div>
  );
}
```

`useMemo`, `appliedToolCalls`, the `sendWithCanvas` wrapper, and the `useEffect` that scanned messages for tool result parts are all gone. `serializeCanvasState` survives because the new `queryCanvas` handler uses it.

**`src/agent.ts`** (full file):

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import { convertToModelMessages } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { streamAgent } from "./agent-core";

interface Env extends Cloudflare.Env {
  OPENAI_API_KEY: string;
  TAVILY_API_KEY: string;
}

export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai("gpt-5.4-mini");
    const messages = await convertToModelMessages(this.messages);

    const result = streamAgent({
      model,
      messages,
      env: { TAVILY_API_KEY: this.env.TAVILY_API_KEY },
    });

    return result.toUIMessageStreamResponse();
  }
}
```

`extractCanvasState`, the `CanvasStatePart` type, and the `canvasState` argument to `streamAgent` are gone. The agent is now a four line stub: parse messages, hand to the model, return.

**`src/agent-core.ts`** streaming variant only (the eval variant `runAgent` gets covered separately in section 7):

```ts
interface AgentArgs {
  model: LanguageModel;
  messages: ModelMessage[];
  system?: string;
  maxSteps?: number;
  env?: { TAVILY_API_KEY?: string };
}

export function streamAgent({
  model,
  messages,
  system = SYSTEM_PROMPT,
  maxSteps = 8,
  env = {},
}: AgentArgs) {
  return streamText({
    model,
    system,
    messages,
    tools: buildTools(env),
    stopWhen: stepCountIs(maxSteps),
  });
}
```

`buildSystem` is gone, the `# Current canvas state` injection is gone, the `canvasState` parameter on `AgentArgs` is gone. The system prompt is the same string for every request now. Canvas state arrives via the `queryCanvas` tool when (and only when) the model decides it needs it.

`src/context/canvas-state.ts` stays where it is: `serializeCanvasState` is still used by the browser's `queryCanvas` handler and by the eval's headless `queryCanvas` simulator.

## 5. searchWeb (server side)

The one tool that stays server side. It calls Tavily, an LLM oriented search API: POST a query, get back clean `{title, content, url}` results, no scraping.

**`src/tools/search-web.ts`**:

```ts
export function makeSearchWeb(apiKey: string | undefined) {
  return tool({
    description: `Search the web for current information. Use this when the user asks about recent technology, frameworks, services, or systems where you may not have up to date knowledge.

Example: searchWeb({ query: "how Cloudflare Workers handle incoming requests", maxResults: 5 })`,
    inputSchema: z.object({
      query: z.string(),
      maxResults: z.number().nullable(),
    }),
    execute: async ({ query, maxResults }) => {
      if (!apiKey) return { error: "Tavily API key is not configured" };
      try {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults ?? 5,
            search_depth: "basic",
          }),
        });
        if (!response.ok) {
          return { error: `Tavily returned ${response.status}: ${await response.text()}` };
        }
        const data = (await response.json()) as { results?: { title?: string; content?: string; url?: string }[] };
        const results = (data.results ?? []).map((r) => ({
          title: r.title ?? "",
          content: r.content ?? "",
          url: r.url ?? "",
        }));
        return { results };
      } catch (err) {
        return { error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
```

Two patterns worth pointing out:

**Errors return, they don't throw.** A network failure becomes `{ error: "..." }`. The agent reads the error in its tool result and decides what to do. Throwing would crash the agent loop.

**Condense external API responses before returning them.** Tavily returns more fields than this. We strip everything except `title`, `content`, `url`. Always do this with external APIs, you're paying tokens for everything you pass through.

## 6. Wiring

**`src/tools.ts`**:

```ts
import { addElements } from "./tools/add-elements";
import { removeElements } from "./tools/remove-elements";
import { updateElements } from "./tools/update-elements";
import { queryCanvas } from "./tools/query-canvas";
import { makeSearchWeb } from "./tools/search-web";

export function buildTools(env: { TAVILY_API_KEY?: string }) {
  return {
    addElements,
    removeElements,
    updateElements,
    queryCanvas,
    searchWeb: makeSearchWeb(env.TAVILY_API_KEY),
  };
}
```

**`src/agent.ts`** shrinks. No more canvas state plumbing.

```ts
export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai("gpt-5.4-mini");
    const messages = await convertToModelMessages(this.messages);
    const result = streamAgent({
      model,
      messages,
      env: { TAVILY_API_KEY: this.env.TAVILY_API_KEY },
    });
    return result.toUIMessageStreamResponse();
  }
}
```

## 7. Eval

The eval has no browser, so the four client side tools have to be simulated headless. `runAgent` builds eval only versions with `execute` functions that mutate an in memory `sim` array. This pattern shows up again any time you have client side tools and a headless eval.

```ts
const sim: any[] = (seedCanvas ?? []).map((el: any) => ({ ...el }));

const baseTools = buildTools(env);
const evalTools = {
  addElements: tool({
    description: baseTools.addElements.description,
    inputSchema: baseTools.addElements.inputSchema as never,
    execute: async ({ elements }: { elements: any[] }) => {
      for (const el of elements) sim.push({ ...el });
      return { added: elements.length };
    },
  }),
  updateElements: tool({
    description: baseTools.updateElements.description,
    inputSchema: baseTools.updateElements.inputSchema as never,
    execute: async ({ updates }: { updates: { id: string; fields: Record<string, unknown> }[] }) => {
      let updated = 0;
      for (const { id, fields } of updates) {
        const target = sim.find((el) => el.id === id);
        if (!target) continue;
        for (const [k, v] of Object.entries(fields)) {
          if (v !== null) target[k] = v;
        }
        updated += 1;
      }
      return { updated };
    },
  }),
  removeElements: tool({
    description: baseTools.removeElements.description,
    inputSchema: baseTools.removeElements.inputSchema as never,
    execute: async ({ ids }: { ids: string[] }) => {
      let removed = 0;
      for (const id of ids) {
        const idx = sim.findIndex((el) => el.id === id);
        if (idx >= 0) {
          sim.splice(idx, 1);
          removed += 1;
        }
      }
      return { removed };
    },
  }),
  queryCanvas: tool({
    description: baseTools.queryCanvas.description,
    inputSchema: z.object({}),
    execute: async () => ({ summary: serializeCanvasState(sim) }),
  }),
  searchWeb: baseTools.searchWeb,
};
```

We also expose the flat list of tool names called across the run, so the new scorer can check tool choice:

```ts
const toolCalls: string[] = [];
for (const step of result.steps) {
  for (const call of step.toolCalls ?? []) toolCalls.push(call.toolName);
}
return { text: result.text, elements: sim, toolCalls, steps: result.steps };
```

### New scorer: ToolChoice

The Preservation scorer is gone. It was tied to the old `modifyDiagram` tool surface and once `extractElements` simulated the canvas headlessly it stopped meaning much. We replace it with a scorer that checks **tool choice** against the test case `category` already in golden, no dataset changes needed.

**`evals/scorers/toolChoice.ts`**:

```ts
export const toolChoiceScorer: EvalScorer<GoldenTestCase, AgentOutput, GoldenTestCase> = ({
  output,
  expected,
}) => {
  const calls = output.toolCalls ?? [];
  const category = expected?.category;

  if (category === "create" || category === "domain") {
    const ok = calls.includes("addElements");
    return { name: "ToolChoice", score: ok ? 1 : 0, metadata: { category, calls } };
  }

  if (category === "modify") {
    const queryAt = calls.indexOf("queryCanvas");
    const firstMutator = calls.findIndex(
      (n) => n === "updateElements" || n === "removeElements"
    );
    if (firstMutator < 0) return { name: "ToolChoice", score: 0, metadata: { category, calls } };
    if (queryAt < 0 || queryAt > firstMutator) {
      return { name: "ToolChoice", score: 0.5, metadata: { category, calls, reason: "mutated without querying first" } };
    }
    return { name: "ToolChoice", score: 1, metadata: { category, calls } };
  }

  return null;
};
```

The rules, by category:

- **create** / **domain**: `addElements` must be called.
- **modify**: at least one of `updateElements` or `removeElements` must be called, and `queryCanvas` must come **before** the first mutation. If the agent mutates without querying first, that's half credit because it's hallucinating ids.
- **edge**: returns null and Braintrust skips it.

Add it to the eval scorer list and drop `preservationScorer`. Run the eval, compare against the lesson 6 baseline. Schema, LabelKeywords, and Structure should hold or improve. ToolChoice is a fresh metric with no historical comparison.

### New scorer: BoundLabels

Lesson 6 added BoundArrows and Connectivity, but it didn't measure whether the model was actually labeling its shapes. It couldn't, because the lesson 6 schema didn't have `containerId`. Now that we've added `containerId` to the element schema in section 1, we have a precise way to measure this.

`BoundLabels` checks: for every container shape (rectangle, ellipse, diamond) in the output, is there a text element whose `containerId` points back to it? Score is the ratio of labeled shapes to total shapes. This is the most direct measure of "is the diagram readable" we can write.

**`evals/scorers/boundLabels.ts`**:

```ts
import type { EvalScorer } from "braintrust";
import type { AgentOutput } from "./schema";
import type { GoldenTestCase } from "../buildMessages";

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

export const boundLabelsScorer: EvalScorer<GoldenTestCase, AgentOutput, GoldenTestCase> = ({
  output,
}) => {
  const elements = (output.elements ?? []) as Record<string, unknown>[];
  const shapes = elements.filter(
    (el) => typeof el?.type === "string" && SHAPE_TYPES.has(el.type as string)
  );
  if (shapes.length === 0) return null;

  const boundLabelShapeIds = new Set<string>();
  for (const el of elements) {
    if (el?.type !== "text") continue;
    const containerId = el.containerId;
    if (typeof containerId === "string" && containerId.length > 0) {
      boundLabelShapeIds.add(containerId);
    }
  }

  let labeled = 0;
  const unlabeled: string[] = [];
  for (const shape of shapes) {
    const id = typeof shape.id === "string" ? shape.id : null;
    if (id && boundLabelShapeIds.has(id)) labeled += 1;
    else unlabeled.push(id ?? "(no id)");
  }

  return {
    name: "BoundLabels",
    score: labeled / shapes.length,
    metadata: { labeled, total: shapes.length, unlabeled },
  };
};
```

Add it to the eval scorer list alongside the others. After the schema description changes in section 1, BoundLabels should jump significantly. The model now has both the field (`containerId`) AND the description telling it when to use the field. The two work together: the field is the mechanism, the description is the prompt.
