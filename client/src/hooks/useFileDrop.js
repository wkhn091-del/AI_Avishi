import { useEffect, useRef, useState } from 'react';

/**
 * Page-wide drag and drop of files. Returns true while files are dragged over
 * the window. Folders are ignored (only real files are passed to `onDrop`).
 *
 * @param {(files: File[]) => void} onDrop
 * @param {{ enabled?: boolean }} [options]
 */
export function useFileDrop(onDrop, { enabled = true } = {}) {
  const [isDragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handler = useRef(onDrop);

  useEffect(() => {
    handler.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    if (!enabled) return undefined;
    const carriesFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (event) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDropEvent = (event) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer.items ?? [])
        .filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (files.length) handler.current(files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDropEvent);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDropEvent);
      depth.current = 0;
      setDragging(false);
    };
  }, [enabled]);

  return isDragging;
}
