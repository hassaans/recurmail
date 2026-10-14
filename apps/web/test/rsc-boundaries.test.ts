import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { type ComponentProps, createElement } from "react";
import { renderToString } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import ScheduleEditor from "../components/ScheduleEditor";
import ScheduleList from "../components/ScheduleList";

vi.stubGlobal("React", React);

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    back: vi.fn(),
    forward: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const expectedPages = [
  "app/(app)/schedules/new/page.tsx",
  "app/(app)/schedules/[id]/edit/page.tsx",
  "app/dashboard/page.tsx",
];

function readSource(relativePath: string): string {
  return readFileSync(path.join(webRoot, relativePath), "utf8");
}

function isClientComponent(relativePath: string): boolean {
  const source = ts.createSourceFile(
    relativePath,
    readSource(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const firstStatement = source.statements[0];
  return (
    firstStatement !== undefined &&
    ts.isExpressionStatement(firstStatement) &&
    ts.isStringLiteral(firstStatement.expression) &&
    firstStatement.expression.text === "use client"
  );
}

function importedClientComponents(
  pagePath: string,
  source: ts.SourceFile,
): Map<string, string> {
  const clientImports = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = statement.moduleSpecifier;
    if (!ts.isStringLiteral(moduleName) || !moduleName.text.startsWith("."))
      continue;
    const resolved = ts.resolveModuleName(
      moduleName.text,
      path.join(webRoot, pagePath),
      {},
      ts.sys,
    ).resolvedModule;
    if (!resolved) continue;
    const componentPath = resolved.resolvedFileName;
    const relativeComponentPath = path.relative(webRoot, componentPath);
    if (!isClientComponent(relativeComponentPath)) continue;

    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) clientImports.set(clause.name.text, relativeComponentPath);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        clientImports.set(element.name.text, relativeComponentPath);
      }
    }
  }
  return clientImports;
}

function nestedFunctionExpression(node: ts.Node): ts.Node | undefined {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  return ts.forEachChild(node, nestedFunctionExpression);
}

function functionPropsInPage(pagePath: string): string[] {
  const source = ts.createSourceFile(
    pagePath,
    readSource(pagePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const clientImports = importedClientComponents(pagePath, source);
  const violations: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName;
      const componentName = ts.isIdentifier(tagName) ? tagName.text : undefined;
      if (componentName && clientImports.has(componentName)) {
        for (const attribute of node.attributes.properties) {
          if (
            !ts.isJsxAttribute(attribute) ||
            !attribute.initializer ||
            !ts.isJsxExpression(attribute.initializer) ||
            !attribute.initializer.expression
          ) {
            continue;
          }
          if (nestedFunctionExpression(attribute.initializer.expression)) {
            violations.push(
              `${pagePath}: ${componentName} prop "${attribute.name.getText(source)}" contains a function expression`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return violations;
}

describe("server/client prop boundaries", () => {
  it("round-trips representative client component props through JSON", () => {
    const editorProps: ComponentProps<typeof ScheduleEditor> = {
      scheduleId: "c4a7b913-3d35-4c0d-8e7c-4c5d101f3f88",
    };
    const listProps: ComponentProps<typeof ScheduleList> = {
      warning: "Some schedules could not be loaded.",
    };

    expect(JSON.parse(JSON.stringify(editorProps))).toEqual(editorProps);
    expect(JSON.parse(JSON.stringify(listProps))).toEqual(listProps);
  });

  it("renders each client component with react-dom/server", () => {
    expect(
      renderToString(
        createElement(ScheduleEditor, { scheduleId: "schedule-123" }),
      ),
    ).toContain("Edit schedule");
    expect(
      renderToString(
        createElement(ScheduleList, { warning: "Check your connection." }),
      ),
    ).toContain("Check your connection.");
  });

  it("keeps the server pages passing only data to imported client components", () => {
    const violations = expectedPages.flatMap(functionPropsInPage);
    expect(violations).toEqual([]);
  });
});
