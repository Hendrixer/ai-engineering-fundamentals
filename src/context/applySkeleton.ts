// Node side simulator for Excalidraw's `convertToExcalidrawElements` helper.
//
// Why this exists:
//   The live app applies new elements via convertToExcalidrawElements (browser
//   only, depends on the Excalidraw runtime). The eval harness has no browser
//   and can't import that helper in node. Before this file existed, the eval
//   simulator just spread raw model input into its simulated canvas, which
//   meant the scorers were reading model CLAIMS not RENDERED RESULTS.
//
//   That gap silently broke every visual scorer the moment we changed the
//   schema vocabulary from runtime field names (containerId, startBinding,
//   endBinding) to skeleton field names (label, start, end). The model started
//   emitting skeleton input, the simulator stored it raw, and the scorers
//   reading runtime field names saw nothing.
//
// What this file does:
//   Take the same skeleton-shaped input the live helper would consume, and
//   produce runtime-shaped elements with the fields the scorers care about
//   (containerId on text, boundElements on containers, startBinding/endBinding
//   on arrows). Just enough of the helper's behavior to make the eval honest.
//
// What this file deliberately does NOT do:
//   Path computation, point arrays, font measurement, group ids, version
//   stamps, anything visual. The scorers don't need it and the lesson code
//   should stay readable.

type SkeletonElement = Record<string, unknown>;
type RuntimeElement = Record<string, unknown>;

// Strip null fields recursively. Mirrors the same helper in src/App.tsx.
// The schema uses nullable (not optional) for OpenAI strict mode, so the
// model always emits every field. Excalidraw's runtime expects undefined
// (or absent), not null.
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

// Apply a batch of skeleton elements to a simulated canvas. Returns the new
// runtime elements that were produced. The caller is responsible for pushing
// them into the simulated canvas store.
//
// For each shape with a `label: { text }`, this produces TWO runtime elements:
// the shape (with `boundElements` populated) and a synthetic child text
// element (with `containerId` pointing back at the shape). That's what
// convertToExcalidrawElements does internally and what the live UI sees.
//
// For each arrow with `start: { id }` / `end: { id }`, this produces the arrow
// with `startBinding: { elementId, focus: 0, gap: 8 }` / `endBinding`. Same
// mapping the live helper does.
export function applySkeleton(skeletons: SkeletonElement[]): RuntimeElement[] {
  const cleaned = skeletons.map((el) => stripNulls(el) as Record<string, unknown>);
  const out: RuntimeElement[] = [];

  for (const el of cleaned) {
    const type = el.type as string;

    if (type === "rectangle" || type === "ellipse" || type === "diamond") {
      // Pull the label off the shape (if any) before pushing the shape to
      // the canvas. The shape stores a reference to its bound text in
      // `boundElements`; the actual text content lives in the synthetic
      // child element.
      const { label, ...shapeFields } = el;
      const shape: RuntimeElement = { ...shapeFields };

      if (label && typeof label === "object") {
        const labelObj = label as Record<string, unknown>;
        const text = labelObj.text;
        if (typeof text === "string" && text.length > 0) {
          // Synthetic child id derived from the parent id so it's stable and
          // human readable in scorer metadata.
          const childId = `${el.id}_label`;
          shape.boundElements = [{ id: childId, type: "text" }];
          out.push(shape);
          out.push({
            id: childId,
            type: "text",
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            text,
            containerId: el.id,
            ...(typeof labelObj.fontSize === "number" ? { fontSize: labelObj.fontSize } : {}),
            ...(typeof labelObj.textAlign === "string" ? { textAlign: labelObj.textAlign } : {}),
          });
          continue;
        }
      }
      out.push(shape);
      continue;
    }

    if (type === "arrow" || type === "line") {
      // Map skeleton `start: { id }` / `end: { id }` to runtime
      // `startBinding: { elementId, focus, gap }` / `endBinding`.
      // focus 0 and gap 8 are the defaults the live helper uses.
      const { start, end, label, ...arrowFields } = el;
      const arrow: RuntimeElement = { ...arrowFields };
      if (start && typeof start === "object") {
        const startId = (start as Record<string, unknown>).id;
        if (typeof startId === "string") {
          arrow.startBinding = { elementId: startId, focus: 0, gap: 8 };
        }
      }
      if (end && typeof end === "object") {
        const endId = (end as Record<string, unknown>).id;
        if (typeof endId === "string") {
          arrow.endBinding = { elementId: endId, focus: 0, gap: 8 };
        }
      }
      // Arrow labels also create a child text element bound to the arrow,
      // same pattern as containers. Most diagrams in this course don't use
      // them, but the lesson example calls them out for "yes/no" decisions.
      if (label && typeof label === "object") {
        const labelObj = label as Record<string, unknown>;
        const text = labelObj.text;
        if (typeof text === "string" && text.length > 0) {
          const childId = `${el.id}_label`;
          arrow.boundElements = [{ id: childId, type: "text" }];
          out.push(arrow);
          out.push({
            id: childId,
            type: "text",
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
            text,
            containerId: el.id,
          });
          continue;
        }
      }
      out.push(arrow);
      continue;
    }

    // Standalone text and anything else: pass through with nulls stripped.
    out.push(el);
  }

  return out;
}
