/** The same public method identity/provenance envelope for any contributed agentic setup. */
export interface AgentSetup {
  schema: 'wom-agent-setup/1';
  id: string;
  label: string;
  revision: string;
  description?: string;
  runner: { kind: 'command'; argv: string[] } | { kind: 'http'; path: string };
  adapter: { id: string; revision: string };
  models: { id: string; provider: string; role: string }[];
  agents: { id: string; role: string; model?: string; tools: string[] }[];
  /** Names only. Credentials are supplied by the runner's environment. */
  environment: string[];
  /** A hashed public configuration file: parameters, prompts, seeds and resource limits. */
  configuration?: { path: string; sha256: string };
}

const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const fail = (message: string): never => { throw new Error(`WOMetrics setup: ${message}`); };
const keys = (value: object, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

export function assertAgentSetup(s: AgentSetup): void {
  if (!s || s.schema !== 'wom-agent-setup/1' || !identifier(s.id) || !nonempty(s.label) || !nonempty(s.revision) ||
      !keys(s, ['schema', 'id', 'label', 'revision', 'description', 'runner', 'adapter', 'models', 'agents', 'environment', 'configuration'])) fail('invalid schema, identity or revision');
  if (s.description !== undefined && !nonempty(s.description)) fail('description must be nonempty');
  const r = s.runner;
  if (!r || (r.kind !== 'command' && r.kind !== 'http')) fail('declare a runner');
  if (r.kind === 'command') {
    if (!keys(r, ['kind', 'argv']) || !Array.isArray(r.argv) || !r.argv.length || !r.argv.every(nonempty)) fail('command runner needs an argv array');
  } else if (!keys(r, ['kind', 'path']) || !nonempty(r.path) || !r.path.startsWith('/') || r.path.startsWith('//') || /[?#]/.test(r.path)) fail('HTTP runner needs a path without credentials or query');
  if (!s.adapter || !keys(s.adapter, ['id', 'revision']) || !identifier(s.adapter.id) || !nonempty(s.adapter.revision)) fail('declare a rendering adapter and revision');
  if (!Array.isArray(s.models) || !Array.isArray(s.agents)) fail('models and agents must be arrays (empty for deterministic methods)');
  const models = new Set<string>(), agents = new Set<string>();
  for (const m of s.models) {
    if (!m || !keys(m, ['id', 'provider', 'role']) || !identifier(m.id) || !nonempty(m.provider) || !nonempty(m.role) || models.has(m.id)) fail('invalid/duplicate model');
    models.add(m.id);
  }
  for (const a of s.agents) {
    if (!a || !keys(a, ['id', 'role', 'model', 'tools']) || !identifier(a.id) || !nonempty(a.role) || agents.has(a.id) ||
        (a.model !== undefined && !models.has(a.model)) || !Array.isArray(a.tools) || !a.tools.every(nonempty) || new Set(a.tools).size !== a.tools.length) fail('invalid/duplicate agent, tool or model reference');
    agents.add(a.id);
  }
  if (!Array.isArray(s.environment) || !s.environment.every((name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name)) ||
      new Set(s.environment).size !== s.environment.length) fail('environment lists variable names, never values');
  const c = s.configuration;
  if (c !== undefined && (!c || !keys(c, ['path', 'sha256']) || !nonempty(c.path) || c.path.startsWith('/') || /[\\:\0]/.test(c.path) ||
      c.path.split('/').some((p) => !p || p === '.' || p === '..') || !/^[a-f0-9]{64}$/.test(c.sha256))) fail('invalid configuration path/hash');
}
