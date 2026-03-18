import * as path from 'path';
import * as vscode from 'vscode';
import { Node as JsonNode, findNodeAtOffset, parseTree } from 'jsonc-parser';
import {
  parseReferenceTarget,
  resolveJsonPointerTarget
} from './reference-utils';

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

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SUPPORTED_LANGUAGES, provider),
    vscode.languages.registerDefinitionProvider(SUPPORTED_LANGUAGES, provider)
  );
}

export function deactivate() {
  // No-op
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
    const parsedTarget = await this.resolveReferenceTarget(document, trimmed);
    if (!parsedTarget) {
      return undefined;
    }

    const { targetUri, pointerPart } = parsedTarget;

    let targetDocument: vscode.TextDocument;
    try {
      targetDocument = await vscode.workspace.openTextDocument(targetUri);
    } catch {
      return undefined;
    }

    const root = parseTree(targetDocument.getText());
    if (!root) {
      return undefined;
    }

    const resolvedTarget = resolveJsonPointerTarget(root, pointerPart);
    if (!resolvedTarget) {
      return undefined;
    }

    const { targetNode, pointerFragment } = resolvedTarget;

    const targetRange = new vscode.Range(
      targetDocument.positionAt(targetNode.offset),
      targetDocument.positionAt(targetNode.offset + targetNode.length)
    );
    const metadata = this.extractSchemaMetadata(targetNode);
    const pointerDisplay = pointerFragment ? `#${pointerFragment}` : '';

    return {
      targetUri,
      targetDocument,
      targetRange,
      metadata,
      pointerDisplay,
      pointerFragment
    };
  }

  private async resolveReferenceTarget(
    document: vscode.TextDocument,
    refValue: string
  ): Promise<
    | {
        targetUri: vscode.Uri;
        pointerPart: string;
      }
    | undefined
  > {
    const parsedTarget = await parseReferenceTarget(refValue, {
      isExistingFile: async (candidate) => {
        const candidateUri = this.resolveUri(document, candidate);
        return candidateUri ? this.uriIsFile(candidateUri) : false;
      }
    });
    if (!parsedTarget) {
      return undefined;
    }

    const targetUri = this.resolveUri(document, parsedTarget.filePart);
    if (!targetUri) {
      return undefined;
    }

    return {
      targetUri,
      pointerPart: parsedTarget.pointerPart
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

  private async uriIsFile(uri: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (
        stat.type === vscode.FileType.File ||
        stat.type === vscode.FileType.SymbolicLink ||
        stat.type === (vscode.FileType.File | vscode.FileType.SymbolicLink)
      );
    } catch {
      return false;
    }
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
