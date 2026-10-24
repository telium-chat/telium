import * as real from '@serenity-kit/opaque/esm/index.js';

// Test-only: cheap argon2id; aliased in vite.config.js.
const keyStretching = { 'argon2id-custom': { iterations: 1, memory: 8, parallelism: 1 } };

export const ready = real.ready;
export const server = real.server;
export const client = {
  ...real.client,
  finishRegistration: (params) => real.client.finishRegistration({ ...params, keyStretching }),
  finishLogin: (params) => real.client.finishLogin({ ...params, keyStretching }),
};
export default { ready, server, client };
