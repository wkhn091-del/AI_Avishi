/**
 * Visual vocabulary for projects: kind labels/icons and the colours used by
 * the fingerprint. Language colours are mid-tones picked to read on both the
 * light and dark themes; non-code categories use theme-aware neutrals.
 */
import {
  Bot, BrainCircuit, CodeXml, Gamepad2, Globe, Monitor, Package, Puzzle, Server, Smartphone, Terminal,
} from 'lucide-react';

export const KINDS = {
  web: { label: 'אפליקציית ווב', icon: Globe },
  api: { label: 'שירות צד שרת', icon: Server },
  mobile: { label: 'אפליקציה לנייד', icon: Smartphone },
  desktop: { label: 'אפליקציית דסקטופ', icon: Monitor },
  game: { label: 'משחק', icon: Gamepad2 },
  extension: { label: 'תוסף לדפדפן', icon: Puzzle },
  bot: { label: 'צ׳אט בוט', icon: Bot },
  ml: { label: 'למידת מכונה', icon: BrainCircuit },
  cli: { label: 'כלי שורת פקודה', icon: Terminal },
  library: { label: 'ספרייה', icon: Package },
  code: { label: 'קוד', icon: CodeXml },
};

export const kindOf = (kind) => KINDS[kind] ?? KINDS.code;

export const LANGUAGE_COLORS = {
  TypeScript: '#2f74d0',
  JavaScript: '#e2b31f',
  Python: '#2a9d8f',
  HTML: '#e4572e',
  CSS: '#8b5cf6',
  SCSS: '#c6538c',
  Less: '#4f63ae',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Astro: '#ff7a3d',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Scala: '#c22d40',
  Swift: '#f05138',
  'Objective-C': '#438eff',
  C: '#7b8794',
  'C++': '#d04c88',
  'C#': '#2e9a48',
  'F#': '#b845fc',
  Go: '#00add8',
  Rust: '#c8693f',
  Dart: '#0db7a6',
  PHP: '#7a86b8',
  Ruby: '#cc342d',
  Lua: '#4f5fd0',
  GDScript: '#478cbf',
  Shell: '#6db33f',
  PowerShell: '#3a73c0',
  Batchfile: '#9dbb2f',
  SQL: '#e38c00',
  'Jupyter Notebook': '#da5b0b',
  R: '#198ce7',
  Julia: '#a270ba',
  Elixir: '#8e6aa0',
  Haskell: '#7d6fc0',
  Zig: '#ec915c',
  Solidity: '#8a8aa8',
  GLSL: '#5686a5',
  WGSL: '#3b7bbf',
  HLSL: '#8fb452',
  ShaderLab: '#6b7f99',
};

const CATEGORY_COLORS = {
  docs: 'var(--fp-docs)',
  data: 'var(--fp-data)',
  asset: 'var(--fp-asset)',
  other: 'var(--fp-other)',
};

export const CATEGORY_LABELS = { docs: 'תיעוד', data: 'נתונים ותצורה', asset: 'משאבים', other: 'אחר' };

/** Colour for a fingerprint category: language colour, neutral, or a stable hue for unknown languages. */
export function colorFor(category) {
  if (LANGUAGE_COLORS[category]) return LANGUAGE_COLORS[category];
  if (CATEGORY_COLORS[category]) return CATEGORY_COLORS[category];
  let hash = 0;
  for (const char of String(category)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 52% 52%)`;
}

export const isLanguage = (name) => Boolean(LANGUAGE_COLORS[name]);
