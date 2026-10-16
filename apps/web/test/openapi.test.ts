import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);
const requiredOperations = [
  ["/api/schedules", "get"],
  ["/api/schedules", "post"],
  ["/api/schedules/{id}", "get"],
  ["/api/schedules/{id}", "patch"],
  ["/api/schedules/{id}", "delete"],
  ["/api/schedules/{id}/pause", "post"],
  ["/api/schedules/{id}/resume", "post"],
  ["/api/schedules/pause-all", "post"],
  ["/api/schedules/test", "post"],
] as const;

interface Operation {
  responses: Record<string, unknown>;
}
interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<
      string,
      { properties?: Record<string, unknown>; anyOf?: { required: string[] }[] }
    >;
  };
}

function document(): OpenApiDocument {
  // JSON syntax is valid YAML. Requiring this subset lets every client load the
  // OpenAPI document without adding a YAML parser dependency to the tests.
  return JSON.parse(readFileSync(new URL("docs/openapi.yaml", root), "utf8"));
}

function exportedNames(source: string, filename: string) {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (!statement.isTypeOnly && !element.isTypeOnly)
            names.add(element.name.text);
        }
      }
      continue;
    }
    const exported =
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body
    ) {
      names.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

describe("US-005 root OpenAPI contract", () => {
  it("is a JSON-compatible YAML OpenAPI 3.1 document with API metadata", () => {
    const spec = document();
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
    expect(spec.info.title).toEqual(expect.any(String));
    expect(spec.info.title.length).toBeGreaterThan(0);
    expect(spec.info.version).toEqual(expect.any(String));
    expect(spec.info.version.length).toBeGreaterThan(0);
    expect(spec.paths).toEqual(expect.any(Object));
  });

  it.each(requiredOperations)("documents %s %s", (path, method) => {
    const operation = document().paths[path]?.[method] as Operation | undefined;
    expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
    expect(operation?.responses).toEqual(expect.any(Object));
    expect(Object.keys(operation?.responses ?? {}).length).toBeGreaterThan(0);
  });

  it("accepts a patch that changes only the sending account, like every other SchedulePatch field", () => {
    const patch = document().components.schemas.SchedulePatch;
    const fields = Object.keys(patch.properties ?? {});
    expect(fields).toContain("gmail_connection_id");
    // The anyOf lists the single-field patches the route accepts. A field in
    // properties but missing here would be rejected on its own.
    const alternatives = (patch.anyOf ?? []).map((branch) => branch.required);
    expect(alternatives).toContainEqual(["gmail_connection_id"]);
    for (const field of fields) expect(alternatives).toContainEqual([field]);
    expect(alternatives.flat().sort()).toEqual([...fields].sort());
  });

  it("maps every documented HTTP operation to a route exporting its method", () => {
    let checked = 0;
    for (const [path, item] of Object.entries(document().paths)) {
      // Path-level parameters, descriptions and extensions are not operations.
      for (const method of Object.keys(item).filter((key) =>
        methods.has(key),
      )) {
        expect(path.startsWith("/")).toBe(true);
        const routePath = path.replace(/\{([^}]+)\}/g, "[$1]");
        const routeUrl = new URL(`apps/web/app${routePath}/route.ts`, root);
        const filename = fileURLToPath(routeUrl);
        const source = readFileSync(routeUrl, "utf8");
        expect(
          exportedNames(source, filename).has(method.toUpperCase()),
          `${method.toUpperCase()} ${path} must be exported by ${filename}`,
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(requiredOperations.length);
  });
});
