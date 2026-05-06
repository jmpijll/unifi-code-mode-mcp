/**
 * Build the lightweight operations index from a resolved OpenAPI document.
 *
 * The index is the data structure exposed to the `search` tool inside the
 * sandbox. It must stay small and JSON-serializable.
 */

import type {
  HttpMethod,
  IndexedOperation,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  SchemaObject,
} from '../types/spec.js';

const HTTP_METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const MAX_DESCRIPTION_LENGTH = 500;

export function buildOperationIndex(spec: OpenApiDocument): IndexedOperation[] {
  const operations: IndexedOperation[] = [];

  for (const [path, item] of Object.entries(spec.paths)) {
    if (!item || typeof item !== 'object') continue;
    const pathItem = item;
    const pathLevelParams = (pathItem.parameters ?? []) as ParameterObject[];

    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      operations.push(buildOperation(method, path, op, pathLevelParams, pathItem));
    }
  }

  // Sort: tag, then path, then method — produces stable, scannable output.
  operations.sort(
    (a, b) =>
      a.primaryTag.localeCompare(b.primaryTag) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method),
  );

  return operations;
}

function buildOperation(
  method: HttpMethod,
  path: string,
  op: OperationObject,
  pathLevelParams: ParameterObject[],
  _pathItem: PathItemObject,
): IndexedOperation {
  const tags = op.tags ?? [];
  const primaryTag = normalizeTag(tags[0] ?? 'default');
  const operationId = op.operationId ?? synthesizeOperationId(method, path);
  const summary = op.summary ?? '';
  const description = (op.description ?? '').slice(0, MAX_DESCRIPTION_LENGTH);

  const allParams: ParameterObject[] = [
    ...pathLevelParams,
    ...((op.parameters ?? []) as ParameterObject[]),
  ];

  const parameters = allParams.map((p) => ({
    name: p.name,
    in: p.in,
    required: p.required ?? p.in === 'path',
    description: p.description,
    type: extractType(p.schema),
  }));

  return {
    operationId,
    primaryTag,
    tags: tags.slice(),
    method: method.toUpperCase(),
    path,
    summary,
    description,
    parameters,
    hasRequestBody: Boolean(op.requestBody),
    deprecated: Boolean(op.deprecated),
  };
}

function extractType(schema: SchemaObject | undefined): string | undefined {
  if (!schema) return undefined;
  const t = schema['type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.join('|');
  return undefined;
}

/** Lower-camelCase the tag so `Sites` → `sites`, `WiFi Broadcasts` → `wifiBroadcasts`. */
export function normalizeTag(tag: string): string {
  const cleaned = tag
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/[_-]+/g, ' ');
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'default';
  const [first, ...rest] = parts;
  return [
    first!.toLowerCase(),
    ...rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()),
  ].join('');
}

/** Synthesize a stable operationId for specs that don't supply one. */
export function synthesizeOperationId(method: string, path: string): string {
  const cleanPath = path
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/[^a-zA-Z0-9]+/g, ''))
    .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join('');
  return `${method.toLowerCase()}${cleanPath.charAt(0).toUpperCase()}${cleanPath.slice(1)}`;
}
