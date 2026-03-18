import { Node as JsonNode, findNodeAtLocation } from 'jsonc-parser';

export interface ParsedReferenceTarget {
  filePart: string;
  pointerPart: string;
}

export interface ReferenceTargetParserOptions {
  isExistingFile: (candidate: string) => boolean | Promise<boolean>;
}

export interface ResolvedJsonPointerTarget {
  targetNode: JsonNode;
  pointerFragment?: string;
}

export async function parseReferenceTarget(
  refValue: string,
  options: ReferenceTargetParserOptions
): Promise<ParsedReferenceTarget | undefined> {
  const trimmed = refValue.trim();
  const hashIndex = trimmed.indexOf('#');

  if (hashIndex >= 0) {
    return {
      filePart: trimmed.slice(0, hashIndex),
      pointerPart: trimmed.slice(hashIndex + 1)
    };
  }

  if (await options.isExistingFile(trimmed)) {
    return {
      filePart: trimmed,
      pointerPart: ''
    };
  }

  for (
    let splitIndex = findPreviousPathSeparator(trimmed, trimmed.length - 1);
    splitIndex >= 0;
    splitIndex = findPreviousPathSeparator(trimmed, splitIndex - 1)
  ) {
    const filePart = trimmed.slice(0, splitIndex);
    if (!filePart) {
      continue;
    }

    const pointerRemainder = trimmed.slice(splitIndex + 1);
    if (!pointerRemainder) {
      continue;
    }

    if (!(await options.isExistingFile(filePart))) {
      continue;
    }

    return {
      filePart,
      pointerPart: `/${normalizePointerSegments(pointerRemainder)}`
    };
  }

  return undefined;
}

export function resolveJsonPointerTarget(
  root: JsonNode,
  pointer: string
): ResolvedJsonPointerTarget | undefined {
  const pointerSegments = parseJsonPointer(pointer);
  const targetNode = findTargetNode(root, pointerSegments);
  if (targetNode) {
    return {
      targetNode,
      pointerFragment: pointer || undefined
    };
  }

  if (
    pointer &&
    !pointer.startsWith('/') &&
    pointerSegments.length === 1 &&
    pointerSegments[0] !== '$defs'
  ) {
    const defsPointerSegments = ['$defs', pointerSegments[0]];
    const defsTargetNode = findTargetNode(root, defsPointerSegments);
    if (defsTargetNode) {
      return {
        targetNode: defsTargetNode,
        pointerFragment: buildPointerFragment(defsPointerSegments)
      };
    }
  }

  return undefined;
}

function buildPointerFragment(segments: Array<string | number>): string {
  return `/${segments
    .map((segment) =>
      String(segment)
        .replace(/~/g, '~0')
        .replace(/\//g, '~1')
    )
    .join('/')}`;
}

export function parseJsonPointer(pointer: string): Array<string | number> {
  if (!pointer) {
    return [];
  }

  const normalized = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  if (!normalized) {
    return [];
  }

  return normalized.split('/').map((segment) => {
    const unescaped = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
  });
}

function findTargetNode(
  root: JsonNode,
  pointerSegments: Array<string | number>
): JsonNode | undefined {
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

function findPreviousPathSeparator(value: string, startIndex: number): number {
  for (let index = startIndex; index >= 0; index -= 1) {
    const char = value[index];
    if (char === '/' || char === '\\') {
      return index;
    }
  }

  return -1;
}

function normalizePointerSegments(value: string): string {
  return value
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .join('/');
}
