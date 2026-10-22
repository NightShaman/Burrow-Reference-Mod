import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreRoot = path.resolve(process.env.BURROW_CORE_ROOT || path.join(root, '..', 'Burrow-Backend'));
async function memoryStore() {
  const settings = new Map(); const secrets = new Map();
  return {
    get: async (n, f = null) => settings.has(n) ? settings.get(n) : f,
    set: async (n, v) => (settings.set(n, v), v), delete: async n => settings.delete(n),
    getSecret: async n => secrets.get(n) ?? null,
    setSecret: async (n, v) => (v ? secrets.set(n, String(v)) : secrets.delete(n), true),
    clearSecret: async n => secrets.delete(n), hasSecret: async n => secrets.has(n), close: async () => {},
  };
}
test('current Core discovers, hosts and resumes ordinary-mod Forge and external-turn RPCs', async (t) => {
  const [{ discoverMods }, { startModHost }, { createModCapabilities }, { createModExternalTurnDispatcher }, { createModGenerationDispatcher }] = await Promise.all(
    ['mod-runtime.mjs', 'mod-host.mjs', 'mod-capabilities.mjs', 'mod-external-turns.mjs', 'mod-generations.mjs'].map(name => import(pathToFileURL(path.join(coreRoot, 'src', name))))
  );
  const runtimeRoot = await fs.mkdtemp('/tmp/burrow-reference-contract-');
  const modsRoot = path.join(runtimeRoot, 'mods');
  await fs.mkdir(modsRoot, { recursive: true });
  await fs.cp(root, path.join(modsRoot, 'burrow-reference-mod'), { recursive: true, filter: source => path.basename(source) !== '.git' });
  t.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const [mod] = await discoverMods({ runtimeRoot, logger: { warn() {} } });
  assert.equal(mod.id, 'burrow-reference-mod'); assert.notEqual(mod.status, 'failed', mod.error);
  assert.notEqual(mod.system, true); assert.deepEqual(Object.keys(mod.ui).sort(), ['control', 'settings']);
  const store = await memoryStore();
  let job; const dispatches = [];
  // In-memory Forge boundary: real Core projection/ownership and host-child RPC,
  // no provider call, credentials, PostgreSQL dependency or paid generation.
  const forge = {
    catalog: async () => ({ models: [{ connectionId: 'private-connection', modelId: 'private-model', kind: 'image', available: true }] }),
    selections: async () => ({ image: { connectionId: 'private-connection', modelId: 'private-model' } }),
    create: async (input, options) => {
      dispatches.push({ input, options });
      const replayed = !!job;
      job ||= { id: 'image-1', kind: 'image', status: 'queued', modOwnerId: options.ownerModId, idempotencyKey: input.idempotencyKey, prompt: input.prompt, modelId: 'private-model', connectionId: 'private-connection', artifacts: [], error: null };
      return { job, replayed };
    },
    get: async id => id === job?.id ? job : null,
    public: value => ({ ...value, artifacts: value.artifacts.map(a => ({ ...a, previewUrl: `/api/forge/jobs/${value.id}/artifacts/${a.id}`, downloadUrl: 'private-download', storageReference: 'private-storage' })) }),
  };
  const agents = { list: async () => [{ id: 'hatchet', name: 'Hatchet', enabled: true }], get: async id => id === 'hatchet' ? { id, name: 'Hatchet', enabled: true } : null };
  const turnRows = new Map(); const turnKeys = new Map(); let releaseTurn;
  const turnStore = {
    async create(input) { const key = `${input.ownerModId}:${input.idempotencyKey}`; const existing = turnKeys.get(key); if (existing) return { turn: { ...existing }, replayed: true }; const turn = { id: 'turn-1', ...input, status: 'queued', runId: null, result: null, error: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', startedAt: null, completedAt: null }; turnRows.set(turn.id, turn); turnKeys.set(key, turn); return { turn: { ...turn }, replayed: false }; },
    async getByIdempotency(owner, key) { const turn = turnKeys.get(`${owner}:${key}`); return turn ? { ...turn } : null; },
    async getOwned(owner, id) { const turn = turnRows.get(id); return turn?.ownerModId === owner ? { ...turn } : null; },
    async markRunning(id, runId) { const turn = turnRows.get(id); Object.assign(turn, { status: 'running', runId, startedAt: '2026-10-22T00:00:01.000Z' }); return { ...turn }; },
    async complete(id, patch) { const turn = turnRows.get(id); Object.assign(turn, patch, { completedAt: '2026-10-22T00:00:02.000Z' }); return { ...turn }; },
  };
  const turnExecution = new Promise(resolve => { releaseTurn = resolve; }); let turnInput;
  const externalTurnDispatcher = createModExternalTurnDispatcher({ store: turnStore, stores: { agents }, rootDir: '/fixture', resolveAgentRuntime: async id => ({ agentId: id }), createRunId: () => 'external-run', executeTurn: async input => { turnInput = input; return turnExecution; } });
  t.after(() => externalTurnDispatcher.close());
  const generationRows = new Map(); let generationSequence = 0;
  const generationStore = {
    async create(input) {
      const existing = [...generationRows.values()].find(row => row.ownerModId === input.ownerModId && row.idempotencyKey === input.idempotencyKey);
      if (existing) return { job: { ...existing }, replayed: true };
      const row = { id: `generation-${++generationSequence}`, ...input, status: 'queued', text: null, error: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', startedAt: null, completedAt: null };
      generationRows.set(row.id, row); return { job: { ...row }, replayed: false };
    },
    async getOwned(owner, id) { const row = generationRows.get(id); return row?.ownerModId === owner ? { ...row } : null; },
    async markRunning(id) { const row = generationRows.get(id); if (row?.status !== 'queued') return null; Object.assign(row, { status: 'running', startedAt: '2026-10-22T00:00:01.000Z', updatedAt: '2026-10-22T00:00:01.000Z' }); return { ...row }; },
    async complete(id, patch) { const row = generationRows.get(id); if (!row || !['queued', 'running'].includes(row.status)) return null; Object.assign(row, patch, { completedAt: '2026-10-22T00:00:02.000Z', updatedAt: '2026-10-22T00:00:02.000Z' }); return { ...row }; },
  };
  const generationDispatcher = createModGenerationDispatcher({ store: generationStore, generateText: async () => ({ text: 'Durable current-Core result.' }) });
  t.after(() => generationDispatcher.close());
  const capabilities = createModCapabilities({ ownerModId: mod.id, resolveAgentRuntime: async id => ({ agentId: id }), externalTurnDispatcher, generationDispatcher, stores: { agents, models: {}, scheduledJobs: {}, conversations: {}, forge } });
  const start = () => startModHost({ mod, store, capabilities, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let host = start(); t.after(() => host.close());
  const activation = await host.activated;
  assert.deepEqual(activation.map(({ method, path }) => `${method} ${path}`), ['GET /images/status', 'GET /images/job', 'POST /images', 'GET /agent-turn/status', 'PUT /agent-turn/configuration', 'POST /agent-turn', 'GET /agent-turn', 'POST /generations', 'GET /generations/job', 'GET /status', 'PUT /configuration']);
  assert.deepEqual(activation.tools.map(({ name, availability }) => ({ name, availability })), [{ name: 'reference_greet', availability: 'grant-required' }]);
  const invoke = (method, path, body = null) => host.invoke(activation.find(route => route.method === method && route.path === path).routeId, { auth: { enabled: false, authenticated: false }, body, query: {}, params: {}, headers: {}, method, path });
  assert.equal((await invoke('GET', '/status')).body.ok, true);
  assert.match((await host.invokeTool('reference_greet', { name: 'Core' }, { agentId: 'fixture', sessionId: 'session' })).message, /Core$/);
  assert.equal((await invoke('GET', '/agent-turn/status')).body.enabled, false);
  const externalInput = { agentId: 'hatchet', sessionId: 'transport:thread-1', message: 'hello from transport', confirmDispatch: true };
  assert.equal((await invoke('POST', '/agent-turn', externalInput)).status, 403);
  assert.equal((await invoke('PUT', '/agent-turn/configuration', { enabled: true })).body.enabled, true);
  const acceptedTurn = await invoke('POST', '/agent-turn', externalInput);
  assert.equal(acceptedTurn.status, 202); assert.equal(acceptedTurn.body.turn.status, 'queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(turnInput.body.message, externalInput.message); assert.equal(turnInput.body.sessionId, externalInput.sessionId);
  assert.equal((await invoke('GET', '/agent-turn')).body.turn.status, 'running');
  const generation = await invoke('POST', '/generations', { connectionId: 'fixture-connection', model: 'fixture-model', prompt: 'Generate slowly.', requestId: 'slow-1', confirmCost: true });
  assert.equal(generation.status, 202); assert.equal(generation.body.job.status, 'queued');
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  const generated = await invoke('GET', '/generations/job');
  assert.equal(generated.body.job.status, 'succeeded'); assert.equal(generated.body.job.text, 'Durable current-Core result.');
  assert.doesNotMatch(JSON.stringify(generated), /Generate slowly|idempotencyKey|ownerModId/);
  releaseTurn({ ok: true, answerText: 'transport answer', decision: 'answer', blockers: [] });
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  const completedTurn = await invoke('GET', '/agent-turn');
  assert.equal(completedTurn.body.turn.result.answerText, 'transport answer');
  assert.doesNotMatch(JSON.stringify(completedTurn), /hello from transport|idempotencyKey|ownerModId/);
  assert.equal((await invoke('GET', '/images/status')).body.available, true);
  const receipt = await invoke('POST', '/images', { prompt: 'A small burrow', confirmCost: true });
  assert.equal(receipt.status, 202); assert.equal(receipt.body.job.status, 'queued');
  assert.equal(dispatches.length, 1);
  assert.deepEqual(Object.keys(dispatches[0].input).sort(), ['idempotencyKey', 'mode', 'prompt']);
  assert.match(dispatches[0].input.idempotencyKey, /^mod:burrow-reference-mod:/);
  assert.deepEqual(dispatches[0].options, { ownerModId: mod.id });
  await host.close(); host = start(); await host.activated;
  assert.equal((await invoke('GET', '/images/status')).body.jobId, receipt.body.job.id);
  job.status = 'succeeded'; job.artifacts = [{ id: 'artifact-1', kind: 'image', mimeType: 'image/png', name: 'preview.png', sizeBytes: 10 }];
  const read = await invoke('GET', '/images/job');
  assert.equal(read.body.job.status, 'succeeded');
  assert.equal(read.body.job.artifacts[0].previewUrl, '/api/forge/jobs/image-1/artifacts/artifact-1');
  assert.doesNotMatch(JSON.stringify(read.body), /private-|prompt|connectionId|modelId|downloadUrl|storageReference/);
  job.modOwnerId = 'foreign-mod';
  const foreign = await invoke('GET', '/images/job');
  assert.equal(foreign.status, 503); assert.equal(foreign.body.error, 'image_capability_failed');
});
