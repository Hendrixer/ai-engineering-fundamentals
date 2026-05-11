import {tool } from 'ai'
import {z} from 'zod'

export const tools = {
  generateDiagram: tool({
    description: "Generate a complete diagram as an array of Excalidraw elements. Use this when the user asks you to create, draw, or design a new diagram. Return all elements needed including shapes, text labels, and arrows/lines connecting them. Position elements with x,y coordinates and give each a unique id.",
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
      "Modify an existing element on the canvas by id. Pass null for any field you don't want to change. The element id must come from the current canvas state.",
    inputSchema: z.object({
      elementId: z.string().describe("The id of the element to modify"),
      // Every field is nullable rather than optional. OpenAI's strict tool
      // calling mode requires every property in `properties` to also be in
      // `required` — optional fields are rejected. Nullable fields satisfy
      // strict mode (they're required, but the value can be null), and the
      // model passes null for fields it doesn't want to change. We strip
      // nulls before applying the merge on the client.
      updates: z
        .object({
          x: z.number().nullable().describe("New x position, or null"),
          y: z.number().nullable().describe("New y position, or null"),
          width: z.number().nullable().describe("New width, or null"),
          height: z.number().nullable().describe("New height, or null"),
          text: z.string().nullable().describe("New label or text content, or null"),
          fontSize: z.number().nullable(),
          textAlign: z.enum(["left", "center", "right"]).nullable(),
          strokeColor: z.string().nullable().describe("Hex stroke color, or null"),
          backgroundColor: z.string().nullable().describe("Hex fill color, or null"),
          fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).nullable(),
          strokeWidth: z.number().nullable(),
          roughness: z.number().nullable(),
          opacity: z.number().nullable(),
        })
        .describe("Fields to change. Set any field you don't want to touch to null."),
    }),
    execute: async ({ elementId, updates }) => {
      // Filter out null fields so the client only sees what should actually
      // change. Without this, a null field would overwrite the live value
      // with null and break the element.
      const filtered: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(updates)) {
        if (value !== null) filtered[key] = value;
      }
      return { elementId, updates: filtered };
    },
  }),
}
