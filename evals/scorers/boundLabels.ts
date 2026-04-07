// BoundLabels scorer: for every container shape (rectangle, ellipse, diamond)
// in the output, check whether there's a corresponding text element with
// containerId pointing to it. Catches the "boxes with no labels" failure
// where the model sets `text` on a rectangle expecting it to render inside,
// when Excalidraw needs a separate bound text element.
//
// Score is the ratio of labeled shapes to total shapes. Skips cases with no
// shapes.

import type { EvalScorer } from "braintrust";
import type { AgentOutput } from "./schema";
import type { GoldenTestCase } from "../buildMessages";

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

export const boundLabelsScorer: EvalScorer<GoldenTestCase, AgentOutput, GoldenTestCase> = ({
  output,
}) => {
  const elements = (output.elements ?? []) as Record<string, unknown>[];
  const shapes = elements.filter(
    (el) => typeof el?.type === "string" && SHAPE_TYPES.has(el.type as string)
  );
  if (shapes.length === 0) return null;

  const boundLabelShapeIds = new Set<string>();
  for (const el of elements) {
    if (el?.type !== "text") continue;
    const containerId = el.containerId;
    if (typeof containerId === "string" && containerId.length > 0) {
      boundLabelShapeIds.add(containerId);
    }
  }

  let labeled = 0;
  const unlabeled: string[] = [];
  for (const shape of shapes) {
    const id = typeof shape.id === "string" ? shape.id : null;
    if (id && boundLabelShapeIds.has(id)) labeled += 1;
    else unlabeled.push(id ?? "(no id)");
  }

  return {
    name: "BoundLabels",
    score: labeled / shapes.length,
    metadata: { labeled, total: shapes.length, unlabeled },
  };
};
