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

export async function activate(context) {
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
