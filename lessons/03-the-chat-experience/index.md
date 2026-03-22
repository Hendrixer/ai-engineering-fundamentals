# The Chat Experience

In lesson 2 you built an agent that responds to messages over WebSocket and generates Excalidraw elements. In this lesson you wire that agent to the chat UI so users can type a message and watch a diagram appear on the canvas. After this lesson, the full loop works end to end.

## Connecting the UI

### useAgent and useAgentChat

The Cloudflare Agents SDK provides two React hooks that handle the entire WebSocket connection and chat protocol for you:

- `useAgent` from `agents/react` opens and manages the WebSocket connection to your agent Durable Object
- `useAgentChat` from `@cloudflare/ai-chat/react` sits on top of `useAgent` and gives you a familiar chat interface: a `messages` array, a `sendMessage` function, and a `status` string that tells you whether the agent is idle, submitted, streaming, or errored

You use them together:

```ts
const agent = useAgent({ agent: "design-agent" });
const { messages, sendMessage, status } = useAgentChat({ agent });
```

That is the entire connection layer. No manual WebSocket code, no message parsing, no reconnect logic. The hooks handle stream resumption, message persistence in the agent's SQLite storage, and the entire wire protocol.

### The AI SDK message protocol

`messages` is an array of **UIMessage** objects from the AI SDK. Each message has a `role` (`user` or `assistant`) and a `parts` array. Parts are the unit of streaming. The model produces them as it goes:

```ts
{
  id: "msg-1",
  role: "assistant",
  parts: [
    { type: "text", text: "Sure, here is your diagram." },
    { type: "tool-generateDiagram", state: "output-available", input: {...}, output: {...} }
  ]
}
```

Possible part types include:

- `text` — plain text from the model. Stream into a `<p>` or markdown renderer.
- `tool-<toolName>` — a tool call. Has a `state` field that goes from `input-streaming` → `input-available` → `output-available` (or `output-error`).
- `reasoning`, `file`, `source-url` — other part types we will not use here.

Rendering a UIMessage means iterating over its parts and choosing the right component for each type. That is exactly what `MessageBubble` does.

## Streaming Responses

Streaming is **already handled by the AI SDK and the AIChatAgent base class**. When the model emits tokens, they arrive as updates to existing parts in the messages array. React re-renders, and you see the text appear in real time.

This is one reason we picked AIChatAgent in lesson 2: streaming is essentially free. We did not have to write any chunk forwarding code, message parsing, or reconnect logic. The hooks and the agent base class handle it all.

## Tool Status

When the model decides to call a tool, a new part appears in the assistant's message with type `tool-generateDiagram` (or whatever the tool is named) and state `input-streaming`. As the tool input arrives, the state moves through `input-available`, then after execution, `output-available` or `output-error`.

Our pre built `ToolStatus` component takes a tool name and a status (`running`, `complete`, or `error`) and renders the right icon. We just need to map the AI SDK part state to our component's status:

```ts
const status =
  toolPart.state === "output-available" ? "complete"
  : toolPart.state === "output-error" ? "error"
  : "running";
```

## Canvas Integration

When a `tool-generateDiagram` part reaches the `output-available` state, its `output` field contains the elements the model generated. We need to apply them to the Excalidraw canvas via the API ref we set up in lesson 1.

Two gotchas:

1. **Excalidraw needs full element data.** Our agent generates simplified element shapes (just position, dimensions, colors, text). Excalidraw's internal scene wants additional fields like `seed`, `versionNonce`, `index`, etc. The library exports a helper called `convertToExcalidrawElements` that takes a skeleton element and fills in everything else.

2. **Apply each tool output once.** Messages re render every time a chunk arrives. If we naively apply the tool output every time the effect runs, we will replay the same diagram on every render. Track applied tool calls by `toolCallId` in a `useRef` Set.

The full pattern:

```ts
const appliedToolCalls = useRef<Set<string>>(new Set());

useEffect(() => {
  if (!excalidrawAPI) return;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (
        part.type === "tool-generateDiagram" &&
        part.state === "output-available" &&
        !appliedToolCalls.current.has(part.toolCallId)
      ) {
        appliedToolCalls.current.add(part.toolCallId);
        const elements = convertToExcalidrawElements(part.output.elements);
        excalidrawAPI.updateScene({ elements });
        excalidrawAPI.scrollToContent(elements, { fitToContent: true });
      }
    }
  }
}, [messages, excalidrawAPI]);
```

After `updateScene`, calling `scrollToContent` zooms and pans the canvas so the new elements are centered and visible.

## Building the Chat Experience

Here is everything that changes in this lesson.

### `src/components/chat/MessageList.tsx` (modified)

Update to take an array of `UIMessage` from the AI SDK:

```tsx
import type { UIMessage } from "ai";
import MessageBubble from "./MessageBubble";

interface MessageListProps {
  messages: UIMessage[];
}

export default function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="message-list empty">
        <p className="placeholder-text">
          Describe a diagram and the AI will create it for you.
        </p>
      </div>
    );
  }

  return (
    <div className="message-list">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </div>
  );
}
```

### `src/components/chat/MessageBubble.tsx` (modified)

Iterate over message parts and render each part with the right component:

```tsx
import type { UIMessage } from "ai";
import MarkdownRenderer from "./MarkdownRenderer";
import ToolStatus from "../streaming/ToolStatus";
import "../streaming/streaming.css";

interface MessageBubbleProps {
  message: UIMessage;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  return (
    <div className={`message-bubble ${message.role}`}>
      <div className="message-role">
        {message.role === "user" ? "You" : "Assistant"}
      </div>
      <div className="message-content">
        {message.parts?.map((part, i) => {
          // Plain text part
          if (part.type === "text") {
            if (message.role === "assistant") {
              return <MarkdownRenderer key={i} content={part.text} />;
            }
            return <p key={i}>{part.text}</p>;
          }

          // Tool call part: type is `tool-<toolName>` (e.g. tool-generateDiagram)
          if (part.type?.startsWith("tool-")) {
            const toolName = part.type.replace("tool-", "");
            const toolPart = part as { state?: string };
            const status =
              toolPart.state === "output-available"
                ? "complete"
                : toolPart.state === "output-error"
                  ? "error"
                  : "running";
            return <ToolStatus key={i} name={toolName} status={status} />;
          }

          return null;
        })}
      </div>
    </div>
  );
}
```

### `src/components/chat/ChatPanel.tsx` (modified)

The chat panel now takes `messages`, `sendMessage`, and `status` as props (from the hooks in App.tsx) and disables the input while the agent is responding:

```tsx
import { useState } from "react";
import type { UIMessage } from "ai";
import MessageList from "./MessageList";
import "./chat.css";

interface ChatPanelProps {
  messages: UIMessage[];
  sendMessage: (message: { role: "user"; parts: { type: "text"; text: string }[] }) => void;
  status: string;
}

export default function ChatPanel({
  messages,
  sendMessage,
  status,
}: ChatPanelProps) {
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: input }],
    });
    setInput("");
  };

  const isStreaming = status === "submitted" || status === "streaming";

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h2>Chat</h2>
      </div>
      <MessageList messages={messages} />
      <form className="chat-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="chat-input"
          placeholder="Describe a diagram..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={isStreaming}
        />
        <button
          type="submit"
          className="chat-send-btn"
          disabled={isStreaming || !input.trim()}
        >
          {isStreaming ? "..." : "Send"}
        </button>
      </form>
    </div>
  );
}
```

### `src/App.tsx` (modified)

Wire the hooks, watch messages for tool outputs, and apply them to the canvas:

```tsx
import { useState, useCallback, useEffect, useRef } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import Canvas from "./components/Canvas";
import ChatPanel from "./components/chat/ChatPanel";
import "./App.css";

export default function App() {
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Track which tool calls we have already applied to the canvas so we
  // don't apply the same elements twice as messages re-render.
  const appliedToolCalls = useRef<Set<string>>(new Set());

  const handleApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawAPI(api);
  }, []);

  // Connect to the agent Durable Object
  const agent = useAgent({ agent: "design-agent" });

  // useAgentChat manages the chat protocol on top of the agent connection.
  // It gives us the messages array, a sendMessage function, and a status.
  const { messages, sendMessage, status } = useAgentChat({ agent });

  // Watch messages for tool outputs and apply them to the canvas.
  useEffect(() => {
    if (!excalidrawAPI) return;

    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts ?? []) {
        if (
          part.type === "tool-generateDiagram" &&
          part.state === "output-available" &&
          !appliedToolCalls.current.has(part.toolCallId)
        ) {
          appliedToolCalls.current.add(part.toolCallId);
          const output = part.output as { elements?: unknown };
          const skeletonElements = output?.elements;
          if (Array.isArray(skeletonElements) && skeletonElements.length > 0) {
            // The agent returns simplified element shapes. Excalidraw needs
            // full element data (seed, versionNonce, etc.) which this helper
            // fills in from a skeleton.
            const elements = convertToExcalidrawElements(
              skeletonElements as any
            );
            excalidrawAPI.updateScene({ elements });
            excalidrawAPI.scrollToContent(elements, { fitToContent: true });
          }
        }
      }
    }
  }, [messages, excalidrawAPI]);

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
    </div>
  );
}
```

### tsconfig changes

The agent and tools now import from `agents` and `@cloudflare/ai-chat`, which expect the global `Cloudflare` namespace from `@cloudflare/workers-types`. Move the agent files into the worker tsconfig and exclude them from the app tsconfig:

`tsconfig.app.json`:
```json
"exclude": ["src/worker.ts", "src/agent.ts", "src/tools.ts"]
```

`tsconfig.worker.json`:
```json
"include": ["src/worker.ts", "src/agent.ts", "src/tools.ts", "src/schemas.ts"]
```

You also need to make the `Env` interface in `src/agent.ts` extend `Cloudflare.Env`:

```ts
interface Env extends Cloudflare.Env {
  OPENAI_API_KEY: string;
}
```

### Try it out

Start the dev server:

```bash
npm run dev
```

Open the app in your browser, type "draw a simple flowchart with three steps" in the chat, and hit Send. You should see:

1. Your message appear in the chat with a "You" label
2. An "Assistant" message with a `generateDiagram` tool status (spinner first, then checkmark)
3. The diagram appear on the canvas, centered and zoomed to fit

The full loop works.

## What is Next

In the next lesson you start the most important discipline in AI engineering: **evaluation**. You will write a golden dataset of test cases, build an eval harness that runs them through the agent, and score the outputs by hand to establish a baseline. This is the foundation for every improvement in the second half of the course.
