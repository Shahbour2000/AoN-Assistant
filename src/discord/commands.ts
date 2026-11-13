import { REST, Routes, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check whether AoN Assistant is online.'),
  new SlashCommandBuilder().setName('ask').setDescription('Ask the Age of Nations assistant a question.')
    .addStringOption((option) => option.setName('question').setDescription('Your question about Age of Nations').setRequired(true).setMaxLength(1500)),
  new SlashCommandBuilder().setName('mentor').setDescription('Get your next personalized beginner or progression step.'),
  new SlashCommandBuilder().setName('link').setDescription('Link your Age of Nations player account.')
    .addStringOption((option) => option.setName('username').setDescription('Your in-game username').setRequired(true).setMaxLength(40)),
  new SlashCommandBuilder().setName('unlink').setDescription('Remove your linked Age of Nations account.'),
  new SlashCommandBuilder().setName('profile').setDescription('Show your linked player profile.'),
  new SlashCommandBuilder().setName('stats').setDescription('Show your linked player statistics.'),
  new SlashCommandBuilder().setName('analyze').setDescription('Analyze your linked player activity.'),
  new SlashCommandBuilder().setName('refresh').setDescription('Refresh and show your linked player data.'),
  new SlashCommandBuilder().setName('ticket').setDescription('Configure and manage support tickets.')
    .addSubcommand((sub) => sub.setName('configure').setDescription('Set ticket channel and category.')
      .addChannelOption((option) => option.setName('channel').setDescription('Ticket panel channel').setRequired(true))
      .addChannelOption((option) => option.setName('category').setDescription('Category for ticket channels').setRequired(true))
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
