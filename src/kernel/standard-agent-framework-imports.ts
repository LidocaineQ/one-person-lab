import fs from 'node:fs';
import path from 'node:path';

const JAVASCRIPT_SOURCE_GLOBS = ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'];
const PYTHON_SOURCE_GLOBS = ['**/*.py'];
const SOURCE_EXCLUDES = [
  '**/.git/**',
  '**/.venv/**',
  '**/build/**',
  '**/dist/**',
  '**/node_modules/**',
  'src/opl_framework/**',
];

function sourceFiles(agentRoot: string, globs: string[]) {
  return fs.globSync(globs, {
    cwd: agentRoot,
    exclude: SOURCE_EXCLUDES,
  });
}

function javascriptFrameworkExports(source: string) {
  const matches = [
    ...source.matchAll(/\bfrom\s+(['"])opl-framework(\/[^'"]+)?\1/g),
    ...source.matchAll(/\bimport\s*\(\s*(['"])opl-framework(\/[^'"]+)?\1/g),
    ...source.matchAll(/\bimport\s+(['"])opl-framework(\/[^'"]+)?\1/g),
    ...source.matchAll(/\brequire\s*\(\s*(['"])opl-framework(\/[^'"]+)?\1/g),
  ];
  return matches.map((match) => match[2] ? `.${match[2]}` : '.');
}

export function inspectStandardAgentFrameworkImports(agentRoot: string) {
  const javascriptFiles = sourceFiles(agentRoot, JAVASCRIPT_SOURCE_GLOBS);
  const requiredExports = [...new Set(javascriptFiles.flatMap((relativePath) => {
    const source = fs.readFileSync(path.join(agentRoot, relativePath), 'utf8');
    return javascriptFrameworkExports(source);
  }))].sort();
  const pythonFiles = sourceFiles(agentRoot, PYTHON_SOURCE_GLOBS);
  const hasPythonImport = pythonFiles.some((relativePath) => {
    const source = fs.readFileSync(path.join(agentRoot, relativePath), 'utf8');
    return /(?:from|import)\s+opl_framework(?:\.|\s|$)/m.test(source);
  });
  return {
    hasJavaScriptImport: requiredExports.length > 0,
    hasPythonImport,
    requiredExports,
  };
}
