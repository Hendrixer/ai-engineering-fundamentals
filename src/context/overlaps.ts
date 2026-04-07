// Pairwise axis aligned bounding box overlap detection.
//
// Used by both:
//   - the live `addElements` tool result (so the agent loop sees collisions
//     immediately and can self correct via `updateElements`)
//   - the eval `noOverlaps` scorer (so we can measure layout quality)
//
// Sharing one implementation is the whole point: if the scorer and the
// agent feedback signal disagreed, we'd get the worst of both worlds —
// an agent that "fixed" what the loop reported but the eval still flagged.
//
// Carve outs (deliberately exclude these from overlap checks):
//   1. Arrow and line elements. Their bounding boxes legitimately cross
//      shapes when the arrow routes between them. Penalizing that would
//      flag every connecting arrow as a bug.
//   2. Bound text labels (text element with `containerId` set). The label
//      is supposed to sit inside its container; that's not an overlap.
//   3. Symmetric self pair: an element does not overlap itself.
//
// Epsilon: 4 pixels of allowed overlap. Two flush adjacent boxes that
// share a one pixel edge should not be penalized. This also lets the
// model use intentional grid alignment without a layout penalty.

interface ElementLike {
  id?: unknown;
  type?: unknown;
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  containerId?: unknown;
}

const EPSILON = 4;

function box(el: ElementLike): { x: number; y: number; w: number; h: number } | null {
  if (
    typeof el.x !== "number" ||
    typeof el.y !== "number" ||
    typeof el.width !== "number" ||
    typeof el.height !== "number"
  ) {
    return null;
  }
  return { x: el.x, y: el.y, w: el.width, h: el.height };
}

function intersects(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  // Standard AABB test, shrunk by EPSILON on all sides so that flush edges
  // and tiny touches don't count as overlaps.
  return (
    a.x + EPSILON < b.x + b.w &&
    a.x + a.w > b.x + EPSILON &&
    a.y + EPSILON < b.y + b.h &&
    a.y + a.h > b.y + EPSILON
  );
}

// Return all pairs of element ids whose bounding boxes overlap. The pair
// order is stable (alphabetically sorted) so identical scenes always
// produce identical overlap lists, which makes the eval reproducible.
export function findOverlaps(elements: unknown[]): [string, string][] {
  if (!Array.isArray(elements) || elements.length < 2) return [];

  const els = elements as ElementLike[];

  // Filter to elements eligible for overlap checks: not arrows, not lines,
  // not text bound to a container. Only consider elements that have an id
  // and a valid bounding box.
  const eligible: { id: string; b: { x: number; y: number; w: number; h: number } }[] = [];
  for (const el of els) {
    const type = typeof el.type === "string" ? el.type : null;
    if (!type || type === "arrow" || type === "line") continue;
    // Bound text labels live inside their container by design.
    if (type === "text" && typeof el.containerId === "string" && el.containerId.length > 0) {
      continue;
    }
    const id = typeof el.id === "string" ? el.id : null;
    if (!id) continue;
    const b = box(el);
    if (!b) continue;
    eligible.push({ id, b });
  }

  const pairs: [string, string][] = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      if (intersects(eligible[i]!.b, eligible[j]!.b)) {
        const a = eligible[i]!.id;
        const c = eligible[j]!.id;
        pairs.push(a < c ? [a, c] : [c, a]);
      }
    }
  }
  return pairs;
}

// Helper used by the noOverlaps scorer: total number of pairs eligible
// for overlap checks. We need this for the denominator so the score is
// graded (1 - overlapping / total) rather than binary.
export function countOverlapEligiblePairs(elements: unknown[]): number {
  if (!Array.isArray(elements)) return 0;
  const els = elements as ElementLike[];
  let n = 0;
  for (const el of els) {
    const type = typeof el.type === "string" ? el.type : null;
    if (!type || type === "arrow" || type === "line") continue;
    if (type === "text" && typeof el.containerId === "string" && el.containerId.length > 0) {
      continue;
    }
    if (typeof el.id !== "string") continue;
    if (
      typeof el.x !== "number" ||
      typeof el.y !== "number" ||
      typeof el.width !== "number" ||
      typeof el.height !== "number"
    ) {
      continue;
    }
    n += 1;
  }
  return (n * (n - 1)) / 2;
}
