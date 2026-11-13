import { ChannelType, EmbedBuilder, OverwriteType, PermissionFlagsBits, type ChatInputCommandInteraction, type Guild, type GuildBasedChannel, type GuildMember, type PermissionResolvable, type TextChannel } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { GuildSettingsRepository, TicketRepository } from '../database/repositories.js';
import { logger } from '../logging/logger.js';

export const TICKET_OPEN_ID = 'aon:ticket:open';
export const TICKET_CLOSE_ID = 'aon:ticket:close';

export class TicketService {
  constructor(private readonly settings: GuildSettingsRepository, private readonly tickets: TicketRepository) {}

  async configure(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !await isAdministrator(interaction)) { await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true }); return; }
    const channel = interaction.options.getChannel('channel', true);
    const category = interaction.options.getChannel('category', true);
    if (channel.type !== ChannelType.GuildText || category.type !== ChannelType.GuildCategory) {
      await interaction.reply({ content: 'Provide a text channel and a category.', ephemeral: true }); return;
    }
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const color = interaction.options.getString('color');
    const buttonLabel = interaction.options.getString('button');
    if (title && title.length > 256 || description && description.length > 4000 || buttonLabel && buttonLabel.length > 80 || color && !/^#[0-9a-f]{6}$/iu.test(color)) {
      await interaction.reply({ content: 'Embed title, description, button label, or #RRGGBB color is invalid.', ephemeral: true }); return;
    }
    this.settings.upsert({ guildId: interaction.guild.id, ticketChannelId: channel.id, ticketCategoryId: category.id,
      ...(title ? { embedTitle: title } : {}), ...(description ? { embedDescription: description } : {}), ...(color ? { embedColor: color } : {}), ...(buttonLabel ? { buttonLabel } : {}) });
    await interaction.reply({ content: 'Ticket settings saved for this server.', ephemeral: true });
  }

  async postPanel(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !await isAdministrator(interaction)) { await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true }); return; }
    const config = this.settings.get(interaction.guild.id);
    if (!config?.ticketChannelId) { await interaction.reply({ content: 'Configure a ticket channel first.', ephemeral: true }); return; }
    const channel = await interaction.guild.channels.fetch(config.ticketChannelId);
    if (!channel?.isTextBased() || !('send' in channel)) { await interaction.reply({ content: 'The configured ticket channel is unavailable.', ephemeral: true }); return; }
    const color = config.embedColor && /^#[0-9a-f]{6}$/iu.test(config.embedColor) ? Number.parseInt(config.embedColor.slice(1), 16) : 0x5865f2;
    await channel.send({ embeds: [new EmbedBuilder().setTitle(config.embedTitle ?? 'Age of Nations Support').setDescription(config.embedDescription ?? 'Press the button below to open a private assistant ticket.').setColor(color)], components: [{ type: 1, components: [{ type: 2, style: 1, label: config.buttonLabel ?? 'Open a ticket', custom_id: TICKET_OPEN_ID }] }] });
    await interaction.reply({ content: 'Ticket panel posted.', ephemeral: true });
  }

  async open(guild: Guild, member: GuildMember): Promise<TextChannel> {
    let stage = 'load_settings';
    const config = this.settings.get(guild.id);
    if (!config?.ticketCategoryId) throw new Error('Ticket category is not configured');
    let category: GuildBasedChannel | null;
    try { category = await guild.channels.fetch(config.ticketCategoryId) as GuildBasedChannel | null; }
    catch (error) { throw logTicketFailure(error, stage, guild.id, { categoryId: config.ticketCategoryId }); }
    if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== guild.id) throw new Error('Configured ticket category is invalid or unavailable');
    const botId = guild.client.user?.id;
    if (!botId) throw new Error('Bot identity is unavailable');
    stage = 'fetch_bot_member';
    let botMember: GuildMember;
    try { botMember = await guild.members.fetch(botId); }
    catch (error) { throw logTicketFailure(error, stage, guild.id, { botId, categoryId: category.id }); }
    const permissions = category.permissionsFor(botMember);
    if (!permissions?.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel])) throw new Error('Bot needs Manage Channels and View Channel permissions in the ticket category');
    const active = this.tickets.getOpenByOwner(guild.id, member.id);
    if (active) throw new Error('You already have an open ticket');
    const id = randomUUID();
    stage = 'create_ticket_channel';
    let channel: TextChannel;
    try { channel = await guild.channels.create({
      name: `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').slice(0, 70) || 'player'}`,
      type: ChannelType.GuildText, parent: config.ticketCategoryId,
      permissionOverwrites: createTicketPermissionOverwrites({
        everyoneId: guild.roles.everyone.id,
        ownerId: member.id,
        botId,
      }),
    }); } catch (error) { throw logTicketFailure(error, stage, guild.id, { everyoneId: guild.roles.everyone.id, ownerId: member.id, botId, categoryId: category.id, ownerFetched: true, botMemberFetched: true }); }
    stage = 'persist_ticket';
    try {
      this.tickets.create({ id, guildId: guild.id, ownerId: member.id, channelId: channel.id, sessionId: id, status: 'open', createdAt: new Date().toISOString(), closedAt: null });
      await channel.send({ content: `<@${member.id}> Your private support ticket is open.`, components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Close ticket', custom_id: TICKET_CLOSE_ID }] }] });
      return channel;
    } catch (error) {
      await channel.delete().catch(() => undefined);
      throw logTicketFailure(error, stage, guild.id, { ownerId: member.id, botId, categoryId: category.id, channelId: channel.id });
    }
  }

  async close(guild: Guild, channelId: string, member: GuildMember): Promise<void> {
    const ticket = this.tickets.getByChannel(channelId);
    if (!ticket || ticket.status !== 'open') throw new Error('This ticket is not open');
    const permitted = canCloseTicket(ticket.ownerId, member.id, typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator));
    if (!permitted) throw new Error('You are not allowed to close this ticket');
    this.tickets.close(ticket.id);
    try { const channel = await guild.channels.fetch(channelId); await channel?.delete(); }
    catch (error) {
      this.tickets.reopen(ticket.id);
      throw error;
    }
  }
}

export function createTicketPermissionOverwrites(input: { everyoneId: string; ownerId: string; botId: string }): Array<{ id: string; type: OverwriteType; allow?: PermissionResolvable[]; deny?: PermissionResolvable[] }> {
  const readAndWrite = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
  return [
    { id: input.everyoneId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: input.ownerId, type: OverwriteType.Member, allow: readAndWrite },
    { id: input.botId, type: OverwriteType.Member, allow: [...readAndWrite, PermissionFlagsBits.ManageChannels] },
  ];
}

export function canCloseTicket(ownerId: string, memberId: string, isAdministrator: boolean): boolean {
  return ownerId === memberId || isAdministrator;
}

function logTicketFailure(error: unknown, stage: string, guildId: string, targets: Record<string, unknown>): Error {
  const failure = error instanceof Error ? error : new Error(String(error));
  logger.error('Ticket creation failed', { stage, guildId, ...targets, error: failure.message, stack: failure.stack });
  return failure;
}

async function isAdministrator(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.member;
  if (!member) return false;
  if ('permissions' in member && typeof member.permissions !== 'string') return member.permissions.has(PermissionFlagsBits.Administrator);
  return false;
}
