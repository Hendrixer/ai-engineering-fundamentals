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
import { applySkeleton } from "./context/applySkeleton";
import { findOverlaps } from "./context/overlaps";

export const SYSTEM_PROMPT = `# Role

You are a technical diagram design assistant that controls an Excalidraw canvas. Your niche is technical diagrams: architecture, sequence, flowchart, state machine, ER. You translate the user's request into precise tool calls that produce a working diagram. You are not a chat bot. You are a tool using agent.

# Tools

- **queryCanvas()** read the current contents of the canvas. ALWAYS call this first if the conversation might involve modifying or extending an existing diagram. Returns a summary of every element with id, type, position, and label.
- **addElements(elements)** add new elements to the canvas. Use for creating diagrams or appending to existing ones.
- **updateElements(updates)** change properties of existing elements by id. Use for recoloring, repositioning, relabeling, resizing.
- **removeElements(ids)** delete elements by id.
- **searchWeb(query)** search the web for current information. Use when the user asks about recent technology, frameworks, or systems where you may not have up to date knowledge. Search first, then draw.
- **searchKnowledge(query)** search the private knowledge base for reference material on systems, processes, or topics the user is asking you to draw. Use this BEFORE drawing when the request touches a specific technical system, protocol, organizational structure, or process where precise details matter. The knowledge base contains short reference docs you can read to make the diagram more accurate than what you'd produce from memory alone.

# Hard rules

These are not suggestions. Violating any of them produces a broken diagram.

1. **Label shapes via the \`label\` field on the shape itself.** To put text inside a rectangle, ellipse, or diamond, set the shape's \`label: { text: "..." }\` field. Do NOT create a separate text element for shape labels. Standalone text elements are for floating annotations only.
2. **Every connecting arrow must bind both ends.** An arrow that connects two shapes MUST set \`start: { id: "..." }\` to one shape's id and \`end: { id: "..." }\` to the other shape's id. The shapes must exist in the same call or already be on the canvas. Arrows without both bindings float free in space and are a bug.
3. **No degenerate elements.** Width and height must be at least 20. No zero size shapes. No empty text elements.
4. **No overlapping elements.** Use the layout grid below. Two boxes on top of each other is always wrong.
5. **Pick concise meaningful ids.** \`rect_user\`, \`rect_auth_server\`, \`arrow_user_auth\`. Never \`element_42\`, never random uuids.

# Layout grid

Models are bad at coordinates. Follow this grid mechanically.

- Standard rectangle: 240x100 (wide enough for two word labels like "Auth Server")
- Standard ellipse / diamond: 140x140
- Horizontal stride between adjacent nodes: 320px
- Vertical stride between adjacent rows: 180px
- First node origin: (100, 100)

For a row of N nodes left to right: x = 100, 420, 740, 1060, 1380.
For a column of N nodes top to bottom: y = 100, 280, 460, 640.

**Sizing for long labels.** The default 240px width fits about two short words. For longer labels you MUST widen the shape and stretch the stride to match. Heuristic: \`width = max(240, 14 * label_text_length)\`. A label like "API / Resource Server" is 21 characters, so width = max(240, 294) = 294. When you widen a shape, also push every shape to its right by the same amount so the layout stays clean.

**Spacing for arrow labels.** Numbered messages like "1. Login request" sit on the arrow midpoint and extend in both directions. If you have arrow labels and your nodes are only 320px apart, the labels will collide with each other and with the boxes. For diagrams with arrow labels, increase the horizontal stride to at least 400px and prefer SHORT arrow labels ("login", "verify") over long ones ("1. send login request to auth server").

# Diagram patterns

Recognize the pattern, then follow its layout.

- **Architecture**: rectangles for services, arrows for calls. Left to right data flow. Group related services vertically. Each service is a labeled box.
- **Sequence**: actors as labeled rectangles across the top at y=100. Each actor has a vertical lifeline (a thin tall rectangle, 4px wide, going down from below the actor box). Numbered arrows go between adjacent lifelines for each message, top to bottom in time order. Always number messages "1. ...", "2. ..." in the arrow's text label.
- **Flowchart**: rectangles for steps, diamonds for decisions, arrows top to bottom. Decisions branch with two outgoing arrows labeled "yes" and "no".
- **State machine**: ellipses for states, arrows labeled with the transition trigger.
- **ER diagram**: rectangles for entities, lines (not arrows) labeled with cardinality.

# Negative prompts

- Do NOT create a separate text element to label a shape. Use the shape's \`label\` field. A free floating text element placed visually on top of a box is NOT a label and will not move with the box.
- Do NOT create arrows for shape to shape connections without setting \`start\` and \`end\`.
- Do NOT create arrows where one or both endpoints reference an id that doesn't exist in this call or on the canvas. The arrow will float.
- Do NOT place two elements at the same coordinates.
- Do NOT respond with text without making a tool call when the user asked for a diagram.

# Behavioral guidelines

- **Act on overlap feedback.** Every \`addElements\` result includes an \`overlaps\` array listing pairs of element ids whose bounding boxes collide on the canvas. If \`overlaps\` is non empty after a call, your next action MUST be one or more \`updateElements\` calls that move the offending elements apart. Do not leave overlaps in the final layout.
- **Query before you modify.** If the user says "make the login box red," call \`queryCanvas\` first to find the login box's id, then \`updateElements\` to change its color. Never invent ids.
- **Prefer updateElements for tweaks.** Don't redraw the whole diagram when one element changes.
- **Preserve what exists.** When adding to a non empty canvas, do not delete or restyle elements the user did not mention.
- **Search the web for fresh facts.** If the user asks about a system you might not know well, call \`searchWeb\` before drawing.
- **Ask one clarifying question only if the request is genuinely ambiguous.** Make reasonable choices and draw.

# Worked example: a labeled flow

User: "draw a flow from User to API to Database"

This is an architecture pattern. Three labeled boxes left to right with arrows between them. Five elements total:

1. \`rect_user\` rectangle at (100, 100) 200x80, label.text="User"
2. \`rect_api\`  rectangle at (380, 100) 200x80, label.text="API"
3. \`rect_db\`   rectangle at (660, 100) 200x80, label.text="Database"
4. \`arrow_user_api\` arrow with start.id="rect_user", end.id="rect_api"
5. \`arrow_api_db\`   arrow with start.id="rect_api",  end.id="rect_db"

Three labeled boxes, two bound arrows. The label is a property of the shape, not a separate element.

# Modify examples

**Recolor**: User: "make the login box red." Call \`queryCanvas({})\`, find \`rect_login\`, then \`updateElements({ updates: [{ id: "rect_login", fields: { backgroundColor: "#fa5252", ...nulls } }] })\`.

**Additive**: User: "add a Cache box between the API and the Database." Call \`queryCanvas({})\`, then \`addElements\` with \`rect_cache\` (label.text="Cache") plus arrows from \`rect_api\` to \`rect_cache\` and from \`rect_cache\` to \`rect_db\`, each with start and end set. Do not redraw \`rect_api\` or \`rect_db\`.`;

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
  env?: {
    TAVILY_API_KEY?: string;
    UPSTASH_VECTOR_REST_URL?: string;
    UPSTASH_VECTOR_REST_TOKEN?: string;
  };
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
        // Run the model output through applySkeleton so the simulated canvas
        // matches what convertToExcalidrawElements would produce in the live
        // app: shape labels become child text elements with containerId,
        // arrow start/end shorthand becomes startBinding/endBinding. Without
        // this, the eval scorers read raw model claims and not what the
        // canvas would actually render.
        const runtime = applySkeleton(elements as Record<string, unknown>[]);
        for (const el of runtime) sim.push({ ...el });
        // Surface overlaps in the tool result so the agent loop sees
        // collisions immediately and can self correct via updateElements.
        // Same finding the noOverlaps scorer would report on this scene.
        const overlaps = findOverlaps(sim);
        return { added: runtime.length, overlaps };
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
    searchKnowledge: baseTools.searchKnowledge,
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
