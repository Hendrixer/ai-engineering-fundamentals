# Your First Cloudflare Agent

In this lesson you will build your first AI agent. By the end, you will have an agent class that receives chat messages, calls an LLM with tool definitions, and streams back responses including Excalidraw diagram elements. The chat UI is not wired up yet (that is lesson 3), but the agent will be fully functional on the backend.

## Agent Architecture

### What is a Cloudflare Agent?

A Cloudflare Agent is a **stateful, long lived server side object** built on top of Cloudflare's Durable Objects. Each agent instance:

- Has its own isolated storage (SQLite)
- Handles WebSocket connections for real time communication
- Persists across requests (it is not a stateless function)
- Runs on Cloudflare's edge network (or locally via `wrangler dev`)

The Cloudflare **Agents SDK** (`agents` npm package) provides routing and infrastructure. For chat agents specifically, we use `AIChatAgent` from `@cloudflare/ai-chat` which gives us built in message history, streaming, and tool handling.

### The Agent Loop

Here is how our agent processes a message:

```
User sends message via WebSocket
        ↓
AIChatAgent receives it, stores in message history
        ↓
onChatMessage() fires
        ↓
We call streamText() with the LLM, tools, and message history
        ↓
LLM decides to use a tool? ──yes──→ Tool executes, result fed back
        ↓ no                              ↓
LLM streams text response          Loop back to LLM
        ↓
Response streamed back to client via WebSocket
```

The key thing to notice is how much the AI SDK and `AIChatAgent` handle for us. We do not manually manage WebSocket messages, message history, or the tool execution loop. We define our tools, call `streamText()`, and return the stream.

### Durable Objects and Workers

The Worker (`src/worker.ts`) acts as a router. The `routeAgentRequest` helper from the Agents SDK inspects incoming requests and routes them to the right Durable Object instance. The Durable Object (our `DesignAgent` class) handles the actual WebSocket connection and message processing.

```
Browser ──WebSocket──→ Worker (routeAgentRequest) ──→ Durable Object (agent)
```

## Excalidraw Elements

Excalidraw represents everything on the canvas as JSON elements. Each element has a `type`, position (`x`, `y`), dimensions (`width`, `height`), and styling properties. Here are the element types our agent can create:

| Type | Use For |
|------|---------|
| `rectangle` | Boxes, containers, cards |
| `ellipse` | Circles, ovals |
| `diamond` | Decision points, conditions |
| `text` | Labels, descriptions |
| `arrow` | Connections, flow direction |
| `line` | Dividers, connections without direction |

Every element shares a base set of properties:

- `id` — unique identifier (the agent generates these)
- `x`, `y` — position on the canvas
- `width`, `height` — dimensions
- `strokeColor` — border/line color (hex string)
- `backgroundColor` — fill color (hex or "transparent")
- `fillStyle` — how the fill renders: "solid", "hachure", or "cross-hatch"
- `roughness` — 0 for clean lines, 1 for hand drawn
- `opacity` — 0 to 100

Some element types have additional properties. Text elements have `text`, `fontSize`, and `fontFamily`. Arrow elements have `points` (array of [x,y] coordinates) and optional `startBinding`/`endBinding` to connect to other elements.

## Tool Design

### The AI SDK and Tool Use

We use the [Vercel AI SDK](https://sdk.vercel.ai) (`ai` package) to interact with the LLM. The AI SDK provides a unified interface across LLM providers and has first class support for tool use with Zod schemas.

You define tools using the `tool()` helper. Each tool has:
- A `description` that tells the LLM when to use it
- An `inputSchema` defined with Zod that validates the arguments
- An `execute` function that runs when the LLM calls the tool

The AI SDK handles the tool use loop automatically. When the LLM calls a tool, the SDK executes it, feeds the result back to the LLM, and lets it continue. We set `stopWhen: stepCountIs(5)` to prevent infinite loops.

### Why These Tools Are Intentionally Naive

Our two tools (`generateDiagram` and `modifyDiagram`) are **deliberately simple**:

- `generateDiagram` asks the LLM to produce ALL elements in one giant JSON array. This means the model has to handle layout, sizing, spacing, colors, text, and arrow connections all at once. That is a lot to ask in a single tool call.
- `modifyDiagram` requires knowing the exact element ID. But the user does not know element IDs, so the agent has to figure them out.

These tools will work for simple diagrams but struggle with complex ones. That is the point. When we build evals in lesson 4 and run them, the scores will show exactly where the agent falls short. Then in later lessons we will break these into better scoped tools and watch the eval scores improve.

## Building the Agent

Here is everything we are adding in this lesson. Follow along in order.

### Install dependencies

```bash
npm install agents ai @ai-sdk/openai @cloudflare/ai-chat zod
```

### Update `.dev.vars`

Make sure your `.dev.vars` has your OpenAI API key:

```
OPENAI_API_KEY=sk-your-openai-key-here
```

### `src/schemas.ts` (new file)

TypeScript types for Excalidraw elements. These define the shape of the JSON that our tools produce. The actual tool schemas use Zod, but having TypeScript types is useful for the rest of the codebase:

```ts
export interface BaseElement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: "solid" | "hachure" | "cross-hatch";
  strokeWidth: number;
  roughness: number;
  opacity: number;
  angle: number;
  groupIds: string[];
  isDeleted: boolean;
  boundElements: { id: string; type: "arrow" | "text" }[] | null;
}

export interface RectangleElement extends BaseElement {
  type: "rectangle";
  roundness: { type: number; value?: number } | null;
}

export interface EllipseElement extends BaseElement {
  type: "ellipse";
}

export interface DiamondElement extends BaseElement {
  type: "diamond";
}

export interface TextElement extends BaseElement {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily: number;
  textAlign: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  containerId: string | null;
}

export interface ArrowElement extends BaseElement {
  type: "arrow";
  points: [number, number][];
  startBinding: { elementId: string; focus: number; gap: number } | null;
  endBinding: { elementId: string; focus: number; gap: number } | null;
}

export interface LineElement extends BaseElement {
  type: "line";
  points: [number, number][];
}

export type ExcalidrawElement =
  | RectangleElement
  | EllipseElement
  | DiamondElement
  | TextElement
  | ArrowElement
  | LineElement;
```

### `src/tools.ts` (new file)

Tool definitions using the AI SDK's `tool()` helper with Zod schemas:

```ts
import { tool } from "ai";
import { z } from "zod";

export const tools = {
  generateDiagram: tool({
    description:
      "Generate a complete diagram as an array of Excalidraw elements. Use this when the user asks you to create, draw, or design a new diagram. Return all elements needed including shapes, text labels, and arrows/lines connecting them. Position elements with x,y coordinates and give each a unique id.",
    inputSchema: z.object({
      elements: z.array(
        z.object({
          id: z.string().describe("Unique identifier"),
          type: z.enum(["rectangle", "ellipse", "diamond", "text", "arrow", "line"]),
          x: z.number().describe("X position"),
          y: z.number().describe("Y position"),
          width: z.number().describe("Width"),
          height: z.number().describe("Height"),
          strokeColor: z.string().default("#1e1e1e").describe("Stroke color (hex)"),
          backgroundColor: z.string().default("transparent").describe("Fill color"),
          fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).default("solid"),
          strokeWidth: z.number().default(2),
          roughness: z.number().default(1).describe("0 for clean, 1 for sketchy"),
          opacity: z.number().default(100),
          text: z.string().optional().describe("Text content (for text elements)"),
          fontSize: z.number().default(20),
          fontFamily: z.number().default(1).describe("1=Virgil, 2=Helvetica, 3=Cascadia"),
          textAlign: z.enum(["left", "center", "right"]).default("center"),
          points: z
            .array(z.array(z.number()))
            .optional()
            .describe("Array of [x,y] points (for arrow/line elements). Each point is a two number array."),
          startBinding: z
            .object({
              elementId: z.string(),
              focus: z.number(),
              gap: z.number(),
            })
            .optional()
            .describe("Bind arrow start to an element"),
          endBinding: z
            .object({
              elementId: z.string(),
              focus: z.number(),
              gap: z.number(),
            })
            .optional()
            .describe("Bind arrow end to an element"),
        })
      ).describe("Array of Excalidraw elements that make up the diagram"),
    }),
    execute: async ({ elements }) => {
      return { elements };
    },
  }),

  modifyDiagram: tool({
    description:
      "Modify an existing element on the canvas by id. Pass null for any field you don't want to change.",
    inputSchema: z.object({
      elementId: z.string().describe("The id of the element to modify"),
      // Every field is nullable rather than optional. OpenAI's strict tool
      // calling mode requires every property in `properties` to also be in
      // `required` — optional fields are rejected. Nullable fields satisfy
      // strict mode (they're required, but the value can be null), and the
      // model passes null for fields it doesn't want to change. We strip
      // nulls before applying the merge on the client.
      updates: z.object({
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
      }),
    }),
    execute: async ({ elementId, updates }) => {
      // Filter out null fields so the client only sees what should actually
      // change. Without this, a null field would overwrite the live value
      // and break the element.
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== null) filtered[key] = value;
      }
      return { elementId, updates: filtered };
    },
  }),
};
```

The `generateDiagram` `execute` is a simple pass through — the LLM does the real work picking which elements to create. `modifyDiagram` does one tiny piece of cleanup: it strips out null fields before returning, so the client only ever sees the fields the model actually wants to change.

**Why nullable instead of optional?** OpenAI's strict tool calling mode requires every property in a tool's input schema to be in the `required` list. Optional fields get rejected outright. Nullable fields satisfy the constraint (the field is required, but its value can be `null`), so we keep strict mode on (better validation guarantees from OpenAI) and the model just passes `null` for fields it doesn't want to touch.

### `src/agent.ts` (new file)

The agent class. This extends `AIChatAgent` which handles WebSocket connections, message history, and the chat protocol:

```ts
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { tools } from "./tools";

interface Env {
  OPENAI_API_KEY: string;
}

const SYSTEM_PROMPT = `You are a diagram design assistant. You help users create and modify diagrams on an Excalidraw canvas.

When the user asks you to create a diagram, use the generateDiagram tool to produce Excalidraw elements.

Guidelines for generating diagrams:
- Give each element a unique id (e.g. "rect-1", "text-1", "arrow-1")
- Position elements with reasonable spacing (at least 20px gap between elements)
- Use rectangles for boxes/containers, ellipses for circles, diamonds for decision points
- Add text labels inside or near shapes
- Connect related elements with arrows
- Use a clean layout: left to right or top to bottom
- Default to strokeColor "#1e1e1e" and backgroundColor "transparent"
- Set roughness to 1 for a hand-drawn look

When the user asks to modify an element, use the modifyDiagram tool with the element's id.`;

export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });

    const result = streamText({
      model: openai("gpt-5.4-mini"),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(this.messages),
      tools,
      stopWhen: stepCountIs(5),
    });

    return result.toUIMessageStreamResponse();
  }
}
```

This is remarkably concise. The `AIChatAgent` base class gives us:
- `this.messages` — the full chat history, persisted in the DO's SQLite storage
- `this.env` — access to environment variables (our API key)
- WebSocket handling, message serialization, and the chat protocol

We just implement `onChatMessage()`, call `streamText()` with our model, tools, and messages, and return the streaming response.

### `wrangler.toml` (modified)

Add the Durable Object binding, migration, and `nodejs_compat` flag:

```toml
name = "ai-design-tool"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]
main = "./src/worker.ts"

[assets]
not_found_handling = "single-page-application"

[[durable_objects.bindings]]
name = "DesignAgent"
class_name = "DesignAgent"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DesignAgent"]
```

Key changes from the starter:
- Added `compatibility_flags = ["nodejs_compat"]` (required for the Agents SDK and AI SDK)
- Added `[[durable_objects.bindings]]` to bind the `DesignAgent` class (the binding name must match the class name so `routeAgentRequest` can find it)
- Added `[[migrations]]` to create SQLite storage for the Durable Object

### `src/worker.ts` (modified)

Update the Worker to use `routeAgentRequest` from the Agents SDK:

```ts
import { DesignAgent } from "./agent";
import { routeAgentRequest } from "agents";

export { DesignAgent };

interface Env {
  DesignAgent: DurableObjectNamespace;
  OPENAI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

This is much simpler than manually routing. `routeAgentRequest` inspects the request, finds the right Durable Object, and handles the WebSocket upgrade. If the request is not for an agent, it returns `null` and we fall through to a 404 (or the Vite plugin serves the React app).

We **re-export** `DesignAgent` so the Workers runtime can discover the Durable Object class.

### Verify it works

Start the dev server:

```bash
npm run dev
```

The server should start without errors. The agent is not connected to the chat UI yet (that is lesson 3), but the Durable Object is running and ready to accept connections.

### Try it out

Since `AIChatAgent` uses WebSocket (not plain HTTP), you cannot test it with curl. Instead, there is a small test script you can run in a separate terminal while the dev server is running:

```bash
npm run agent "draw a simple flowchart with 3 steps"
```

This connects to the agent over WebSocket, sends your message, and prints the raw streamed response. You will see the LLM's response chunks including any tool calls and their results. The output is raw protocol data, not pretty formatted, but it proves the agent is working.

Here is the script (`scripts/test-agent.mjs`):

```js
// Quick script to test the agent without the chat UI.
// Make sure `npm run dev` is running first, then:
//   npm run agent "draw a simple flowchart"

const message = process.argv.slice(2).join(" ") || "draw a rectangle";
const url = "ws://localhost:5173/agents/design-agent/test";

const ws = new WebSocket(url);
const requestId = crypto.randomUUID();

ws.addEventListener("open", () => {
  console.log(`Sending: "${message}"\n`);

  // AIChatAgent protocol: send a cf_agent_use_chat_request with
  // the messages in the init.body as JSON.
  const userMessage = {
    id: crypto.randomUUID(),
    role: "user",
    parts: [{ type: "text", text: message }],
  };

  ws.send(
    JSON.stringify({
      type: "cf_agent_use_chat_request",
      id: requestId,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [userMessage] }),
      },
    })
  );
});

ws.addEventListener("message", (event) => {
  const data = event.data;
  try {
    const parsed = JSON.parse(data);
    if (parsed.type === "cf_agent_use_chat_response" && parsed.id === requestId) {
      process.stdout.write(parsed.body);
      if (parsed.done) {
        console.log("\n");
        ws.close();
      }
    }
  } catch {
    process.stdout.write(data);
  }
});

ws.addEventListener("close", () => {
  process.exit(0);
});

ws.addEventListener("error", (err) => {
  console.error("WebSocket error:", err.message);
  console.error("Make sure `npm run dev` is running first.");
  process.exit(1);
});

setTimeout(() => {
  console.log("\n\nTimeout, closing.");
  ws.close();
  process.exit(0);
}, 60000);
```

Notice the URL pattern: `routeAgentRequest` automatically routes WebSocket connections at `/agents/{agent-name}/{instance-id}`. The agent class name `DesignAgent` becomes `design-agent` in the URL, and `test` is just an arbitrary instance name.

## What is Next

In the next lesson you will wire the chat UI to this agent. You will use the `useAgent` hook from the Agents SDK to establish a WebSocket connection, stream messages into the pre built chat components, and render the generated Excalidraw elements on the canvas. After lesson 3, the full loop will work: type in the chat, agent processes it, diagram appears on canvas.
