// Shared by the runtime, benchmark and viewer. Bump the revision when the agent's technique changes.
import type { PlacementMethod, PlannedObject, SceneDoc } from './types.ts';

export const PLACEMENT_AGENT_REVISION = 'polish-v1';
export const PLACEMENT_AGENT_FIT = { refineRounds: 32, preserveTranslation: true } as const;

/** Old and partially completed agent results can be updated explicitly; split parts stay together. */
export function placementAgentNeedsRun(
  doc: Pick<SceneDoc, 'objects'>,
  method: PlacementMethod,
  plan: readonly Pick<PlannedObject, 'id' | 'part'>[] = [],
): boolean {
  const parts = new Set(plan.filter((o) => o.part).map((o) => o.id));
  return doc.objects.some((o) => !parts.has(o.id) && o.placements?.[method]?.agentRevision !== PLACEMENT_AGENT_REVISION);
}
