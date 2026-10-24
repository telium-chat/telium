
export const LOOKUP_MODES = ['hover', 'open', 'never'];

/// Changing this changes a privacy default.
export const DEFAULT_LOOKUPS = 'open';

/// Unset or unrecognised values resolve to the default, never to more spending.
export function normalizeLookups(value) {
  return LOOKUP_MODES.includes(value) ? value : DEFAULT_LOOKUPS;
}

export function lookupAllowed(mode, trigger) {
  if (normalizeLookups(mode) === 'never') return false;
  if (trigger !== 'hover') return true;
  return normalizeLookups(mode) === 'hover';
}
