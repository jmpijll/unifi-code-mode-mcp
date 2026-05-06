/**
 * Shared OpenAPI types — minimal subset of OpenAPI 3.0/3.1 we care about.
 *
 * We use a deliberately narrow shape so we don't depend on the official
 * OpenAPI types package (which is large and frequently changes).
 */

export interface OpenApiDocument {
  openapi: string;
  info: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, ParameterObject>;
    responses?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

export type PathItemObject = {
  parameters?: ParameterObject[];
  description?: string;
  summary?: string;
} & Partial<Record<HttpMethod, OperationObject>>;

export interface OperationObject {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
}

export interface ParameterObject {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie';
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
  deprecated?: boolean;
}

export interface RequestBodyObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
  required?: boolean;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

export type SchemaObject = Record<string, unknown>;

/** A flattened operation — what the search index uses */
export interface IndexedOperation {
  /** Operation identifier — synthesized from method+path if not present in spec */
  operationId: string;
  /** First tag, used for namespace grouping (lowercased, kebab-cased) */
  primaryTag: string;
  /** All tags */
  tags: string[];
  /** HTTP method (uppercase: GET, POST, ...) */
  method: string;
  /** Path with `{param}` placeholders */
  path: string;
  /** Short summary (first line) */
  summary: string;
  /** Longer description (truncated for index efficiency) */
  description: string;
  /** Parameter info — flattened with location */
  parameters: Array<{
    name: string;
    in: 'query' | 'header' | 'path' | 'cookie';
    required: boolean;
    description?: string;
    type?: string;
  }>;
  /** Whether the operation accepts a request body */
  hasRequestBody: boolean;
  /** Whether the operation is deprecated */
  deprecated: boolean;
}

/** A processed spec ready for use by the executor and search tool */
export interface ProcessedSpec {
  /** Source URL where the spec was fetched */
  sourceUrl: string;
  /** Application version reported by the source (e.g. "10.1.84") */
  version: string;
  /** Friendly title */
  title: string;
  /** Server prefix to prepend to operation paths (e.g. "/proxy/network/integration") */
  serverPrefix: string;
  /** Flattened operations indexed for search */
  operations: IndexedOperation[];
  /** Raw $ref-resolved OpenAPI document, available for advanced search */
  document: OpenApiDocument;
}
