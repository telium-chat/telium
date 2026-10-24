// The client doesn't verify the relocation record's signatures (peers do); it checks the held token works at the new name.

import { discover, request } from './api.js';

export async function findHomeRelocation(home) {
  let doc;
  try {
    doc = await request(home.base, 'GET', '/.well-known/telium/server');
  } catch {
    return null;
  }
  const to = doc?.moved_to;
  if (typeof to !== 'string' || !to || to === home.domain) return null;
  // Must be the old name's document naming this move, else a different server is answering.
  const record = doc.relocation;
  if (doc.server_name !== home.domain || record?.old_domain !== home.domain || record?.new_domain !== to) {
    return null;
  }
  try {
    const next = await discover(to);
    const domain = next.server_name || to;
    if (domain !== to) return null;
    const me = await request(next.api, 'GET', '/_telium/v1/whoami', { token: home.token });
    if (typeof me?.user_id !== 'string' || !me.user_id.endsWith(`:${domain}`)) return null;
    return {
      domain,
      base: next.api.replace(/\/$/, ''),
      gateway: next.gateway,
      user_id: me.user_id,
    };
  } catch {
    return null;
  }
}

export function relocateSession(session, moved) {
  const old = session.home.domain;
  const servers = { ...session.servers };
  if (servers[old]) {
    servers[moved.domain] = { ...servers[old], base: moved.base, gateway: moved.gateway };
    delete servers[old];
  }
  return {
    ...session,
    home: {
      ...session.home,
      domain: moved.domain,
      base: moved.base,
      user_id: moved.user_id,
      fallback: null,
    },
    servers,
  };
}
