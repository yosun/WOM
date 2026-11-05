import { agentPlacement, type AgentOutcome, type PlacementTask } from '../bench/llm.ts';
import type { Placement } from '../geometry/pose.ts';
import { beginAgentObservation, type ObservationContext } from './store.ts';
import type { AgentScores } from './types.ts';

/** Wrap the existing agent; the observation uses the same answer and never makes another model call. */
export async function observedAgentPlacement(
  task: PlacementTask, model: string, options: Parameters<typeof agentPlacement>[2],
  context: Omit<ObservationContext, 'model' | 'objectName' | 'asset'>,
  score: (placement: Placement) => AgentScores,
): Promise<AgentOutcome> {
  const observation = await beginAgentObservation({ ...context, model, objectName: task.objectName, asset: task.assetModel }, task);
  let outcome: AgentOutcome;
  try {
    outcome = await agentPlacement(task, model, { ...options, onProgress: observation.progress });
  } catch (error) {
    await observation.finish(null, undefined, error instanceof Error ? error.message : String(error));
    throw error;
  }
  let scores: AgentScores | undefined;
  try { if (outcome.placement) scores = score(outcome.placement); } catch { /* the caller still performs its normal scoring */ }
  await observation.finish(outcome, scores);
  return outcome;
}
