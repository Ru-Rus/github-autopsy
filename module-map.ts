import type { ModuleMap } from "./types";
import ts from "typescript";

interface ScannedFile {
  path: string;
  text: string;
}
interface Alias {
  prefix: string;
  target: string;
}
const scriptFile = /\.(?:tsx?|jsx?|mjs|cjs)$/i;
const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function normalize(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}
function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
function aliasesFrom(content: string | null, configPath: string): Alias[] {
  if (!content) return [];
  try {
    const result = ts.parseConfigFileTextToJson(configPath, content);
    if (result.error) return [];
    const parsed = result.config as {
      compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
    };
    const options = parsed.compilerOptions ?? {};
    const configDir = directoryOf(configPath);
    const base = normalize(configDir + "/" + (options.baseUrl ?? "."));
    const mappings: Alias[] = [];
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      if (!pattern.endsWith("/*") || !Array.isArray(targets)) continue;
      for (const target of targets) {
        if (!target.endsWith("/*")) continue;
        mappings.push({
          prefix: pattern.slice(0, -1),
          target: normalize(base + "/" + target.slice(0, -1)),
        });
      }
    }
    return mappings.sort((a, b) => b.prefix.length - a.prefix.length);
  } catch {
    return [];
  }
}
function moduleFor(path: string): string {
  const directories = path.split("/").slice(0, -1);
  if (!directories.length) return "root";
  return directories.slice(0, 2).join("/");
}
function resolveSource(
  specifier: string,
  importer: string,
  sourcePaths: Set<string>,
  aliases: Alias[],
): string | null {
  let base: string | null = null;
  if (specifier.startsWith(".")) {
    base = normalize(directoryOf(importer) + "/" + specifier);
  } else {
    const alias = aliases.find((item) => specifier.startsWith(item.prefix));
    if (alias) {
      base = normalize(
        alias.target + "/" + specifier.slice(alias.prefix.length),
      );
    }
  }
  if (!base) return null;
  const candidates = [base];
  if (
    !extensions.some((extension) => base!.toLowerCase().endsWith(extension))
  ) {
    for (const extension of extensions) candidates.push(base + extension);
    for (const extension of extensions)
      candidates.push(base + "/index" + extension);
  }
  return candidates.find((candidate) => sourcePaths.has(candidate)) ?? null;
}
function importedSpecifiers(text: string): string[] {
  const found = new Set<string>();
  const source = ts.createSourceFile("module.tsx", text, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) found.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) found.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}
export function buildModuleMap(
  files: ScannedFile[],
  sourcePaths: string[],
  config: string | null,
  configPath: string,
): ModuleMap {
  const supportedPaths = sourcePaths.filter((path) => scriptFile.test(path));
  const paths = new Set(supportedPaths);
  const groups = new Map<string, number>();
  for (const path of supportedPaths) {
    const module = moduleFor(path);
    groups.set(module, (groups.get(module) ?? 0) + 1);
  }
  const sortedGroups = [...groups].sort((a, b) => b[1] - a[1]);
  const hasOther = sortedGroups.length > 7;
  const includedGroups = sortedGroups.slice(0, hasOther ? 7 : 8);
  const includedIds = new Set(includedGroups.map(([id]) => id));
  const moduleId = (id: string) => (includedIds.has(id) ? id : "__other__");
  const nodes = includedGroups.map(([id, count]) => ({
    id,
    label: id === "root" ? "Root files" : id,
    files: count,
  }));
  const collapsedModules = hasOther
    ? sortedGroups.length - includedGroups.length
    : 0;
  if (hasOther) {
    nodes.push({
      id: "__other__",
      label: "Other modules",
      files: sortedGroups
        .slice(includedGroups.length)
        .reduce((count, [, files]) => count + files, 0),
    });
  }

  const aliases = aliasesFrom(config, configPath);
  const edgeCounts = new Map<
    string,
    { from: string; to: string; imports: number }
  >();
  const supportedFiles = files.filter((file) => scriptFile.test(file.path));
  for (const file of supportedFiles) {
    const from = moduleId(moduleFor(file.path));
    const targets = new Set<string>();
    for (const specifier of importedSpecifiers(file.text)) {
      const targetPath = resolveSource(specifier, file.path, paths, aliases);
      if (!targetPath) continue;
      const to = moduleId(moduleFor(targetPath));
      if (from !== to) targets.add(to);
    }
    for (const to of targets) {
      const key = from + "\n" + to;
      const edge = edgeCounts.get(key) ?? { from, to, imports: 0 };
      edge.imports++;
      edgeCounts.set(key, edge);
    }
  }
  const edges = [...edgeCounts.values()]
    .sort((a, b) => b.imports - a.imports)
    .slice(0, 16);
  return {
    nodes,
    edges,
    scannedFiles: supportedFiles.length,
    totalSourceFiles: supportedPaths.length,
    moduleCount: sortedGroups.length,
    collapsedModules,
  };
}
