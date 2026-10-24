import { useMemo, useState } from 'react';
import { createDragDropManager } from 'dnd-core';
import { HTML5Backend } from 'react-dnd-html5-backend';

export function useDragRoot() {
  const [root, setRoot] = useState(null);
  const manager = useMemo(
    () => (root ? createDragDropManager(HTML5Backend, undefined, { rootElement: root }) : null),
    [root],
  );
  return [setRoot, manager];
}
