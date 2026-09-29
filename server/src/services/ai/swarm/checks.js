/**
 * The QA compiler's deterministic half: checks that need no model, run on every file in every round.
 * Babel's parser reads each JavaScript and TypeScript file, so these findings are facts, not opinions:
 *  - syntax errors, with the line;
 *  - relative imports that resolve to no file of the project, and named imports the target doesn't
 *    export (reported on the file that must change: the target when the blueprint promised that
 *    export, the importer otherwise);
 *  - packages a file imports that no package.json above it lists (the controller adds those);
 *  - names used but never defined or imported (JavaScript and JSX; TypeScript's types would need its compiler);
 *  - placeholders: "TODO", "add logic here", "rest of the code" and the like in comments, and
 *    "not implemented" errors;
 *  - exports the blueprint promised that the file doesn't have, and planned files never written;
 *  - JSON that doesn't parse, CSS with unbalanced braces, HTML loading files that don't exist, empty files.
 */
import path from 'node:path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import globals from 'globals';
import { CODE_EXTENSIONS, declares, extOf, isLocal, manifestsAbove, packageOf, resolveImport, rootsOf } from './blueprint.js';

const traverse = traverseModule.default ?? traverseModule;
const posix = path.posix;

const ENVIRONMENT = new Set([
  ...['builtin', 'browser', 'node', 'worker', 'serviceworker', 'sharednodebrowser'].flatMap((name) => Object.keys(globals[name] ?? {})),
  'globalThis', 'undefined', 'NaN', 'Infinity', 'arguments', 'require', 'module', 'exports', '__dirname', '__filename',
]);
const TEST_GLOBALS = new Set([...['jest', 'mocha', 'vitest'].flatMap((name) => Object.keys(globals[name] ?? {})), 'vi', 'expect', 'describe', 'it', 'test', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const isTestFile = (file) => /(^|\/)(__tests__|tests?)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);

// Words that mean the code isn't there. Upper-case markers only: a "todo" app's comments are fine.
export const PLACEHOLDERS = [
  /\bTODO\b|\bFIXME\b|\bXXX\b|@todo\b/,
  /\b(add|insert|put|write|implement|place)\s+(your|the|more|actual|real|additional|remaining|any)?\s*(own\s+)?(logic|code|implementation|functionality|handlers?|content)\s+here\b/i,
  /\b(logic|code|implementation|functionality)\s+(goes|would go|will go)\s+here\b/i,
  /\b(rest|remainder)\s+of\s+(the\s+)?(code|file|implementation|logic|component|function|module|class|styles?|rules|markup)\b/i,
  /\bnot\s+(yet\s+)?implemented\b/i,
  /\bplaceholder\s+(for|implementation|logic|code|function)\b/i,
  /^\s*(\.{3}|…)\s*$/,
  /(\.{3}|…)\s*(existing|previous|same as|unchanged|more code|rest)\b/i,
  /\b(for brevity|omitted for|left as an exercise|simplified (version|implementation)|in a real (app|application|project|implementation))\b/i,
];
const NOT_IMPLEMENTED = /\bnot\s+(yet\s+)?implemented\b|\bTODO\b|\bimplement\s+me\b/i;
export const placeholderIn = (text) => PLACEHOLDERS.some((pattern) => pattern.test(text));
const short = (text, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text).replace(/\s+/g, ' ');
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const nameOf = (node) => (node?.type === 'StringLiteral' ? node.value : node?.name);

function declaredNames(node) {
  if (!node) return [];
  if (node.id?.name && /Declaration$/.test(node.type)) return [node.id.name];
  if (node.type === 'VariableDeclaration') return node.declarations.flatMap((item) => patternNames(item.id));
  return [];
}
function patternNames(node) {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ObjectPattern') return node.properties.flatMap((item) => patternNames(item.type === 'RestElement' ? item.argument : item.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap((item) => patternNames(item));
  if (node.type === 'RestElement') return patternNames(node.argument);
  if (node.type === 'AssignmentPattern') return patternNames(node.left);
  return [];
}

/** What one script file declares, imports and gets wrong on its own. */
function analyzeScript(file, code) {
  const ext = extOf(file);
  const typescript = ['.ts', '.tsx', '.mts', '.cts'].includes(ext);
  const plugins = typescript ? (ext === '.tsx' ? ['typescript', 'jsx'] : ['typescript']) : ['jsx'];
  const result = { issues: [], imports: [], exports: { names: new Set(), default: false, star: false, commonjs: false } };
  let ast;
  try {
    ast = parse(code, { sourceType: 'unambiguous', errorRecovery: true, allowAwaitOutsideFunction: true, plugins });
  } catch (error) {
    result.issues.push({ kind: 'syntax', line: error.loc?.line ?? null, message: `Syntax error: ${error.message.replace(/\s*\(\d+:\d+\)$/, '')}.` });
    result.exports = null; // unknown: importers aren't judged by it
    return result;
  }
  for (const error of ast.errors ?? []) result.issues.push({ kind: 'syntax', line: error.loc?.line ?? null, message: `Syntax error: ${error.message.replace(/\s*\(\d+:\d+\)$/, '')}.` });

  const { names } = result.exports;
  for (const node of ast.program.body) {
    const line = node.loc?.start.line ?? null;
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
      const specifiers = node.specifiers.filter((item) => item.importKind !== 'type');
      const named = specifiers.filter((item) => item.type === 'ImportSpecifier').map((item) => nameOf(item.imported));
      result.imports.push({
        from: node.source.value,
        line,
        default: specifiers.some((item) => item.type === 'ImportDefaultSpecifier') || named.includes('default'),
        names: named.filter((name) => name !== 'default'),
      });
    } else if (node.type === 'ExportNamedDeclaration' && node.exportKind !== 'type') {
      for (const name of declaredNames(node.declaration)) names.add(name);
      for (const item of node.specifiers ?? []) {
        const exported = nameOf(item.exported);
        if (exported === 'default') result.exports.default = true;
        else names.add(exported);
      }
      if (node.source) {
        const local = (node.specifiers ?? []).filter((item) => item.type === 'ExportSpecifier').map((item) => nameOf(item.local));
        result.imports.push({ from: node.source.value, line, default: local.includes('default'), names: local.filter((name) => name !== 'default') });
      }
    } else if (node.type === 'ExportDefaultDeclaration') result.exports.default = true;
    else if (node.type === 'ExportAllDeclaration' && node.exportKind !== 'type') {
      result.exports.star = true;
      result.imports.push({ from: node.source.value, line, default: false, names: [] });
    } else if (node.type === 'TSExportAssignment') result.exports.commonjs = true;
  }

  const tests = isTestFile(file);
  const undefinedNames = new Map();
  traverse(ast, {
    CallExpression(item) {
      const { callee, arguments: args } = item.node;
      if (args[0]?.type !== 'StringLiteral') return;
      if (callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require' && !item.scope.hasBinding('require'))) {
        result.imports.push({ from: args[0].value, line: item.node.loc?.start.line ?? null, default: false, names: [] });
      }
    },
    ImportExpression(item) {
      if (item.node.source?.type === 'StringLiteral') result.imports.push({ from: item.node.source.value, line: item.node.loc?.start.line ?? null, default: false, names: [] });
    },
    AssignmentExpression(item) {
      const left = item.node.left;
      if (left.type !== 'MemberExpression') return;
      const root = left.object.type === 'MemberExpression' ? left.object.object : left.object;
      if (root.type === 'Identifier' && (root.name === 'module' || root.name === 'exports') && !item.scope.hasBinding(root.name)) result.exports.commonjs = true;
    },
    ThrowStatement(item) {
      const argument = item.node.argument;
      const message = argument?.type === 'NewExpression' || argument?.type === 'CallExpression' ? argument.arguments?.[0] : argument;
      const text = message?.type === 'StringLiteral' ? message.value : message?.type === 'TemplateLiteral' ? message.quasis.map((part) => part.value.cooked).join('') : '';
      if (text && NOT_IMPLEMENTED.test(text)) result.issues.push({ kind: 'placeholder', line: item.node.loc?.start.line ?? null, message: `Throws "${short(text)}": implement it instead.` });
    },
    ReferencedIdentifier(item) {
      if (typescript) return;
      const name = item.node.name;
      if (item.isJSXIdentifier()) {
        const objectOfMember = item.parentPath.isJSXMemberExpression() && item.parentPath.node.object === item.node;
        if (!objectOfMember && (!/^[A-Z]/.test(name) || name.includes('-'))) return; // <div>, <my-element>
      }
      if (item.parentPath.isUnaryExpression({ operator: 'typeof' })) return;
      if (item.scope.hasBinding(name, true) || ENVIRONMENT.has(name) || (tests && TEST_GLOBALS.has(name))) return;
      if (!undefinedNames.has(name)) undefinedNames.set(name, item.node.loc?.start.line ?? null);
    },
  });
  for (const [name, line] of undefinedNames) result.issues.push({ kind: 'undefined', line, message: `"${name}" is used but never defined or imported.` });
  for (const comment of ast.comments ?? []) {
    if (placeholderIn(comment.value)) result.issues.push({ kind: 'placeholder', line: comment.loc?.start.line ?? null, message: `Placeholder comment "${short(comment.value.trim())}": write the real code.` });
  }
  return result;
}

function analyzeCss(code) {
  const issues = [];
  const imports = [];
  // Braces inside comments and strings don't count.
  const plain = code.replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' ')).replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (text) => text.replace(/[{}]/g, ' '));
  let depth = 0;
  let line = 1;
  for (const char of plain) {
    if (char === '\n') line += 1;
    else if (char === '{') depth += 1;
    else if (char === '}' && (depth -= 1) < 0) {
      issues.push({ kind: 'syntax', line, message: 'A "}" closes nothing.' });
      depth = 0;
    }
  }
  if (depth > 0) issues.push({ kind: 'syntax', line: null, message: `${depth} "{" never closed.` });
  for (const match of code.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    if (placeholderIn(match[1])) issues.push({ kind: 'placeholder', line: lineAt(code, match.index), message: `Placeholder comment "${short(match[1].trim())}": write the real styles.` });
  }
  for (const match of code.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/g)) imports.push({ from: match[1], line: lineAt(code, match.index), default: false, names: [] });
  return { issues, imports };
}

function analyzeHtml(code) {
  const issues = [];
  const imports = [];
  for (const match of code.matchAll(/<(script|link|img|source)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const target = match[3];
    if (/^(https?:|\/\/|data:|mailto:|tel:|#)/i.test(target) || target.includes('{')) continue;
    imports.push({ from: target.startsWith('/') || target.startsWith('.') ? target : `./${target}`, line: lineAt(code, match.index), default: false, names: [], html: true });
  }
  for (const match of code.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (placeholderIn(match[1])) issues.push({ kind: 'placeholder', line: lineAt(code, match.index), message: `Placeholder comment "${short(match[1].trim())}": write the real markup.` });
  }
  return { issues, imports };
}

const exportList = (exports) => [...(exports.default ? ['default'] : []), ...exports.names].join(', ') || 'nothing';

/**
 * Checks a whole project.
 * @param {Map<string, string>} files  path → content, the package.json files included
 * @param {object} blueprint
 * @returns {{ issues: Map<string, Array<object>>, missingPackages: Map<string, Set<string>>, dependents: Map<string, Set<string>> }}
 *   `missingPackages` is per package.json; `dependents` maps a file to the files that import it.
 */
export function checkProject(files, blueprint) {
  const paths = new Set(files.keys());
  const roots = rootsOf(blueprint, [...paths]);
  const planned = new Map(blueprint.files.map((file) => [file.path, file]));
  const issues = new Map();
  const missingPackages = new Map();
  const dependents = new Map();
  const add = (file, issue) => {
    const list = issues.get(file) ?? [];
    if (!list.some((item) => item.message === issue.message)) list.push({ source: 'compiler', ...issue });
    issues.set(file, list);
  };

  const analyses = new Map();
  for (const [file, code] of files) {
    if (!String(code ?? '').trim()) {
      add(file, { kind: 'incomplete', line: null, message: 'The file is empty.' });
      continue;
    }
    const ext = extOf(file);
    let analysis = null;
    if (CODE_EXTENSIONS.has(ext)) analysis = analyzeScript(file, code);
    else if (ext === '.json') {
      try {
        JSON.parse(code);
        analysis = { issues: [], imports: [] };
      } catch (error) {
        analysis = { issues: [{ kind: 'syntax', line: null, message: `Invalid JSON: ${error.message}.` }], imports: [] };
      }
    } else if (ext === '.css' || ext === '.scss') analysis = analyzeCss(code);
    else if (ext === '.html' || ext === '.htm') analysis = analyzeHtml(code);
    if (!analysis) continue;
    analyses.set(file, analysis);
    for (const issue of analysis.issues) add(file, issue);
  }

  for (const [file, analysis] of analyses) {
    for (const item of analysis.imports) {
      const specifier = item.from;
      if (!specifier || specifier.startsWith('virtual:') || specifier.startsWith('data:')) continue;
      if (/^(https?:)?\/\//i.test(specifier)) {
        if (CODE_EXTENSIONS.has(extOf(file))) add(file, { kind: 'dependency', line: item.line, message: `Imports "${specifier}" from a URL: use an npm package from package.json.` });
        continue;
      }
      if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
        add(file, { kind: 'import', line: item.line, message: `Imports "${specifier}" through a path alias: use a relative path.` });
        continue;
      }
      if (isLocal(specifier)) {
        const target = resolveImport(file, specifier, paths, roots);
        if (!target) {
          add(file, { kind: 'import', line: item.line, message: `${item.html ? 'Loads' : 'Imports'} "${specifier}", but no such file is in the project.` });
          continue;
        }
        if (!dependents.has(target)) dependents.set(target, new Set());
        dependents.get(target).add(file);
        const other = analyses.get(target);
        if (!other?.exports || other.exports.star || other.exports.commonjs) continue;
        for (const name of [...(item.default ? ['default'] : []), ...item.names]) {
          if (name === 'default' ? other.exports.default : other.exports.names.has(name)) continue;
          // A promised export is the target's to add (reported below); anything else is the importer's mistake.
          if (planned.get(target)?.exports.some((promised) => promised.name === name)) continue;
          add(file, { kind: 'import', line: item.line, message: `Imports ${name === 'default' ? 'a default export' : `"${name}"`} from "${specifier}", but ${target} doesn't export it (it exports: ${exportList(other.exports)}).` });
        }
        continue;
      }
      const pkg = packageOf(specifier);
      if (pkg.builtin || declares(file, pkg.name, blueprint.packages)) continue;
      const manifest = manifestsAbove(file, blueprint.packages)[0];
      if (!manifest) add(file, { kind: 'dependency', line: item.line, message: `Uses the package "${pkg.name}", but the project has no package.json.` });
      else {
        if (!missingPackages.has(manifest.path)) missingPackages.set(manifest.path, new Set());
        missingPackages.get(manifest.path).add(pkg.name);
      }
    }
  }

  for (const [file, plan] of planned) {
    if (!files.has(file)) {
      add(file, { kind: 'missing', line: null, message: 'The file was never written.' });
      continue;
    }
    const exports = analyses.get(file)?.exports;
    if (!exports || exports.star || exports.commonjs) continue;
    for (const promised of plan.exports) {
      if (promised.name === 'default' ? exports.default : exports.names.has(promised.name)) continue;
      add(file, { kind: 'contract', line: null, message: `Must export "${promised.name}"${promised.signature ? ` (${promised.signature})` : ''} as the blueprint says, but doesn't.` });
    }
  }
  return { issues, missingPackages, dependents };
}

/** How many of a file's problems are syntax errors: a fix may not add any. */
export const syntaxErrors = (list = []) => list.filter((issue) => issue.kind === 'syntax').length;
export { posix };
