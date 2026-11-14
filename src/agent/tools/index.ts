import { GAME_TOOLS } from './game.js';
import { calculator, searchKnowledge } from './knowledge.js';
import type { AgentTool, ToolContext } from './types.js';

export type { AgentTool, ToolContext, ToolResult, ActivePlayer, GameApi } from './types.js';

/** Tools available for this deployment. Game API tools are omitted when no API client is configured. */
export function createTools(context: Pick<ToolContext, 'knowledge' | 'api'>): AgentTool[] {
  return [
    ...(context.knowledge ? [searchKnowledge] : []),
    calculator,
    ...(context.api ? GAME_TOOLS : []),
  ];
}
