import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction, type Message } from 'discord.js';
import type { AssistantService } from '../assistant/service.js';
import { AssistantRateLimitError } from '../assistant/service.js';
import type { AonApiClient } from '../aon-api/client.js';
import { analyzePlayer } from '../aon-api/analysis.js';
import type { PlayerLinkService } from '../aon-api/linking.js';
import { LlmError } from '../llm/types.js';
import { logger } from '../logging/logger.js';
import type { GuildSettingsRepository, LinkedPlayerRepository, TicketRepository } from '../database/repositories.js';
import { TicketService, TICKET_CLOSE_ID, TICKET_OPEN_ID } from './tickets.js';

export function createDiscordClient(assistant: AssistantService, settings: GuildSettingsRepository, tickets: TicketRepository, playerTools?: { api: AonApiClient; links: LinkedPlayerRepository; linking: PlayerLinkService }): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  const ticketService = new TicketService(settings, tickets);
  const processed = new Set<string>();
  client.once(Events.ClientReady, (readyClient) => logger.info('Discord client ready', { userId: readyClient.user.id }));
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guildId || !client.user || processed.has(message.id)) return;
    processed.add(message.id);
    if (processed.size > 5000) processed.delete(processed.values().next().value as string);
    const ticket = tickets.getByChannel(message.channelId);
    const configuredTicketChannel = settings.get(message.guildId)?.ticketChannelId ?? undefined;
    const shouldHandle = ticket?.status === 'open' || await shouldHandleMessage(message, client.user.id, configuredTicketChannel);
    if (!shouldHandle) return;
    const question = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'gu'), '').trim();
    if (!question) return;
    const typing = setInterval(() => { void message.channel.sendTyping().catch(() => undefined); }, 8000);
    void message.channel.sendTyping().catch(() => undefined);
    try {
      const response = await assistant.ask({ guildId: message.guildId, userId: message.author.id, channelId: message.channelId, question, ...(ticket?.status === 'open' ? { conversationId: ticket.sessionId } : {}) });
      for (const part of splitDiscordMessage(response)) await message.reply({ content: part, allowedMentions: { repliedUser: false } });
    } catch (error) {
      const { failure, retryAfter, httpStatus } = failureInfo(error);
      const original = error instanceof Error ? error : new Error(String(error));
      logger.error('Assistant message failed', { stage: 'discord_ticket_message', failure, guildId: message.guildId, userId: message.author.id, channelId: message.channelId, httpStatus, retryAfterSeconds: retryAfter, error: original.message, stack: original.stack });
      const failureReply = failure === 'rate_limit' && retryAfter
        ? `طلبات المساعد كثيرة حاليًا. جرّب تاني بعد ${retryAfter} ثانية.`
        : failure === 'rate_limit' ? 'طلبات المساعد كثيرة حاليًا. حاول مرة أخرى بعد قليل.'
        : failure === 'timeout' || failure === 'unavailable' || failure === 'network' ? 'المساعد لا يستطيع الوصول إلى خدمة الإجابة الآن. حاول مرة أخرى بعد قليل.'
          : 'تعذر إكمال الإجابة الآن. حاول مرة أخرى لاحقًا.';
      try { await message.reply({ content: failureReply, allowedMentions: { repliedUser: false } }); }
      catch (replyError) { const sendFailure = replyError instanceof Error ? replyError : new Error(String(replyError)); logger.error('Unable to send assistant error reply', { stage: 'discord_error_reply', guildId: message.guildId, channelId: message.channelId, error: sendFailure.message, stack: sendFailure.stack }); }
    } finally { clearInterval(typing); }
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      try {
        const linkAction = /^aon:link:(confirm|cancel):([\da-f-]+)$/u.exec(interaction.customId);
        if (linkAction && playerTools) {
          const [, action, token] = linkAction;
          if (action === 'confirm') {
            playerTools.linking.confirm(token!, interaction.user.id);
            await interaction.update({ content: 'تم ربط الحساب. تنبيه: الربط لا يثبت ملكية حساب اللعبة.', components: [] });
          } else {
            playerTools.linking.cancel(token!, interaction.user.id);
            await interaction.update({ content: 'تم إلغاء ربط الحساب.', components: [] });
          }
        } else if (interaction.customId === TICKET_OPEN_ID && interaction.guild) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const channel = await ticketService.open(interaction.guild, member);
          await interaction.reply({ content: `Your ticket is ready: ${channel}`, ephemeral: true });
        } else if (interaction.customId === TICKET_CLOSE_ID && interaction.guild) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await ticketService.close(interaction.guild, interaction.channelId, member);
          await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const isLinkAction = interaction.customId.startsWith('aon:link:');
        logger.error(isLinkAction ? 'Player link confirmation failed' : 'Ticket button interaction failed', { stage: isLinkAction ? 'player_link_confirmation' : interaction.customId === TICKET_OPEN_ID ? 'open_ticket_interaction' : 'close_ticket_interaction', guildId: interaction.guildId, channelId: interaction.channelId, userId: interaction.user.id, error: failure.message, stack: failure.stack });
        await interaction.reply({ content: isLinkAction ? 'This link confirmation is invalid or expired. Run /link again.' : error instanceof Error ? error.message : 'Could not complete the ticket action.', ephemeral: true }).catch(() => undefined);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong! AoN Assistant is online.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === 'ask') await handleAsk(interaction, assistant);
    if (interaction.commandName === 'mentor') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const linked = playerTools?.links.getByDiscordUser(interaction.user.id);
      const prompt = linked ? 'Give me my next concise Age of Nations mentor step. Prioritize missions and sustainable economy, use my current onboarding stage and avoid repeating completed checkpoints.' : 'Give me a concise first step for a new Age of Nations player, focusing on missions and sustainable economy.';
      await interaction.editReply(await assistant.ask({ guildId: interaction.guildId ?? 'dm', userId: interaction.user.id, question: `${prompt}\n\n[mentor]` }));
    }
    if (playerTools && ['link', 'unlink', 'profile', 'stats', 'analyze', 'refresh'].includes(interaction.commandName)) {
      await handlePlayerCommand(interaction, playerTools);
      return;
    }
    if (interaction.commandName === 'ticket') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'configure') await ticketService.configure(interaction);
      if (subcommand === 'panel') await ticketService.postPanel(interaction);
      if (subcommand === 'close' && interaction.guild) {
        try { const member = await interaction.guild.members.fetch(interaction.user.id); await ticketService.close(interaction.guild, interaction.channelId, member); await interaction.reply({ content: 'Ticket closed.', ephemeral: true }); }
        catch (error) { await interaction.reply({ content: error instanceof Error ? error.message : 'Could not close ticket.', ephemeral: true }); }
      }
    }
  });
  return client;
}

async function handlePlayerCommand(interaction: ChatInputCommandInteraction, tools: { api: AonApiClient; links: LinkedPlayerRepository; linking: PlayerLinkService }): Promise<void> {
  const command = interaction.commandName;
  try {
    if (command === 'link') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const pending = await tools.linking.begin(interaction.user.id, interaction.options.getString('username', true));
      const current = tools.links.getByDiscordUser(interaction.user.id);
      if (current && current.playerId !== pending.player.id) throw new Error('UNLINK_BEFORE_CHANGING_ACCOUNT');
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`aon:link:confirm:${pending.token}`).setLabel('Confirm link').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`aon:link:cancel:${pending.token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ content: `Found **${safeDiscordText(pending.player.username)}** (ID: ${safeDiscordText(pending.player.id)}), level ${display(pending.player.level)}. Confirm to link. This confirms your selection only; account ownership is not verified.`, components: [row] });
      return;
    }
    if (command === 'unlink') {
      const removed = tools.links.unlink(interaction.user.id);
      await interaction.reply({ content: removed ? 'Your player account was unlinked.' : 'No player account is linked.', flags: MessageFlags.Ephemeral });
      return;
    }
    const link = tools.links.getByDiscordUser(interaction.user.id);
    if (!link) { await interaction.reply({ content: 'Link your game account first with /link.', flags: MessageFlags.Ephemeral }); return; }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const snapshot = command === 'refresh' ? await tools.api.refreshPlayer(link.playerId, link.username) : await tools.api.getSnapshot(link.playerId);
    if (command === 'profile' || command === 'refresh') {
      const p = snapshot.profile;
      const rank = p.rank && typeof p.rank === 'object' ? (p.rank as { code?: unknown }).code : undefined;
      await interaction.editReply({ content: `**${safeDiscordText(p.username)}** · Level ${display(p.level)} · ${safeDiscordText(rank ?? 'Rank unavailable')}\nCountry: ${safeDiscordText(p.countryId ?? 'Unavailable')} · Prestige: ${display(p.prestige)}\nFetched: ${snapshot.fetchedAt}\n_Linked, not ownership-verified._`, allowedMentions: { parse: [] } });
    } else if (command === 'stats') {
      const s = snapshot.stats;
      await interaction.editReply({ content: `**${safeDiscordText(s.username)} — statistics**\nDamage: all ${display(s.damage?.all ?? s.damage?.total)}, week ${display(s.damage?.week)}, month ${display(s.damage?.month)}\nWork: all ${display(s.work?.all)}, week ${display(s.work?.week)}\nTrade: all ${display(s.trade?.all)}, week ${display(s.trade?.week)}\nCompanies: ${display(snapshot.companies.total ?? snapshot.companies.companies.length)}\nFetched: ${snapshot.fetchedAt}`, allowedMentions: { parse: [] } });
    } else {
      const a = analyzePlayer(snapshot);
      await interaction.editReply({ content: `**${safeDiscordText(snapshot.profile.username)} — activity analysis**\nCurrent momentum: ${a.currentFocus}\n${a.explanation}\nHistorical specialization: ${a.historicalSpecialization}. ${a.historicalExplanation}\nFetched: ${snapshot.fetchedAt}`, allowedMentions: { parse: [] } });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Player API request failed';
    logger.error('Player command failed', { stage: `player_${command}`, userId: interaction.user.id, error: message, stack: error instanceof Error ? error.stack : undefined });
    const response = message === 'PLAYER_ALREADY_LINKED' ? 'That game account is already linked to another Discord user.'
      : message === 'UNLINK_BEFORE_CHANGING_ACCOUNT' ? 'Unlink your current account first, then link the new account.'
        : message === 'LINK_CONFIRMATION_EXPIRED' ? 'This confirmation expired or belongs to another user. Run /link again.'
          : 'Could not retrieve player information right now. Please try again later.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(response);
    else await interaction.reply({ content: response, flags: MessageFlags.Ephemeral });
  }
}

function display(value: unknown): string { return value === undefined || value === null || value === '' ? 'unavailable' : String(value).slice(0, 100); }
function safeDiscordText(value: unknown): string { return String(value).replace(/([\\`*_{}\[\]()<>#+\-.!|~])/gu, '\\$1').replace(/@/gu, '@\u200b').slice(0, 100); }

/** The only parts of a Discord message the routing decision needs. `Message` satisfies this structurally; tests can pass plain objects. */
export interface RoutableMessage {
  guildId: string | null;
  channelId: string;
  mentions: { has(userId: string): boolean };
  reference: { messageId?: string | undefined } | null;
  fetchReference(): Promise<{ author: { id: string } }>;
}

export async function shouldHandleMessage(message: RoutableMessage, botId: string, ticketChannelId?: string): Promise<boolean> {
  if (!message.guildId) return false;
  if (ticketChannelId && message.channelId === ticketChannelId) return false;
  if (message.mentions.has(botId)) return true;
  if (!message.reference?.messageId) return false;
  try {
    const referenced = await message.fetchReference();
    return referenced.author.id === botId;
  } catch { return false; }
}

async function handleAsk(interaction: ChatInputCommandInteraction, assistant: AssistantService): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) { await interaction.reply({ content: 'Use /ask inside a server.', flags: MessageFlags.Ephemeral }); return; }
  await interaction.deferReply();
  try {
    const response = await assistant.ask({ guildId, userId: interaction.user.id, question: interaction.options.getString('question', true) });
    const parts = splitDiscordMessage(response);
    await interaction.editReply(parts[0]!);
    for (const part of parts.slice(1)) await interaction.followUp(part);
  } catch (error) {
    const { failure, retryAfter, httpStatus } = failureInfo(error);
    const original = error instanceof Error ? error : new Error(String(error));
    logger.error('Slash ask failed', { stage: 'discord_slash_ask', failure, guildId, userId: interaction.user.id, httpStatus, retryAfterSeconds: retryAfter, error: original.message, stack: original.stack });
    const message = failure === 'rate_limit' && retryAfter
      ? `طلبات المساعد كثيرة حاليًا. جرّب تاني بعد ${retryAfter} ثانية.`
      : failure === 'rate_limit'
      ? 'طلبات المساعد كثيرة حاليًا. حاول مرة أخرى بعد قليل.'
      : failure === 'timeout' || failure === 'unavailable'
        ? 'المساعد لا يستطيع الوصول إلى خدمة الإجابة الآن. حاول مرة أخرى بعد قليل.'
        : 'تعذر إكمال الإجابة الآن. حاول مرة أخرى لاحقًا.';
    await interaction.editReply(message);
  }
}

function failureInfo(error: unknown): { failure: string; retryAfter?: number; httpStatus?: number } {
  if (error instanceof AssistantRateLimitError) return { failure: 'rate_limit', retryAfter: error.retryAfterSeconds };
  if (error instanceof LlmError) return { failure: error.kind, ...(error.retryAfterSeconds === undefined ? {} : { retryAfter: error.retryAfterSeconds }), ...(error.status === undefined ? {} : { httpStatus: error.status }) };
  return { failure: 'request_failed' };
}

export function splitDiscordMessage(text: string, maxLength = 1900): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 100) throw new Error('Message length limit must be at least 100');
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    let boundary = remaining.lastIndexOf('\n', maxLength);
    if (boundary < maxLength * 0.5) boundary = remaining.lastIndexOf(' ', maxLength);
    if (boundary < maxLength * 0.5) boundary = maxLength;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.length ? parts : ['لم يصل رد نصي من المساعد.'];
}
