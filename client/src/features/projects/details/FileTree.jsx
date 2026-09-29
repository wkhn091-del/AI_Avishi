import { ChevronDown, ChevronLeft, File, FileCode2, FileImage, FileText, Folder, FolderOpen } from 'lucide-react';
import { cx } from '../../../lib/cx.js';
import { colorFor } from '../projectVisuals.js';

const LANGUAGE_BY_EXTENSION = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less', vue: 'Vue', svelte: 'Svelte', go: 'Go',
  rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', cpp: 'C++', cc: 'C++', hpp: 'C++', c: 'C', h: 'C', php: 'PHP', rb: 'Ruby',
  dart: 'Dart', swift: 'Swift', lua: 'Lua', gd: 'GDScript', sh: 'Shell', ps1: 'PowerShell', sql: 'SQL', ipynb: 'Jupyter Notebook',
  shader: 'ShaderLab', glsl: 'GLSL', wgsl: 'WGSL',
};
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const TEXT = /\.(md|markdown|mdx|txt|rst|log|csv|json|ya?ml|toml|ini|env|lock)$/i;
const INDENT = 16;

/** Icon for a file, tinted with its language colour (the same colours as the fingerprint). */
export function FileIcon({ name }) {
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const language = LANGUAGE_BY_EXTENSION[extension];
  const Icon = IMAGE.test(name) ? FileImage : language ? FileCode2 : TEXT.test(name) ? FileText : File;
  return <Icon size={15} className="shrink-0" style={{ color: language ? colorFor(language) : 'var(--color-mist)' }} aria-hidden="true" />;
}

/** Row style shared by the tree and the filter results; the selected row gets a bar on its start edge. */
export const treeRowClass = (active) =>
  cx(
    'flex w-full items-center gap-2 border-s-2 py-[5px] pe-3 text-start text-[13.5px] transition-colors',
    active ? 'border-ink bg-sunken font-medium text-ink' : 'border-transparent text-graphite hover:bg-sunken/60 hover:text-ink',
  );

/** Folders (open on click) and files. Which folders are open and which file is selected live in FilesTab. */
export function FileTree({ node, depth = 0, expanded, onToggle, selected, onSelect }) {
  return (
    <ul>
      {node.children.map((child) => {
        if (child.type === 'dir') {
          const open = expanded.has(child.path);
          const Chevron = open ? ChevronDown : ChevronLeft;
          const FolderIcon = open ? FolderOpen : Folder;
          return (
            <li key={child.path}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onToggle(child.path)}
                className={treeRowClass(false)}
                style={{ paddingInlineStart: 10 + depth * INDENT }}
              >
                <Chevron size={14} className="shrink-0 text-mist" aria-hidden="true" />
                <FolderIcon size={15} className="shrink-0 text-graphite" aria-hidden="true" />
                <bdi className="truncate">{child.name}</bdi>
              </button>
              {open && (
                <FileTree node={child} depth={depth + 1} expanded={expanded} onToggle={onToggle} selected={selected} onSelect={onSelect} />
              )}
            </li>
          );
        }
        const active = child.path === selected;
        return (
          <li key={child.path}>
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(child.path)}
              className={treeRowClass(active)}
              style={{ paddingInlineStart: 10 + depth * INDENT + 22 }}
            >
              <FileIcon name={child.name} />
              <bdi className="truncate">{child.name}</bdi>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
