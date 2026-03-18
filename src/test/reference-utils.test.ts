import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTree } from 'jsonc-parser';
import {
  parseReferenceTarget,
  resolveJsonPointerTarget
} from '../reference-utils';

test('parseReferenceTarget keeps standard hash-based refs unchanged', async () => {
  const parsed = await parseReferenceTarget('./product.json#/$defs/money', {
    isExistingFile: () => false
  });

  assert.deepEqual(parsed, {
    filePart: './product.json',
    pointerPart: '/$defs/money'
  });
});

test('parseReferenceTarget resolves slash-style file refs into a pointer', async () => {
  const parsed = await parseReferenceTarget('./product.json/$defs/money', {
    isExistingFile: async (candidate) => candidate === './product.json'
  });

  assert.deepEqual(parsed, {
    filePart: './product.json',
    pointerPart: '/$defs/money'
  });
});

test('resolveJsonPointerTarget resolves the parsed slash-style pointer', async () => {
  const parsed = await parseReferenceTarget('./product.json/$defs/money', {
    isExistingFile: async (candidate) => candidate === './product.json'
  });
  const root = parseTree(
    JSON.stringify({
      $defs: {
        money: {
          type: 'number'
        }
      }
    })
  );

  assert.ok(parsed);
  assert.ok(root);

  const resolved = resolveJsonPointerTarget(root, parsed.pointerPart);

  assert.ok(resolved);
  assert.equal(resolved.pointerFragment, '/$defs/money');
  assert.equal(resolved.targetNode.type, 'object');
});

test('resolveJsonPointerTarget resolves bare fragments into $defs', () => {
  const root = parseTree(
    JSON.stringify({
      $defs: {
        money: {
          type: 'number'
        }
      }
    })
  );

  assert.ok(root);

  const resolved = resolveJsonPointerTarget(root, 'money');

  assert.ok(resolved);
  assert.equal(resolved.pointerFragment, '/$defs/money');
  assert.equal(resolved.targetNode.type, 'object');
});

test('resolveJsonPointerTarget prefers direct targets over $defs shorthand', () => {
  const root = parseTree(
    JSON.stringify({
      Designable: {
        type: 'string'
      },
      $defs: {
        Designable: {
          type: 'object'
        }
      }
    })
  );

  assert.ok(root);

  const resolved = resolveJsonPointerTarget(root, 'Designable');

  assert.ok(resolved);
  assert.equal(resolved.pointerFragment, 'Designable');
  assert.equal(resolved.targetNode.type, 'object');
});

test('resolveJsonPointerTarget still resolves explicit $defs pointers', () => {
  const root = parseTree(
    JSON.stringify({
      $defs: {
        Designable: {
          type: 'object'
        }
      }
    })
  );

  assert.ok(root);

  const resolved = resolveJsonPointerTarget(root, '/$defs/Designable');

  assert.ok(resolved);
  assert.equal(resolved.pointerFragment, '/$defs/Designable');
  assert.equal(resolved.targetNode.type, 'object');
});
