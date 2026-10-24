
export function activeSunset(record) {
  if (!record || typeof record !== 'object') return null;
  if (!record.mode || record.mode === 'none') return null;
  return record;
}

export function describeSunset(record, now = Date.now()) {
  const sunset = activeSunset(record);
  if (!sunset || sunset.mode !== 'shutdown') return null;
  const domain = sunset.domain || 'Your home server';
  if (sunset.finalized) {
    return `${domain} has shut down. You can still download a copy of your account `
      + 'in Settings, Account.';
  }
  const when = sunset.effective_at && sunset.effective_at > now
    ? `on ${new Date(sunset.effective_at).toLocaleString()}`
    : 'now';
  return `${domain} is shutting down ${when}. To keep using Telium, move your account `
    + 'to another server before then, or download a copy of it, in Settings, Account.';
}
