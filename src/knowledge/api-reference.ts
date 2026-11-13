import type { KnowledgeChunk } from './retrieval.js';

export function apiReferenceChunks(spec: unknown): KnowledgeChunk[] {
  if (!spec || typeof spec !== 'object') return [];
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths;
  if (!paths) return [];
  return Object.entries(paths).flatMap(([path, methods]) => Object.entries(methods).map(([method, raw]) => {
    const operation = raw as { summary?: string; description?: string; parameters?: unknown[]; responses?: Record<string, unknown> };
    return { source: 'AgeOfNations_API_Reference.json', heading: `${method.toUpperCase()} ${path}`, content: `${operation.summary ?? ''}\n${operation.description ?? ''}\nParameters: ${JSON.stringify(operation.parameters ?? [])}\nResponses: ${JSON.stringify(operation.responses?.['200'] ?? {})}`.slice(0, 5000) };
  }));
}
