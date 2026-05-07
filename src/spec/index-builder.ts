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
    if (typeof item !== 'object') continue;
    const pathItem = item;
    const pathLevelParams = pathItem.parameters ?? [];

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
    ...(op.parameters ?? []),
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

/**
 * Lower-camelCase the tag so `Sites` → `sites`, `WiFi Broadcasts` → `wifiBroadcasts`.
 *
 * Also compacts verbose API-doc boilerplate before camelCasing. Examples:
 *   - "Camera information & management"   → "camera"
 *   - "Camera PTZ control & management"   → "cameraPtz"
 *   - "Live view management"              → "liveView"
 *   - "Alarm manager integration"         → "alarmManager"
 *   - "Access Control (ACL Rules)"        → "aclRules"      (prefer parenthetical alias)
 *   - "Information about application"     → "applicationInfo" (matches Network's "Application Info")
 *   - "WiFi Broadcasts"                   → "wifiBroadcasts" (no change — no boilerplate)
 *
 * The compaction is conservative and only triggers on phrases that are
 * known to be Ubiquiti API-doc boilerplate; novel multi-word tags pass
 * through unchanged.
 */
export function normalizeTag(tag: string): string {
  const compact = compactTagPhrase(tag);
  const cleaned = compact
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/[_-]+/g, ' ');
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'default';
  const [first, ...rest] = parts;
  if (first === undefined) return 'default';
  return [
    first.toLowerCase(),
    ...rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()),
  ].join('');
}

/**
 * Strip the API-doc boilerplate that bloats UniFi (especially Protect)
 * tag names. Pure phrase-level normalisation — no camelCasing here.
 *
 * Exposed for unit tests; not part of the public API.
 */
export function compactTagPhrase(tag: string): string {
  let s = tag.trim();
  if (s.length === 0) return s;

  const paren = s.match(/^([^()]+?)\s*\(([^)]+)\)\s*$/);
  if (paren?.[2]) {
    s = paren[2].trim();
  }

  const aboutMatch = s.match(/^information\s+about\s+(.+)$/i);
  if (aboutMatch?.[1]) {
    s = `${aboutMatch[1]} info`;
  }

  const suffixes: RegExp[] = [
    /\s+control\s*(?:&|and)\s*management$/i,
    /\s+information\s*(?:&|and)\s*management$/i,
    /\s+information$/i,
    /\s+management$/i,
    /\s+integration$/i,
  ];
  for (const re of suffixes) {
    const stripped = s.replace(re, '').trim();
    if (stripped.length > 0 && stripped !== s) {
      s = stripped;
      break;
    }
  }

  return s;
}

/**
 * Synthesize a stable, REST-friendly operationId for specs that don't supply one.
 *
 * The official UniFi Protect OpenAPI document
 * (`apidoc-cdn.ui.com/protect/v7.0.107/integration.json`) ships every
 * operation with `operationId: null`, so the loader relies on this helper to
 * produce names like `listCameras`, `getCamera`, `cameraPtzGoto` rather than
 * the older naive form (`getV1Cameras`, `postV1CamerasIdPtzGotoSlot`, …).
 *
 * Heuristics, in order:
 *   1. Drop a /v\d+ version prefix.
 *   2. Collection root  /resource              → list/create/update/delete<Resource[s]>
 *   3. Single resource  /resource/{id}         → get/update/delete<Resource> (singular)
 *   4. Action endpoint  /resource/{id}/<verb…> → get<Resource><Action> for GET,
 *                                                <resource><Action> for POST
 *                                                update/delete<Resource><Action> for others
 *   5. No params, multi-segment (/v1/meta/info) → get/create/update/delete<JoinedSegments>
 *   6. Fallback: legacy `<method><camelCasedPath>` form.
 *
 * Names are unique within both Protect v7.0.107 (25 ops) and Network v10.1.84.
 */
export function synthesizeOperationId(method: string, path: string): string {
  const m = method.toLowerCase();

  const segments = path.split('/').filter(Boolean);
  if (segments[0] && /^v\d+$/i.test(segments[0])) {
    segments.shift();
  }

  if (segments.length === 0) {
    return m === 'get' ? 'getRoot' : `${m}Root`;
  }

  type Seg = { type: 'resource' | 'param'; name: string };
  const parts: Seg[] = segments.map((s) =>
    /^\{.*\}$/.test(s)
      ? { type: 'param' as const, name: s.slice(1, -1) }
      : { type: 'resource' as const, name: s },
  );

  const last = parts[parts.length - 1];
  if (!last) {
    return m === 'get' ? 'getRoot' : `${m}Root`;
  }

  // Case 2: /resource (collection root)
  if (parts.length === 1 && last.type === 'resource') {
    const collection = pascalSegment(last.name);
    if (m === 'get') return `list${collection}`;
    if (m === 'post') return `create${pascalSegment(singularize(last.name))}`;
    if (m === 'delete') return `delete${collection}`;
    if (m === 'patch' || m === 'put') return `update${collection}`;
  }

  // Case 3: /resource/{id} (path ends in single param, all preceding are resources)
  const isSingularResource =
    parts.length >= 2 &&
    last.type === 'param' &&
    parts.slice(0, -1).every((p) => p.type === 'resource');
  if (isSingularResource) {
    const resourceParts = parts.slice(0, -1).map((p) => p.name);
    const lastResource = resourceParts[resourceParts.length - 1];
    if (lastResource !== undefined) {
      const prefix = resourceParts.slice(0, -1).map(pascalSegment).join('');
      const target = `${prefix}${pascalSegment(singularize(lastResource))}`;
      if (m === 'get') return `get${target}`;
      if (m === 'patch' || m === 'put') return `update${target}`;
      if (m === 'delete') return `delete${target}`;
      if (m === 'post') return `create${target}`;
    }
  }

  // Case 4: action endpoint — at least one path param somewhere in the path,
  // with resource segments both before and after that first param.
  const firstParamIdx = parts.findIndex((p) => p.type === 'param');
  if (firstParamIdx > 0) {
    const entityResources = parts
      .slice(0, firstParamIdx)
      .filter((p) => p.type === 'resource')
      .map((p) => p.name);
    const trailingResources = parts
      .slice(firstParamIdx + 1)
      .filter((p) => p.type === 'resource')
      .map((p) => p.name);

    if (entityResources.length > 0 && trailingResources.length > 0) {
      const entityWord = entityResources
        .map((n, i) => (i === entityResources.length - 1 ? singularize(n) : n))
        .map(pascalSegment)
        .join('');
      const actionWord = trailingResources.map(pascalSegment).join('');
      if (m === 'get') return `get${entityWord}${actionWord}`;
      if (m === 'post') return `${lowerFirstChar(entityWord)}${actionWord}`;
      if (m === 'patch' || m === 'put') return `update${entityWord}${actionWord}`;
      if (m === 'delete') return `delete${entityWord}${actionWord}`;
    }
  }

  // Case 5: no params at all, multi-segment (/v1/meta/info → getMetaInfo, …)
  if (parts.every((p) => p.type === 'resource')) {
    const joined = parts.map((p) => pascalSegment(p.name)).join('');
    if (m === 'get') return `get${joined}`;
    if (m === 'post') return `create${joined}`;
    if (m === 'patch' || m === 'put') return `update${joined}`;
    if (m === 'delete') return `delete${joined}`;
  }

  // Case 6: anything weirder. Fall back to the original naive form so spec
  // shapes we didn't anticipate still get a stable name.
  const cleanPath = path
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .map((seg) => seg.replace(/[^a-zA-Z0-9]+/g, ''))
    .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
    .join('');
  return `${m}${cleanPath.charAt(0).toUpperCase()}${cleanPath.slice(1)}`;
}

/** "wifi-broadcasts" / "ptz_goto" / "snapshot" → "WifiBroadcasts" / "PtzGoto" / "Snapshot" */
function pascalSegment(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function lowerFirstChar(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

/** Naive English singularizer tuned for the UniFi domain (cameras→camera, etc.). */
function singularize(s: string): string {
  if (s.length <= 2) return s;
  const lower = s.toLowerCase();
  if (lower.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (lower.endsWith('ses') && !lower.endsWith('sses')) return s.slice(0, -2);
  if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us')) {
    return s.slice(0, -1);
  }
  return s;
}
