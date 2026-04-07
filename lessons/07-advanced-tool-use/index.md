# Advanced Tool Use

Lesson 6 fixed the agent's context. This lesson fixes its tools. We replace the two coarse tools from lesson 2 (`generateDiagram`, `modifyDiagram`) with a small set of focused CRUD tools, all running client side, plus a server side `searchWeb` tool that hits a real external API. The tool surface is part of the prompt: the model can only do what its tools let it do.

## Three changes

1. **Split into focused tools**: `addElements`, `updateElements`, `removeElements`. CRUD on the canvas.
2. **All canvas tools are client side**: no `execute` on the worker. The browser fulfills them via `useAgentChat`'s `onToolCall`. That includes `queryCanvas`, the read tool the agent calls on demand instead of paying the canvas serialization tax in the system prompt every turn.
3. **Add `searchWeb` via Tavily**: a real external API call from a server side tool.

## 1. The element schema

Both `addElements` and (a nullable variant of) `updateElements` use the same shape. Defining it once means the agent sees the same field names whether it's creating or editing.

**`src/tools/element-schema.ts`**:

```ts
import { z } from "zod";

export const elementSchema = z.object({
  id: z.string(),
  type: z.enum(["rectangle", "ellipse", "diamond", "text", "arrow", "line"]),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  strokeColor: z.string().nullable(),
  backgroundColor: z.string().nullable(),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).nullable(),
  strokeWidth: z.number().nullable(),
  roughness: z.number().nullable(),
  opacity: z.number().nullable(),
  text: z.string().nullable(),
  fontSize: z.number().nullable(),
  fontFamily: z.number().nullable(),
  textAlign: z.enum(["left", "center", "right"]).nullable(),
  points: z.array(z.array(z.number())).nullable(),
  startBinding: z.object({ elementId: z.string(), focus: z.number(), gap: z.number() }).nullable(),
  endBinding: z.object({ elementId: z.string(), focus: z.number(), gap: z.number() }).nullable(),
});
```

Note **nullable, not optional**. OpenAI's strict mode requires every field present in every call. Null means "not applicable for this element type" (e.g. `points` on a rectangle, `startBinding` on a text). Optional fields fail strict mode.

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

**`src/App.tsx`**:

```tsx
const { messages, sendMessage, status } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    const api = excalidrawAPIRef.current;
    if (!api) return;

    if (toolCall.toolName === "queryCanvas") {
      addToolOutput({
        toolCallId: toolCall.toolCallId,
        output: { summary: serializeCanvasState(api.getSceneElements() as unknown[]) },
      });
      return;
    }

    if (toolCall.toolName === "addElements") {
      const { elements } = toolCall.input as { elements: unknown[] };
      // regenerateIds: false so the agent's chosen ids survive.
      const newOnes = convertToExcalidrawElements(elements as never, { regenerateIds: false });
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
      // Strip nulls. Schema makes the model mention every field; only the
      // non null ones should actually apply.
      const byId = new Map(
        updates.map((u) => {
          const fields: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(u.fields)) if (v !== null) fields[k] = v;
          return [u.id, fields];
        })
      );
      const next = api.getSceneElements().map((el) => {
        const fields = byId.get(el.id);
        return fields ? newElementWith(el, fields as never) : el;
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

### Delete the lesson 6 plumbing

Several pieces of `App.tsx` exist only because lesson 6 had to ship the canvas state to the worker on every turn and watch tool result messages to apply them to the scene. With everything client side, all of it goes away.

In `src/App.tsx`, delete:

- The `useMemo` import (no longer used).
- The `appliedToolCalls` ref. Tool calls run exactly once now, no double apply guard needed.
- The entire `sendWithCanvas` wrapper. We pass the raw `sendMessage` to `<ChatPanel>` instead.
- The entire `useEffect` that watches `messages` for `tool-generateDiagram` / `tool-modifyDiagram` parts and applies them to the scene. Replaced by `onToolCall`.
- The `import { serializeCanvasState } from "./context/canvas-state"` line stays, because `onToolCall`'s `queryCanvas` branch still uses it.

In `src/agent.ts`, delete:

- `extractCanvasState` and the `CanvasStatePart` type.
- The `canvasState` argument passed to `streamAgent`.

In `src/agent-core.ts`, delete:

- `buildSystem` and the `# Current canvas state` injection.
- The `canvasState` parameter on `AgentArgs` (the streaming variant; the eval variant gets a new `seedCanvas` parameter, see section 7).

You can also delete `src/context/canvas-state.ts` entirely... almost. The `serializeCanvasState` function is still used by the browser's `queryCanvas` handler and by the eval's headless `queryCanvas` simulator. Move the file or leave it where it is, but the function is still load bearing.

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
