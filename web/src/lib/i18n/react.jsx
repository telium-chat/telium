// React's half of the translation layer; no provider.

import { cloneElement, isValidElement, useSyncExternalStore } from 'react';
import { activeDirection, activeLocale, localeVersion, onLocaleChange, t, tParts } from './index.js';

/// The snapshot is a version counter, not the tag, because pseudolocale re-seeding and HMR change strings without changing the tag.
export function useT() {
  useSyncExternalStore(onLocaleChange, localeVersion, localeVersion);
  return t;
}

export function useLocale() {
  useSyncExternalStore(onLocaleChange, localeVersion, localeVersion);
  return { locale: activeLocale(), dir: activeDirection() };
}

/// A sentence with elements in it; fragment keys would hardcode English word order.
export function Trans({ k, values, components }) {
  useSyncExternalStore(onLocaleChange, localeVersion, localeVersion);
  return toNodes(tParts(k, values), components || {}, `${k}:`);
}

function toNodes(parts, components, prefix) {
  const nodes = [];
  parts.forEach((part, index) => {
    if (part.type === 'text') { nodes.push(part.value); return; }
    const children = toNodes(part.children, components, `${prefix}${index}:`);
    const element = components[part.name];
    if (!isValidElement(element)) { nodes.push(...children); return; }
    const key = `${prefix}${index}`;
    // Two calls, not a conditional third argument: `undefined` children to `cloneElement` replace the element's own children.
    nodes.push(children.length
      ? cloneElement(element, { key }, children)
      : cloneElement(element, { key }));
  });
  if (nodes.length === 1 && typeof nodes[0] === 'string') return nodes[0];
  return nodes;
}
