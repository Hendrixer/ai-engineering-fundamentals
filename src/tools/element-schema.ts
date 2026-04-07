import { z } from "zod";

// Shared element schema. The descriptions on each field aren't just for
// validation, they're part of the prompt the model reads when it loads the
// tool. Use them to teach the model how Excalidraw actually works, especially
// the gotchas it would otherwise get wrong (text labels, arrow bindings).
//
// Nullable rather than optional so OpenAI strict mode stays on. Null means
// "not applicable for this element type" (e.g. points on a rectangle).

export const elementSchema = z.object({
  id: z
    .string()
    .describe(
      "Unique identifier. Pick concise meaningful ids like 'rect_login' or 'arrow_login_db'. Other elements (text labels, arrow bindings) reference shapes by id, so the id must be unique within the canvas and stable across calls."
    ),
  type: z
    .enum(["rectangle", "ellipse", "diamond", "text", "arrow", "line"])
    .describe(
      "Element type. rectangle/ellipse/diamond are container shapes, text is a label, arrow is a directed connection, line is an undirected connection."
    ),
  x: z.number().describe("X position in pixels"),
  y: z.number().describe("Y position in pixels"),
  width: z.number().describe("Width in pixels. Must be at least 20."),
  height: z.number().describe("Height in pixels. Must be at least 20."),

  strokeColor: z.string().nullable().describe("Stroke color (hex). Null for default '#1e1e1e'."),
  backgroundColor: z.string().nullable().describe("Fill color. Null for default 'transparent'."),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).nullable(),
  strokeWidth: z.number().nullable(),
  roughness: z.number().nullable().describe("0 for clean, 1 for sketchy. Null for default."),
  opacity: z.number().nullable(),

  text: z
    .string()
    .nullable()
    .describe(
      "REQUIRED for text elements (the label content). FORBIDDEN on rectangle/ellipse/diamond: setting text on a shape does NOT render anything inside the box, you must create a separate text element with containerId pointing to the shape's id. Null for non text elements."
    ),
  fontSize: z.number().nullable().describe("Font size for text elements. Null for non text."),
  fontFamily: z.number().nullable().describe("1=Virgil, 2=Helvetica, 3=Cascadia. Null for default."),
  textAlign: z.enum(["left", "center", "right"]).nullable(),
  containerId: z
    .string()
    .nullable()
    .describe(
      "TEXT elements only. Set this to the id of the rectangle, ellipse, or diamond this label belongs INSIDE. The shape must exist in the same addElements call or already on the canvas. When containerId is set, Excalidraw automatically centers the text inside the container. This is the ONLY way to label a shape. Null for shapes and standalone text."
    ),

  points: z
    .array(z.array(z.number()))
    .nullable()
    .describe(
      "Arrow/line shape only. Array of [x,y] points relative to the element's x,y. Usually you can leave this null and let the bindings determine the path. Null for non line shapes."
    ),
  startBinding: z
    .object({
      elementId: z
        .string()
        .describe(
          "Id of the shape this arrow starts at. The shape must exist in the same call or already on the canvas. If the id is wrong or missing, the arrow floats free in space, which is always a bug."
        ),
      focus: z.number().describe("0 for center attach. Use 0 unless you have a reason."),
      gap: z.number().describe("Pixels of gap between the arrow and the shape edge. Use 8."),
    })
    .nullable()
    .describe(
      "REQUIRED for arrows that connect two shapes. Set both startBinding AND endBinding for any connecting arrow. Null for lines and standalone arrows."
    ),
  endBinding: z
    .object({
      elementId: z
        .string()
        .describe(
          "Id of the shape this arrow ends at. Same rules as startBinding.elementId."
        ),
      focus: z.number().describe("0 for center attach."),
      gap: z.number().describe("8 for normal spacing."),
    })
    .nullable()
    .describe(
      "REQUIRED for arrows that connect two shapes. Pair with startBinding."
    ),
});

export type ElementInput = z.infer<typeof elementSchema>;
