import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { listedMainFiles, mainModuleFiles } from "./helpers/main-source";

// electron/main.ts is the bootstrap only; the main process lives in electron/main/ (see
// docs/development.md, "Main process layout"). These keep it that way.
const root = path.join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const parse = (file: string) =>
  ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

function electronFiles(dir = "electron"): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "native" ? [] : electronFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Every relative module a file imports, resolved to a repository path without its extension. */
function relativeImports(file: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const spec =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments[0] &&
            ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : undefined;
    if (spec?.startsWith(".")) found.push(path.posix.join(path.posix.dirname(file), spec));
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return found;
}

/** What a module runs when it is imported: its top-level code, without the bodies of its functions. */
function importTimeNodes(file: string, each: (node: ts.Node) => void) {
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    each(node);
    ts.forEachChild(node, visit);
  };
  for (const statement of parse(file).statements) visit(statement);
}

test("electron/main.ts stays a bootstrap under 800 lines", () => {
  const lines = read("electron/main.ts").split("\n").length;
  assert.ok(lines < 800, `electron/main.ts has ${lines} lines`);
});

test("the tests read every main module, each once", () => {
  const listed = listedMainFiles();
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual(
    listed.filter((file) => file !== "electron/main.ts").sort(),
    mainModuleFiles().sort(),
  );
});

test("nothing imports the bootstrap", () => {
  for (const file of electronFiles())
    for (const target of relativeImports(file))
      assert.notEqual(target, "electron/main", `${file} imports electron/main.ts`);
});

test("no main module touches Electron's app while it is imported", () => {
  // Before main.ts sets the name, app.getPath and the like would answer for "Electron".
  for (const file of mainModuleFiles())
    importTimeNodes(file, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "app"
      )
        assert.fail(`${file} calls app.${node.expression.name.text}() at import`);
    });
});

test("no main module keeps a copy of a late-bound singleton", () => {
  // A module-level copy would keep the value from before startup set it: undefined.
  for (const file of mainModuleFiles()) {
    const source = parse(file);
    const fromState = new Set<string>();
    for (const statement of source.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        /^\.{1,2}\/(?:\.\.\/)*state$/.test(statement.moduleSpecifier.text)
      ) {
        const named = statement.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) for (const element of named.elements) fromState.add(element.name.text);
      }
    for (const statement of source.statements)
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (declaration.initializer && ts.isIdentifier(declaration.initializer))
            assert.ok(!fromState.has(declaration.initializer.text), `${file} copies ${declaration.initializer.text}`);
  }
});

test("the IPC handlers stay at the top of their registration functions", () => {
  // Tests find a handler's end at the next "\n  handle(".
  for (const file of mainModuleFiles().filter((name) => name.includes("/ipc/")))
    for (const line of read(file).split("\n"))
      if (/^\s*handle\("/.test(line)) assert.match(line, /^ {2}handle\("/, `${file}: ${line.trim()}`);
});
