# Intro to AI Engineering

Welcome to AI Engineering Fundamentals. In this course you will build an intelligent diagram design tool by adding an AI agent to an Excalidraw canvas. Along the way you will learn the professional discipline of building, evaluating, and improving AI powered systems.

This first lesson is about understanding what an AI Engineer does, orienting yourself in the codebase, and getting your environment set up so you are ready to start building.

## What We Are Building

We are building an **AI powered diagram design tool**. You start with a fully functional Excalidraw canvas and a chat sidebar. Over the course of 12 lessons, you will turn that chat sidebar into an intelligent agent that can create, modify, and reason about diagrams on the canvas.

The app is built on **Cloudflare Workers** with the **Agents SDK** for the backend, and **React** with **Excalidraw** for the frontend. Everything runs locally on your machine. No deployment or cloud account needed.

Here is the progression:

1. **Lessons 1 through 5**: Build the agent, wire up the chat, and establish evals so you have a working baseline to improve against
2. **Lessons 6 through 12**: Systematically improve the agent using context engineering, better tools, RAG, generative UI, human in the loop flows, planning mode, and data flywheels. Every improvement is measured with evals.

By the end you will have a working agentic application AND the professional discipline to keep improving it.

## How This Course Works

### Branches

Each lesson has its own git branch. The branch for lesson N contains the completed solution for lesson N minus one. So if you fall behind or get stuck, you can always check out the next lesson's branch to catch up:

```bash
# If you're stuck on lesson 3, jump to the lesson 4 branch
# which has the lesson 3 solution already done
git checkout lesson-4
npm install
```

The `main` branch contains the final version with all lessons completed.

### Using AI to Help You

Each lesson includes markdown notes (like the one you are reading now) with all the theory and complete code blocks for every change. You can use these notes together with a coding agent like Claude Code, Cursor, or Copilot to help you work through the exercises.

For example, you could paste the lesson notes into your agent and say "help me implement this lesson" or point it at the specific code blocks you are stuck on. The notes are written to be both human readable and useful as context for an AI coding assistant.

You can also run `npm run docs` to view these notes as a formatted website locally.

## What is an AI Engineer?

An AI Engineer is a **system builder**. You take foundation models (like Claude, GPT, etc.) and turn them into dependable product features. This is different from ML Engineering, where the focus is on training models, managing datasets, and optimizing model performance. As an AI Engineer, you treat the model as a given and focus on everything around it:

- **Context engineering**: curating exactly the right tokens to send to the model at inference time
- **Tool design**: giving the model the right capabilities to take actions in the world
- **Evaluation**: building automated test suites that measure whether the system is getting better or worse
- **Production reliability**: handling errors, managing costs, dealing with latency, and shipping to real users

Think of it this way: an ML Engineer builds the engine. An AI Engineer builds the car around it.

In 2026, roughly 70% of AI Engineer job postings center on four skills: RAG, evals, agents, and production deployment. This course covers all of them.

## 12 Factor Agents

The [12 Factor Agents](https://github.com/humanlayer/12-factor-agents) framework provides a set of principles for building reliable AI agents. Here are the key ideas:

1. **Natural language is the universal interface** between models, tools, and humans
2. **Own your prompts** rather than hiding them behind abstractions
3. **Tools are just functions** with clear schemas the model can call
4. **Own your control flow** rather than handing it entirely to the model
5. **Keep small, focused agents** instead of one giant agent that does everything
6. **Unify your context** so every piece of information the model needs is in one place
7. **Let the model handle ambiguity** but keep humans in the loop for high stakes decisions
8. **Compact your context** to stay within token budgets without losing critical information
9. **Use evals** as your test suite because unit tests alone cannot catch AI regressions
10. **Build for observability** so you can see what the model is doing and why
11. **Fail gracefully** with fallbacks and error boundaries
12. **Deploy progressively** and measure the impact of each change

We will touch on many of these throughout the course. The most important takeaway: **an agent is just a program**. It has inputs, outputs, and a control flow that you design. The model is a powerful component inside that program, but you are the architect.

## The Build, Eval, Improve Loop

This course is structured around a simple loop:

```
Build → Eval → Improve → Eval → Improve → ...
```

The first half of the course is about building and measuring. You will create the agent, wire up the chat interface, write a golden dataset of test cases, and build automated scorers. By the end of that phase you will have a working agent AND a baseline eval score.

The second half is about systematic improvement. Each lesson applies one technique (context engineering, better tools, RAG, etc.), then runs evals to measure the impact. Every change is measured. This is the professional workflow: you never ship an improvement you have not evaluated.

The reason this matters is that AI systems are probabilistic. The same input can produce different outputs. You cannot just "eyeball it" and ship. Evals are your test suite, your regression detector, and your proof that things are getting better.

## Project Structure Tour

Here is what the codebase looks like and what each piece does:

```
├── src/
│   ├── main.tsx              # React entry point
│   ├── App.tsx               # Root component, layout
│   ├── App.css               # Layout styles
│   ├── index.css             # Global styles, fonts
│   ├── worker.ts             # Cloudflare Worker entry point
│   ├── components/
│   │   ├── Canvas.tsx         # Excalidraw wrapper
│   │   ├── chat/              # Chat panel components
│   │   ├── streaming/         # Streaming text, tool status
│   │   └── hitl/              # Human in the loop components
├── lessons/                   # Course notes (you are here)
├── evals/                     # Eval dataset (golden.json is pre populated, scorers added in lesson 5)
├── wrangler.toml              # Cloudflare Workers config
├── vite.config.ts             # Vite + Cloudflare plugin config
├── package.json               # Dependencies and scripts
└── .dev.vars.example          # Environment variable template
```

### Key files to understand

**`vite.config.ts`** ties together the React frontend and the Cloudflare Worker backend using the `@cloudflare/vite-plugin`. One `npm run dev` command starts everything:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
});
```

**`wrangler.toml`** configures the Cloudflare Worker. Right now it just serves the React app as a single page application. In lesson 2 we will add Durable Object bindings for the agent:

```toml
name = "ai-design-tool"
compatibility_date = "2025-04-01"
main = "./src/worker.ts"

[assets]
not_found_handling = "single-page-application"
```

**`src/worker.ts`** is the Worker entry point. Currently minimal, it just returns 404 for any API routes (the Vite plugin handles serving the React app). This is where the agent will live starting in lesson 2:

```ts
export default {
  fetch(_request: Request, _env: Env) {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface Env {}
```

**`src/App.tsx`** is the root React component. It renders the Excalidraw canvas and the chat sidebar. It holds a reference to the Excalidraw API (which the agent will use to draw on the canvas) and syncs the theme between Excalidraw and the chat panel:

```tsx
import { useState, useCallback } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import Canvas from "./components/Canvas";
import ChatPanel from "./components/chat/ChatPanel";
import "./App.css";

export default function App() {
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const handleApiReady = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawAPI(api);
  }, []);

  return (
    <div className={`app ${theme}`}>
      <div className="canvas-container">
        <Canvas onApiReady={handleApiReady} onThemeChange={setTheme} />
      </div>
      <ChatPanel />
    </div>
  );
}
```

**`src/components/Canvas.tsx`** wraps the Excalidraw React component. It exposes the Excalidraw API via a callback and listens for theme changes so the rest of the app can follow along:

```tsx
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import { useRef, useCallback } from "react";

interface CanvasProps {
  onApiReady?: (api: ExcalidrawImperativeAPI) => void;
  onThemeChange?: (theme: "light" | "dark") => void;
}

export default function Canvas({ onApiReady, onThemeChange }: CanvasProps) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastTheme = useRef<string>("light");

  const handleMount = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      onApiReady?.(api);
    },
    [onApiReady]
  );

  const handleChange = useCallback(
    (_elements: readonly any[], appState: AppState) => {
      if (appState.theme !== lastTheme.current) {
        lastTheme.current = appState.theme;
        onThemeChange?.(appState.theme as "light" | "dark");
      }
    },
    [onThemeChange]
  );

  return (
    <div className="canvas-wrapper">
      <Excalidraw
        excalidrawAPI={handleMount}
        initialData={{ appState: { openSidebar: null } }}
        onChange={handleChange}
      />
    </div>
  );
}
```

**`src/components/chat/ChatPanel.tsx`** is the chat sidebar. Right now it renders an empty message list and an input that does nothing. In lesson 3 we will wire this up to the agent:

```tsx
import { useState } from "react";
import MessageList from "./MessageList";
import type { Message } from "./types";
import "./chat.css";

export default function ChatPanel() {
  const [messages] = useState<Message[]>([]);
  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Non-functional — wired up in lesson 3
  };

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
        />
        <button type="submit" className="chat-send-btn">
          Send
        </button>
      </form>
    </div>
  );
}
```

### The component library

The `src/components/` directory also includes pre built components you will use throughout the course. You do not need to understand these now, just know they exist:

- **`streaming/StreamingText.tsx`** renders text as it arrives chunk by chunk (used in lesson 3)
- **`streaming/ToolStatus.tsx`** shows tool call progress like "Drawing flowchart..." (used in lesson 3)
- **`hitl/ConfirmationCard.tsx`** shows approve/reject buttons for destructive actions (used in lesson 10)
- **`hitl/ApprovalStatus.tsx`** displays whether an action is pending, approved, or rejected (used in lesson 10)

## Environment Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set up your API key

Copy the example environment file and add your OpenAI API key:

```bash
cp .dev.vars.example .dev.vars
```

Then open `.dev.vars` and replace the placeholder with your actual key:

```
OPENAI_API_KEY=sk-your-openai-key-here
```

You can get an API key at [platform.openai.com](https://platform.openai.com).

### 3. Start the development server

```bash
npm run dev
```

This starts the Vite dev server with the Cloudflare Worker running locally. Open [http://localhost:5173](http://localhost:5173) in your browser.

### 4. Verify everything works

You should see:
- An Excalidraw canvas taking up most of the screen
- A chat sidebar on the right with a "Describe a diagram..." input
- The Excalidraw toolbar at the top (shapes, arrows, text, etc.)
- You can draw on the canvas manually
- The chat input does nothing yet (that is coming in lesson 3)

Try toggling dark mode from the Excalidraw menu (hamburger icon in the top left). The chat sidebar should follow the theme.

### 5. View the course notes (optional)

You can view these notes as a formatted site:

```bash
npm run docs
```

This starts a VitePress dev server. Or just read the markdown files directly in your editor.

## What is Next

In the next lesson you will build your first Cloudflare Agent. You will create an agent class using the Agents SDK, define Excalidraw element schemas, and build your first tools that let the agent draw on the canvas. The chat will not be wired up yet (that is lesson 3), but by the end of lesson 2 you will have a working agent that can receive messages and return diagram data.
