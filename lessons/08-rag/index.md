# RAG

Lesson 7 gave the agent better tools, but it still has no domain knowledge. Ask it to draw an ER diagram and it draws *something*, but the cardinality notation is whatever the model happened to remember from training. Ask for an AWS architecture and you get the model's average idea of one — sometimes good, sometimes off by a layer.

This lesson adds a small private knowledge base — six markdown files describing common diagram patterns — and gives the agent one new tool that searches it. The tool returns the matching documents as text, the agent reads them, and the next call to `addElements` is informed by the actual content of those documents instead of training-data averages.

That's the whole pattern. RAG (Retrieval Augmented Generation) is exactly that: fetch relevant documents at request time and feed them to the model as context. The "retrieval" is just a vector similarity search. The "augmentation" is just appending the result to a tool response.

## Three patterns for getting information into the model

We've now built all three:

| Pattern | Where it lives | When the model sees it | Use when |
|---|---|---|---|
| **Context** (lesson 6) | System prompt | Every turn | Facts you ALWAYS need (canvas state, role) |
| **Tool** (lesson 7 — `searchWeb`) | Tool execute hits external API | When the model decides to call | Public web facts |
| **RAG** (this lesson — `searchKnowledge`) | Tool execute hits your private vector store | When the model decides to call | Private corpus the model doesn't know |

RAG is the same shape as `searchWeb` from lesson 7. The difference is the data source: instead of Tavily's index of the web, it's a vector index of *your own documents*. Same on-demand pattern, same factory function, same result shape. If you understood `searchWeb`, you already understand RAG mechanically. The only new piece is the vector store.

## Why not local SQLite

The original plan was to use SQLite with `sqlite-vec` so everything ran locally. That doesn't work: Cloudflare Workers cannot run native SQLite extensions, and the embed script (Node-side) and the agent tool (Worker-side) need to share the same store. Two paths to fix that:

1. **Cloudflare Vectorize.** Local mode is shallow (no real ANN), and the embed script can't use the binding anyway — it would have to hit Vectorize over REST, requiring a configured Cloudflare account. Same friction we were trying to avoid.
2. **Hosted vector store with a REST API.** Free tier, no infra, identical client from Node and the Worker.

We pick option 2 with [Upstash Vector](https://upstash.com/docs/vector). Free, no credit card, two env vars. The client (`@upstash/vector`) works the same in Node and in Workers.

### Bonus: Upstash hosts the embedding model

When you create the index on the Upstash dashboard, you pick an embedding model from a dropdown. After that, the SDK accepts raw text on both write (`upsert`) and read (`query`) — Upstash embeds it server-side. We never call an embedding API ourselves. This trims an entire step out of the lesson and removes one credential.

The trade-off: you don't see the explicit "call OpenAI to embed, then send the vector to the store" two-step that production RAG systems usually have. The mental model is the same; the SDK just collapses it into one call. If you swap providers later, you'd add the explicit embedding call back in.

## Setup: create the index

1. Sign up at upstash.com, go to the Vector tab.
2. Create an index. Pick any embedding model — `mixedbread-ai/mxbai-embed-large-v1` is a good default. Pick the default region.
3. From the index page, copy `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` into your `.dev.vars`:

```
UPSTASH_VECTOR_REST_URL=https://...upstash.io
UPSTASH_VECTOR_REST_TOKEN=...
```

Install the client:

```bash
npm install @upstash/vector
```

## 1. The vector store wrapper

One file that owns the env-var contract. Both the embed script and the agent tool import it.

`src/rag/vector-store.ts`:

```ts
import { Index } from "@upstash/vector";

export interface VectorEnv {
  UPSTASH_VECTOR_REST_URL?: string;
  UPSTASH_VECTOR_REST_TOKEN?: string;
}

export function getIndex(env: VectorEnv): Index {
  if (!env.UPSTASH_VECTOR_REST_URL || !env.UPSTASH_VECTOR_REST_TOKEN) {
    throw new Error(
      "Upstash Vector is not configured: set UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN"
    );
  }
  return new Index({
    url: env.UPSTASH_VECTOR_REST_URL,
    token: env.UPSTASH_VECTOR_REST_TOKEN,
  });
}
```

Nothing clever. The point of pulling this into its own file is to keep the env-var names in exactly one place. If we want to swap providers later, this is the single file we change.

## 2. The corpus

Six markdown files under `data/corpus/`, one per topic, 200–500 words each:

```
data/corpus/
  cloudflare-workers-request-lifecycle.md
  oauth-authorization-code-flow.md
  kubernetes-pod-networking.md
  postgres-write-path.md
  startup-org-structure.md
  general-best-practices.md
```

A deliberate mix of *subject-matter* documents (specific systems and processes the agent might be asked to draw) and one *meta* document (general drawing best practices that apply to anything). The first version of the corpus was six "how to draw a flowchart / sequence diagram / ER diagram" docs. That's the wrong move: the model already knows roughly how those diagram types work, so retrieving "here's how ER diagrams work" adds no signal. Retrieval only earns its keep when it surfaces something the model *doesn't* already know precisely — like the exact sequence of an OAuth code exchange with PKCE, or which Postgres process flushes the WAL.

The point is that these are *your own* documents. The agent only knows what you put here. Think of the corpus as the institutional knowledge you want the agent to lean on — internal architecture, your company's processes, specific integrations, compliance rules, anything that isn't in training data.

A note on document length: at 200–500 words, document-level embedding is fine. Longer documents would need chunking (split into 200–500 word chunks before embedding, embed each chunk separately). For a workshop the right answer is to keep documents short and skip chunking entirely.

## 3. The embed script

A one-shot Node script. Run it with `npm run embed` after editing the corpus.

`src/rag/embed.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getIndex } from "./vector-store";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORPUS_DIR = join(__dirname, "..", "..", "data", "corpus");

async function main() {
  const index = getIndex({
    UPSTASH_VECTOR_REST_URL: process.env.UPSTASH_VECTOR_REST_URL,
    UPSTASH_VECTOR_REST_TOKEN: process.env.UPSTASH_VECTOR_REST_TOKEN,
  });

  console.log("Resetting index...");
  await index.reset();

  const entries = await readdir(CORPUS_DIR);
  const files = entries.filter((f) => f.endsWith(".md"));
  console.log(`Found ${files.length} corpus files in ${CORPUS_DIR}`);

  let ok = 0;
  let failed = 0;
  for (const file of files) {
    const id = parse(file).name;
    try {
      const content = await readFile(join(CORPUS_DIR, file), "utf8");
      await index.upsert({
        id,
        data: content,
        metadata: { source: file, content },
      });
      console.log(`  upserted ${id}`);
      ok++;
    } catch (err) {
      console.error(`  failed ${id}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`Done. ${ok} upserted, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

A few things to point out:

**Idempotency comes from `reset`, not from upsert dedup.** The script always starts with `index.reset()`, which drops every existing vector. Then it re-uploads everything from the corpus directory. Re-running the script always produces the same end state, regardless of how many times you've run it before. No "have I seen this id before" tracking, no diffing — just truncate and rebuild. For a small corpus this is by far the simplest approach.

**Per-file try/catch.** If one file fails to upsert, we log it and keep going. The script only exits non-zero at the end if anything failed. This matters when the corpus grows and one bad file shouldn't kill the whole pipeline.

**Why we pass `content` on metadata too.** Upstash's query response only returns metadata for matched results — the `data` field that was embedded is *not* echoed back. So we store the original content on `metadata.content` so the retrieval tool can return it to the agent.

**Run it via dotenv-cli.** The `npm run embed` script uses `dotenv -e .dev.vars -- tsx src/rag/embed.ts`. The Worker reads `.dev.vars` automatically; the Node script doesn't, so we use `dotenv-cli` to inject the same file.

Add this to `package.json`:

```json
"scripts": {
  "embed": "dotenv -e .dev.vars -- tsx src/rag/embed.ts"
}
```

Run it:

```bash
npm run embed
```

Expected output:

```
Resetting index...
Found 6 corpus files in /.../data/corpus
  upserted cloudflare-workers-request-lifecycle
  upserted general-best-practices
  upserted kubernetes-pod-networking
  upserted oauth-authorization-code-flow
  upserted postgres-write-path
  upserted startup-org-structure
Done. 6 upserted, 0 failed.
```

## 4. The retrieval tool

Same factory pattern as `searchWeb` from lesson 7 — the Upstash credentials come from request-scoped env, not from a top-level import. This is what lets the eval harness pass them through cleanly.

`src/tools/search-knowledge.ts`:

```ts
import { tool } from "ai";
import { z } from "zod";
import { getIndex, type VectorEnv } from "../rag/vector-store";

export function makeSearchKnowledge(env: VectorEnv) {
  return tool({
    description: `Search the private knowledge base for reference material on systems, processes, and topics the user might ask you to draw. Use this BEFORE drawing when the request touches a specific technical system, protocol, organizational structure, or process where precise details matter. The corpus contains short reference docs the model may not have memorized accurately.

Example: searchKnowledge({ query: "OAuth 2.0 authorization code flow with PKCE" })`,
    inputSchema: z.object({
      query: z.string().describe("Natural language query describing what you need to know"),
    }),
    execute: async ({ query }) => {
      try {
        const index = getIndex(env);
        const results = await index.query({
          data: query,
          topK: 3,
          includeMetadata: true,
        });
        return {
          results: results.map((r) => ({
            source: (r.metadata as { source?: string } | undefined)?.source ?? String(r.id),
            content: (r.metadata as { content?: string } | undefined)?.content ?? "",
            score: r.score,
          })),
        };
      } catch (err) {
        return { error: `Knowledge search failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
```

The whole tool is fifteen lines of real logic. It takes a query, hits the index with `topK: 3`, returns the matched documents with their similarity scores. The same error-as-return pattern from `searchWeb` — a network failure becomes `{ error: "..." }` and the agent decides what to do, not a thrown exception that kills the run.

**Why `topK: 3`.** Three results give the agent enough variety without overwhelming the context window. One result is too narrow (if the top match is wrong, the agent has nothing else). Five is too noisy on a six-document corpus. Three is the sweet spot for a small starter corpus.

## 5. Wiring

Three files change. First, `src/tools.ts` adds the new tool to `buildTools` and widens the env type:

```ts
import { addElements } from "./tools/add-elements";
import { removeElements } from "./tools/remove-elements";
import { updateElements } from "./tools/update-elements";
import { queryCanvas } from "./tools/query-canvas";
import { makeSearchWeb } from "./tools/search-web";
import { makeSearchKnowledge } from "./tools/search-knowledge";

export interface ToolEnv {
  TAVILY_API_KEY?: string;
  UPSTASH_VECTOR_REST_URL?: string;
  UPSTASH_VECTOR_REST_TOKEN?: string;
}

export function buildTools(env: ToolEnv) {
  return {
    addElements,
    removeElements,
    updateElements,
    queryCanvas,
    searchWeb: makeSearchWeb(env.TAVILY_API_KEY),
    searchKnowledge: makeSearchKnowledge(env),
  };
}
```

`src/agent.ts` widens its `Env` and forwards the new vars to `streamAgent`:

```ts
interface Env extends Cloudflare.Env {
  OPENAI_API_KEY: string;
  TAVILY_API_KEY: string;
  UPSTASH_VECTOR_REST_URL: string;
  UPSTASH_VECTOR_REST_TOKEN: string;
}

export class DesignAgent extends AIChatAgent<Env> {
  async onChatMessage() {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai("gpt-5.4-mini");

    const allMessages = await convertToModelMessages(this.messages);
    const messages = await compactHistory(allMessages, { model });

    const result = streamAgent({
      model,
      messages,
      env: {
        TAVILY_API_KEY: this.env.TAVILY_API_KEY,
        UPSTASH_VECTOR_REST_URL: this.env.UPSTASH_VECTOR_REST_URL,
        UPSTASH_VECTOR_REST_TOKEN: this.env.UPSTASH_VECTOR_REST_TOKEN,
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
```

`src/agent-core.ts` widens its `AgentArgs.env`, adds a system prompt bullet, and adds `searchKnowledge` to `evalTools` as a passthrough:

```ts
// in SYSTEM_PROMPT, in the Tools section:
- **searchKnowledge(query)** — search the private knowledge base for reference material on systems, processes, or topics the user is asking you to draw. Use this BEFORE drawing when the request touches a specific technical system, protocol, organizational structure, or process where precise details matter. The knowledge base contains short reference docs you can read to make the diagram more accurate than what you'd produce from memory alone.
```

```ts
// AgentArgs.env type:
env?: {
  TAVILY_API_KEY?: string;
  UPSTASH_VECTOR_REST_URL?: string;
  UPSTASH_VECTOR_REST_TOKEN?: string;
};
```

```ts
// at the end of evalTools:
searchWeb: baseTools.searchWeb,
searchKnowledge: baseTools.searchKnowledge,
```

Note that `searchKnowledge` does NOT need a custom eval implementation. Unlike `addElements`, `updateElements`, `removeElements`, and `queryCanvas` (which all need to mutate or read the simulated `sim` array), `searchKnowledge` hits the real Upstash index — and the eval *should* hit the real index. The whole point of the eval is to measure whether RAG actually helps. Stubbing it would defeat the purpose.

## How it runs end-to-end

The user asks "draw a sequence diagram of an OAuth 2.0 login with PKCE."

1. Agent reads the system prompt. Sees the "use searchKnowledge BEFORE drawing when precise details matter" rule.
2. Agent calls `searchKnowledge({ query: "OAuth 2.0 authorization code flow with PKCE" })`.
3. The tool's execute function calls `index.query({ data: "...", topK: 3 })`. Upstash embeds the query server-side, runs ANN search, returns the three closest documents — almost certainly `oauth-authorization-code-flow.md` as the top hit, plus two weaker matches.
4. The tool returns those documents to the agent as text.
5. The agent now has explicit text in its context describing the verifier/challenge generation, the redirect hops through the user's browser, the code-for-token exchange with the verifier, and the bearer token call to the resource server. It uses those concrete details to construct the diagram.
6. Agent calls `addElements` with participants (User, Client App, Authorization Server, Resource Server), the message arrows in the right order, and accurate labels.

The key thing: step 3 happens *inside the agent loop*. The agent decides to call the tool, the tool result lands in the conversation, the next model turn sees it. No preprocessing, no document stuffed into the system prompt every turn. Pure on-demand.

The other key thing: without the corpus, the model might draw a 5-step OAuth flow with the verifier in the wrong place, or skip the redirect through the user entirely. Those are exactly the kinds of mistakes the model makes when it's working from a fuzzy training-data memory of OAuth instead of from a concrete document. The corpus sharpens the output where it matters.

## Eval

We don't change the eval dataset. The eval already uses `buildTools` via `evalTools`, so adding `searchKnowledge` exposes it to every existing case automatically. Cases that ask for specific diagram types should now score better because the agent has actual reference documents to consult instead of guessing.

If the score doesn't move, the corpus is the lever to pull, not the code. Add more documents, make existing documents more specific, or add documents covering the diagram types your eval cases ask about.

## Recap

- Added Upstash Vector as the store. One factory function (`getIndex`) hides the env-var contract.
- Six corpus markdown files under `data/corpus/` cover the diagram types the agent draws.
- `npm run embed` resets the index and re-uploads everything. Idempotent by truncation, not by dedup.
- One new tool (`searchKnowledge`) — same factory pattern as `searchWeb`. Wired into `buildTools` and `evalTools`.
- The agent calls the tool on demand when its system-prompt instructions say to.
- No new eval cases. Existing cases that ask for specific diagram types should score better automatically.

Lesson 9 picks up here and changes how the *agent's tool results* render in the chat — generative UI. Same agent loop, richer presentation.
