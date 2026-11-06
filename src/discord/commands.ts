import { REST, Routes, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check whether AoN Assistant is online.'),
  new SlashCommandBuilder().setName('ask').setDescription('Ask the Age of Nations assistant a question.')
    .addStringOption((option) => option.setName('question').setDescription('Your question about Age of Nations').setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName('ticket').setDescription('Configure and manage support tickets.')
    .addSubcommand((sub) => sub.setName('configure').setDescription('Set ticket channel, category, and manager roles.')
      .addChannelOption((option) => option.setName('channel').setDescription('Ticket panel channel').setRequired(true))
      .addChannelOption((option) => option.setName('category').setDescription('Category for ticket channels').setRequired(true))
      .addStringOption((option) => option.setName('roles').setDescription('Comma-separated role IDs allowed to close tickets').setRequired(true))
      .addStringOption((option) => option.setName('title').setDescription('Panel embed title'))
      .addStringOption((option) => option.setName('description').setDescription('Panel embed description'))
      .addStringOption((option) => option.setName('color').setDescription('Panel color in #RRGGBB format'))
      .addStringOption((option) => option.setName('button').setDescription('Open button label')))
    .addSubcommand((sub) => sub.setName('panel').setDescription('Post the ticket opening panel in the configured channel.'))
    .addSubcommand((sub) => sub.setName('close').setDescription('Close this ticket.')),
].map((command) => command.toJSON());

export async function registerCommands(token: string, clientId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}
