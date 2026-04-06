# Advanced Tool Use

Lesson 6 fixed the agent's *context* — what information lands in front of the model on every turn. This lesson fixes the *tools* — the actions the model can take. We replace the two coarse tools from lesson 2 (`generateDiagram`, `modifyDiagram`) with a small set of focused CRUD tools, move canvas reads onto a client side tool the agent calls on demand, and add a web search tool that hits a real external API. The whole point is that **better tools change behavior more than better prompting**, and the eval shows it.

## Where we left off

Lesson 6 ended at:

| Scorer | Lesson 6 |
|---|---|
| Schema | 100% |
| LabelKeywords | 94% |
| Structure | 67% |
| Preservation | 50% |

Preservation jumped from 25 to 50 once we started serializing the canvas into the system prompt. But it's still half. The agent knows what's there, it just doesn't have the right tools to keep things while changing one piece. `generateDiagram` is all or nothing. The agent's options are "regenerate everything" or "modify one element by id." There is no "add a box without touching the rest." So when the user says "add a cache between the API and the database," the agent picks the closest tool, calls `generateDiagram` with everything redrawn, and the seed elements either change ids, lose styling, or vanish.

This is the tool design lesson. The tool surface is part of the prompt — the model can only do what its tools let it do.

## Three changes

1. **Split `generateDiagram` and `modifyDiagram` into focused tools**: `addElements`, `updateElements`, `removeElements`. CRUD on the canvas.
2. **Make `queryCanvas` a client side tool**: instead of stuffing canvas state into the system prompt every turn, the agent calls a tool that runs *in the browser* when it actually needs to know what's there.
3. **Add `searchWeb` via Tavily**: a real external API call inside a tool's execute function. The agent fetches fresh information when the user asks about something the model may not know.

That's the whole lesson. No registry, no sandbox, no clever architecture. Just small tools and one client side tool.

## 1. Scoped tools

The new files live under `src/tools/`. Each tool gets its own file because each one has its own schema and example, and putting them next to each other in one file gets noisy fast.

`src/tools/add-elements.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { elementSchema } from "./element-schema";

export const addElements = tool({
  description: `Add new elements to the canvas. Use this for creating diagrams or adding to an existing one. Each element needs an id, type, position, and size.

Example: addElements({ elements: [
  { id: "rect_start", type: "rectangle", x: 100, y: 100, width: 160, height: 80, text: "Start" },
  { id: "rect_end", type: "rectangle", x: 360, y: 100, width: 160, height: 80, text: "End" },
  { id: "arrow_start_end", type: "arrow", x: 260, y: 140, width: 100, height: 0, startBinding: { elementId: "rect_start", focus: 0, gap: 8 }, endBinding: { elementId: "rect_end", focus: 0, gap: 8 } }
]})`,
  inputSchema: z.object({
    elements: z.array(elementSchema),
  }),
  execute: async ({ elements }) => {
    return { elements };
  },
});
```

Two things to notice:

**The execute function is a passthrough.** The worker doesn't know what's actually on the canvas — only the browser does. The worker's job is to relay the agent's intent. The browser watches messages, sees `tool-addElements` parts, and applies them via the Excalidraw API. Same pattern as lesson 3, just with three tools instead of one.

**The few shot example lives inside the description.** Not in the system prompt, not in a separate examples file. It travels with the tool. When the model loads this tool's schema it sees the example right there next to the parameter list. This is the cheapest, highest leverage thing you can do for tool reliability.

`src/tools/update-elements.ts` is the same shape, with the nullable fields trick from lesson 2 so OpenAI strict mode stays on:

```ts
const updateFields = z.object({
  x: z.number().nullable(),
  y: z.number().nullable(),
  width: z.number().nullable(),
  // ...every field nullable
});

export const updateElements = tool({
  description: `Update one or more existing elements by id. Pass null for any field you don't want to change.

Example: updateElements({ updates: [
  { id: "rect_login", fields: { backgroundColor: "#fa5252", x: null, y: null, ... } }
]})`,
  inputSchema: z.object({
    updates: z.array(z.object({
      id: z.string(),
      fields: updateFields,
    })),
  }),
  execute: async ({ updates }) => {
    // Strip nulls before sending to the client.
    const cleaned = updates.map(({ id, fields }) => {
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== null) filtered[key] = value;
      }
      return { id, fields: filtered };
    });
    return { updates: cleaned };
  },
});
```

The big change from lesson 2's `modifyDiagram` is that `updateElements` is **batch**: one tool call can update many elements at once. The old tool only modified one element per call. For a request like "make all the rectangles blue," the old agent had to call `modifyDiagram` N times, burning a turn each. Now it's one call.

`src/tools/remove-elements.ts` is the smallest:

```ts
export const removeElements = tool({
  description: `Remove elements from the canvas by id.

Example: removeElements({ ids: ["rect_old", "arrow_stale"] })`,
  inputSchema: z.object({
    ids: z.array(z.string()),
  }),
  execute: async ({ ids }) => {
    return { ids };
  },
});
```

## 2. The client side tool

Lesson 6 sent the canvas state to the worker on every user message via a `data-canvas-state` message part. That worked, but it was wasteful — every turn, even ones that didn't need canvas info, paid the token cost of the full canvas serialization. And it was a hack: the AI SDK protocol doesn't really have a place for "extra payload alongside a user message," so we shoved it into a custom data part the worker had to extract.

The right answer is: let the agent **fetch** canvas state when it needs it, with a tool. And since the canvas only exists in the browser, that tool has to **execute in the browser**. The AI SDK supports this directly via tools with no `execute` function. The protocol pauses the agent loop on the tool call, streams the call to the client, the client runs whatever it wants, sends the result back, and the agent continues.

`src/tools/query-canvas.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";

export const queryCanvas = tool({
  description: `Read the current contents of the canvas. Call this when you need to know what elements already exist before adding, modifying, or removing anything. Returns a summary of every element with its id, type, position, and label.

Example: queryCanvas({})`,
  inputSchema: z.object({}),
  // No execute. The browser handles it.
});
```

That's the whole worker side. No `execute`. The AI SDK sees that and treats this tool as client side. When the model calls it, the worker streams the call out and waits.

The browser side fulfills it via `useAgentChat`'s `onToolCall` callback. In `src/App.tsx`:

```tsx
const { messages, sendMessage, status } = useAgentChat({
  agent,
  onToolCall: async ({ toolCall, addToolOutput }) => {
    if (toolCall.toolName !== "queryCanvas") return;
    const api = excalidrawAPIRef.current;
    const elements = api?.getSceneElements() ?? [];
    addToolOutput({
      toolCallId: toolCall.toolCallId,
      output: { summary: serializeCanvasState(elements as unknown[]) },
    });
  },
});
```

When the agent calls `queryCanvas`, the browser reads the live scene with `excalidrawAPI.getSceneElements()`, runs the same `serializeCanvasState` from lesson 6 on it, and submits the result. The agent loop resumes automatically (`autoContinueAfterToolResult` is true by default). One round trip, one tool result, the agent proceeds with that string in its context.

**Why this is better than the lesson 6 hack:**

- **Lazy.** The agent only fetches state when it actually needs it. "Draw a flowchart of user signup" on an empty canvas? No queryCanvas call, no token cost. "Make the login box red"? One queryCanvas call, the agent finds the id, then one updateElements call. Done.
- **No custom protocol.** No `data-canvas-state` message part. No `extractCanvasState` function on the worker. No `sendWithCanvas` wrapper on the client. All deleted.
- **Always fresh.** The browser is the source of truth. There's no risk of the agent acting on a stale snapshot from a few turns ago.

The system prompt also changes. Lesson 6 appended a "Current canvas state" section to the system prompt at request time. Lesson 7 drops that entirely and instead instructs the model on **when** to call queryCanvas:

```
- **Query before you modify.** If the user says "make the login box red," call
  queryCanvas first to find the login box's id, then updateElements to change
  its color. Never invent ids.
```

The model decides the timing. We just have to teach it the policy.

## 3. Web search via Tavily

The third change is `searchWeb`. It's a normal server side tool with an execute function, but the execute calls the Tavily API instead of doing local work. Tavily is purpose built for LLM agents — you POST a query, you get back clean condensed results in `{title, content, url}` shape, no scraping, no parsing, no per page rate limit games. Free tier is 1000 searches/month at tavily.com.

`src/tools/search-web.ts`:

```ts
export function makeSearchWeb(apiKey: string | undefined) {
  return tool({
    description: `Search the web for current information. Use this when the user asks about recent technology, frameworks, services, or systems where you may not have up to date knowledge — for example "draw an architecture diagram of how Cloudflare Workers handle requests" should trigger a search before you start drawing.

Example: searchWeb({ query: "how Cloudflare Workers handle incoming requests", maxResults: 5 })`,
    inputSchema: z.object({
      query: z.string(),
      maxResults: z.number().optional(),
    }),
    execute: async ({ query, maxResults }) => {
      if (!apiKey) {
        return { error: "Tavily API key is not configured" };
      }
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
        const data = await response.json();
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

A few patterns worth pointing out:

**Errors return, they don't throw.** A network failure, a missing key, a 429 from Tavily — every one of those becomes `{ error: "..." }`. The agent reads the error in its tool result, decides what to do (retry with a different query, give up, ask the user), and keeps going. If we threw, the whole agent loop would crash. Tools that talk to the network MUST do this. Doesn't matter what the network does, your agent shouldn't die.

**The result is condensed before it leaves.** Tavily returns more fields than this — relevance scores, raw content lengths, timestamps. We strip everything except `title`, `content`, `url`. The model only needs those to decide what to draw. Sending the rest costs tokens for no benefit. **Always condense external API responses before feeding them back to the model.**

**Factory function for env injection.** `makeSearchWeb(apiKey)` returns a tool. We can't reach into a Worker's `env` from a top level export, so we build the tool inside the agent's `onChatMessage` and pass it the key. This is a common pattern when tool execute functions need request scoped config.

### Why search lives in tools vs context vs RAG

Three different ways to get external information into the model. They have different patterns.

- **Context (lesson 6)**: facts the model needs *every turn*. The system prompt, the canvas state (when it was a context thing, not a tool), the user role. Cheap to retrieve, expensive to send because it bloats every request. Use this when the answer is "always."
- **Tools (this lesson)**: facts the model fetches *on demand* when it decides it needs them. The model controls the trigger. Web search, database lookups, file reads, API calls. Use this when the answer is "sometimes, and the model will know when."
- **RAG (lesson 8)**: facts retrieved from *your own corpus* via embedding similarity. Same on demand pattern as tools, but the data source is your own vector store instead of the open web. Use this when the answer lives in private data the model doesn't know.

`searchWeb` is the simplest version of "model decides to fetch." Lesson 8 swaps the data source for an internal one and adds the embedding step, but the trigger is the same shape.

## Wiring it all together

`src/tools.ts` becomes a barrel that re exports everything as a single tool set, plus a `buildTools(env)` factory for the request scoped Tavily key:

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

`src/agent.ts` shrinks. No more `extractCanvasState`. No more `canvasState` plumbing. Just hand the env to streamAgent and let the tool layer handle everything:

```ts
export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai("gpt-5.4-mini");
    const allMessages = await convertToModelMessages(this.messages);
    const messages = await compactHistory(allMessages, { model });
    const result = streamAgent({
      model,
      messages,
      env: { TAVILY_API_KEY: this.env.TAVILY_API_KEY },
    });
    return result.toUIMessageStreamResponse();
  }
}
```

`src/agent-core.ts` drops `buildSystem` and the canvas state argument. The system prompt is the same string for every request now. The tool wiring uses `buildTools(env)`. The eval variant of `runAgent` builds eval only versions of every tool that mutate an in memory `sim` array, including a `queryCanvas` *with* an execute function (because the eval has no browser to fulfill it):

```ts
const evalTools = {
  addElements: tool({ /* ... */ execute: async ({ elements }) => {
    for (const el of elements) sim.push({ ...el });
    return { elements };
  }}),
  updateElements: tool({ /* ... */ execute: async ({ updates }) => {
    // mutate sim, return the cleaned updates
  }}),
  removeElements: tool({ /* ... */ }),
  queryCanvas: tool({
    description: baseTools.queryCanvas.description,
    inputSchema: z.object({}),
    execute: async () => ({ summary: serializeCanvasState(sim) }),
  }),
  searchWeb: baseTools.searchWeb,
};
```

This is the recurring pattern: the eval has to *simulate* whatever the browser does in production, otherwise the agent loop hangs on the client side tool. Worth understanding because we'll do it again in lesson 9.

`src/App.tsx` gets the new tool handlers and the `onToolCall` for queryCanvas. The full file is in the lesson 8 branch. The interesting bit is the message watcher:

```tsx
useEffect(() => {
  if (!excalidrawAPI) return;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      const type = (part as { type?: string }).type;
      if (type === "tool-addElements") {
        // skeletons → newElements, append to scene
      } else if (type === "tool-updateElements") {
        // batch merge fields by id
      } else if (type === "tool-removeElements") {
        // filter out removed ids
      }
    }
  }
}, [messages, excalidrawAPI]);
```

Three parallel branches for the three mutating tools, all guarded by the `appliedToolCalls` set so we don't double apply on rerender. Same `regenerateIds: false`, `newElementWith`, `CaptureUpdateAction.IMMEDIATELY` invariants from the earlier lessons.

## Eval

Run the eval on lesson 8 (where the solution lives) and compare against lesson 6:

| Scorer | Lesson 6 | Lesson 7 | Δ |
|---|---|---|---|
| Schema | 100% | 100% | 0 |
| LabelKeywords | 94% | 93% | -1 |
| Structure | 67% | 67% | 0 |
| **Preservation** | **50%** | **100%** | **+50** |
| Duration | (baseline) | -41% | faster |

Preservation **doubled to 100 percent**. The agent now perfectly preserves seed elements on modify cases because `addElements` is purely additive — there's no way to clobber existing elements anymore. The only path to losing an element is to call `removeElements` on its id, which the agent only does when the user asks. Schema and Structure stay flat (they were already topped out), LabelKeywords drifts down a hair (noise — eval scores will differ run to run, the absolute number matters less than the trend on the scorer that was actually broken).

Duration dropped 41 percent. Two reasons: most turns no longer pay the canvas serialization tax in the system prompt, and modify cases are now one tool call instead of N.

**Your numbers will differ.** What matters: Preservation should jump from roughly half to roughly all, and the others should stay flat or improve slightly. If Preservation didn't move, something is wrong with the agent loop — most likely the agent isn't calling queryCanvas before updateElements, or the eval `evalTools.queryCanvas` isn't reading from `sim` correctly.

## Things that didn't make the cut

The original lesson 7 plan had a tool registry (search for relevant tools per request) and a sandboxed code execution tool (let the agent write JS for repetitive layouts). Both got cut.

**Tool registry**: only worth it once you have ~20+ tools. With six, keyword search is over engineering. The model can hold all six tool definitions in context with no issue. We'll revisit registries in a later lesson if the surface grows.

**Code sandbox**: interesting, but the safety story on Cloudflare Workers is awkward (no real preemption for sync code, the "5 second timeout" is advisory at best), and the use cases overlap with what `addElements` already does well via batch input. Cut for simplicity. If you want this, the right place is a local Node sandbox inside your eval harness, not the production worker.

## Recap

- Replaced two coarse tools with three focused CRUD tools and a query tool.
- The query tool runs in the browser via the AI SDK's no execute pattern. Goodbye `data-canvas-state` hack.
- Added a real external API tool (Tavily web search) with proper error handling and result condensation.
- Eval went from 50 to 100 on Preservation, the scorer that was actually broken.
- The system prompt got *smaller*, not bigger, because the agent now reads canvas state on demand instead of receiving it on every turn.

Lesson 8 picks up here and adds RAG: same on demand pattern, but the data source is a private vector store instead of the open web.
