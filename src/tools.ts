import { tool } from "ai";
import { z } from "zod";

// Tool definitions using the AI SDK's tool() helper with Zod schemas.
// These are intentionally naive:
// - generateDiagram asks the LLM to produce ALL elements in one shot
// - modifyDiagram requires knowing element IDs
// Both weaknesses will show up in evals and get improved in later lessons.

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
      // Pass through. The LLM generates the elements, we just return them.
      return { elements };
    },
  }),

  modifyDiagram: tool({
    description:
      "Modify an existing element on the canvas. Use this when the user wants to change, update, move, resize, or restyle an existing element. You need to know the element's id.",
    inputSchema: z.object({
      elementId: z.string().describe("The id of the element to modify"),
      updates: z.record(z.string(), z.unknown()).describe(
        "Object with the properties to update (e.g. { x: 100, backgroundColor: '#ff0000' })"
      ),
    }),
    execute: async ({ elementId, updates }) => {
      // In a real app we would look up the element and merge.
      // For now, return the updates so the client can apply them.
      return { elementId, updates };
    },
  }),
};
