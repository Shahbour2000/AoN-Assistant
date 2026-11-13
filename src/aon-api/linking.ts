import { randomUUID } from 'node:crypto';
import type { AonApiClient, AonPlayer } from './client.js';
import type { LinkedPlayerRepository } from '../database/repositories.js';

export interface PendingPlayerLink { token: string; discordUserId: string; player: AonPlayer; expiresAt: number; }
export class PlayerLinkService {
  private readonly pending = new Map<string, PendingPlayerLink>();
  constructor(private readonly api: AonApiClient, private readonly links: LinkedPlayerRepository, private readonly now: () => number = Date.now) {}
  async begin(discordUserId: string, username: string): Promise<PendingPlayerLink> {
    for (const [token, pending] of this.pending) if (pending.expiresAt < this.now()) this.pending.delete(token);
    const player = await this.api.findPlayer(username);
    const existing = this.links.getByPlayerId(player.id);
    if (existing && existing.discordUserId !== discordUserId) throw new Error('PLAYER_ALREADY_LINKED');
    const token = randomUUID();
    const pending = { token, discordUserId, player, expiresAt: this.now() + 5 * 60_000 };
    this.pending.set(token, pending);
    return pending;
  }
  confirm(token: string, discordUserId: string): void {
    const pending = this.pending.get(token);
    if (!pending || pending.expiresAt < this.now() || pending.discordUserId !== discordUserId) throw new Error('LINK_CONFIRMATION_EXPIRED');
    this.pending.delete(token);
    const current = this.links.getByDiscordUser(discordUserId);
    if (current && current.playerId !== pending.player.id) throw new Error('UNLINK_BEFORE_CHANGING_ACCOUNT');
    const wasAlreadyLinked = current?.playerId === pending.player.id;
    this.links.link(discordUserId, pending.player.id, pending.player.username, wasAlreadyLinked);
    this.links.startOnboarding(pending.player.id);
  }
  cancel(token: string, discordUserId: string): void {
    const pending = this.pending.get(token);
    if (pending?.discordUserId === discordUserId) this.pending.delete(token);
  }
}
