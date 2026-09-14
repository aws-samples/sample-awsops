import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('type-checks the actual DB pool and observer against the locked pg declarations', () => {
  const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, projectDirectory, undefined, configPath);
  expect(parsed.errors).toEqual([]);

  // Compile the production sources and their imports, without unrelated test files.
  // Unlike transpileModule, this checks the PoolConfig.Client assignment and subclass types.
  const program = ts.createProgram({
    rootNames: ['db.ts', 'db-connection.ts'].map(name => fileURLToPath(new URL(name, import.meta.url))),
    options: { ...parsed.options, noEmit: true, incremental: false },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => projectDirectory,
    getNewLine: () => '\n',
  });
  expect(diagnostics.length, formatted).toBe(0);
}, 30_000);
