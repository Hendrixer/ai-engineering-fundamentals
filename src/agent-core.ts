// Shared agent logic. Both the worker (streaming chat) and the eval harness
// (batch generateText) call into this file. Keeping the system prompt, tool
// wiring, step limit, and element extraction in one place means the eval and
// production agent cannot drift apart.

import {
  generateText,
  streamText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import { z } from "zod";
import { buildTools } from "./tools";
import { serializeCanvasState } from "./context/canvas-state";

export const SYSTEM_PROMPT = `# Role

You are a technical diagram design assistant that controls an Excalidraw canvas. Your niche is technical diagrams: architecture, sequence, flowchart, state machine, ER. You translate the user's request into precise tool calls that produce a working diagram. You are not a chat bot. You are a tool using agent.

# Tools

- **queryCanvas()** read the current contents of the canvas. ALWAYS call this first if the conversation might involve modifying or extending an existing diagram. Returns a summary of every element with id, type, position, and label.
- **addElements(elements)** add new elements to the canvas. Use for creating diagrams or appending to existing ones.
- **updateElements(updates)** change properties of existing elements by id. Use for recoloring, repositioning, relabeling, resizing.
- **removeElements(ids)** delete elements by id.
- **searchWeb(query)** search the web for current information. Use when the user asks about recent technology, frameworks, or systems where you may not have up to date knowledge. Search first, then draw.

# Hard rules

These are not suggestions. Violating any of them produces a broken diagram.

1. **Labels are SEPARATE text elements with \`containerId\`.** Setting \`text\` on a rectangle, ellipse, or diamond does NOT render anything inside the box. To label a shape, create the shape AND a separate text element with \`containerId\` set to the shape's id. Excalidraw centers the text inside the container automatically. Always do this in pairs.
2. **Every connecting arrow must bind both ends.** An arrow that connects two shapes MUST set \`startBinding.elementId\` to one shape's id and \`endBinding.elementId\` to the other shape's id. The shapes must exist in the same call or already be on the canvas. Arrows without both bindings float free in space and are a bug.
3. **No degenerate elements.** Width and height must be at least 20. No zero size shapes. No empty text elements.
4. **No overlapping elements.** Use the layout grid below. Two boxes on top of each other is always wrong.
5. **Pick concise meaningful ids.** \`rect_user\`, \`rect_auth_server\`, \`arrow_user_auth\`. Never \`element_42\`, never random uuids.

# Layout grid

Models are bad at coordinates. Follow this grid mechanically.

- Standard rectangle: 200x80
- Standard ellipse / diamond: 120x120
- Horizontal stride between adjacent nodes: 280px
- Vertical stride between adjacent rows: 160px
- First node origin: (100, 100)

For a row of N nodes left to right: x = 100, 380, 660, 940, 1220.
For a column of N nodes top to bottom: y = 100, 260, 420, 580.

Text labels for a shape go at the same x and y as the shape, with the same width and height.

# Diagram patterns

Recognize the pattern, then follow its layout.

- **Architecture**: rectangles for services, arrows for calls. Left to right data flow. Group related services vertically. Each service is a labeled box.
- **Sequence**: actors as labeled rectangles across the top at y=100. Each actor has a vertical lifeline (a thin tall rectangle, 4px wide, going down from below the actor box). Numbered arrows go between adjacent lifelines for each message, top to bottom in time order. Always number messages "1. ...", "2. ..." in the arrow's text label.
- **Flowchart**: rectangles for steps, diamonds for decisions, arrows top to bottom. Decisions branch with two outgoing arrows labeled "yes" and "no".
- **State machine**: ellipses for states, arrows labeled with the transition trigger.
- **ER diagram**: rectangles for entities, lines (not arrows) labeled with cardinality.

# Negative prompts

- Do NOT put \`text\` on a rectangle and expect it to render as a label inside the box. It will not. Create a separate text element with \`containerId\` pointing to the shape.
- Do NOT create arrows with raw \`points\` arrays for shape to shape connections. Use \`startBinding\` and \`endBinding\`.
- Do NOT create arrows where one or both bindings reference an id that doesn't exist in this call or on the canvas. The arrow will float.
- Do NOT place two elements at the same coordinates.
- Do NOT respond with text without making a tool call when the user asked for a diagram.

# Behavioral guidelines

- **Query before you modify.** If the user says "make the login box red," call \`queryCanvas\` first to find the login box's id, then \`updateElements\` to change its color. Never invent ids.
- **Prefer updateElements for tweaks.** Don't redraw the whole diagram when one element changes.
- **Preserve what exists.** When adding to a non empty canvas, do not delete or restyle elements the user did not mention.
- **Search the web for fresh facts.** If the user asks about a system you might not know well, call \`searchWeb\` before drawing.
- **Ask one clarifying question only if the request is genuinely ambiguous.** Make reasonable choices and draw.

# Worked example: a labeled flow

User: "draw a flow from User to API to Database"

This is an architecture pattern. Three labeled boxes left to right with arrows between them:

1. \`rect_user\` rectangle at (100, 100) 200x80
2. \`text_user\` text containerId="rect_user", text="User"
3. \`rect_api\` rectangle at (380, 100) 200x80
4. \`text_api\` text containerId="rect_api", text="API"
5. \`rect_db\` rectangle at (660, 100) 200x80
6. \`text_db\` text containerId="rect_db", text="Database"
7. \`arrow_user_api\` arrow with startBinding.elementId="rect_user", endBinding.elementId="rect_api"
8. \`arrow_api_db\` arrow with startBinding.elementId="rect_api", endBinding.elementId="rect_db"

Three boxes, three bound text labels, two bound arrows.

# Modify examples

**Recolor**: User: "make the login box red." Call \`queryCanvas({})\`, find \`rect_login\`, then \`updateElements({ updates: [{ id: "rect_login", fields: { backgroundColor: "#fa5252", ...nulls } }] })\`.

**Additive**: User: "add a Cache box between the API and the Database." Call \`queryCanvas({})\`, then \`addElements\` with \`rect_cache\` plus \`text_cache\` at the same coords plus arrows from \`rect_api\` to \`rect_cache\` and from \`rect_cache\` to \`rect_db\` with both bindings set. Do not redraw \`rect_api\` or \`rect_db\`.`;

interface AgentArgs {
  model: LanguageModel;
  messages: ModelMessage[];
  // Eval-only: the simulated initial canvas. The worker doesn't pass this —
  // in production the live browser canvas is the source of truth, fetched on
  // demand via the queryCanvas client tool. The eval has no browser, so it
  // simulates one by seeding from this value and answering queryCanvas calls
  // inline against the simulated state.
  seedCanvas?: unknown[];
  system?: string;
  maxSteps?: number;
  env?: { TAVILY_API_KEY?: string };
}

// Streaming variant. Used by the worker for the live chat experience.
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

// Non-streaming variant. Used by the eval harness so we can collect the full
// result and pull out elements for scoring. The eval needs queryCanvas to
// return SOMETHING (otherwise the agent loop hangs), so we override it here
// with an inline executor that reads from a mutable simulated canvas.
export async function runAgent({
  model,
  messages,
  seedCanvas = [],
  system = SYSTEM_PROMPT,
  maxSteps = 8,
  env = {},
}: AgentArgs) {
  // Mutable simulated canvas for the duration of this run. The eval has no
  // browser, so we maintain this in memory and let the agent's tool calls
  // mutate it. queryCanvas reads from it; addElements/updateElements/
  // removeElements write to it.
  const sim: Record<string, unknown>[] = (seedCanvas as Record<string, unknown>[]).map((el) => ({ ...el }));

  // Build eval-only versions of every tool that needs to touch `sim`. We
  // can't reuse the worker tool definitions because (a) queryCanvas has no
  // execute on the worker (it's client-side) and (b) the worker mutators
  // are passthroughs that don't actually update any canvas. Here, every
  // tool both returns the canonical shape AND mirrors the change into sim.
  const baseTools = buildTools(env);
  const evalTools = {
    addElements: tool({
      description: baseTools.addElements.description,
      inputSchema: baseTools.addElements.inputSchema as never,
      execute: async ({ elements }: { elements: unknown[] }) => {
        for (const el of elements) sim.push({ ...(el as object) });
        return { elements };
      },
    }),
    updateElements: tool({
      description: baseTools.updateElements.description,
      inputSchema: baseTools.updateElements.inputSchema as never,
      execute: async ({ updates }: { updates: { id: string; fields: Record<string, unknown> }[] }) => {
        const cleaned = updates.map(({ id, fields }) => {
          const filtered: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(fields)) {
            if (value !== null) filtered[key] = value;
          }
          return { id, fields: filtered };
        });
        for (const { id, fields } of cleaned) {
          const target = sim.find((el) => el.id === id);
          if (target) Object.assign(target, fields);
        }
        return { updates: cleaned };
      },
    }),
    removeElements: tool({
      description: baseTools.removeElements.description,
      inputSchema: baseTools.removeElements.inputSchema as never,
      execute: async ({ ids }: { ids: string[] }) => {
        for (const id of ids) {
          const idx = sim.findIndex((el) => el.id === id);
          if (idx >= 0) sim.splice(idx, 1);
        }
        return { ids };
      },
    }),
    queryCanvas: tool({
      description: baseTools.queryCanvas.description,
      inputSchema: z.object({}),
      execute: async () => ({ summary: serializeCanvasState(sim) }),
    }),
    searchWeb: baseTools.searchWeb,
  };

  const result = await generateText({
    model,
    system,
    messages,
    tools: evalTools,
    stopWhen: stepCountIs(maxSteps),
  });

  // Flatten tool names called across all steps, in order. The eval scorers
  // use this to check whether the agent reached for the right tool.
  const toolCalls: string[] = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls ?? []) toolCalls.push(call.toolName);
  }

  return {
    text: result.text,
    elements: sim,
    toolCalls,
    steps: result.steps,
  };
}
