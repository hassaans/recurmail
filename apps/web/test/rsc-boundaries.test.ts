import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { type ComponentProps, createElement } from "react";
import { renderToString } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import ConfirmForm from "../components/ConfirmForm";
import ScheduleEditor from "../components/ScheduleEditor";
import ScheduleList from "../components/ScheduleList";
import SchedulePauseButton from "../components/SchedulePauseButton";

type HasFunction<T> = T extends (...args: never[]) => unknown
  ? true
  : T extends readonly (infer Item)[]
    ? HasFunction<Item>
    : T extends object
      ? true extends {
          [Key in keyof T]-?: HasFunction<T[Key]>;
        }[keyof T]
        ? true
        : false
      : false;
type Assert<T extends true> = T;

type ScheduleEditorPropsAreDataOnly = Assert<
  HasFunction<ComponentProps<typeof ScheduleEditor>> extends false
    ? true
    : false
>;
type ScheduleListPropsAreDataOnly = Assert<
  HasFunction<ComponentProps<typeof ScheduleList>> extends false ? true : false
>;
type ConfirmFormPropsAreDataOnly = Assert<
  HasFunction<ComponentProps<typeof ConfirmForm>> extends false ? true : false
>;
type SchedulePauseButtonPropsAreDataOnly = Assert<
  HasFunction<ComponentProps<typeof SchedulePauseButton>> extends false
    ? true
    : false
>;

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
  "app/(app)/schedules/[id]/page.tsx",
  "app/(app)/settings/page.tsx",
  "app/dashboard/page.tsx",
];

const listProps: ComponentProps<typeof ScheduleList> = {
  initialSchedules: [
    {
      id: "c4a7b913-3d35-4c0d-8e7c-4c5d101f3f88",
      subject: "Weekly check-in",
      recipients: "one@example.test and two@example.test",
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=15;BYSECOND=0",
      timezone: "Asia/Karachi",
      status: "active",
      next_send_at: "2026-10-19T04:15:00.000Z",
    },
  ],
  connectionStatus: "connected",
  loadError: false,
};
const confirmFormProps: ComponentProps<typeof ConfirmForm> = {
  trigger: "Disconnect",
  triggerStyle: "dangerQuiet",
  title: "Disconnect Gmail?",
  description: "Every schedule will pause.",
  confirmLabel: "Disconnect Gmail",
  pendingLabel: "Disconnecting…",
  action: "/api/gmail/disconnect",
  tone: "danger",
};
const pauseButtonProps: ComponentProps<typeof SchedulePauseButton> = {
  scheduleId: "c4a7b913-3d35-4c0d-8e7c-4c5d101f3f88",
  subject: "Weekly check-in",
  status: "paused",
};

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
  it("keeps client component props data-only at compile time", () => {
    const editorPropsAreDataOnly: ScheduleEditorPropsAreDataOnly = true;
    const listPropsAreDataOnly: ScheduleListPropsAreDataOnly = true;
    const confirmFormPropsAreDataOnly: ConfirmFormPropsAreDataOnly = true;
    const pauseButtonPropsAreDataOnly: SchedulePauseButtonPropsAreDataOnly = true;

    expect(editorPropsAreDataOnly).toBe(true);
    expect(listPropsAreDataOnly).toBe(true);
    expect(confirmFormPropsAreDataOnly).toBe(true);
    expect(pauseButtonPropsAreDataOnly).toBe(true);
  });

  it("round-trips representative client component props through JSON", () => {
    const editorProps: ComponentProps<typeof ScheduleEditor> = {
      scheduleId: "c4a7b913-3d35-4c0d-8e7c-4c5d101f3f88",
    };

    expect(JSON.parse(JSON.stringify(editorProps))).toEqual(editorProps);
    expect(JSON.parse(JSON.stringify(listProps))).toEqual(listProps);
    expect(JSON.parse(JSON.stringify(confirmFormProps))).toEqual(
      confirmFormProps,
    );
    expect(JSON.parse(JSON.stringify(pauseButtonProps))).toEqual(
      pauseButtonProps,
    );
  });

  it("renders each client component with react-dom/server", () => {
    expect(
      renderToString(
        createElement(ScheduleEditor, { scheduleId: "schedule-123" }),
      ),
    ).toContain("Edit schedule");
    const list = renderToString(createElement(ScheduleList, listProps));
    expect(list).toContain("Weekly check-in");
    expect(list).toContain("Every week on Monday at 9:15 AM");
    expect(list).toContain("Mon, Oct 19 at 9:15 AM PKT");
    expect(list).toContain("one@example.test and two@example.test");
    const pausedList = renderToString(
      createElement(ScheduleList, {
        ...listProps,
        initialSchedules: [
          { ...listProps.initialSchedules[0], status: "paused" },
        ],
      }),
    );
    expect(pausedList).toContain("Paused. Won&#x27;t send until you resume.");
    expect(pausedList).not.toContain("Next send");
    const waitingList = renderToString(
      createElement(ScheduleList, {
        ...listProps,
        connectionStatus: "disconnected",
      }),
    );
    expect(waitingList).toContain("Waiting for Gmail");
    expect(waitingList).not.toContain("Next send");
    expect(
      renderToString(
        createElement(ScheduleList, {
          ...listProps,
          initialSchedules: [],
          loadError: true,
        }),
      ),
    ).toContain("Schedules could not be loaded.");
    const confirmForm = renderToString(
      createElement(ConfirmForm, confirmFormProps),
    );
    expect(confirmForm).toContain("Disconnect Gmail?");
    expect(confirmForm).toContain('action="/api/gmail/disconnect"');
    const pauseButton = renderToString(
      createElement(SchedulePauseButton, pauseButtonProps),
    );
    expect(pauseButton).toContain("Resume");
  });

  it("keeps the server pages passing only data to imported client components", () => {
    const violations = expectedPages.flatMap(functionPropsInPage);
    expect(violations).toEqual([]);
  });
});
