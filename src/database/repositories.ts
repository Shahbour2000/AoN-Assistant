import type Database from 'better-sqlite3';

export interface GuildSettings {
  guildId: string; ticketCategoryId: string | null; entryChannelId: string | null;
  embedTitle: string | null; embedDescription: string | null; embedColor: string | null;
  embedImageUrl: string | null; embedThumbnailUrl: string | null; buttonLabel: string | null;
  inactivityMinutes: number;
  ticketChannelId: string | null;
}
export interface GuildSettingsInput extends Partial<Omit<GuildSettings, 'guildId'>> { guildId: string; }
export interface Session { id: string; guildId: string; userId: string; channelId: string; lastActivityAt: string; createdAt: string; }
export interface ConversationMessage { sessionId: string; ordinal: number; role: 'user' | 'model'; content: string; createdAt: string; }
export interface UserConversationMessage { guildId: string; userId: string; role: 'user' | 'model'; content: string; createdAt: string; }
export interface LinkedPlayer { discordUserId: string; playerId: string; username: string; linkedAt: string; verified: false; }
export interface AssistantContext { selectedPlayerId?: string; selectedPlayerName?: string; selectedFetchedAt?: string; waitingForUsername: boolean; updatedAt: string; }

const settingsColumns: Record<keyof Omit<GuildSettings, 'guildId'>, string> = {
  ticketCategoryId: 'ticket_category_id', entryChannelId: 'entry_channel_id', embedTitle: 'embed_title',
  embedDescription: 'embed_description', embedColor: 'embed_color', embedImageUrl: 'embed_image_url',
  embedThumbnailUrl: 'embed_thumbnail_url', buttonLabel: 'button_label', inactivityMinutes: 'inactivity_minutes',
  ticketChannelId: 'ticket_channel_id',
};

export class GuildSettingsRepository {
  constructor(private readonly db: Database.Database) {}
  get(guildId: string): GuildSettings | undefined {
    const row = this.db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as Record<string, unknown> | undefined;
    return row ? mapSettings(row) : undefined;
  }
  upsert(input: GuildSettingsInput): GuildSettings {
    const normalized = input;
    const entries = Object.entries(normalized).filter(([key]) => key !== 'guildId' && key in settingsColumns) as [keyof typeof settingsColumns, unknown][];
    this.db.prepare('INSERT OR IGNORE INTO guild_settings (guild_id) VALUES (?)').run(input.guildId);
    if (entries.length) {
      const updates = entries.map(([key]) => `${settingsColumns[key]} = @${key}`).join(', ');
      this.db.prepare(`UPDATE guild_settings SET ${updates} WHERE guild_id = @guildId`).run(normalized);
    }
    return this.get(input.guildId)!;
  }
  delete(guildId: string): boolean { return this.db.prepare('DELETE FROM guild_settings WHERE guild_id = ?').run(guildId).changes > 0; }
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}
  create(session: Session): void {
    this.db.prepare('INSERT INTO sessions (id, guild_id, user_id, channel_id, last_activity_at, created_at) VALUES (@id, @guildId, @userId, @channelId, @lastActivityAt, @createdAt)').run(session);
  }
  getById(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : undefined;
  }
  getByUser(guildId: string, userId: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : undefined;
  }
  getByChannel(channelId: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE channel_id = ?').get(channelId) as Record<string, unknown> | undefined;
    return row ? mapSession(row) : undefined;
  }
  list(guildId: string): Session[] { return (this.db.prepare('SELECT * FROM sessions WHERE guild_id = ? ORDER BY created_at').all(guildId) as Record<string, unknown>[]).map(mapSession); }
  touch(id: string, at = new Date().toISOString()): boolean { return this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(at, id).changes > 0; }
  delete(id: string): boolean { return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes > 0; }
}

export class MessageRepository {
  constructor(private readonly db: Database.Database) {}
  append(sessionId: string, role: ConversationMessage['role'], content: string, createdAt = new Date().toISOString()): ConversationMessage {
    const ordinal = this.db.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS next FROM conversation_messages WHERE session_id = ?').get(sessionId) as { next: number };
    this.db.prepare('INSERT INTO conversation_messages (session_id, ordinal, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, ordinal.next, role, content, createdAt);
    return { sessionId, ordinal: ordinal.next, role, content, createdAt };
  }
  list(sessionId: string, limit = 100): ConversationMessage[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Message limit must be a positive integer');
    const rows = this.db.prepare('SELECT * FROM (SELECT * FROM conversation_messages WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?) ORDER BY ordinal').all(sessionId, limit) as Record<string, unknown>[];
    return rows.map((row) => ({ sessionId: String(row.session_id), ordinal: Number(row.ordinal), role: row.role as ConversationMessage['role'], content: String(row.content), createdAt: String(row.created_at) }));
  }
  deleteForSession(sessionId: string): number { return this.db.prepare('DELETE FROM conversation_messages WHERE session_id = ?').run(sessionId).changes; }
  appendForUser(message: UserConversationMessage): ConversationMessage {
    const sessionId = `user:${message.guildId}:${message.userId}`;
    return this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO sessions (id, guild_id, user_id, channel_id, last_activity_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(sessionId, message.guildId, message.userId, sessionId, message.createdAt, message.createdAt);
      const session = this.db.prepare('SELECT id FROM sessions WHERE guild_id = ? AND user_id = ?').get(message.guildId, message.userId) as { id: string };
      const stored = this.append(session.id, message.role, message.content, message.createdAt);
      this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(message.createdAt, session.id);
      return stored;
    })();
  }
  appendForScope(message: UserConversationMessage, channelId: string): ConversationMessage {
    const id = `scope:${message.guildId}:${channelId}:${message.userId}`;
    return this.db.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO sessions (id, guild_id, user_id, channel_id, last_activity_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, message.guildId, id, id, message.createdAt, message.createdAt);
      const stored = this.append(id, message.role, message.content, message.createdAt);
      this.db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(message.createdAt, id);
      return stored;
    })();
  }
  listForScope(guildId: string, channelId: string, userId: string, limit = 20): ConversationMessage[] {
    const id = `scope:${guildId}:${channelId}:${userId}`;
    return this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id) ? this.list(id, limit) : [];
  }
  listForUser(guildId: string, userId: string, limit = 20): ConversationMessage[] {
    const row = this.db.prepare('SELECT id FROM sessions WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as { id: string } | undefined;
    return row ? this.list(row.id, limit) : [];
  }
  appendToSession(sessionId: string, role: ConversationMessage['role'], content: string, createdAt = new Date().toISOString()): ConversationMessage { return this.append(sessionId, role, content, createdAt); }
  listForSession(sessionId: string, limit = 20): ConversationMessage[] { return this.list(sessionId, limit); }
  getAssistantContext(key: string, now = Date.now(), ttlMs = 2 * 60 * 60 * 1000): AssistantContext | undefined {
    const row = this.db.prepare('SELECT * FROM assistant_context WHERE context_key = ?').get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    if (Date.parse(String(row.updated_at)) < now - ttlMs) { this.db.prepare('DELETE FROM assistant_context WHERE context_key = ?').run(key); return undefined; }
    return { ...(row.selected_player_id ? { selectedPlayerId: String(row.selected_player_id) } : {}), ...(row.selected_player_name ? { selectedPlayerName: String(row.selected_player_name) } : {}), ...(row.selected_fetched_at ? { selectedFetchedAt: String(row.selected_fetched_at) } : {}), waitingForUsername: Number(row.waiting_for_username) === 1, updatedAt: String(row.updated_at) };
  }
  setAssistantContext(key: string, context: AssistantContext): void {
    this.db.prepare(`INSERT INTO assistant_context (context_key, selected_player_id, selected_player_name, selected_fetched_at, waiting_for_username, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(context_key) DO UPDATE SET selected_player_id=excluded.selected_player_id, selected_player_name=excluded.selected_player_name, selected_fetched_at=excluded.selected_fetched_at, waiting_for_username=excluded.waiting_for_username, updated_at=excluded.updated_at`)
      .run(key, context.selectedPlayerId ?? null, context.selectedPlayerName ?? null, context.selectedFetchedAt ?? null, context.waitingForUsername ? 1 : 0, context.updatedAt);
  }
}

export interface Ticket { id: string; guildId: string; ownerId: string; channelId: string; sessionId: string; status: 'open' | 'closed'; createdAt: string; closedAt: string | null; }
export class TicketRepository {
  constructor(private readonly db: Database.Database) {}
  create(ticket: Ticket): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO sessions (id, guild_id, user_id, channel_id, last_activity_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(ticket.sessionId, ticket.guildId, `ticket:${ticket.id}`, ticket.channelId, ticket.createdAt, ticket.createdAt);
      this.db.prepare('INSERT INTO tickets (id, guild_id, owner_id, channel_id, session_id, status, created_at, closed_at) VALUES (@id, @guildId, @ownerId, @channelId, @sessionId, @status, @createdAt, @closedAt)').run(ticket);
    })();
  }
  getByChannel(channelId: string): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId) as Record<string, unknown> | undefined;
    return row ? mapTicket(row) : undefined;
  }
  getOpenByOwner(guildId: string, ownerId: string): Ticket | undefined {
    const row = this.db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND owner_id = ? AND status = 'open'").get(guildId, ownerId) as Record<string, unknown> | undefined;
    return row ? mapTicket(row) : undefined;
  }
  close(id: string, closedAt = new Date().toISOString()): boolean {
    return this.db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'").run(closedAt, id).changes > 0;
  }
  reopen(id: string): boolean { return this.db.prepare("UPDATE tickets SET status = 'open', closed_at = NULL WHERE id = ? AND status = 'closed'").run(id).changes > 0; }
}

export class LinkedPlayerRepository {
  constructor(private readonly db: Database.Database) {}
  getByDiscordUser(discordUserId: string): LinkedPlayer | undefined {
    const row = this.db.prepare('SELECT * FROM linked_players WHERE discord_user_id = ?').get(discordUserId) as Record<string, unknown> | undefined;
    return row ? mapLinkedPlayer(row) : undefined;
  }
  getByPlayerId(playerId: string): LinkedPlayer | undefined {
    const row = this.db.prepare('SELECT * FROM linked_players WHERE player_id = ?').get(playerId) as Record<string, unknown> | undefined;
    return row ? mapLinkedPlayer(row) : undefined;
  }
  link(discordUserId: string, playerId: string, username: string, replaceOwn = false): LinkedPlayer {
    const existingOwner = this.getByPlayerId(playerId);
    if (existingOwner && existingOwner.discordUserId !== discordUserId) throw new Error('PLAYER_ALREADY_LINKED');
    const linkedAt = new Date().toISOString();
    try {
      if (replaceOwn) this.db.prepare(`INSERT INTO linked_players (discord_user_id, player_id, username, linked_at, verified)
        VALUES (?, ?, ?, ?, 0) ON CONFLICT(discord_user_id) DO UPDATE SET player_id = excluded.player_id, username = excluded.username, linked_at = excluded.linked_at, verified = 0`)
        .run(discordUserId, playerId, username, linkedAt);
      else this.db.prepare('INSERT INTO linked_players (discord_user_id, player_id, username, linked_at, verified) VALUES (?, ?, ?, ?, 0)')
        .run(discordUserId, playerId, username, linkedAt);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/u.test(error.message)) throw new Error('ACCOUNT_LINK_CONFLICT');
      throw error;
    }
    return this.getByDiscordUser(discordUserId)!;
  }
  getOnboarding(playerId: string): { playerId: string; startedAt: string; stage: string; initialGuidanceAt: string | null; lastInteractionAt: string | null; checkpoints: string[] } | undefined {
    const row = this.db.prepare('SELECT * FROM onboarding_state WHERE player_id = ?').get(playerId) as Record<string, unknown> | undefined;
    return row ? { playerId, startedAt: String(row.started_at), stage: String(row.stage), initialGuidanceAt: nullable(row.initial_guidance_at), lastInteractionAt: nullable(row.last_interaction_at), checkpoints: JSON.parse(String(row.checkpoints)) as string[] } : undefined;
  }
  startOnboarding(playerId: string, at = new Date().toISOString()): void {
    this.db.prepare("INSERT OR IGNORE INTO onboarding_state (player_id, started_at) VALUES (?, ?)").run(playerId, at);
  }
  updateOnboarding(playerId: string, stage: string, checkpoint?: string, at = new Date().toISOString()): void {
    this.startOnboarding(playerId, at);
    const current = this.getOnboarding(playerId)!;
    const checkpoints = checkpoint && !current.checkpoints.includes(checkpoint) ? [...current.checkpoints, checkpoint] : current.checkpoints;
    this.db.prepare("UPDATE onboarding_state SET stage = ?, last_interaction_at = ?, initial_guidance_at = COALESCE(initial_guidance_at, ?), checkpoints = ? WHERE player_id = ?")
      .run(stage, at, at, JSON.stringify(checkpoints), playerId);
  }
  unlink(discordUserId: string): boolean { return this.db.prepare('DELETE FROM linked_players WHERE discord_user_id = ?').run(discordUserId).changes > 0; }
}

function mapSettings(row: Record<string, unknown>): GuildSettings {
  return { guildId: String(row.guild_id), ticketCategoryId: nullable(row.ticket_category_id), entryChannelId: nullable(row.entry_channel_id), embedTitle: nullable(row.embed_title), embedDescription: nullable(row.embed_description), embedColor: nullable(row.embed_color), embedImageUrl: nullable(row.embed_image_url), embedThumbnailUrl: nullable(row.embed_thumbnail_url), buttonLabel: nullable(row.button_label), inactivityMinutes: Number(row.inactivity_minutes), ticketChannelId: nullable(row.ticket_channel_id) };
}
function mapSession(row: Record<string, unknown>): Session { return { id: String(row.id), guildId: String(row.guild_id), userId: String(row.user_id), channelId: String(row.channel_id), lastActivityAt: String(row.last_activity_at), createdAt: String(row.created_at) }; }
function mapTicket(row: Record<string, unknown>): Ticket { return { id: String(row.id), guildId: String(row.guild_id), ownerId: String(row.owner_id), channelId: String(row.channel_id), sessionId: String(row.session_id), status: row.status as Ticket['status'], createdAt: String(row.created_at), closedAt: nullable(row.closed_at) }; }
function mapLinkedPlayer(row: Record<string, unknown>): LinkedPlayer { return { discordUserId: String(row.discord_user_id), playerId: String(row.player_id), username: String(row.username), linkedAt: String(row.linked_at), verified: false }; }
function nullable(value: unknown): string | null { return value === null ? null : String(value); }
