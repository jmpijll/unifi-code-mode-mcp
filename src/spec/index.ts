/**
 * Spec module entry — re-exports + helpers for working with a ProcessedSpec.
 */

import { normalizeTag } from './index-builder.js';
import type { IndexedOperation, ProcessedSpec } from '../types/spec.js';

export { loadLocalSpec, loadCloudSpec, clearSpecCache } from './loader.js';
export { buildOperationIndex, normalizeTag, synthesizeOperationId } from './index-builder.js';

/**
 * Look up an operation by operationId, or by `METHOD path` (e.g. "GET /v1/sites").
 */
export function findOperation(
  spec: ProcessedSpec,
  identifier: string,
): IndexedOperation | undefined {
  const trimmed = identifier.trim();
  // Try exact operationId match first.
  let op = spec.operations.find((o) => o.operationId === trimmed);
  if (op) return op;
  // Try "METHOD path" match.
  const split = trimmed.split(/\s+/);
  if (split.length === 2) {
    const [m, p] = split;
    op = spec.operations.find(
      (o) => o.method === m!.toUpperCase() && o.path === p,
    );
  }
  return op;
}

/** Group operations by their normalized primary tag (the namespace key). */
export function groupOperationsByTag(spec: ProcessedSpec): Map<string, IndexedOperation[]> {
  const groups = new Map<string, IndexedOperation[]>();
  for (const op of spec.operations) {
    const arr = groups.get(op.primaryTag) ?? [];
    arr.push(op);
    groups.set(op.primaryTag, arr);
  }
  return groups;
}

/**
 * Substring/keyword search across operationId, summary, description, tags, path.
 * Case-insensitive, whitespace-tolerant. Returns a ranked list (best first).
 */
export function searchOperations(
  spec: ProcessedSpec,
  query: string,
  limit = 25,
): IndexedOperation[] {
  const q = query.toLowerCase().trim();
  if (!q) return spec.operations.slice(0, limit);

  const scored: Array<{ op: IndexedOperation; score: number }> = [];
  for (const op of spec.operations) {
    let score = 0;
    if (op.operationId.toLowerCase() === q) score += 100;
    if (op.operationId.toLowerCase().includes(q)) score += 30;
    if (op.path.toLowerCase().includes(q)) score += 20;
    if (op.summary.toLowerCase().includes(q)) score += 15;
    if (op.tags.some((t) => t.toLowerCase().includes(q))) score += 10;
    if (op.description.toLowerCase().includes(q)) score += 5;
    if (score > 0) scored.push({ op, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.op);
}

/**
 * Compact each operation for safe serialization into the sandbox.
 * Strips any large embedded schemas — search uses the index for discovery.
 */
export function summarizeOperation(op: IndexedOperation): Record<string, unknown> {
  return {
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    tag: op.primaryTag,
    summary: op.summary || undefined,
    parameters: op.parameters.map((p) => ({
      name: p.name,
      in: p.in,
      required: p.required,
      type: p.type,
    })),
    hasRequestBody: op.hasRequestBody || undefined,
    deprecated: op.deprecated || undefined,
  };
}

/** Helper for diagnostics. */
export function specSummary(spec: ProcessedSpec): {
  title: string;
  version: string;
  operationCount: number;
  tagCount: number;
} {
  const tags = new Set(spec.operations.map((o) => o.primaryTag));
  return {
    title: spec.title,
    version: spec.version,
    operationCount: spec.operations.length,
    tagCount: tags.size,
  };
}

// Re-export the namespace tag normalizer so other modules don't reach into index-builder.
export { normalizeTag as toNamespaceKey };
