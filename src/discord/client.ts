import { Client, Events, GatewayIntentBits, MessageFlags, type ChatInputCommandInteraction, type Message } from 'discord.js';
import type { AssistantService } from '../assistant/service.js';
import { GeminiFailure } from '../gemini/client.js';
import { logger } from '../logging/logger.js';
import type { GuildSettingsRepository, TicketRepository } from '../database/repositories.js';
import { TicketService, TICKET_CLOSE_ID, TICKET_OPEN_ID } from './tickets.js';

export function createDiscordClient(assistant: AssistantService, settings: GuildSettingsRepository, tickets: TicketRepository): Client {
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
    try {
      const response = await assistant.ask({ guildId: message.guildId, userId: message.author.id, question, ...(ticket?.status === 'open' ? { conversationId: ticket.sessionId } : {}) });
      for (const part of splitDiscordMessage(response)) await message.reply({ content: part, allowedMentions: { repliedUser: false } });
    } catch (error) {
      const failure = error instanceof GeminiFailure ? error.kind : 'request_failed';
      logger.warn('Assistant message failed', { failure, guildId: message.guildId, userId: message.author.id });
      const reply = failure === 'rate_limit' ? 'طلبات المساعد كثيرة حاليًا. حاول مرة أخرى بعد قليل.'
        : failure === 'timeout' || failure === 'unavailable' ? 'المساعد لا يستطيع الوصول إلى خدمة الإجابة الآن. حاول مرة أخرى بعد قليل.'
          : 'تعذر إكمال الإجابة الآن. حاول مرة أخرى لاحقًا.';
      try { await message.reply({ content: reply, allowedMentions: { repliedUser: false } }); }
      catch { logger.warn('Unable to send safe error reply', { guildId: message.guildId }); }
    }
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
      try {
        if (interaction.customId === TICKET_OPEN_ID && interaction.guild) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const channel = await ticketService.open(interaction.guild, member);
          await interaction.reply({ content: `Your ticket is ready: ${channel}`, ephemeral: true });
        } else if (interaction.customId === TICKET_CLOSE_ID && interaction.guild) {
          const member = await interaction.guild.members.fetch(interaction.user.id);
          await ticketService.close(interaction.guild, interaction.channelId, member);
          await interaction.reply({ content: 'Ticket closed.', ephemeral: true });
        }
      } catch (error) {
        await interaction.reply({ content: error instanceof Error ? error.message : 'Could not complete the ticket action.', ephemeral: true }).catch(() => undefined);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong! AoN Assistant is online.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === 'ask') await handleAsk(interaction, assistant);
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

export async function shouldHandleMessage(message: Pick<Message, 'guildId' | 'channelId' | 'mentions' | 'reference' | 'fetchReference'>, botId: string, ticketChannelId?: string): Promise<boolean> {
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
    const failure = error instanceof GeminiFailure ? error.kind : 'request_failed';
    logger.warn('Assistant request failed', { failure, guildId, userId: interaction.user.id });
    const message = failure === 'rate_limit'
      ? 'طلبات المساعد كثيرة حاليًا. حاول مرة أخرى بعد قليل.'
      : failure === 'timeout' || failure === 'unavailable'
        ? 'المساعد لا يستطيع الوصول إلى خدمة الإجابة الآن. حاول مرة أخرى بعد قليل.'
        : 'تعذر إكمال الإجابة الآن. حاول مرة أخرى لاحقًا.';
    await interaction.editReply(message);
  }
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
