import * as path from 'path';
import * as vscode from 'vscode';
import {
  Node as JsonNode,
  findNodeAtLocation,
  findNodeAtOffset,
  parseTree
} from 'jsonc-parser';

interface ResolvedReference {
  refValue: string;
  sourceRange: vscode.Range;
  targetUri: vscode.Uri;
  targetDocument: vscode.TextDocument;
  targetRange: vscode.Range;
  metadata: SchemaMetadata;
  pointerDisplay: string;
  pointerFragment?: string;
}

interface SchemaMetadata {
  title?: string;
  description?: string;
  type?: string;
}

const SUPPORTED_LANGUAGES = ['json', 'jsonc'];

export function activate(context: vscode.ExtensionContext) {
  const provider = new JsonRefNavigationProvider();
  const diagnosticCollection = vscode.languages.createDiagnosticCollection('json-schema-references');

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SUPPORTED_LANGUAGES, provider),
    vscode.languages.registerDefinitionProvider(SUPPORTED_LANGUAGES, provider),
    diagnosticCollection
  );

  // Validate all open documents on activation
  vscode.workspace.textDocuments.forEach((doc) => {
    if (SUPPORTED_LANGUAGES.includes(doc.languageId)) {
      validateDocument(doc, diagnosticCollection);
    }
  });

  // Validate when a document is opened
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (SUPPORTED_LANGUAGES.includes(doc.languageId)) {
        validateDocument(doc, diagnosticCollection);
      }
    })
  );

  // Validate when a document is changed
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (SUPPORTED_LANGUAGES.includes(event.document.languageId)) {
        validateDocument(event.document, diagnosticCollection);
      }
    })
  );

  // Clear diagnostics when a document is closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnosticCollection.delete(doc.uri);
    })
  );
}

export function deactivate() {
  // No-op
}

async function validateDocument(
  document: vscode.TextDocument,
  diagnosticCollection: vscode.DiagnosticCollection
): Promise<void> {
  const text = document.getText();
  const root = parseTree(text);
  if (!root) {
    diagnosticCollection.set(document.uri, []);
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [];
  await findAllRefs(document, root, diagnostics);
  diagnosticCollection.set(document.uri, diagnostics);
}

async function findAllRefs(
  document: vscode.TextDocument,
  node: JsonNode,
  diagnostics: vscode.Diagnostic[]
): Promise<void> {
  if (!node) {
    return;
  }

  // Check if this is a $ref property
  if (node.type === 'property' && node.children?.[0]?.value === '$ref') {
    const valueNode = node.children[1];
    if (valueNode && valueNode.type === 'string') {
      const refValue = String(valueNode.value ?? '');
      if (refValue.trim()) {
        await validateReference(document, valueNode, refValue, diagnostics);
      }
    }
  }

  // Recursively check all children
  if (node.children) {
    for (const child of node.children) {
      await findAllRefs(document, child, diagnostics);
    }
  }
}

async function validateReference(
  document: vscode.TextDocument,
  node: JsonNode,
  refValue: string,
  diagnostics: vscode.Diagnostic[]
): Promise<void> {
  const trimmed = refValue.trim();
  const hashIndex = trimmed.indexOf('#');
  const filePart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const pointerPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : '';

  // Resolve the target URI
  const targetUri = resolveUri(document, filePart);
  if (!targetUri) {
    const range = new vscode.Range(
      document.positionAt(node.offset),
      document.positionAt(node.offset + node.length)
    );
    const diagnostic = new vscode.Diagnostic(
      range,
      `Cannot resolve reference: "${refValue}"`,
      vscode.DiagnosticSeverity.Error
    );
    diagnostics.push(diagnostic);
    return;
  }

  // Try to open the target document
  let targetDocument: vscode.TextDocument;
  try {
    targetDocument = await vscode.workspace.openTextDocument(targetUri);
  } catch (error) {
    const range = new vscode.Range(
      document.positionAt(node.offset),
      document.positionAt(node.offset + node.length)
    );
    const diagnostic = new vscode.Diagnostic(
      range,
      `File not found: "${filePart || 'current file'}"`,
      vscode.DiagnosticSeverity.Error
    );
    diagnostics.push(diagnostic);
    return;
  }

  // If there's a JSON pointer, validate it
  if (pointerPart) {
    const pointerSegments = parseJsonPointer(pointerPart);
    const targetNode = findTargetNode(targetDocument, pointerSegments);
    if (!targetNode) {
      const range = new vscode.Range(
        document.positionAt(node.offset),
        document.positionAt(node.offset + node.length)
      );
      const diagnostic = new vscode.Diagnostic(
        range,
        `Invalid JSON pointer: "#${pointerPart}"`,
        vscode.DiagnosticSeverity.Error
      );
      diagnostics.push(diagnostic);
    }
  }
}

function resolveUri(
  document: vscode.TextDocument,
  filePart: string
): vscode.Uri | undefined {
  if (!filePart) {
    return document.uri;
  }

  if (/^[a-zA-Z][a-zA-Z+\-.]*:\/\//.test(filePart)) {
    const parsed = vscode.Uri.parse(filePart);
    return parsed.scheme === 'file' ? parsed : undefined;
  }

  if (path.isAbsolute(filePart)) {
    return vscode.Uri.file(filePart);
  }

  // Windows absolute paths like C:\foo will not be caught by path.isAbsolute when run on POSIX.
  if (/^[a-zA-Z]:[\\/]/.test(filePart)) {
    return vscode.Uri.file(filePart);
  }

  const baseDir = path.dirname(document.uri.fsPath);
  return vscode.Uri.file(path.resolve(baseDir, filePart));
}

function parseJsonPointer(pointer: string): Array<string | number> {
  if (!pointer) {
    return [];
  }

  const normalized = pointer.startsWith('/')
    ? pointer.slice(1)
    : pointer;

  if (!normalized) {
    return [];
  }

  return normalized.split('/').map((segment) => {
    const unescaped = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
  });
}

function findTargetNode(
  document: vscode.TextDocument,
  pointerSegments: Array<string | number>
): JsonNode | undefined {
  const text = document.getText();
  const root = parseTree(text);
  if (!root) {
    return undefined;
  }

  if (!pointerSegments.length) {
    return root;
  }

  const located = findNodeAtLocation(root, pointerSegments);
  if (!located) {
    return undefined;
  }

  if (located.type === 'property' && located.children?.[1]) {
    return located.children[1];
  }

  return located;
}

class JsonRefNavigationProvider
  implements vscode.HoverProvider, vscode.DefinitionProvider
{
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    const info = await this.resolveReference(document, position);
    if (!info) {
      return undefined;
    }

    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = true;
    const fileLabel = path.basename(info.targetUri.fsPath);
    const header = info.pointerDisplay
      ? `${fileLabel}${info.pointerDisplay}`
      : fileLabel;

    const linkUri = info.pointerFragment
      ? info.targetUri.with({ fragment: info.pointerFragment })
      : info.targetUri;

    markdown.appendMarkdown(
      `[${this.escapeMarkdown(header)}](${linkUri.toString(true)})\n\n`
    );

    const detailLines: string[] = [];
    if (info.metadata.title) {
      detailLines.push(
        `- **Title:** ${this.escapeMarkdown(
          this.truncateText(info.metadata.title)
        )}`
      );
    }
    if (info.metadata.description) {
      detailLines.push(
        `- **Description:** ${this.escapeMarkdown(
          this.truncateText(info.metadata.description)
        )}`
      );
    }
    if (info.metadata.type) {
      detailLines.push(
        `- **Type:** ${this.escapeMarkdown(this.truncateText(info.metadata.type))}`
      );
    }

    if (detailLines.length) {
      markdown.appendMarkdown(detailLines.join('\n'));
    } else {
      markdown.appendMarkdown('_No schema metadata available._');
    }

    markdown.appendMarkdown('\n\nCmd+Click to open the referenced schema.');

    return new vscode.Hover(markdown, info.sourceRange);
  }

  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Definition | vscode.DefinitionLink[] | undefined> {
    const info = await this.resolveReference(document, position);
    if (!info) {
      return undefined;
    }

    return [
      {
        originSelectionRange: info.sourceRange,
        targetUri: info.targetUri,
        targetRange: info.targetRange,
        targetSelectionRange: info.targetRange
      }
    ];
  }

  private async resolveReference(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<ResolvedReference | undefined> {
    const refNode = this.getRefNodeAtPosition(document, position);
    if (!refNode) {
      return undefined;
    }

    const refValue = String(refNode.node.value ?? '');
    if (!refValue.trim()) {
      return undefined;
    }

    const resolvedTarget = await this.resolveTargetDocument(
      document,
      refValue
    );
    if (!resolvedTarget) {
      return undefined;
    }

    const sourceRange = new vscode.Range(
      document.positionAt(refNode.node.offset),
      document.positionAt(refNode.node.offset + refNode.node.length)
    );

    return {
      refValue,
      sourceRange,
      ...resolvedTarget
    };
  }

  private getRefNodeAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { node: JsonNode } | undefined {
    const text = document.getText();
    const root = parseTree(text);
    if (!root) {
      return undefined;
    }

    const offset = document.offsetAt(position);
    const node = findNodeAtOffset(root, offset, true);
    if (!node || node.type !== 'string') {
      return undefined;
    }

    const propertyNode = node.parent;
    if (!propertyNode || propertyNode.type !== 'property') {
      return undefined;
    }

    const keyNode = propertyNode.children?.[0];
    if (!keyNode || keyNode.value !== '$ref') {
      return undefined;
    }

    return { node };
  }

  private async resolveTargetDocument(
    document: vscode.TextDocument,
    refValue: string
  ): Promise<
    Omit<ResolvedReference, 'refValue' | 'sourceRange'> | undefined
  > {
    const trimmed = refValue.trim();
    const hashIndex = trimmed.indexOf('#');
    const filePart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
    const pointerPart = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : '';
    const pointerDisplay = pointerPart ? `#${pointerPart}` : '';

    const targetUri = this.resolveUri(document, filePart);
    if (!targetUri) {
      return undefined;
    }

    let targetDocument: vscode.TextDocument;
    try {
      targetDocument = await vscode.workspace.openTextDocument(targetUri);
    } catch {
      return undefined;
    }

    const pointerSegments = this.parseJsonPointer(pointerPart);
    const targetNode = this.findTargetNode(targetDocument, pointerSegments);
    if (!targetNode) {
      return undefined;
    }

    const targetRange = new vscode.Range(
      targetDocument.positionAt(targetNode.offset),
      targetDocument.positionAt(targetNode.offset + targetNode.length)
    );
    const metadata = this.extractSchemaMetadata(targetNode);

    return {
      targetUri,
      targetDocument,
      targetRange,
      metadata,
      pointerDisplay,
      pointerFragment: pointerPart || undefined
    };
  }

  private resolveUri(
    document: vscode.TextDocument,
    filePart: string
  ): vscode.Uri | undefined {
    if (!filePart) {
      return document.uri;
    }

    if (/^[a-zA-Z][a-zA-Z+\-.]*:\/\//.test(filePart)) {
      const parsed = vscode.Uri.parse(filePart);
      return parsed.scheme === 'file' ? parsed : undefined;
    }

    if (path.isAbsolute(filePart)) {
      return vscode.Uri.file(filePart);
    }

    // Windows absolute paths like C:\foo will not be caught by path.isAbsolute when run on POSIX.
    if (/^[a-zA-Z]:[\\/]/.test(filePart)) {
      return vscode.Uri.file(filePart);
    }

    const baseDir = path.dirname(document.uri.fsPath);
    return vscode.Uri.file(path.resolve(baseDir, filePart));
  }

  private parseJsonPointer(pointer: string): Array<string | number> {
    if (!pointer) {
      return [];
    }

    const normalized = pointer.startsWith('/')
      ? pointer.slice(1)
      : pointer;

    if (!normalized) {
      return [];
    }

    return normalized.split('/').map((segment) => {
      const unescaped = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
    });
  }

  private findTargetNode(
    document: vscode.TextDocument,
    pointerSegments: Array<string | number>
  ): JsonNode | undefined {
    const text = document.getText();
    const root = parseTree(text);
    if (!root) {
      return undefined;
    }

    if (!pointerSegments.length) {
      return root;
    }

    const located = findNodeAtLocation(root, pointerSegments);
    if (!located) {
      return undefined;
    }

    if (located.type === 'property' && located.children?.[1]) {
      return located.children[1];
    }

    return located;
  }

  private extractSchemaMetadata(targetNode: JsonNode): SchemaMetadata {
    if (targetNode.type !== 'object') {
      return {};
    }

    const metadata: SchemaMetadata = {};

    for (const property of targetNode.children ?? []) {
      if (property.type !== 'property' || !property.children?.[0]) {
        continue;
      }
      const keyNode = property.children[0];
      const valueNode = property.children[1];
      if (!valueNode) {
        continue;
      }

      switch (keyNode.value) {
        case 'title':
          if (valueNode.type === 'string') {
            metadata.title = String(valueNode.value ?? '');
          }
          break;
        case 'description':
          if (valueNode.type === 'string') {
            metadata.description = String(valueNode.value ?? '');
          }
          break;
        case 'type':
          if (valueNode.type === 'string') {
            metadata.type = String(valueNode.value ?? '');
          } else if (valueNode.type === 'array') {
            const types = (valueNode.children ?? [])
              .filter((child) => child.type === 'string')
              .map((child) => String(child.value ?? ''));
            if (types.length) {
              metadata.type = types.join(' | ');
            }
          }
          break;
        default:
          break;
      }
    }

    return metadata;
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/([\\`*_{}[\]()#+\-!.])/g, '\\$1');
  }

  private truncateText(text: string, max = 280): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
}
