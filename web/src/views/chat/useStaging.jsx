import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportError } from '../../hooks/useToast.jsx';
import { t } from '../../lib/i18n/index.js';

let seq = 0;

function previewable(file) {
  const type = file.type || '';
  return type.startsWith('image/') || type.startsWith('video/');
}

export function useStagedFiles(surface) {
  const [items, setItems] = useState([]);

  const urls = useRef(new Set());
  const mint = useCallback((file) => {
    const url = URL.createObjectURL(file);
    urls.current.add(url);
    return url;
  }, []);
  const release = useCallback((list) => {
    for (const entry of list || []) {
      if (entry?.preview && urls.current.delete(entry.preview)) {
        URL.revokeObjectURL(entry.preview);
      }
    }
  }, []);
  useEffect(() => {
    const held = urls.current;
    return () => {
      held.forEach((url) => URL.revokeObjectURL(url));
      held.clear();
    };
  }, []);

  const add = useCallback(async (files, opts = {}) => {
    const picked = [...(files || [])].filter(Boolean);
    if (!picked.length) return;
    const entries = picked.map((file) => {
      seq += 1;
      return {
        key: `staged-${seq}`,
        file,
        name: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        preview: previewable(file) ? mint(file) : null,
        status: 'uploading',
        progress: 0,
        att: null,
      };
    });
    setItems((was) => [...was, ...entries]);

    for (const entry of entries) {
      try {
        const att = await surface.upload(entry.file, {
          ttlSecs: opts.ttlSecs,
          externalHost: opts.externalHost || null,
          onProgress: (loaded, total) => setItems((was) => was.map((item) => (
            item.key === entry.key
              ? { ...item, progress: total ? Math.round((loaded / total) * 100) : 0 }
              : item
          ))),
        });
        setItems((was) => was.map((item) => (
          item.key === entry.key ? { ...item, status: 'ready', progress: 100, att } : item
        )));
      } catch (e) {
        reportError(e, t('chat.staged.uploadFailed', { name: entry.name }));
        release([entry]);
        setItems((was) => was.filter((item) => item.key !== entry.key));
      }
    }
  }, [surface, mint, release]);

  const remove = useCallback((key) => setItems((was) => {
    release(was.filter((item) => item.key === key));
    return was.filter((item) => item.key !== key);
  }), [release]);

  const rename = useCallback((key, next) => {
    const name = String(next || '').trim();
    if (!name) return;
    setItems((was) => was.map((item) => {
      if (item.key !== key) return item;
      let att = item.att;
      if (att) {
        att = { ...att, name };
        if ('filename' in item.att) att.filename = name;
      }
      return { ...item, name, att };
    }));
  }, []);

  const clear = useCallback(() => setItems([]), []);
  const restore = useCallback((list) => setItems(list || []), []);
  const drop = useCallback((list) => {
    release(list);
    setItems([]);
  }, [release]);

  const staged = useMemo(() => items.filter((i) => i.att).map((i) => i.att), [items]);

  return useMemo(
    () => ({ items, staged, add, remove, rename, clear, drop, restore, release }),
    [items, staged, add, remove, rename, clear, drop, restore, release],
  );
}

export function useFileDrop({ active, onFiles }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const held = useRef(onFiles);
  held.current = onFiles;

  useEffect(() => {
    if (!active) {
      depth.current = 0;
      setOver(false);
      return undefined;
    }

    const isFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
      || Boolean(e.dataTransfer?.files?.length);

    const enter = (e) => {
      if (!isFiles(e)) return;
      depth.current += 1;
      setOver(true);
    };
    const leave = (e) => {
      if (!isFiles(e)) return;
      if (!e.relatedTarget) {
        depth.current = 0;
        setOver(false);
        return;
      }
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const over_ = (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const drop = (e) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) held.current?.(files);
    };

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over_);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over_);
      window.removeEventListener('drop', drop);
      depth.current = 0;
    };
  }, [active]);

  return over;
}
