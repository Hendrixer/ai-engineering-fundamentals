// NoOverlaps scorer
// =================
//
// What it measures:
//   For every pair of elements eligible for overlap checks (shapes and
//   standalone text, but NOT arrows/lines and NOT bound text labels),
//   does any pair's bounding box collide with another? Score is graded:
//   1 - (overlapping_pairs / total_eligible_pairs).
//
// The failure mode it catches:
//   The model produces five labeled boxes that partially sit on top of
//   each other, or a free text annotation overlapping a shape, or a
//   sequence diagram where the actor labels collide with each other.
//   Visually broken, structurally fine — every existing scorer passes
//   and the canvas looks like a mess.
//
// Why graded instead of binary:
//   Continuous scores show progress as the agent gets closer to clean
//   layouts. Binary (any overlap = 0) is noisier and gives less signal
//   over successive iterations of the improvement loop.
//
// What this scorer is paired with:
//   The `addElements` tool result also returns the same overlap pairs
//   (computed via the same `findOverlaps` helper) so the agent loop sees
//   the collisions immediately and can self correct via `updateElements`.
//   Sharing one implementation prevents drift between "what the agent
//   sees" and "what the eval grades."
//
// Skips when:
//   - Fewer than 2 eligible elements (no pairs to check, returns null)
//
// Carve outs (deliberately ignored):
//   - Arrows and lines: their paths legitimately cross other shapes
//   - Bound text labels: a label sitting inside its container is correct

import type { EvalScorer } from "braintrust";
import type { AgentOutput } from "./schema";
import type { GoldenTestCase } from "../buildMessages";
import { findOverlaps, countOverlapEligiblePairs } from "../../src/context/overlaps";

export const noOverlapsScorer: EvalScorer<GoldenTestCase, AgentOutput, GoldenTestCase> = ({
  output,
}) => {
  const elements = (output.elements ?? []) as unknown[];
  const totalPairs = countOverlapEligiblePairs(elements);
  if (totalPairs === 0) return null;

  const overlapping = findOverlaps(elements);
  const score = 1 - overlapping.length / totalPairs;

  return {
    name: "NoOverlaps",
    score,
    metadata: {
      overlapping_pairs: overlapping,
      total_pairs: totalPairs,
      passed: overlapping.length === 0,
    },
  };
};
