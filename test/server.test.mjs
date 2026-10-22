import test from 'node:test';
import assert from 'node:assert/strict';
import { activate, referenceContract } from '../server/index.mjs';

function fixture() {
  const routes = new Map();
  const tools = [];
  const settings = new Map();
  const secrets = new Map();
  const logs = [];
  const context = {
    api: Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)])),
    tools: { register: (tool) => tools.push(tool) },
    settings: { get: async (name, fallback = null) => settings.has(name) ? settings.get(name) : fallback, set: async (name, value) => { settings.set(name, value); return value; }, delete: async (name) => settings.delete(name) },
    secrets: { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => { secrets.set(name, value); return true; }, clear: async (name) => secrets.delete(name), has: async (name) => secrets.has(name) },
    logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...values) => logs.push([level, ...values])])),
  };
  return { context, routes, tools, settings, secrets, logs };
}
const request = (body, auth = { enabled: true, authenticated: true }) => ({ body, auth, query: {}, params: {}, headers: {}, method: 'PUT', path: '/configuration' });
test('activation registers the public route and grant-required tool contract', async () => { const f = fixture(); const cleanup = await activate(f.context); assert.deepEqual([...f.routes.keys()], ['GET /images/status', 'GET /images/job', 'POST /images', 'GET /status', 'PUT /configuration']); assert.equal(f.tools.length, 1); assert.equal(f.tools[0].name, 'reference_greet'); assert.equal(f.tools[0].availability, undefined); assert.equal(f.tools[0].inputSchema.additionalProperties, false); assert.equal(typeof cleanup, 'function'); cleanup(); assert.deepEqual(f.logs.map((entry) => entry[1]), ['Burrow Reference Mod activated', 'Burrow Reference Mod stopped']); });
test('status returns public configuration without exposing the secret', async () => { const f = fixture(); await activate(f.context); f.secrets.set('example-secret', 'never-return-this'); const result = await f.routes.get('GET /status')({ auth: { enabled: false, authenticated: false } }); assert.equal(result.status, 200); assert.deepEqual(result.body, { ok: true, greeting: referenceContract.DEFAULT_GREETING, secretConfigured: true }); assert.doesNotMatch(JSON.stringify(result), /never-return-this/); });
test('configuration persists namespaced settings and write-only secret state', async () => { const f = fixture(); await activate(f.context); const save = await f.routes.get('PUT /configuration')(request({ greeting: '  Welcome.  ', secret: 'private-example' })); assert.deepEqual(save.body, { ok: true, greeting: 'Welcome.', secretConfigured: true }); assert.equal(f.settings.get('greeting'), 'Welcome.'); assert.equal(f.secrets.get('example-secret'), 'private-example'); assert.doesNotMatch(JSON.stringify(save), /private-example/); const clear = await f.routes.get('PUT /configuration')(request({ greeting: 'Welcome.', secret: '' })); assert.equal(clear.body.secretConfigured, false); assert.equal(f.secrets.has('example-secret'), false); });
test('configuration uses trusted auth context and rejects malformed input', async () => { const f = fixture(); await activate(f.context); const denied = await f.routes.get('PUT /configuration')(request({ greeting: 'Nope' }, { enabled: true, authenticated: false })); assert.equal(denied.status, 401); for (const body of [null, {}, { greeting: '' }, { greeting: 'ok', surprise: true }, { greeting: 'x'.repeat(161) }]) assert.equal((await f.routes.get('PUT /configuration')(request(body))).status, 400); assert.equal((await f.routes.get('PUT /configuration')(request({ greeting: 'Trusted network' }, { enabled: false, authenticated: false }))).status, 200); });
test('tool validates arguments, reads current settings, and honors cancellation', async () => { const f = fixture(); await activate(f.context); f.settings.set('greeting', 'Greetings,'); const tool = f.tools[0]; assert.deepEqual(await tool.handler({ name: 'Ada' }, { signal: new AbortController().signal }), { ok: true, message: 'Greetings, Ada' }); await assert.rejects(tool.handler({ name: 'Ada', forged: true }, { signal: new AbortController().signal }), /invalid_arguments/); const controller = new AbortController(); controller.abort(); await assert.rejects(tool.handler({ name: 'Ada' }, { signal: controller.signal }), /cancelled/); });

function imageFixture() {
  const f = fixture();
  const calls = [];
  const jobs = new Map();
  f.context.forge = {
    images: {
      status: async () => ({ available: true }),
      create: async (input) => {
        calls.push(input);
        const replayed = jobs.has(input.idempotencyKey);
        const job = jobs.get(input.idempotencyKey) || { id: `image-${jobs.size}`, kind: 'image', status: 'queued', artifacts: [], error: null };
        jobs.set(input.idempotencyKey, job);
        return { job, replayed };
      },
    },
    jobs: { read: async (id) => [...jobs.values()].find((job) => job.id === id) },
  };
  return { ...f, calls, jobs };
}
test('images require explicit consent/auth and reject selection, cancellation and malformed fields', async () => {
  const f = imageFixture(); await activate(f.context);
  const create = f.routes.get('POST /images');
  assert.equal((await create(request({ prompt: 'a tree', confirmCost: true }, { enabled: true, authenticated: false }))).status, 401);
  for (const body of [null, {}, { prompt: '' , confirmCost: true }, { prompt: 'x'.repeat(4001), confirmCost: true }, { prompt: 'tree', confirmCost: false }, ...['model', 'provider', 'connectionId', 'cancel', 'download'].map((key) => ({ prompt: 'tree', confirmCost: true, [key]: 'no' }))]) {
    assert.equal((await create(request(body))).status, 400);
  }
  assert.equal(f.calls.length, 0);
  f.context.forge.images.status = async () => ({ available: false, reason: 'forge_selection_missing' });
  assert.equal((await f.routes.get('GET /images/status')(request())).body.reason, 'forge_selection_missing');
  assert.equal((await create(request({ prompt: 'tree', confirmCost: true }))).status, 409);
  assert.equal(f.calls.length, 0);
});
test('images persist receipt, return asynchronously and resume polling after activation', async () => {
  const f = imageFixture(); await activate(f.context);
  const created = await f.routes.get('POST /images')(request({ prompt: '  a tree  ', confirmCost: true }));
  assert.equal(created.status, 202); assert.equal(created.body.job.status, 'queued');
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['idempotencyKey', 'prompt']);
  assert.equal(f.calls[0].prompt, 'a tree');
  const saved = f.settings.get('image-request'); assert.equal(saved.jobId, created.body.job.id); assert.equal(Object.hasOwn(saved, 'prompt'), false);
  assert.equal((await f.routes.get('POST /images')(request({ prompt: 'another', confirmCost: true }))).status, 409);
  await activate(f.context); // Same durable settings, new activation-local state.
  const job = [...f.jobs.values()][0];
  for (const status of ['running', 'succeeded', 'failed', 'interrupted']) {
    job.status = status;
    assert.equal((await f.routes.get('GET /images/job')(request())).body.job.status, status);
  }
  assert.doesNotMatch(JSON.stringify((await f.routes.get('GET /images/status')(request())).body), /a tree|idempotencyKey/);
});
test('ambiguous create or receipt persistence failures retry the durable key, not a new paid request', async () => {
  for (const failAt of ['create', 'receipt']) {
    const f = imageFixture(); await activate(f.context);
    const original = f.context.forge.images.create;
    let fail = true;
    f.context.forge.images.create = async (input) => { const result = await original(input); if (failAt === 'create' && fail) { fail = false; throw Error('secret-provider-details'); } return result; };
    const set = f.context.settings.set;
    f.context.settings.set = async (key, value) => { if (failAt === 'receipt' && value.jobId && fail) { fail = false; throw Error('secret-provider-details'); } return set(key, value); };
    const result = await f.routes.get('POST /images')(request({ prompt: 'tree', confirmCost: true }));
    assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result), /secret-provider-details/);
    await activate(f.context);
    assert.equal((await f.routes.get('GET /images/status')(request())).body.retryPending, true);
    const retry = await f.routes.get('POST /images')(request({ confirmCost: true }));
    assert.equal(retry.status, 202); assert.equal(retry.body.replayed, true);
    assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.jobs.size, 1);
  }
});
test('failed durable intent writes never dispatch; overlapping submissions are rejected', async () => {
  const f = imageFixture(); await activate(f.context);
  const set = f.context.settings.set;
  f.context.settings.set = async () => { throw Error('storage-failed'); };
  assert.equal((await f.routes.get('POST /images')(request({ prompt: 'tree', confirmCost: true }))).status, 503);
  assert.equal(f.calls.length, 0);
  f.context.settings.set = set;
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const original = f.context.forge.images.create;
  f.context.forge.images.create = async (input) => { await gate; return original(input); };
  const first = f.routes.get('POST /images')(request({ prompt: 'tree', confirmCost: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await f.routes.get('POST /images')(request({ prompt: 'tree', confirmCost: true }))).status, 409);
  release(); assert.equal((await first).status, 202); assert.equal(f.calls.length, 1);
});

test('image reads enforce trusted auth and sanitize upstream errors even with status codes', async () => {
  const f = imageFixture(); await activate(f.context);
  for (const route of ['GET /images/status', 'GET /images/job']) {
    assert.equal((await f.routes.get(route)(request(null, { enabled: true, authenticated: false }))).status, 401);
  }
  f.context.forge.images.status = async () => { throw Object.assign(Error('private-provider-credential'), { statusCode: 401 }); };
  const result = await f.routes.get('GET /images/status')(request());
  assert.equal(result.status, 503); assert.equal(result.body.error, 'image_capability_failed');
  assert.equal(result.headers['cache-control'], 'no-store'); assert.doesNotMatch(JSON.stringify(result), /private-provider/);
});
