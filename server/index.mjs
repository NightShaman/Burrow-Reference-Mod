import { randomUUID } from 'node:crypto';

const IMAGE_REQUEST_SETTING = 'image-request';
const TERMINAL_IMAGE_STATUSES = ['succeeded', 'failed', 'interrupted'];
const AGENT_TURN_ENABLED_SETTING = 'agent-turn-enabled';
const AGENT_TURN_REQUEST_SETTING = 'agent-turn-request';
const GENERATION_REQUEST_SETTING = 'generation-request';

const DEFAULT_GREETING = 'Hello from the Burrow Reference Mod.';
const MAX_GREETING_LENGTH = 160;
const MAX_SECRET_LENGTH = 4096;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateGreeting(value) {
  if (typeof value !== 'string') throw Object.assign(new Error('greeting_invalid'), { statusCode: 400 });
  const greeting = value.trim();
  if (!greeting || greeting.length > MAX_GREETING_LENGTH) throw Object.assign(new Error('greeting_invalid'), { statusCode: 400 });
  return greeting;
}

function validateConfiguration(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => !['greeting', 'secret'].includes(key))) {
    throw Object.assign(new Error('configuration_invalid'), { statusCode: 400 });
  }
  const greeting = validateGreeting(value.greeting);
  if (value.secret !== undefined && (typeof value.secret !== 'string' || value.secret.length > MAX_SECRET_LENGTH)) {
    throw Object.assign(new Error('secret_invalid'), { statusCode: 400 });
  }
  return { greeting, ...(value.secret !== undefined ? { secret: value.secret } : {}) };
}

function requireOperator(request) {
  if (request?.auth?.enabled === true && request.auth.authenticated !== true) {
    throw Object.assign(new Error('operator_authentication_required'), { statusCode: 401 });
  }
}

function response(status, body) {
  return { status, headers: { 'cache-control': 'no-store' }, body };
}

// Deliberately one retained request: persist intent before paid dispatch so an
// ambiguous RPC/storage failure can be retried with exactly the same Core key.
function registerImageExample(context) {
  let submitting = false;
  const savedRequest = () => context.settings.get(IMAGE_REQUEST_SETTING, null);
  const publicErrors = new Set(['operator_authentication_required', 'image_request_invalid', 'image_submission_busy', 'image_retry_unavailable', 'image_request_pending', 'image_unavailable']);
  const failure = (error) => response(publicErrors.has(error?.message) ? error.statusCode : 503, {
    ok: false,
    error: publicErrors.has(error?.message) ? error.message : 'image_capability_failed',
  });
  context.api.get('/images/status', async (request) => {
    try {
      requireOperator(request);
      const availability = await context.forge.images.status();
      const saved = await savedRequest();
      return response(200, { ok: true, ...availability, jobId: saved?.jobId || null, retryPending: !!saved && !saved.jobId });
    } catch (error) { return failure(error); }
  });
  context.api.get('/images/job', async (request) => {
    try {
      requireOperator(request);
      const saved = await savedRequest();
      return response(200, { ok: true, job: saved?.jobId ? await context.forge.jobs.read(saved.jobId) : null });
    } catch (error) { return failure(error); }
  });
  context.api.post('/images', async (request) => {
    let acquired = false;
    try {
      requireOperator(request);
      const body = request.body;
      if (!plainObject(body) || Object.keys(body).some((key) => !['prompt', 'confirmCost'].includes(key)) || body.confirmCost !== true ||
          (body.prompt !== undefined && (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000))) {
        throw Object.assign(new Error('image_request_invalid'), { statusCode: 400 });
      }
      if (submitting) throw Object.assign(new Error('image_submission_busy'), { statusCode: 409 });
      submitting = true; acquired = true;
      let saved = await savedRequest();
      if (body.prompt === undefined) {
        if (!saved || saved.jobId) throw Object.assign(new Error('image_retry_unavailable'), { statusCode: 409 });
      } else {
        if (saved && (!saved.jobId || !TERMINAL_IMAGE_STATUSES.includes((await context.forge.jobs.read(saved.jobId)).status))) {
          throw Object.assign(new Error('image_request_pending'), { statusCode: 409 });
        }
        if (!(await context.forge.images.status()).available) throw Object.assign(new Error('image_unavailable'), { statusCode: 409 });
        saved = { prompt: body.prompt.trim(), idempotencyKey: randomUUID(), jobId: null };
        await context.settings.set(IMAGE_REQUEST_SETTING, saved);
      }
      const result = await context.forge.images.create({ prompt: saved.prompt, idempotencyKey: saved.idempotencyKey });
      await context.settings.set(IMAGE_REQUEST_SETTING, { idempotencyKey: saved.idempotencyKey, jobId: result.job.id });
      // Accepted is not completed. Read the durable job in a later route call.
      return response(202, { ok: true, job: result.job, replayed: result.replayed });
    } catch (error) { return failure(error); }
    finally { if (acquired) submitting = false; }
  });
}

// Narrow operator-only scaffold: disabled by default, one retained logical turn,
// no activation/timer/tool dispatch, and no direct provider integration.
function registerAgentTurnExample(context) {
  let submitting = false;
  const savedRequest = () => context.settings.get(AGENT_TURN_REQUEST_SETTING, null);
  const publicErrors = new Set(['operator_authentication_required', 'agent_turn_invalid', 'agent_turn_disabled', 'agent_turn_busy', 'agent_turn_pending', 'agent_turn_retry_unavailable', 'agent_not_found', 'agent_disabled', 'mod_external_turn_idempotency_conflict', 'mod_external_turn_not_found']);
  const failTurn = (error) => response(publicErrors.has(error?.message) ? Number(error.statusCode) || 409 : 503, { ok: false, error: publicErrors.has(error?.message) ? error.message : 'agent_turn_capability_failed' });
  context.api.get('/agent-turn/status', async (request) => {
    try {
      requireOperator(request);
      return response(200, { ok: true, enabled: await context.settings.get(AGENT_TURN_ENABLED_SETTING, false) === true, agents: await context.agents.list(), retained: !!(await savedRequest()) });
    } catch (error) { return failTurn(error); }
  });
  context.api.put('/agent-turn/configuration', async (request) => {
    try {
      requireOperator(request);
      if (!plainObject(request.body) || Object.keys(request.body).some(key => key !== 'enabled') || typeof request.body.enabled !== 'boolean') throw Object.assign(Error('agent_turn_invalid'), { statusCode: 400 });
      await context.settings.set(AGENT_TURN_ENABLED_SETTING, request.body.enabled);
      return response(200, { ok: true, enabled: request.body.enabled });
    } catch (error) { return failTurn(error); }
  });
  context.api.post('/agent-turn', async (request) => {
    let acquired = false;
    try {
      requireOperator(request);
      if (await context.settings.get(AGENT_TURN_ENABLED_SETTING, false) !== true) throw Object.assign(Error('agent_turn_disabled'), { statusCode: 403 });
      const body = request.body;
      if (!plainObject(body) || Object.keys(body).some(key => !['agentId', 'sessionId', 'message', 'confirmDispatch'].includes(key)) || body.confirmDispatch !== true) throw Object.assign(Error('agent_turn_invalid'), { statusCode: 400 });
      if (submitting) throw Object.assign(Error('agent_turn_busy'), { statusCode: 409 });
      submitting = true; acquired = true;
      let saved = await savedRequest();
      if (body.message === undefined) {
        if (!saved || saved.turnId) throw Object.assign(Error('agent_turn_retry_unavailable'), { statusCode: 409 });
      } else {
        for (const [name, max] of [['agentId', 96], ['sessionId', 128], ['message', 100_000]]) {
          if (typeof body[name] !== 'string' || !body[name].trim() || body[name].length > max) throw Object.assign(Error('agent_turn_invalid'), { statusCode: 400 });
        }
        if (saved && (!saved.turnId || !TERMINAL_IMAGE_STATUSES.includes((await context.agents.turns.read(saved.turnId)).status))) throw Object.assign(Error('agent_turn_pending'), { statusCode: 409 });
        saved = { agentId: body.agentId.trim(), sessionId: body.sessionId.trim(), message: body.message, idempotencyKey: randomUUID(), turnId: null };
        await context.settings.set(AGENT_TURN_REQUEST_SETTING, saved);
      }
      const accepted = await context.agents.turns.submit({ agentId: saved.agentId, sessionId: saved.sessionId, message: saved.message, idempotencyKey: saved.idempotencyKey });
      await context.settings.set(AGENT_TURN_REQUEST_SETTING, { agentId: saved.agentId, sessionId: saved.sessionId, idempotencyKey: saved.idempotencyKey, turnId: accepted.turn.id });
      return response(202, { ok: true, turn: accepted.turn, replayed: accepted.replayed });
    } catch (error) { return failTurn(error); }
    finally { if (acquired) submitting = false; }
  });
  context.api.get('/agent-turn', async (request) => {
    try {
      requireOperator(request);
      const saved = await savedRequest();
      return response(200, { ok: true, retryPending: !!saved && !saved.turnId, turn: saved?.turnId ? await context.agents.turns.read(saved.turnId) : null });
    } catch (error) { return failTurn(error); }
  });
}

function registerGenerationExample(context) {
  const savedRequest = () => context.settings.get(GENERATION_REQUEST_SETTING, null);
  const failGeneration = error => response(Number(error?.statusCode) || 503, { ok: false, error: Number(error?.statusCode) ? error.message : 'generation_capability_failed' });
  context.api.post('/generations', async request => {
    try {
      requireOperator(request);
      const body = request.body;
      if (!plainObject(body) || Object.keys(body).some(key => !['connectionId','model','prompt','maxTokens','requestId','confirmCost'].includes(key)) || body.confirmCost !== true) throw Object.assign(Error('generation_request_invalid'), { statusCode: 400 });
      for (const [name,max] of [['connectionId',128],['model',256],['prompt',100_000],['requestId',128]]) if (typeof body[name] !== 'string' || !body[name].trim() || body[name].length > max) throw Object.assign(Error('generation_request_invalid'), { statusCode: 400 });
      if (body.maxTokens !== undefined && (!Number.isSafeInteger(body.maxTokens) || body.maxTokens < 1)) throw Object.assign(Error('generation_request_invalid'), { statusCode: 400 });
      const retained = await savedRequest();
      const idempotencyKey = `reference-generation:${body.requestId.trim()}`;
      if (retained && retained.idempotencyKey !== idempotencyKey) {
        const current = await context.models.generations.read(retained.jobId);
        if (!TERMINAL_IMAGE_STATUSES.includes(current.status)) throw Object.assign(Error('generation_request_pending'), { statusCode: 409 });
      }
      const accepted = await context.models.generations.submit({ connectionId: body.connectionId.trim(), model: body.model.trim(), prompt: body.prompt, ...(body.maxTokens === undefined ? {} : { maxTokens: body.maxTokens }), idempotencyKey });
      await context.settings.set(GENERATION_REQUEST_SETTING, { idempotencyKey, jobId: accepted.job.id });
      return response(202, { ok: true, job: accepted.job, replayed: accepted.replayed });
    } catch (error) { return failGeneration(error); }
  });
  context.api.get('/generations/job', async request => {
    try { requireOperator(request); const saved = await savedRequest(); return response(200, { ok: true, job: saved?.jobId ? await context.models.generations.read(saved.jobId) : null }); }
    catch (error) { return failGeneration(error); }
  });
}

export async function activate(context) {
  registerImageExample(context);
  registerAgentTurnExample(context);
  registerGenerationExample(context);
  context.api.get('/status', async () => response(200, {
    ok: true,
    greeting: await context.settings.get('greeting', DEFAULT_GREETING),
    secretConfigured: await context.secrets.has('example-secret'),
  }));

  context.api.put('/configuration', async (request) => {
    try {
      requireOperator(request);
      const configuration = validateConfiguration(request.body);
      await context.settings.set('greeting', configuration.greeting);
      if (Object.hasOwn(configuration, 'secret')) {
        if (configuration.secret) await context.secrets.set('example-secret', configuration.secret);
        else await context.secrets.clear('example-secret');
      }
      return response(200, {
        ok: true,
        greeting: configuration.greeting,
        secretConfigured: await context.secrets.has('example-secret'),
      });
    } catch (error) {
      return response(Number(error?.statusCode) || 500, { ok: false, error: Number(error?.statusCode) ? error.message : 'internal_error' });
    }
  });

  context.tools.register({
    name: 'reference_greet',
    description: 'Return the configured example greeting for a supplied name.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['name']
    },
    async handler(argumentsValue, caller) {
      if (!plainObject(argumentsValue) || Object.keys(argumentsValue).length !== 1) throw new Error('invalid_arguments');
      const name = typeof argumentsValue.name === 'string' ? argumentsValue.name.trim() : '';
      if (!name || name.length > 80) throw new Error('invalid_arguments');
      if (caller?.signal?.aborted) throw new Error('cancelled');
      const greeting = await context.settings.get('greeting', DEFAULT_GREETING);
      return { ok: true, message: `${greeting} ${name}` };
    },
  });

  context.logger.info('Burrow Reference Mod activated');
  return () => context.logger.info('Burrow Reference Mod stopped');
}

export const referenceContract = Object.freeze({ DEFAULT_GREETING, MAX_GREETING_LENGTH, MAX_SECRET_LENGTH });
