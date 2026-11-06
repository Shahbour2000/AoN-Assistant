import { ChannelType, EmbedBuilder, PermissionFlagsBits, type ChatInputCommandInteraction, type Guild, type GuildMember, type TextChannel } from 'discord.js';
import { randomUUID } from 'node:crypto';
import type { GuildSettingsRepository, TicketRepository } from '../database/repositories.js';

export const TICKET_OPEN_ID = 'aon:ticket:open';
export const TICKET_CLOSE_ID = 'aon:ticket:close';

export class TicketService {
  constructor(private readonly settings: GuildSettingsRepository, private readonly tickets: TicketRepository) {}

  async configure(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild || !await isAdministrator(interaction)) { await interaction.reply({ content: 'Administrator permission is required.', ephemeral: true }); return; }
    const channel = interaction.options.getChannel('channel', true);
    const category = interaction.options.getChannel('category', true);
    const roles = interaction.options.getString('roles', true).split(',').map((id) => id.trim()).filter(Boolean);
    if (channel.type !== ChannelType.GuildText || category.type !== ChannelType.GuildCategory || roles.some((id) => !/^\d{17,20}$/u.test(id))) {
      await interaction.reply({ content: 'Provide a text channel, a category, and valid comma-separated role IDs.', ephemeral: true }); return;
    }
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const color = interaction.options.getString('color');
    const buttonLabel = interaction.options.getString('button');
    if (title && title.length > 256 || description && description.length > 4000 || buttonLabel && buttonLabel.length > 80 || color && !/^#[0-9a-f]{6}$/iu.test(color)) {
      await interaction.reply({ content: 'Embed title, description, button label, or #RRGGBB color is invalid.', ephemeral: true }); return;
    }
    this.settings.upsert({ guildId: interaction.guild.id, ticketChannelId: channel.id, ticketCategoryId: category.id, ticketAdminRoleIds: roles,
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
    const config = this.settings.get(guild.id);
    if (!config?.ticketCategoryId) throw new Error('Ticket category is not configured');
    const active = this.tickets.getOpenByOwner(guild.id, member.id);
    if (active) throw new Error('You already have an open ticket');
    const id = randomUUID();
    const channel = await guild.channels.create({
      name: `ticket-${member.user.username.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').slice(0, 70) || 'player'}`,
      type: ChannelType.GuildText, parent: config.ticketCategoryId,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
        ...config.ticketAdminRoleIds.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] })),
      ],
    });
    try {
      this.tickets.create({ id, guildId: guild.id, ownerId: member.id, channelId: channel.id, sessionId: id, status: 'open', createdAt: new Date().toISOString(), closedAt: null });
      await channel.send({ content: `<@${member.id}> Your private support ticket is open.`, components: [{ type: 1, components: [{ type: 2, style: 4, label: 'Close ticket', custom_id: TICKET_CLOSE_ID }] }] });
      return channel;
    } catch (error) {
      await channel.delete().catch(() => undefined);
      throw error;
    }
  }

  async close(guild: Guild, channelId: string, member: GuildMember): Promise<void> {
    const ticket = this.tickets.getByChannel(channelId);
    if (!ticket || ticket.status !== 'open') throw new Error('This ticket is not open');
    const config = this.settings.get(guild.id);
    const permitted = ticket.ownerId === member.id || (typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator)) || config?.ticketAdminRoleIds.some((id) => member.roles.cache.has(id));
    if (!permitted) throw new Error('You are not allowed to close this ticket');
    this.tickets.close(ticket.id);
    try { const channel = await guild.channels.fetch(channelId); await channel?.delete(); }
    catch (error) {
      this.tickets.reopen(ticket.id);
      throw error;
    }
  }
}

async function isAdministrator(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.member;
  if (!member) return false;
  if ('permissions' in member && typeof member.permissions !== 'string') return member.permissions.has(PermissionFlagsBits.Administrator);
  return false;
}
