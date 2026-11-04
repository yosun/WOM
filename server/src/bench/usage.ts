// What the ledger's labels mean in this app, for the metrics package's spend report: what a paid call
// bought, which world it was about, and which benchmark method's case it priced. The ledger itself
// (data/ledger.jsonl) is written by world builds and by benchmark runs; this only reads its labels.
import type { LedgerEntry, UsageHooks } from '@wom/metrics';
import { listWorlds } from '../store.ts';
import { methodSpec, shortModel } from './spec.ts';

/** What a paid call bought, from its label. The first matching rule wins. */
const KINDS: { id: string; label: string; test: RegExp }[] = [
  { id: 'bench-patrol', label: 'Benchmark: visual patrols', test: /^patrol /i },
  { id: 'bench-agent', label: 'Benchmark: placement agents', test: /^bench placement agent /i },
  { id: 'bench-direct', label: 'Benchmark: direct placements', test: /^bench placement direct /i },
  { id: 'asset-check', label: 'Asset checks', test: /^asset check/i },
  { id: 'agents', label: 'Placement agents in world builds', test: /placement agent/i },
  { id: 'objects', label: '3D objects (IDOL, Tripo)', test: /^(idol|triposplat|tripo)/i },
  { id: 'marble', label: 'Surrounding worlds (Marble)', test: /^marble/i },
  { id: 'depth', label: 'Depth (MoGe)', test: /^moge/i },
  { id: 'plan', label: 'Scene plans', test: /scene plan/i },
  { id: 'segmentation', label: 'Segmentation (SAM, mask review)', test: /^sam |mask review/i },
  { id: 'images', label: 'Images (clean plate, completions)', test: /^muse image/i },
];

export function kindOf(label: string): { id: string; label: string } {
  return KINDS.find((k) => k.test.test(label)) ?? { id: 'other', label: 'Other' };
}

/** `bench placement direct <model>: <world>/<object>/<asset>@<depth>` (the agent's has ` turn n` after it). */
const PLACEMENT_CALL = /^bench placement (direct|agent) (\S+): (.+?)(?: turn \d+)?$/;
/** Benchmark labels end in "<world>/<object>/<asset>", which says which world the call was about. */
const WORLD_IN_LABEL = /: ([a-z0-9]{6,32})\//;

export async function usageHooks(): Promise<UsageHooks> {
  const worlds = await listWorlds();
  return {
    classify: (e: LedgerEntry) => kindOf(e.label),
    perCase: (e: LedgerEntry) => {
      const call = PLACEMENT_CALL.exec(e.label);
      if (!call) return null;
      const [, protocol, model, caseLabel] = call;
      const spec = methodSpec(protocol as 'direct' | 'agent', model);
      return {
        subject: model,
        method: spec.id,
        case: caseLabel,
        run: (e.ref ?? '').split(':')[0],
        label: `${spec.label} · Muse ${shortModel(model)}`,
        about: protocol === 'agent' ? 'Renders, scores and fits, several calls per case' : 'One call per case',
      };
    },
    worldOf: (e: LedgerEntry) => e.worldId ?? WORLD_IN_LABEL.exec(e.label)?.[1],
    worldTitles: new Map(worlds.map((m) => [m.id, m.title])),
    contextLabels: { bench: 'Benchmarks', pipeline: 'World builds' },
    providerLabels: { ai3d: 'AI3D (depth, objects, worlds)', meta: 'Meta Model API (Muse, SAM)', google: 'Google Vertex AI (Gemini)', openai: 'OpenAI' },
  };
}
