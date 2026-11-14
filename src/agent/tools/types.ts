import type { KnowledgeBase } from '../../knowledge/index.js';

export type ToolStatus = 'ok' | 'partial' | 'not_found' | 'unavailable' | 'rate_limited' | 'invalid_input' | 'no_results' | 'needs_input';
export interface ToolResult { status: ToolStatus; [key: string]: unknown }

/** Minimal read-only view of the Age of Nations API used by tools. `AonApiClient.getJson` satisfies it. */
export interface GameApi { getJson(path: string): Promise<unknown>; }

export interface ActivePlayer { id: string; username: string; fetchedAt: string; }
export interface ToolContext {
  knowledge?: KnowledgeBase | undefined;
  api?: GameApi | undefined;
  getActivePlayer(): ActivePlayer | undefined;
  setActivePlayer(player: ActivePlayer): void;
  now(): number;
}

export interface AgentTool {
  name: string;
  /** `game` tools return live API data, `knowledge` tools return wiki passages; both count as evidence for validation. */
  kind: 'knowledge' | 'game' | 'utility';
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export class InvalidInput extends Error {}

export function str(args: Record<string, unknown>, key: string, options: { max?: number; optional?: boolean } = {}): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') { if (options.optional) return undefined; throw new InvalidInput(`"${key}" is required`); }
  if (typeof value !== 'string') throw new InvalidInput(`"${key}" must be a string`);
  const text = value.trim();
  if (!text) { if (options.optional) return undefined; throw new InvalidInput(`"${key}" must not be empty`); }
  if (text.length > (options.max ?? 200)) throw new InvalidInput(`"${key}" is too long`);
  return text;
}
export function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback?: T): T {
  const value = args[key];
  if (value === undefined || value === null || value === '') { if (fallback !== undefined) return fallback; throw new InvalidInput(`"${key}" is required (one of: ${allowed.join(', ')})`); }
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new InvalidInput(`"${key}" must be one of: ${allowed.join(', ')}`);
  return value as T;
}
export function int(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) throw new InvalidInput(`"${key}" must be an integer between ${min} and ${max}`);
  return number;
}
export function strList(args: Record<string, unknown>, key: string, maxItems: number, maxLength: number): string[] {
  const value = args[key];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.length) throw new InvalidInput(`"${key}" must be a non-empty array of strings`);
  const out = list.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim().slice(0, maxLength));
  if (!out.length) throw new InvalidInput(`"${key}" must contain at least one non-empty string`);
  return out.slice(0, maxItems);
}
