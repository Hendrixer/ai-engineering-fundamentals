# AI Engineering Fundamentals

A hands-on workshop where you build an agentic diagram design tool, then learn to evaluate and improve it using professional AI engineering practices.

You build a Cloudflare Workers agent that controls an Excalidraw canvas through tool calls. Then you measure it with evals, and across the rest of the course you systematically improve it (context engineering, better tools, RAG, generative UI, human-in-the-loop, planning, data flywheel) and watch the eval scores move.

![The diagram design tool](./assets/screenshot.png)

## What you'll build

A live diagramming agent that:

- Reads natural language requests ("draw a sequence diagram of an OAuth login")
- Controls an Excalidraw canvas via structured tool calls (add/update/remove elements)
- Reads the live canvas state on demand
- Searches the web for fresh information when it needs to
- Searches a private knowledge corpus via RAG when it needs precise reference material
- Streams responses, shows tool status, handles approvals, and gets better at all of this as you measure it

By the end you have a working agent and the discipline to evaluate and improve any agent you build next.

## How the course is organized

Each lesson is its own git branch. The branch sequence is:

```
lesson-1 → lesson-2 → ... → lesson-9 (latest)
```

Each lesson branch contains:

- The solution for the previous lesson (so you can catch up if you fall behind)
- The notes for the current lesson under `lessons/<lesson-name>/index.md`

There are also two convenience branches:

- **`main`** — points at the latest lesson so far. This is what you see when you land on the GitHub page.
- **`complete`** — same as `main`, an explicit name for "everything that exists right now."

So if you fall behind in lesson 5, you can `git checkout lesson-6` to grab the lesson 5 solution and pick up from there. If you want to see everything, `git checkout complete`.

### Lesson notes

Notes live alongside the code under `lessons/`:

```
lessons/
  01-intro-to-ai-engineering/
    index.md
  02-your-first-cloudflare-agent/
    index.md
  ...
```

You can read them three ways:

- **Directly on GitHub or in your editor** — they're plain markdown.
- **In Obsidian** — open the `lessons/` directory as a vault.
- **As a local site** — run `npm run docs` to serve them with VitePress at http://localhost:5173.

## Setup

### 1. Clone and install

```bash
git clone <this repo url>
cd intro-ai-engineering
npm install
```

### 2. Create accounts

You need accounts at four services. Three are free with no credit card. One needs a credit card but the costs for this course are pennies.

| Service | Why | Cost | Credit card required? |
|---|---|---|---|
| **OpenAI** | LLM provider for the agent | A few cents for the whole course | **Yes** |
| **Upstash Vector** | Vector store for RAG (lesson 8) | Free tier, very generous | No |
| **Braintrust** | Eval platform (lessons 4+) | Free tier | No |
| **Tavily** | Web search API for the agent's `searchWeb` tool (lesson 7) | Free tier, 1000 searches/month | No |

#### OpenAI

1. Sign up at [platform.openai.com](https://platform.openai.com).
2. Add a payment method. The course costs pennies but OpenAI requires a card on file before issuing API keys.
3. Create an API key under **API keys**. Save it for the next step.

#### Upstash Vector

1. Sign up at [upstash.com](https://upstash.com). No credit card needed.
2. Go to **Vector** in the console and click **Create Index**.
3. Pick any embedding model from the dropdown — `mixedbread-ai/mxbai-embed-large-v1` is a good default. The model is hosted by Upstash, which is what lets the embed script and the agent skip the embedding step entirely.
4. Pick a region close to you. Free tier is fine.
5. After creation, the index page shows `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN`. Save both.

#### Braintrust

1. Sign up at [braintrust.dev](https://braintrust.dev). No credit card needed.
2. Create an API key from settings. Save it.

#### Tavily

1. Sign up at [tavily.com](https://tavily.com). No credit card needed.
2. Get your API key from the dashboard. Save it.

### 3. Configure environment variables

Create `.dev.vars` at the project root:

```
OPENAI_API_KEY=sk-...
UPSTASH_VECTOR_REST_URL=https://...upstash.io
UPSTASH_VECTOR_REST_TOKEN=...
BRAINTRUST_API_KEY=sk-...
TAVILY_API_KEY=tvly-...
```

The Worker reads from this file via `wrangler dev` automatically. Node scripts (`npm run embed`, `npm run eval`) read it via `dotenv-cli`.

### 4. Run things

```bash
npm run dev      # start the app at http://localhost:5173 (or 5174/5175 if 5173 is taken)
npm run docs     # serve the lesson notes locally
npm run embed    # rebuild the RAG vector index from data/corpus/ (lesson 8+)
npm run eval     # run the eval suite (lesson 4+)
```

The first time you start a lesson that introduces a new service, the relevant lesson notes will tell you when to use these commands.

## Using the lessons

Recommended flow:

1. **Watch / read the lesson talk first.** The notes have a theory section at the top.
2. **Live-code along.** The notes contain the full code for every change in fenced code blocks. You can copy / paste if you fall behind.
3. **Run it.** Each lesson has a clear "this is what success looks like" moment — a working chat, an eval score, a new tool call in the trace.
4. **Move to the next branch when you're ready.** `git checkout lesson-N+1`.

If you get stuck, the next branch contains the previous lesson's solution. So if lesson 5 isn't compiling for you, `git checkout lesson-6`, look at the working state, then go back to lesson-5 and figure out the diff.

## Tech stack

- **Runtime**: Node + Cloudflare Workers (local via `wrangler dev`, no deployment needed)
- **Frontend**: Vite + React + Excalidraw
- **Agent**: AI SDK + Cloudflare Agents SDK (Durable Objects, `useAgentChat`)
- **Vector store**: Upstash Vector (lesson 8+)
- **Evals**: Braintrust (lesson 4+)
- **Web search**: Tavily (lesson 7+)

Everything runs locally. No deployment, no production cloud infrastructure.

## Getting help

- The lesson notes have full code blocks, so any time you're stuck, the answer is probably in the next branch's notes.
- Issues with the course material → open a GitHub issue.
