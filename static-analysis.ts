import ts from "typescript";

/** Syntax counts describe the bounded sample, not the complete repository. */
export function analyzeSyntax(files: { path: string; text: string }[]) {
  let functions = 0, classes = 0, branches = 0, imports = 0, exports = 0;
  for (const file of files) {
    if (!/\.(tsx?|jsx?|mjs|cjs)$/i.test(file.path)) continue;
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) functions++;
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) classes++;
      if (ts.isImportDeclaration(node)) imports++;
      if (ts.isExportDeclaration(node) || ts.isExportAssignment(node) ||
          (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))) exports++;
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isForStatement(node) ||
          ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isWhileStatement(node) ||
          ts.isDoStatement(node) || ts.isCaseClause(node) || ts.isCatchClause(node) ||
          (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind))) branches++;
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { functions, classes, branches, imports, exports };
}
