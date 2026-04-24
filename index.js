require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const discordTranscripts = require("discord-html-transcripts");

const math = require("mathjs");

const {
  initDatabase,
  getNextTicketNumber,
  getTicketCounter,
  setTicketCounter,
  getRequirements,
  setRequirements,
  incrementLifetimeTicketCount,
  getLifetimeTicketCount,
  createTicket,
  getTicketByChannelId,
  getOpenTicketByOwnerId,
  getQueuedOpenTickets,
  addTicketToQueue,
  removeTicketFromQueue,
  setTicketQueuePosition,
  clearQueueForClosedOrDeletedTicket,
  closeTicket,
  deleteTicket,
  markTranscriptGenerated,
  createIntakeSession,
  getIntakeSession,
  updateIntakeSession,
  stopIntakeSession,
  getCountingState,
  updateCountingState,
  recordHighStreak,
  incrementMistakes,
  getTopStreaks,
  getTopMistakes,
} = require("./database");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const userSelections = new Map();
const pendingAppSelections = new Map();
const pendingHelpSelections = new Map();
const channelRenameCooldowns = new Map(); // channelId -> last rename timestamp

const BROAD_APP_CHANNEL_MEMBER_LIMIT = 25;

// Prevent bot crash on Discord rate limits
client.on("error", (error) => console.error("Discord client error:", error));
process.on("unhandledRejection", (error) =>
  console.error("Unhandled promise rejection:", error),
);

client.once("clientReady", async () => {
  try {
    await initDatabase();
    console.log(`Logged in as ${client.user.tag}`);
    console.log("✅ Postgres database connected and initialized.");

    // Automatic rich presence
    client.user.setActivity("Apply now!", { type: 0 }); // Playing • Apply now!
    console.log('✅ Rich presence set: "Apply now!"');
  } catch (error) {
    console.error("Startup error:", error);
  }
});

function hasStaffAccess(member) {
  return (
    member.roles.cache.has(process.env.STAFF_ROLE_ID) ||
    member.roles.cache.has(process.env.OWNER_ROLE_ID)
  );
}

function getBotLogoUrl() {
  if (process.env.BOT_LOGO_URL) return process.env.BOT_LOGO_URL;
  return client.user.displayAvatarURL({ size: 256 });
}

function getFooterIconUrl() {
  if (process.env.FOOTER_ICON_URL) return process.env.FOOTER_ICON_URL;
  return client.user.displayAvatarURL({ size: 256 });
}

function buildBotEmbed({
  title,
  description,
  fields = [],
  color = 0x2b2d31,
  footerNote = null,
}) {
  const footerText = footerNote
    ? `Developed by Branslam • ${footerNote}`
    : "Developed by Branslam";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .setThumbnail(getBotLogoUrl())
    .setFooter({
      text: footerText,
      iconURL: getFooterIconUrl(),
    })
    .setTimestamp();

  if (fields.length > 0) {
    embed.addFields(fields);
  }

  return embed;
}

function clearPendingAppSelection(channelId) {
  const pending = pendingAppSelections.get(channelId);
  if (pending?.timeout) {
    clearTimeout(pending.timeout);
  }
  pendingAppSelections.delete(channelId);
}

function setPendingAppSelection(channelId, ownerId, userIds) {
  clearPendingAppSelection(channelId);

  const timeout = setTimeout(() => {
    pendingAppSelections.delete(channelId);
  }, 5000);

  pendingAppSelections.set(channelId, {
    ownerId,
    userIds,
    timeout,
  });
}

function clearPendingHelpSelection(channelId) {
  pendingHelpSelections.delete(channelId);
}

function setPendingHelpSelection(channelId, ownerId) {
  pendingHelpSelections.set(channelId, { ownerId });
}

function normalizeSearchText(text) {
  return text.toLowerCase().trim();
}

function extractMentionedUserId(raw) {
  const match = raw.match(/^<@!?(\d+)>$/);
  return match ? match[1] : null;
}

function parseIntegerInput(raw) {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^\d+$/.test(cleaned)) return null;
  return parseInt(cleaned, 10);
}

function parseTicketTypeFlag(raw) {
  const normalized = String(raw || "").toLowerCase();
  if (normalized === "s") return "standard";
  if (normalized === "p") return "paid";
  return null;
}

function formatTicketTypeLabel(ticketType) {
  return ticketType === "paid" ? "Paid" : "Standard";
}

function formatPlatformLabel(value) {
  if (value === "pc") return "PC";
  if (value === "mobile") return "Mobile";
  if (value === "console") return "Console";
  return value;
}

function formatActivityLabel(value) {
  const map = {
    lt1: "<1 hour",
    h1_3: "1–3 hours",
    h4_8: "4–8 hours",
    h9_24: "9–24 hours",
    h25plus: "25+ hours",
  };
  return map[value] || value;
}

function formatYesNo(value) {
  return value === "yes" ? "Yes" : "No";
}

function hasOwnerAccess(member) {
  return member.roles.cache.has(process.env.OWNER_ROLE_ID);
}

// ====================== NEW MODERATION HELPERS ======================

async function resolveUser(guild, rawInput) {
  if (!rawInput) return null;
  const query = String(rawInput).trim();

  const mentionId = extractMentionedUserId(query);
  const userId = mentionId || (/^\d+$/.test(query) ? query : null);

  if (userId) {
    return (
      guild.members.cache.get(userId) ||
      (await guild.members.fetch(userId).catch(() => null)) ||
      (await guild.users.fetch(userId).catch(() => null))
    ); // fallback for unbans
  }

  return await findMemberFromQuery(guild, query);
}

async function getTicketOwnerOrMentioned(message) {
  const ticketInfo = await getTicketByChannelId(message.channel.id);
  if (!ticketInfo) return null;

  // If replied to a message, use that author
  if (message.reference) {
    const repliedMsg = await message.channel.messages
      .fetch(message.reference.messageId)
      .catch(() => null);
    if (repliedMsg && !repliedMsg.author.bot) {
      return repliedMsg.author;
    }
  }

  return null;
}

function parseDurationString(raw) {
  const match = String(raw || "")
    .trim()
    .toLowerCase()
    .match(/^(\d+)([smhd])$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  let ms = 0;

  if (unit === "s") ms = value * 1000;
  if (unit === "m") ms = value * 60 * 1000;
  if (unit === "h") ms = value * 60 * 60 * 1000;
  if (unit === "d") ms = value * 24 * 60 * 60 * 1000;

  const maxMs = 28 * 24 * 60 * 60 * 1000;

  if (ms <= 0 || ms > maxMs) return null;

  return {
    value,
    unit,
    ms,
  };
}

async function resolveGuildMember(guild, rawInput) {
  const query = String(rawInput || "").trim();
  if (!query) return null;

  const mentionId = extractMentionedUserId(query);
  const userId = mentionId || (/^\d+$/.test(query) ? query : null);

  if (userId) {
    return (
      guild.members.cache.get(userId) ||
      (await guild.members.fetch(userId).catch(() => null))
    );
  }

  return await findMemberFromQuery(guild, query);
}

function formatRequirementValue(value) {
  return String(value).toLowerCase() === "null"
    ? "Unavailable / N/A"
    : String(value);
}

function evaluateStandardCriteria(data) {
  const failures = [];

  if (data.activity === "lt1") {
    failures.push("Estimated weekly activity is under 1 hour.");
  }

  if (typeof data.wins === "number" && data.wins < 1200) {
    failures.push("Wins are under 1200.");
  }

  if (
    typeof data.wins === "number" &&
    typeof data.kills === "number" &&
    data.wins > data.kills
  ) {
    failures.push(
      "Wins are greater than kills, which likely means the values were swapped.",
    );
  }

  if (data.afkFarm === "no") {
    failures.push("Cannot AFK farm crowns.");
  }

  return failures;
}

function buildBaseTicketChannelName(ticketInfo) {
  return `ticket-${String(ticketInfo.ticket_number).padStart(3, "0")}`;
}

function buildQueuedTicketChannelName(ticketInfo, queuePosition) {
  return `q${queuePosition}-${buildBaseTicketChannelName(ticketInfo)}`;
}

async function refreshQueueNames(guild) {
  try {
    const queuedTickets = await getQueuedOpenTickets();

    for (let i = 0; i < queuedTickets.length; i++) {
      const ticket = queuedTickets[i];
      const newPosition = i + 1;

      await setTicketQueuePosition(ticket.channel_id, newPosition);

      const channel = await guild.channels
        .fetch(ticket.channel_id)
        .catch(() => null);
      if (!channel) continue;

      const desiredName = buildQueuedTicketChannelName(ticket, newPosition);

      if (channel.name !== desiredName) {
        try {
          await channel.setName(desiredName);
          console.log(`[QUEUE] Updated name: ${channel.name} → ${desiredName}`);
        } catch (err) {
          console.error(
            `[QUEUE] Rename failed for ${ticket.channel_id}:`,
            err.message,
          );
        }
      }
    }
  } catch (error) {
    console.error("[QUEUE] Critical error in refreshQueueNames:", error);
  }
}

async function resetChannelNameFromTicket(channel, ticketInfo) {
  const desiredName = buildBaseTicketChannelName(ticketInfo);

  if (channel.name === desiredName) return;

  try {
    await channel.setName(desiredName);
    console.log(
      `[QUEUE] Reset name for ticket ${ticketInfo.ticket_number} → ${desiredName}`,
    );
  } catch (error) {
    console.error(
      `[QUEUE] Failed to reset name for ${channel.id}:`,
      error.message,
    );
    // Don't crash the command
  }
}

function canRenameChannel(channelId) {
  const lastRename = channelRenameCooldowns.get(channelId);
  if (!lastRename) return true;

  const cooldownMs = 10 * 60 * 1000; // 10 minutes
  return Date.now() - lastRename > cooldownMs;
}

function setChannelRenameCooldown(channelId) {
  channelRenameCooldowns.set(channelId, Date.now());
}

function buildRequirementsEmbed(requirements) {
  return buildBotEmbed({
    title: "📋 Clan Requirements",
    description:
      "✨ Here are the current requirements for **standard members** to stay in the clan:",
    fields: [
      {
        name: "👑 Standard Members",
        value: `${requirements.standardCrowns} crowns per week`,
        inline: true,
      },
      {
        name: "💎 Server Boosters",
        value: `${requirements.boosterCrowns} crowns per week`,
        inline: true,
      },
      {
        name: "🛡️ Staff",
        value: `${requirements.staffCrowns} crowns per week`,
        inline: true,
      },
      {
        name: "⚔️ AP Requirement",
        value: formatRequirementValue(requirements.ap),
        inline: true,
      },
      {
        name: "📣 Blade Ball Ads",
        value: `${requirements.ads} clan advertisements in the official Blade Ball server`,
        inline: false,
      },
    ],
  });
}

async function findMemberFromQuery(guild, rawQuery) {
  const query = rawQuery.trim();
  if (!query) return null;

  try {
    await guild.members.fetch({ force: false });
  } catch (e) {}

  const mentionId = extractMentionedUserId(query);
  if (mentionId) {
    return guild.members.cache.get(mentionId) || null;
  }

  if (/^\d+$/.test(query)) {
    return guild.members.cache.get(query) || null;
  }

  const normalized = normalizeSearchText(query);

  const exactMatch = guild.members.cache.find((member) => {
    const username = normalizeSearchText(member.user.username);
    const displayName = normalizeSearchText(member.displayName);
    const globalName = member.user.globalName
      ? normalizeSearchText(member.user.globalName)
      : "";

    return (
      username === normalized ||
      displayName === normalized ||
      globalName === normalized
    );
  });

  if (exactMatch) return exactMatch;

  const partialMatches = guild.members.cache.filter((member) => {
    const username = normalizeSearchText(member.user.username);
    const displayName = normalizeSearchText(member.displayName);
    const globalName = member.user.globalName
      ? normalizeSearchText(member.user.globalName)
      : "";

    return (
      username.includes(normalized) ||
      displayName.includes(normalized) ||
      globalName.includes(normalized)
    );
  });

  if (partialMatches.size === 1) {
    return partialMatches.first();
  }

  return null;
}

async function getVisibleNonBotMembers(channel) {
  try {
    await channel.guild.members.fetch({ force: false });
  } catch (e) {
    console.error("Member fetch error (rate limited?):", e.message);
  }

  return channel.guild.members.cache.filter((member) => {
    if (member.user.bot) return false;
    try {
      return channel
        .permissionsFor(member)
        .has(PermissionFlagsBits.ViewChannel);
    } catch {
      return false;
    }
  });
}

async function sendAppCountEmbed(message, member) {
  const lifetimeCount = await getLifetimeTicketCount(member.id);

  const embed = buildBotEmbed({
    title: "📨 Application Lookup",
    description: `✨ Application count for <@${member.id}>`,
    fields: [
      {
        name: "👤 User",
        value: `${member.user.tag}`,
        inline: true,
      },
      {
        name: "🆔 Discord ID",
        value: member.id,
        inline: true,
      },
      {
        name: "📦 Lifetime Applications",
        value: String(lifetimeCount),
        inline: true,
      },
    ],
  });

  await message.reply({ embeds: [embed] });
}

function createSelectRow(customId, placeholder, options) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .addOptions(options),
  );
}

function createButtonRow(customId, label, style = ButtonStyle.Primary) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style),
  );
}

async function sendUsernameQuestion(channel) {
  const embed = buildBotEmbed({
    title: "📝 Question 1",
    description: "🎮 Press the button below to enter your in-game username.",
  });

  const row = createButtonRow(
    "intake_open_username_modal",
    "Enter In-Game Username",
  );

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendUsernameConfirmQuestion(channel, username) {
  const embed = buildBotEmbed({
    title: "✅ Confirm Username",
    description: `You entered **${username}**.\n\n❓ Is this your correct in-game username?`,
  });

  const row = createSelectRow(
    "intake_username_confirm_select",
    "Choose yes or no",
    [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ],
  );

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendPlatformQuestion(channel, ticketType) {
  const embed = buildBotEmbed({
    title: "🖥️ Question 2",
    description: `🎮 Enter which platform you play on for this ${ticketType} ticket.`,
  });

  const row = createSelectRow("intake_platform_select", "Choose a platform", [
    { label: "PC", value: "pc" },
    { label: "Mobile", value: "mobile" },
    { label: "Console", value: "console" },
  ]);

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendActivityQuestion(channel) {
  const embed = buildBotEmbed({
    title: "⏱️ Question 3",
    description: "📊 Enter your estimated weekly activity.",
  });

  const row = createSelectRow(
    "intake_activity_select",
    "Choose your activity level",
    [
      { label: "<1 hour", value: "lt1" },
      { label: "1–3 hours", value: "h1_3" },
      { label: "4–8 hours", value: "h4_8" },
      { label: "9–24 hours", value: "h9_24" },
      { label: "25+ hours", value: "h25plus" },
    ],
  );

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendWinsKillsQuestion(channel) {
  const embed = buildBotEmbed({
    title: "🏆 Question 4",
    description:
      "📈 Enter your wins and kills.\n\nPress the button below to open the form. Whole numbers only. Commas are okay.",
  });

  const row = createButtonRow(
    "intake_open_winskills_modal",
    "Enter Wins & Kills",
  );

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendAfkQuestion(channel) {
  const embed = buildBotEmbed({
    title: "🌙 Question 5",
    description: "👑 Can you AFK farm (crowns)?",
  });

  const row = createSelectRow("intake_afk_select", "Choose yes or no", [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" },
  ]);

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendPaidConfirmQuestion(channel) {
  const embed = buildBotEmbed({
    title: "💰 Question 3",
    description:
      "A 4Less Premium membership starts at 1000 Blade Ball tokens for your first month and will require additional recurring payments of the same amount after the first month, on the same day as the initial down payment. Confirm if this works for you or not.",
  });

  const row = createSelectRow(
    "intake_paid_confirm_select",
    "Choose yes or no",
    [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
    ],
  );

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendHelpMenu(channel) {
  const embed = buildBotEmbed({
    title: "🆘 Ticket Help",
    description: "✨ Choose how you want to request assistance.",
  });

  const row = createSelectRow("ticket_help_select", "Choose a help option", [
    { label: "Ping Staff Team", value: "staff_team" },
    { label: "Ping Specific Staff", value: "specific_staff" },
  ]);

  await channel.send({
    embeds: [embed],
    components: [row],
  });
}

async function sendNextIntakePrompt(channel, session) {
  if (
    session.step === "standard_username" ||
    session.step === "paid_username"
  ) {
    await sendUsernameQuestion(channel);
    return;
  }

  if (
    session.step === "standard_username_confirm" ||
    session.step === "paid_username_confirm"
  ) {
    const pendingUsername = session.data?.pendingUsername || "Unknown";
    await sendUsernameConfirmQuestion(channel, pendingUsername);
    return;
  }

  if (session.step === "standard_platform") {
    await sendPlatformQuestion(channel, "standard");
    return;
  }

  if (session.step === "standard_activity") {
    await sendActivityQuestion(channel);
    return;
  }

  if (session.step === "standard_winskills") {
    await sendWinsKillsQuestion(channel);
    return;
  }

  if (session.step === "standard_afk") {
    await sendAfkQuestion(channel);
    return;
  }

  if (session.step === "paid_platform") {
    await sendPlatformQuestion(channel, "paid");
    return;
  }

  if (session.step === "paid_confirm") {
    await sendPaidConfirmQuestion(channel);
  }
}

async function handleStandardCompletion(channel, sessionData) {
  const failures = evaluateStandardCriteria(sessionData);
  const passed = failures.length === 0;

  const embed = buildBotEmbed({
    title: "📋 Standard Application Result",
    description: passed
      ? "✅ The applicant currently meets the automatic screening criteria."
      : "❌ The applicant does not meet the automatic screening criteria.",
    color: passed ? 0x57f287 : 0xed4245,
    fields: [
      {
        name: "🎮 In-Game Username",
        value: sessionData.username || "N/A",
        inline: true,
      },
      {
        name: "🖥️ Platform",
        value: formatPlatformLabel(sessionData.platform || "N/A"),
        inline: true,
      },
      {
        name: "⏱️ Weekly Activity",
        value: formatActivityLabel(sessionData.activity || "N/A"),
        inline: true,
      },
      {
        name: "🏆 Wins",
        value: String(sessionData.wins ?? "N/A"),
        inline: true,
      },
      {
        name: "💀 Kills",
        value: String(sessionData.kills ?? "N/A"),
        inline: true,
      },
      {
        name: "👑 AFK Farm",
        value: formatYesNo(sessionData.afkFarm || "N/A"),
        inline: true,
      },
      {
        name: passed ? "✅ Criteria Check" : "❌ Failed Criteria",
        value: passed
          ? "Passed all automatic checks."
          : failures.map((f) => `• ${f}`).join("\n"),
        inline: false,
      },
    ],
  });

  await channel.send({ embeds: [embed] });
}

async function handlePaidCompletion(channel, sessionData) {
  if (sessionData.premiumAccepted === "no") {
    const embed = buildBotEmbed({
      title: "💸 Premium Eligibility Result",
      description: `❌ This applicant is **not eligible** for premium because they did not accept the premium payment terms.\n\n<@&${process.env.OWNER_ROLE_ID}> please review and close this ticket.`,
      color: 0xed4245,
      fields: [
        {
          name: "🎮 In-Game Username",
          value: sessionData.username || "N/A",
          inline: true,
        },
        {
          name: "🖥️ Platform",
          value: formatPlatformLabel(sessionData.platform || "N/A"),
          inline: true,
        },
        { name: "💰 Accepted Premium Terms", value: "No", inline: true },
      ],
    });

    await channel.send({
      content: `<@&${process.env.OWNER_ROLE_ID}>`,
      embeds: [embed],
    });
    return;
  }

  const embed = buildBotEmbed({
    title: "✅ Premium Payment Approval",
    description: `<@&${process.env.OWNER_ROLE_ID}> the applicant accepted the premium payment terms. Please continue with payment collection. From this point forward, this ticket is human-driven.`,
    color: 0x57f287,
    fields: [
      {
        name: "🎮 In-Game Username",
        value: sessionData.username || "N/A",
        inline: true,
      },
      {
        name: "🖥️ Platform",
        value: formatPlatformLabel(sessionData.platform || "N/A"),
        inline: true,
      },
      { name: "💰 Accepted Premium Terms", value: "Yes", inline: true },
    ],
  });

  await channel.send({
    content: `<@&${process.env.OWNER_ROLE_ID}>`,
    embeds: [embed],
  });
}

async function generateTranscript(
  channel,
  ticketInfo,
  actorId = null,
  force = false,
) {
  if (!ticketInfo) {
    console.error("[TRANSCRIPT] No ticketInfo provided");
    return false;
  }

  if (ticketInfo.transcript_generated && !force) {
    return true;
  }

  try {
    const paddedTicketNumber = String(ticketInfo.ticket_number).padStart(
      3,
      "0",
    );
    const filename = `${ticketInfo.type}-ticket-${paddedTicketNumber}-transcript.html`;

    const attachment = await discordTranscripts.createTranscript(channel, {
      limit: -1,
      filename,
      poweredBy: false,
      saveImages: true,
      footerText: "Exported {number} message{s}",
    });

    const embed = buildBotEmbed({
      title: "🧾 Ticket Transcript",
      description: `✨ Transcript generated for **${formatTicketTypeLabel(ticketInfo.type)} Ticket #${paddedTicketNumber}**.`,
      fields: [
        {
          name: "👤 Ticket Owner",
          value: `<@${ticketInfo.owner_id}>`,
          inline: true,
        },
        {
          name: "🛠️ Generated By",
          value: actorId ? `<@${actorId}>` : "Manual",
          inline: true,
        },
      ],
    });

    const logChannelId = process.env.TRANSCRIPT_LOG_CHANNEL_ID;
    const logChannel = logChannelId
      ? await channel.guild.channels.fetch(logChannelId).catch(() => null)
      : null;

    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({
        embeds: [embed],
        files: [attachment],
      });
    } else {
      await channel.send({
        embeds: [embed],
        files: [attachment],
      });
    }

    await markTranscriptGenerated(channel.id);
    return true;
  } catch (error) {
    console.error("[TRANSCRIPT ERROR]", error);
    return false;
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // ====================== COUNTING BOT ======================
  if (
    message.channel.id === process.env.COUNTING_CHANNEL_ID &&
    !message.content.startsWith(process.env.PREFIX)
  ) {
    const state = await getCountingState();
    const expected = state.current_number + 1;

    let number = null;

    try {
      const input = message.content.trim();

      if (/^\d+$/.test(input)) {
        number = parseInt(input, 10);
      } else {
        const cleaned = input.replace(/[^0-9+\-*/^().\s]/gi, "").trim();
        if (cleaned) {
          number = Math.floor(math.evaluate(cleaned));
        }
      }
    } catch (err) {
      return; // invalid input, ignore silently
    }

    if (number === null || isNaN(number)) return;

    // === MISTAKE ===
    if (number !== expected) {
      await incrementMistakes(message.author.id);

      const embed = buildBotEmbed({
        title: "❌ Counting Streak Broken",
        description: `<@${message.author.id}> messed up the count!\n\nExpected **${expected}** but said **${number}**.\nStreak ended at **${state.current_streak}**.\n\nThe count has been reset back to **1**.`,
        color: 0xed4245,
      });

      await message.reply({ embeds: [embed] });

      await updateCountingState(0, null, 0);
      return;
    }

    // === SUCCESS ===
    const newStreak = state.current_streak + 1;

    // Prevent same user twice in a row (except first count)
    if (
      state.last_user_id === message.author.id &&
      state.current_number !== 0
    ) {
      await incrementMistakes(message.author.id);
      await message.reply({
        embeds: [
          buildBotEmbed({
            title: "❌ No Consecutive Counts",
            description: `<@${message.author.id}> you cannot count twice in a row!`,
            color: 0xed4245,
          }),
        ],
      });
      await updateCountingState(0, null, 0);
      return;
    }

    await updateCountingState(number, message.author.id, newStreak);

    // React with green checkmark ✅ on every valid count
    await message.react("✅").catch(() => {});

    if (number === 100) await message.react("💯");
    if (number === 67) {
      await message.react("6️⃣");
      await message.react("7️⃣");
    }

    if (newStreak > 0) {
      await recordHighStreak(message.author.id, newStreak);
    }
  }

  const prefix = process.env.PREFIX;

  const pendingAppSelection = pendingAppSelections.get(message.channel.id);

  if (
    pendingAppSelection &&
    pendingAppSelection.ownerId === message.author.id
  ) {
    try {
      if (!message.content.startsWith(prefix)) {
        clearPendingAppSelection(message.channel.id);

        return message.reply({
          embeds: [
            buildBotEmbed({
              title: "📨 Application Lookup",
              description:
                "❌ Invalid input. The pending selection has been canceled. Run `..app` again.",
            }),
          ],
        });
      }

      const pendingContent = message.content.slice(prefix.length).trim();
      const pendingArgs = pendingContent.split(/ +/);
      const pendingCommand = pendingArgs.shift()?.toLowerCase();

      if (/^\d+$/.test(pendingCommand) && pendingArgs.length === 0) {
        const pickedIndex = parseInt(pendingCommand, 10) - 1;
        const selectedUserId = pendingAppSelection.userIds[pickedIndex];

        if (!selectedUserId) {
          clearPendingAppSelection(message.channel.id);
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "📨 Application Lookup",
                description:
                  "❌ Invalid selection. The request has been canceled. Run `..app` again.",
              }),
            ],
          });
        }

        const member =
          message.guild.members.cache.get(selectedUserId) ||
          (await message.guild.members.fetch(selectedUserId).catch(() => null));

        clearPendingAppSelection(message.channel.id);

        if (!member) {
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "📨 Application Lookup",
                description:
                  "❌ That suggested user could not be found anymore. Run `..app` again.",
              }),
            ],
          });
        }

        await sendAppCountEmbed(message, member);
        return;
      }

      clearPendingAppSelection(message.channel.id);
    } catch (error) {
      console.error("ERROR in pending app selection handler:", error);
      clearPendingAppSelection(message.channel.id);
    }
  }

  const pendingHelpSelection = pendingHelpSelections.get(message.channel.id);

  if (
    pendingHelpSelection &&
    pendingHelpSelection.ownerId === message.author.id
  ) {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo || ticketInfo.status !== "open") {
      clearPendingHelpSelection(message.channel.id);
    } else {
      if (message.content.startsWith(prefix)) {
        const tempContent = message.content.slice(prefix.length).trim();
        const tempCommand = tempContent.split(/ +/)[0]?.toLowerCase();

        if (tempCommand === "help") {
          clearPendingHelpSelection(message.channel.id);
        } else {
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "🆘 Ticket Help",
                description:
                  "❌ Enter a valid staff Discord ID or run `..help` again to choose a different help option.",
              }),
            ],
          });
        }
      } else {
        const raw = message.content.trim();
        const targetId =
          extractMentionedUserId(raw) || (/^\d+$/.test(raw) ? raw : null);

        if (!targetId) {
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "🆘 Ticket Help",
                description:
                  "❌ That is not a valid Discord ID. Enter a valid staff ID or run `..help` again to switch options.",
              }),
            ],
          });
        }

        const member =
          message.guild.members.cache.get(targetId) ||
          (await message.guild.members.fetch(targetId).catch(() => null));

        if (!member || member.user.bot) {
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "🆘 Ticket Help",
                description:
                  "❌ That user ID is invalid. Enter a valid staff ID or run `..help` again.",
              }),
            ],
          });
        }

        const canViewTicket = message.channel
          .permissionsFor(member)
          ?.has(PermissionFlagsBits.ViewChannel);

        if (!canViewTicket) {
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "🆘 Ticket Help",
                description:
                  "❌ That user does not have access to this ticket. Enter a valid staff ID or run `..help` again.",
              }),
            ],
          });
        }

        clearPendingHelpSelection(message.channel.id);

        await message.channel.send({
          content: `<@${member.id}>`,
          embeds: [
            buildBotEmbed({
              title: "🆘 Client Help Request",
              description: `✨ <@${message.author.id}> needs assistance in this ticket.`,
            }),
          ],
        });

        return;
      }
    }
  }

  if (!message.content.startsWith(prefix)) {
    return;
  }

  const contentWithoutPrefix = message.content.slice(prefix.length).trim();
  if (!contentWithoutPrefix) return;

  const args = contentWithoutPrefix.split(/ +/);
  const command = args.shift()?.toLowerCase();
  console.log("COMMAND DETECTED:", command);

  // ====================== COUNTING COMMANDS (LB & HOF) ======================
  if (command === "leaderboard" || command === "lb" || command === "hof") {
    if (message.channel.id !== process.env.COUNTING_CHANNEL_ID) {
      return; // silently ignore if not in counting channel
    }

    try {
      if (command === "leaderboard" || command === "lb") {
        const top = await getTopStreaks(10);

        if (top.length === 0) {
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "🏆 Counting Leaderboard",
                description:
                  "No high scores yet. Be the first to set a record!",
              }),
            ],
          });
        }

        const lines = top.map((entry, i) => {
          const date = entry.highest_streak_date
            ? `<t:${Math.floor(new Date(entry.highest_streak_date).getTime() / 1000)}:D>`
            : "Unknown";
          return `**#${i + 1}** <@${entry.user_id}> — **${entry.highest_streak}** (${date})`;
        });

        return message.reply({
          embeds: [
            buildBotEmbed({
              title: "🏆 Counting Leaderboard",
              description: lines.join("\n"),
            }),
          ],
        });
      }

      if (command === "hof") {
        const top = await getTopMistakes(10);

        if (top.length === 0) {
          return message.reply({
            embeds: [
              buildBotEmbed({
                title: "💀 Hall of Shame",
                description: "No mistakes yet. Impressive!",
              }),
            ],
          });
        }

        const lines = top.map(
          (entry, i) =>
            `**#${i + 1}** <@${entry.user_id}> — **${entry.total_mistakes}** mistakes`,
        );

        return message.reply({
          embeds: [
            buildBotEmbed({
              title: "💀 Hall of Shame",
              description: lines.join("\n"),
            }),
          ],
        });
      }
    } catch (error) {
      console.error("[LB/HOF ERROR]", error);
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "❌ Error",
            description:
              "There was an error fetching the leaderboard. Check console.",
          }),
        ],
      });
    }
  }

  // ====================== LOL COMMAND ======================
  if (command === "lol") {
    if (!message.reference) {
      return; // silent if not a reply
    }

    try {
      const repliedMsg = await message.channel.messages.fetch(
        message.reference.messageId,
      );

      const emojis = ["💀", "☠️", "😭", "😂", "🤣", "🥀"];

      // Shuffle emojis randomly
      const shuffled = emojis.sort(() => Math.random() - 0.5);

      // React in random order
      for (const emoji of shuffled) {
        await repliedMsg.react(emoji).catch(() => {});
      }

      // Delete the user's ..lol command message
      await message.delete().catch(() => {});
    } catch (error) {
      // silently fail if something goes wrong (e.g. message deleted)
    }
    return;
  }

  // ====================== CLAIM OLD TICKET (OWNER ONLY) ======================
  if (command === "claim" || command === "adopt") {
    if (message.author.id !== process.env.OWNER_USER_ID) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔗 Claim Ticket",
            description: "❌ Only the bot owner can use this command.",
          }),
        ],
      });
    }

    const existing = await getTicketByChannelId(message.channel.id);
    if (existing) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔗 Claim Ticket",
            description: "✅ This ticket is already in the system.",
          }),
        ],
      });
    }

    const channelName = message.channel.name.toLowerCase();

    // Safety check
    if (
      !channelName.includes("ticket") &&
      !channelName.includes("app") &&
      !channelName.includes("paid")
    ) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔗 Claim Ticket",
            description:
              '❌ This command can only be used on channels that look like tickets (must contain "ticket", "app", or "paid" in the name).',
            color: 0xed4245,
          }),
        ],
      });
    }

    const isPaid =
      channelName.includes("paid") || channelName.includes("premium");
    const numberMatch = channelName.match(/(\d+)/);
    const ticketNumber = numberMatch ? parseInt(numberMatch[0]) : 999;

    await createTicket({
      channelId: message.channel.id,
      ownerId: "unknown", // You can manually edit this in database later if needed
      type: isPaid ? "paid" : "standard",
      ticketNumber: ticketNumber,
    });

    await message.reply({
      embeds: [
        buildBotEmbed({
          title: "✅ Ticket Claimed",
          description: `This channel has been added as a **${isPaid ? "Paid" : "Standard"}** ticket (#${ticketNumber}).`,
          color: 0x57f287,
        }),
      ],
    });

    return;
  }

  if (command === "ping") {
    return message.reply("pong");
  }

  if (command === "panel") {
    const embed = buildBotEmbed({
      title: "📋 4Less Applications",
      description: `**Please read** <#1410747125943505040> **first** before applying.\n\nChoose your application type below:`,
      color: 0x5865f2,
    });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ticket_type_select")
        .setPlaceholder("Select Application Type")
        .addOptions([
          {
            label: "Standard Application",
            value: "standard",
            description: "Regular membership application",
            emoji: "📝",
          },
          {
            label: "Paid Application",
            value: "paid",
            description: "Priority / Paid application",
            emoji: "💎",
          },
        ]),
    );

    await message.channel.send({ embeds: [embed], components: [row] });
    await message.delete().catch(() => {});
    return;
  }

  if (command === "app") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📨 Application Lookup",
            description: "❌ Only staff can use this command.",
          }),
        ],
      });
    }

    const queryText = args.join(" ").trim();

    if (queryText) {
      const member = await findMemberFromQuery(message.guild, queryText);

      if (!member) {
        return message.reply({
          embeds: [
            buildBotEmbed({
              title: "📨 Application Lookup",
              description:
                "❌ No matching user was found. Try a mention, exact username, display name, or user ID.",
            }),
          ],
        });
      }

      await sendAppCountEmbed(message, member);
      return;
    }

    const visibleMembers = await getVisibleNonBotMembers(message.channel);

    if (visibleMembers.size === 0) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📨 Application Lookup",
            description:
              "❌ There are no visible non-bot users in this channel to scan.",
          }),
        ],
      });
    }

    if (visibleMembers.size > BROAD_APP_CHANNEL_MEMBER_LIMIT) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📨 Application Lookup",
            description:
              "⚠️ This channel has too many visible users to scan broadly. Use `..app <user id>`, `..app <username>`, or mention the user instead.",
          }),
        ],
      });
    }

    const sortedMembers = [...visibleMembers.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );

    setPendingAppSelection(
      message.channel.id,
      message.author.id,
      sortedMembers.map((member) => member.id),
    );

    const lines = sortedMembers.map((member, index) => {
      return `${index + 1}) ${member.displayName} — \`${member.id}\``;
    });

    const embed = buildBotEmbed({
      title: "📨 Application Lookup",
      description: `✨ Pick one of these users with \`..number\` (you have 5 seconds).\n\n${lines.join("\n")}`,
    });

    await message.reply({ embeds: [embed] });
    return;
  }

  if (command === "req") {
    const requirements = await getRequirements();

    return message.reply({
      embeds: [buildRequirementsEmbed(requirements)],
    });
  }

  if (command === "reqedit") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🛠️ Requirement Edit",
            description: "❌ Only staff can edit requirements.",
          }),
        ],
      });
    }

    if (args.length !== 5) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🛠️ Requirement Edit",
            description: "⚠️ Usage: `..reqedit 1000 700 500 null 4`",
          }),
        ],
      });
    }

    const [standardRaw, boosterRaw, staffRaw, apRaw, adsRaw] = args;

    const standardCrowns = parseIntegerInput(standardRaw);
    const boosterCrowns = parseIntegerInput(boosterRaw);
    const staffCrowns = parseIntegerInput(staffRaw);
    const ads = parseIntegerInput(adsRaw);

    if (
      standardCrowns === null ||
      boosterCrowns === null ||
      staffCrowns === null ||
      ads === null
    ) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🛠️ Requirement Edit",
            description:
              "❌ Standard, booster, staff, and ads values must all be whole numbers.",
          }),
        ],
      });
    }

    const normalizedAp =
      String(apRaw).toLowerCase() === "null"
        ? "null"
        : (() => {
            const parsed = parseIntegerInput(apRaw);
            return parsed === null ? null : String(parsed);
          })();

    if (normalizedAp === null) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🛠️ Requirement Edit",
            description: "❌ AP must be either a whole number or `null`.",
          }),
        ],
      });
    }

    await setRequirements({
      standardCrowns,
      boosterCrowns,
      staffCrowns,
      ap: normalizedAp,
      ads,
    });

    const updated = await getRequirements();

    return message.reply({
      embeds: [
        buildBotEmbed({
          title: "✅ Requirements Updated",
          description:
            "✨ The clan requirements have been updated successfully.",
          fields: buildRequirementsEmbed(updated).data.fields,
        }),
      ],
    });
  }

  if (command === "tcount") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🎫 Ticket Counter",
            description: "❌ Only staff can use this command.",
          }),
        ],
      });
    }

    const ticketType = parseTicketTypeFlag(args[0]);

    if (!ticketType) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🎫 Ticket Counter",
            description: "⚠️ Usage: `..tcount s` or `..tcount p`",
          }),
        ],
      });
    }

    const currentValue = await getTicketCounter(ticketType);

    return message.reply({
      embeds: [
        buildBotEmbed({
          title: "🎫 Ticket Counter",
          description: `✨ Current highest internal ${formatTicketTypeLabel(ticketType)} ticket number: **${currentValue}**`,
        }),
      ],
    });
  }

  if (command === "tset") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🎫 Ticket Counter",
            description: "❌ Only staff can use this command.",
          }),
        ],
      });
    }

    const ticketType = parseTicketTypeFlag(args[0]);
    const rawValue = args[1];
    const parsedValue = parseIntegerInput(rawValue || "");

    if (!ticketType || parsedValue === null) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🎫 Ticket Counter",
            description: "⚠️ Usage: `..tset s 40` or `..tset p 30`",
          }),
        ],
      });
    }

    if (parsedValue < 0 || parsedValue > 10000) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🎫 Ticket Counter",
            description:
              "❌ The ticket counter must be a whole number between 0 and 10000.",
          }),
        ],
      });
    }

    await setTicketCounter(ticketType, parsedValue);

    return message.reply({
      embeds: [
        buildBotEmbed({
          title: "✅ Ticket Counter Updated",
          description: `✨ ${formatTicketTypeLabel(ticketType)} ticket counter set to **${parsedValue}**.`,
        }),
      ],
    });
  }

  if (command === "treset") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🎫 Ticket Counter",
            description: "❌ Only staff can use this command.",
          }),
        ],
      });
    }

    const ticketType = parseTicketTypeFlag(args[0]);

    if (!ticketType) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🎫 Ticket Counter",
            description: "⚠️ Usage: `..treset s` or `..treset p`",
          }),
        ],
      });
    }

    await setTicketCounter(ticketType, 0);

    return message.reply({
      embeds: [
        buildBotEmbed({
          title: "♻️ Ticket Counter Reset",
          description: `✨ ${formatTicketTypeLabel(ticketType)} ticket counter reset to **0**.`,
        }),
      ],
    });
  }

  if (command === "purge") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧹 Purge",
            description: "❌ Only staff can use this command.",
          }),
        ],
      });
    }

    const ticketInfo = await getTicketByChannelId(message.channel.id);
    if (ticketInfo) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧹 Purge",
            description:
              "❌ This command cannot be used inside tracked ticket channels.",
          }),
        ],
      });
    }

    const amount = parseIntegerInput(args[0] || "");

    if (amount === null || amount < 1 || amount > 100) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧹 Purge",
            description: "⚠️ Usage: `..purge 1-100`",
          }),
        ],
      });
    }

    try {
      await message.channel.bulkDelete(amount + 1, true);

      const confirm = await message.channel.send({
        embeds: [
          buildBotEmbed({
            title: "✅ Purge Complete",
            description: `✨ Deleted up to **${amount}** recent messages.`,
          }),
        ],
      });

      setTimeout(() => {
        confirm.delete().catch(() => {});
      }, 4000);
    } catch (error) {
      console.error(error);
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧹 Purge",
            description:
              "❌ There was an error purging messages. Discord cannot bulk delete messages older than 14 days.",
          }),
        ],
      });
    }

    return;
  }

  if (command === "kick") {
    if (!hasOwnerAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "👢 Kick",
            description: "❌ Only the owner role can use this command.",
          }),
        ],
      });
    }

    const targetInput = args[0];
    if (!targetInput) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "👢 Kick",
            description: "⚠️ Usage: `..kick @user` or `..kick userId`",
          }),
        ],
      });
    }

    const member = await resolveGuildMember(message.guild, targetInput);

    if (!member) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "👢 Kick",
            description: "❌ Could not find that user.",
          }),
        ],
      });
    }

    if (member.id === message.author.id) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "👢 Kick",
            description: "❌ You cannot kick yourself.",
          }),
        ],
      });
    }

    if (!member.kickable) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "👢 Kick",
            description:
              "❌ I cannot kick that user. Check role hierarchy and permissions.",
          }),
        ],
      });
    }

    try {
      await member.kick(`Kicked by ${message.author.tag}`);

      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ User Kicked",
            description: `👢 Successfully kicked <@${member.id}>.`,
          }),
        ],
      });
    } catch (error) {
      console.error(error);
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "👢 Kick",
            description: "❌ There was an error trying to kick that user.",
          }),
        ],
      });
    }
  }

  if (command === "ban") {
    if (!hasOwnerAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Ban",
            description: "❌ Only the owner role can use this command.",
          }),
        ],
      });
    }

    const targetInput = args[0];
    if (!targetInput) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Ban",
            description: "⚠️ Usage: `..ban @user` or `..ban userId`",
          }),
        ],
      });
    }

    const member = await resolveGuildMember(message.guild, targetInput);

    if (!member) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Ban",
            description: "❌ Could not find that user.",
          }),
        ],
      });
    }

    if (member.id === message.author.id) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Ban",
            description: "❌ You cannot ban yourself.",
          }),
        ],
      });
    }

    if (!member.bannable) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Ban",
            description:
              "❌ I cannot ban that user. Check role hierarchy and permissions.",
          }),
        ],
      });
    }

    try {
      await member.ban({ reason: `Banned by ${message.author.tag}` });

      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ User Banned",
            description: `🔨 Successfully banned <@${member.id}>.`,
          }),
        ],
      });
    } catch (error) {
      console.error(error);
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Ban",
            description: "❌ There was an error trying to ban that user.",
          }),
        ],
      });
    }
  }

  if (command === "mute") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Mute",
            description: "❌ Only staff or owners can use this command.",
          }),
        ],
      });
    }

    const targetInput = args[0];
    const durationInput = args[1];

    if (!targetInput || !durationInput) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Mute",
            description:
              "⚠️ Usage: `..mute @user 3s`, `..mute @user 3m`, `..mute @user 3h`, or `..mute @user 3d`",
          }),
        ],
      });
    }

    const member = await resolveGuildMember(message.guild, targetInput);

    if (!member) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Mute",
            description: "❌ Could not find that user.",
          }),
        ],
      });
    }

    if (member.id === message.author.id) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Mute",
            description: "❌ You cannot mute yourself.",
          }),
        ],
      });
    }

    const duration = parseDurationString(durationInput);

    if (!duration) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Mute",
            description:
              "❌ Invalid duration. Use `s`, `m`, `h`, or `d`, and keep it at or under 28 days.",
          }),
        ],
      });
    }

    if (!member.moderatable) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Mute",
            description:
              "❌ I cannot mute that user. Check role hierarchy and permissions.",
          }),
        ],
      });
    }

    try {
      await member.timeout(duration.ms, `Muted by ${message.author.tag}`);

      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ User Muted",
            description: `🔇 Successfully muted <@${member.id}> for **${duration.value}${duration.unit}**.`,
          }),
        ],
      });
    } catch (error) {
      console.error(error);
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Mute",
            description: "❌ There was an error trying to mute that user.",
          }),
        ],
      });
    }
  }

  // ====================== UNMUTE ======================
  if (command === "unmute") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Unmute",
            description: "❌ Only staff or owners can use this command.",
          }),
        ],
      });
    }

    const targetInput = args[0];
    if (!targetInput) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Unmute",
            description: "⚠️ Usage: `..unmute @user` or `..unmute userId`",
          }),
        ],
      });
    }

    const member = await resolveGuildMember(message.guild, targetInput);

    if (!member) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Unmute",
            description: "❌ Could not find that user.",
          }),
        ],
      });
    }

    if (!member.moderatable) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Unmute",
            description:
              "❌ I cannot unmute that user. Check role hierarchy and bot permissions.",
          }),
        ],
      });
    }

    try {
      await member.timeout(null, `Unmuted by ${message.author.tag}`);

      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ User Unmuted",
            description: `🔇 Successfully removed timeout from <@${member.id}>.`,
            color: 0x57f287,
          }),
        ],
      });
    } catch (error) {
      console.error(error);
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔇 Unmute",
            description: "❌ There was an error trying to unmute that user.",
          }),
        ],
      });
    }
  }

  // ====================== UNBAN ======================
  if (command === "unban") {
    if (!hasOwnerAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Unban",
            description: "❌ Only the owner role can use this command.",
          }),
        ],
      });
    }

    const targetInput = args[0];
    if (!targetInput) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Unban",
            description:
              "⚠️ Usage: `..unban userId` (you must use the Discord ID)",
          }),
        ],
      });
    }

    const userId =
      extractMentionedUserId(targetInput) ||
      (/^\d+$/.test(targetInput) ? targetInput : null);

    if (!userId) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Unban",
            description: "❌ Please provide a valid Discord user ID.",
          }),
        ],
      });
    }

    try {
      await message.guild.members.unban(
        userId,
        `Unbanned by ${message.author.tag}`,
      );

      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ User Unbanned",
            description: `🔨 Successfully unbanned user with ID \`${userId}\`.`,
            color: 0x57f287,
          }),
        ],
      });
    } catch (error) {
      console.error(error);
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🔨 Unban",
            description:
              "❌ Failed to unban. The user may not be banned or I lack permissions.",
          }),
        ],
      });
    }
  }

  // ====================== ID ======================
  if (command === "id") {
    let target;

    if (message.reference) {
      // Replied to a message
      const repliedMsg = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      if (repliedMsg) target = repliedMsg.author;
    } else if (args[0]) {
      target = await resolveUser(message.guild, args[0]);
    }

    if (!target || target.bot) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🆔 User ID",
            description:
              "❌ Please reply to a user's message or provide a valid user/ID.",
          }),
        ],
      });
    }

    await message.reply(`\`${target.id}\``);
    return;
  }

  // ====================== PFP ======================
  if (command === "pfp") {
    let target;

    if (message.reference) {
      const repliedMsg = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      if (repliedMsg) target = repliedMsg.author;
    } else if (args[0]) {
      target = await resolveUser(message.guild, args[0]);
    }

    if (!target || target.bot) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🖼️ Profile Picture",
            description:
              "❌ Please reply to a user's message or provide a valid @user or ID.",
          }),
        ],
      });
    }

    const embed = buildBotEmbed({
      title: `${target.tag}'s Profile Picture`,
      description: `🖼️ [Direct Link](${target.displayAvatarURL({ size: 4096 })})`,
    }).setImage(target.displayAvatarURL({ size: 512 }));

    await message.reply({ embeds: [embed] });
    return;
  }

  // ====================== RTD (Roll the Die) ======================
  if (command === "rtd") {
    const roll = Math.floor(Math.random() * 6) + 1;
    await message.reply({
      embeds: [
        buildBotEmbed({
          title: "🎲 Roll the Die",
          description: `You rolled a **${roll}**!`,
          color: 0x57f287,
        }),
      ],
    });
    return;
  }

  if (command === "rtd2") {
    const roll1 = Math.floor(Math.random() * 6) + 1;
    const roll2 = Math.floor(Math.random() * 6) + 1;
    await message.reply({
      embeds: [
        buildBotEmbed({
          title: "🎲 Roll Two Dice",
          description: `You rolled a **${roll1}** and a **${roll2}**!`,
          color: 0x57f287,
        }),
      ],
    });
    return;
  }

  // ====================== COIN FLIP ======================
  if (command === "cf") {
    const rand = Math.random() * 100;

    let result, description, color;

    if (rand < 48) {
      result = "Heads";
      description = "🪙 The coin landed on **Heads**!";
      color = 0x57f287;
    } else if (rand < 96) {
      result = "Tails";
      description = "🪙 The coin landed on **Tails**!";
      color = 0x57f287;
    } else {
      result = "Edge";
      description =
        "🪙 The coin landed on its **edge**!\n\nYou need to reroll!";
      color = 0xf1c40f;
    }

    await message.reply({
      embeds: [
        buildBotEmbed({
          title: "🪙 Coin Flip",
          description,
          color,
        }),
      ],
    });
    return;
  }

  if (command === "q") {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Queue",
            description:
              "❌ This command can only be used inside tracked ticket channels.",
          }),
        ],
      });
    }

    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Queue",
            description: "❌ Only staff can manage the queue.",
          }),
        ],
      });
    }

    if (ticketInfo.status !== "open") {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Queue",
            description:
              "❌ Only open tickets can be added to or removed from queue.",
          }),
        ],
      });
    }

    // Check cooldown before any rename
    if (!canRenameChannel(message.channel.id)) {
      const remaining = Math.ceil(
        (channelRenameCooldowns.get(message.channel.id) +
          10 * 60 * 1000 -
          Date.now()) /
          1000 /
          60,
      );
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "⏳ Rename Cooldown",
            description: `❌ You can only rename this channel **twice every 10 minutes**.\n\nPlease wait **${remaining} minute${remaining > 1 ? "s" : ""}** before using \`..q\` again.`,
            color: 0xed4245,
          }),
        ],
      });
    }

    if (ticketInfo.is_queued) {
      // Remove from queue
      await removeTicketFromQueue(message.channel.id);
      await resetChannelNameFromTicket(message.channel, ticketInfo);
      await refreshQueueNames(message.guild);

      setChannelRenameCooldown(message.channel.id); // Start cooldown

      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Queue Updated",
            description: "➖ This ticket was removed from the queue.",
            color: 0xed4245,
          }),
        ],
      });
    }

    // Add to queue
    await addTicketToQueue(message.channel.id);
    await refreshQueueNames(message.guild);

    const updatedTicket = await getTicketByChannelId(message.channel.id);

    setChannelRenameCooldown(message.channel.id); // Start cooldown

    return message.reply({
      embeds: [
        buildBotEmbed({
          title: "📌 Queue Updated",
          description: `✅ This ticket was added to the queue at position **q${updatedTicket.queue_position}**.`,
          color: 0x57f287,
        }),
      ],
    });
  }

  // ====================== SILENT QUEUE (..sq) - OWNER ONLY ======================
  if (command === "sq") {
    if (message.author.id !== process.env.OWNER_USER_ID) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Silent Queue",
            description: "❌ Only the bot owner can use this command.",
          }),
        ],
      });
    }

    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Silent Queue",
            description:
              "❌ This command can only be used inside tracked ticket channels.",
          }),
        ],
      });
    }

    if (ticketInfo.status !== "open") {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Silent Queue",
            description: "❌ Only open tickets can be queued.",
          }),
        ],
      });
    }

    if (ticketInfo.is_queued) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Silent Queue",
            description: "✅ This ticket is already in the queue.",
          }),
        ],
      });
    }

    // Add to queue internally (no rename)
    await addTicketToQueue(message.channel.id);
    await refreshQueueNames(message.guild);

    const updatedTicket = await getTicketByChannelId(message.channel.id);

    await message.reply({
      embeds: [
        buildBotEmbed({
          title: "📌 Silent Queue",
          description: `✅ Ticket has been added to the queue at position **q${updatedTicket.queue_position}**.\n\nChannel name was **not** changed.`,
          color: 0x57f287,
        }),
      ],
    });

    return;
  }

  // ====================== INACTIVITY WARNING (! ) ======================
  if (command === "!") {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "⚠️ Inactivity Warning",
            description:
              "❌ This command can only be used inside tracked ticket channels.",
          }),
        ],
      });
    }

    if (ticketInfo.status !== "open") {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "⚠️ Inactivity Warning",
            description:
              "❌ This command can only be used in **open** tickets.",
          }),
        ],
      });
    }

    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "⚠️ Inactivity Warning",
            description: "❌ Only staff or owners can use this command.",
          }),
        ],
      });
    }

    let targetUser;
    let hours = 4; // default

    // Check if replied to a message
    if (message.reference) {
      const repliedMsg = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      if (repliedMsg && !repliedMsg.author.bot) {
        targetUser = repliedMsg.author;
      }
    }

    // If not replied, parse arguments: ..! user 6
    if (!targetUser) {
      const targetInput = args[0];
      const hoursInput = parseIntegerInput(args[1] || "4");

      if (!targetInput) {
        return message.reply({
          embeds: [
            buildBotEmbed({
              title: "⚠️ Inactivity Warning",
              description:
                "⚠️ Usage: `..! @user 4` or reply to their message and type `..!`",
            }),
          ],
        });
      }

      targetUser = await resolveUser(message.guild, targetInput);

      if (hoursInput !== null) {
        hours = Math.min(Math.max(hoursInput, 1), 48);
      }
    }

    if (!targetUser || targetUser.bot) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "⚠️ Inactivity Warning",
            description: "❌ Could not find a valid non-bot user.",
          }),
        ],
      });
    }

    // Delete the staff command message for cleanliness
    await message.delete().catch(() => {});

    const now = Math.floor(Date.now() / 1000);
    const deadline = now + hours * 3600;

    const embed = buildBotEmbed({
      title: "⚠️ Inactivity Warning",
      description:
        `Hey <@${targetUser.id}>, we noticed you haven't responded yet.\n\n` +
        `Please reply to the questions in this ticket within the next **${hours} hours**.\n` +
        `You have until: <t:${deadline}:F> (<t:${deadline}:R>)`,
      color: 0xf1c40f, // orange warning
    }).addFields({
      name: "📌 What to do",
      value:
        "Answer the intake questions or let us know if you need more time.",
      inline: false,
    });

    await message.channel.send({
      content: `<@${targetUser.id}>`,
      embeds: [embed],
    });

    return;
  }

  if (command === "qrefresh") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📌 Queue",
            description: "❌ Only staff can refresh the queue.",
          }),
        ],
      });
    }

    await refreshQueueNames(message.guild);

    return message.reply({
      embeds: [
        buildBotEmbed({
          title: "🔄 Queue Refreshed",
          description:
            "✨ Queue positions and channel names have been rebuilt.",
        }),
      ],
    });
  }

  if (command === "qlist") {
    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📋 Queue List",
            description: "❌ Only staff can view the queue list.",
          }),
        ],
      });
    }

    const queuedTickets = await getQueuedOpenTickets();

    if (queuedTickets.length === 0) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "📋 Queue List",
            description: "✨ There are currently no tickets in queue.",
          }),
        ],
      });
    }

    const lines = queuedTickets.map((ticket) => {
      const position = ticket.queue_position ?? "?";
      return `• **q${position}** — <#${ticket.channel_id}> — \`ticket-${String(ticket.ticket_number).padStart(3, "0")}\``;
    });

    return message.reply({
      embeds: [
        buildBotEmbed({
          title: "📋 Queue List",
          description: lines.join("\n"),
        }),
      ],
    });
  }

  if (command === "transcript" || command === "t") {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧾 Transcript",
            description:
              "❌ This command can only be used inside tracked ticket channels.",
          }),
        ],
      });
    }

    if (!hasStaffAccess(message.member)) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧾 Transcript",
            description: "❌ Only staff can generate transcripts.",
          }),
        ],
      });
    }

    if (ticketInfo.status !== "closed") {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧾 Transcript",
            description:
              "⚠️ Transcripts can only be generated after the ticket has been closed.",
          }),
        ],
      });
    }

    const success = await generateTranscript(
      message.channel,
      ticketInfo,
      message.author.id,
      true,
    );

    if (success) {
      await message.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ Transcript Generated",
            description:
              "✨ Transcript has been generated and sent successfully.",
            color: 0x57f287,
          }),
        ],
      });
    } else {
      await message.reply({
        embeds: [
          buildBotEmbed({
            title: "❌ Transcript Failed",
            description:
              "There was an error generating the transcript. Check the console for details.",
            color: 0xed4245,
          }),
        ],
      });
    }

    return;
  }

  if (command === "help") {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo || ticketInfo.status !== "open") {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🆘 Ticket Help",
            description:
              "❌ This command can only be used by the ticket owner inside an open ticket.",
          }),
        ],
      });
    }

    if (message.author.id !== ticketInfo.owner_id) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🆘 Ticket Help",
            description: "❌ Only the ticket owner can use this command.",
          }),
        ],
      });
    }

    clearPendingHelpSelection(message.channel.id);
    await sendHelpMenu(message.channel);
    return;
  }

  if (command === "close" || command === "c") {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo) {
      return message.reply(
        "This command can only be used inside a tracked ticket channel.",
      );
    }

    if (!hasStaffAccess(message.member)) {
      return message.reply("Only staff can close tickets.");
    }

    if (ticketInfo.status === "closed") {
      return message.reply("This ticket is already closed.");
    }

    if (ticketInfo.status === "deleted") {
      return message.reply("This ticket is already marked as deleted.");
    }

    const closedCategoryId =
      ticketInfo.type === "standard"
        ? process.env.CLOSED_STANDARD_CATEGORY_ID
        : process.env.CLOSED_PAID_CATEGORY_ID;

    const closedName = `closed-ticket-${String(ticketInfo.ticket_number).padStart(3, "0")}`;

    try {
      if (ticketInfo.is_queued) {
        await clearQueueForClosedOrDeletedTicket(message.channel.id);
      }

      await closeTicket(message.channel.id);
      await stopIntakeSession(message.channel.id);
      clearPendingHelpSelection(message.channel.id);

      await message.channel.permissionOverwrites.edit(ticketInfo.owner_id, {
        ViewChannel: false,
        SendMessages: false,
        ReadMessageHistory: false,
      });

      await message.channel.setName(closedName);
      await message.channel.setParent(closedCategoryId);

      await message.channel.send(`Ticket closed by <@${message.author.id}>.`);

      await refreshQueueNames(message.guild);
    } catch (error) {
      console.error(error);
      return message.reply("There was an error while closing the ticket.");
    }

    return;
  }

  if (command === "rename" || command === "r") {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo) {
      return message.reply(
        "This command can only be used inside a tracked ticket channel.",
      );
    }

    if (!hasStaffAccess(message.member)) {
      return message.reply("Only staff can rename tickets.");
    }

    const newName = args
      .join("-")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");

    if (!newName) {
      return message.reply("Usage: `..rename new-name-here`");
    }

    try {
      await message.channel.setName(newName);
      await message.channel.send(
        `Channel renamed to \`${newName}\` by <@${message.author.id}>.`,
      );
    } catch (error) {
      console.error(error);
      return message.reply("There was an error renaming this ticket.");
    }

    return;
  }

  if (command === "delete" || command === "d" || command === "del") {
    const ticketInfo = await getTicketByChannelId(message.channel.id);

    if (!ticketInfo) {
      return message.reply(
        "This command can only be used inside a tracked ticket channel.",
      );
    }

    if (!hasStaffAccess(message.member)) {
      return message.reply("Only staff can delete tickets.");
    }

    if (ticketInfo.status === "closed" && !ticketInfo.transcript_generated) {
      return message.reply({
        embeds: [
          buildBotEmbed({
            title: "🧾 Transcript Required",
            description:
              "⚠️ This closed ticket does not have a transcript yet. Run `..transcript` or `..t` before deleting it.",
          }),
        ],
      });
    }

    await stopIntakeSession(message.channel.id);
    clearPendingHelpSelection(message.channel.id);

    if (ticketInfo.is_queued) {
      await clearQueueForClosedOrDeletedTicket(message.channel.id);
      await refreshQueueNames(message.guild);
    }

    await message.channel.send("This ticket will be deleted in 5 seconds.");

    setTimeout(async () => {
      try {
        await deleteTicket(message.channel.id);
        await message.channel.delete();
      } catch (error) {
        console.error(error);
      }
    }, 5000);

    return;
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === "ticket_type_select") {
      const selectedType = interaction.values[0];

      await interaction.deferUpdate();

      // Auto-create the ticket immediately after selection
      const existingOpenTicket = await getOpenTicketByOwnerId(
        interaction.user.id,
      );

      if (existingOpenTicket) {
        return interaction.followUp({
          content: `You already have an open ticket: <#${existingOpenTicket.channel_id}>`,
          ephemeral: true,
        });
      }

      const categoryId =
        selectedType === "standard"
          ? process.env.STANDARD_CATEGORY_ID
          : process.env.PAID_CATEGORY_ID;

      try {
        const ticketNumber = await getNextTicketNumber(selectedType);
        const paddedTicketNumber = String(ticketNumber).padStart(3, "0");
        const channelName = `ticket-${paddedTicketNumber}`;

        const ticketChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: categoryId,
          permissionOverwrites: [
            {
              id: interaction.guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            {
              id: process.env.STAFF_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
            {
              id: process.env.OWNER_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
            {
              id: client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
          ],
        });

        const typeLabel =
          selectedType === "standard"
            ? "Standard Application"
            : "Paid Application";

        const welcomeEmbed = buildBotEmbed({
          title: `🎟️ ${typeLabel} Ticket`,
          description: `Welcome <@${interaction.user.id}>.\n\n✨ Please complete the automated intake questions below. Use \`..help\` at any time if you need staff assistance.`,
          color: 0x57f287,
        });

        await ticketChannel.send({
          content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE_ID}>`,
          embeds: [welcomeEmbed],
        });

        await createTicket({
          channelId: ticketChannel.id,
          ownerId: interaction.user.id,
          type: selectedType,
          ticketNumber,
        });

        await incrementLifetimeTicketCount(interaction.user.id);

        const initialStep =
          selectedType === "standard" ? "standard_username" : "paid_username";

        await createIntakeSession({
          channelId: ticketChannel.id,
          ownerId: interaction.user.id,
          ticketType: selectedType,
          step: initialStep,
        });

        await sendNextIntakePrompt(ticketChannel, {
          channel_id: ticketChannel.id,
          owner_id: interaction.user.id,
          ticket_type: selectedType,
          step: initialStep,
          status: "active",
          data: {},
        });

        await interaction.followUp({
          content: `✅ Your ${typeLabel.toLowerCase()} has been created: ${ticketChannel}`,
          ephemeral: true,
        });
      } catch (error) {
        console.error("Ticket creation error:", error);
        await interaction.followUp({
          content: "❌ There was an error creating your ticket.",
          ephemeral: true,
        });
      }

      return;
    }

    if (interaction.customId === "ticket_help_select") {
      const ticketInfo = await getTicketByChannelId(interaction.channel.id);

      if (!ticketInfo || ticketInfo.status !== "open") {
        return interaction.reply({
          content: "This help menu can only be used in an open ticket.",
          ephemeral: true,
        });
      }

      if (interaction.user.id !== ticketInfo.owner_id) {
        return interaction.reply({
          content: "Only the ticket owner can use this help menu.",
          ephemeral: true,
        });
      }

      const helpChoice = interaction.values[0];
      await interaction.deferUpdate();

      if (helpChoice === "staff_team") {
        clearPendingHelpSelection(interaction.channel.id);

        await interaction.channel.send({
          content: `<@&${process.env.STAFF_ROLE_ID}>`,
          embeds: [
            buildBotEmbed({
              title: "🆘 Client Help Request",
              description: `✨ <@${interaction.user.id}> needs assistance in this ticket.`,
            }),
          ],
        });

        return;
      }

      if (helpChoice === "specific_staff") {
        setPendingHelpSelection(interaction.channel.id, interaction.user.id);

        await interaction.channel.send({
          embeds: [
            buildBotEmbed({
              title: "🆘 Specific Staff Request",
              description:
                "Paste the Discord ID of the specific staff member you want to ping. They must have access to this ticket. If you want to switch back, run `..help` again.",
            }),
          ],
        });

        return;
      }
    }

    const session = await getIntakeSession(interaction.channel.id);

    if (!session || session.status !== "active") {
      return interaction.reply({
        content: "This intake prompt is no longer active.",
        ephemeral: true,
      });
    }

    if (interaction.user.id !== session.owner_id) {
      return interaction.reply({
        content: "Only the ticket owner can answer this intake prompt.",
        ephemeral: true,
      });
    }

    if (interaction.customId === "intake_username_confirm_select") {
      if (
        session.step !== "standard_username_confirm" &&
        session.step !== "paid_username_confirm"
      ) {
        return interaction.reply({
          content: "This username confirmation prompt is no longer active.",
          ephemeral: true,
        });
      }

      const answer = interaction.values[0];
      const pendingUsername = session.data?.pendingUsername || "";
      const currentData = session.data || {};

      await interaction.deferUpdate();

      if (answer === "no") {
        const newData = { ...currentData };
        delete newData.pendingUsername;

        const resetStep =
          session.step === "standard_username_confirm"
            ? "standard_username"
            : "paid_username";

        await updateIntakeSession(interaction.channel.id, {
          step: resetStep,
          data: newData,
        });

        await sendNextIntakePrompt(interaction.channel, {
          ...session,
          step: resetStep,
          data: newData,
        });
        return;
      }

      const newData = {
        ...currentData,
        username: pendingUsername,
      };
      delete newData.pendingUsername;

      const nextStep =
        session.step === "standard_username_confirm"
          ? "standard_platform"
          : "paid_platform";

      await updateIntakeSession(interaction.channel.id, {
        step: nextStep,
        data: newData,
      });

      await sendNextIntakePrompt(interaction.channel, {
        ...session,
        step: nextStep,
        data: newData,
      });
      return;
    }

    if (interaction.customId === "intake_platform_select") {
      if (
        session.step !== "standard_platform" &&
        session.step !== "paid_platform"
      ) {
        return interaction.reply({
          content: "This platform prompt is no longer active.",
          ephemeral: true,
        });
      }

      const platform = interaction.values[0];
      const data = {
        ...(session.data || {}),
        platform,
      };

      await interaction.deferUpdate();

      if (session.step === "standard_platform") {
        await updateIntakeSession(interaction.channel.id, {
          step: "standard_activity",
          data,
        });

        await sendNextIntakePrompt(interaction.channel, {
          ...session,
          step: "standard_activity",
          data,
        });
        return;
      }

      await updateIntakeSession(interaction.channel.id, {
        step: "paid_confirm",
        data,
      });

      await sendNextIntakePrompt(interaction.channel, {
        ...session,
        step: "paid_confirm",
        data,
      });
      return;
    }

    if (interaction.customId === "intake_activity_select") {
      if (session.step !== "standard_activity") {
        return interaction.reply({
          content: "This activity prompt is no longer active.",
          ephemeral: true,
        });
      }

      const activity = interaction.values[0];
      const data = {
        ...(session.data || {}),
        activity,
      };

      await updateIntakeSession(interaction.channel.id, {
        step: "standard_winskills",
        data,
      });

      await interaction.deferUpdate();

      await sendNextIntakePrompt(interaction.channel, {
        ...session,
        step: "standard_winskills",
        data,
      });
      return;
    }

    if (interaction.customId === "intake_afk_select") {
      if (session.step !== "standard_afk") {
        return interaction.reply({
          content: "This AFK prompt is no longer active.",
          ephemeral: true,
        });
      }

      const afkFarm = interaction.values[0];
      const data = {
        ...(session.data || {}),
        afkFarm,
      };

      await updateIntakeSession(interaction.channel.id, {
        step: "standard_completed",
        status: "completed",
        data,
      });

      await interaction.deferUpdate();
      await handleStandardCompletion(interaction.channel, data);
      return;
    }

    if (interaction.customId === "intake_paid_confirm_select") {
      if (session.step !== "paid_confirm") {
        return interaction.reply({
          content: "This premium confirmation prompt is no longer active.",
          ephemeral: true,
        });
      }

      const premiumAccepted = interaction.values[0];
      const data = {
        ...(session.data || {}),
        premiumAccepted,
      };

      await updateIntakeSession(interaction.channel.id, {
        step: "paid_completed",
        status: "completed",
        data,
      });

      await interaction.deferUpdate();
      await handlePaidCompletion(interaction.channel, data);
      return;
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId === "ticket_submit") {
      const selectedType = userSelections.get(interaction.user.id);

      if (!selectedType) {
        await interaction.deferUpdate();
        return;
      }

      const existingOpenTicket = await getOpenTicketByOwnerId(
        interaction.user.id,
      );

      if (existingOpenTicket) {
        const typeLabel =
          existingOpenTicket.type === "standard"
            ? "Standard Application"
            : "Paid Application";

        await interaction.reply({
          content: `You already have an open ${typeLabel} ticket: <#${existingOpenTicket.channel_id}>. You need to close it first before opening another ticket.`,
          ephemeral: true,
        });
        return;
      }

      const categoryId =
        selectedType === "standard"
          ? process.env.STANDARD_CATEGORY_ID
          : process.env.PAID_CATEGORY_ID;

      try {
        const ticketNumber = await getNextTicketNumber(selectedType);
        const paddedTicketNumber = String(ticketNumber).padStart(3, "0");
        const channelName = `ticket-${paddedTicketNumber}`;

        const ticketChannel = await interaction.guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: categoryId,
          permissionOverwrites: [
            {
              id: interaction.guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            {
              id: process.env.STAFF_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
            {
              id: process.env.OWNER_ROLE_ID,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
            {
              id: client.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.ManageChannels,
              ],
            },
          ],
        });

        const typeLabel =
          selectedType === "standard"
            ? "Standard Application"
            : "Paid Application";

        const welcomeEmbed = buildBotEmbed({
          title: `🎟️ ${typeLabel} Ticket`,
          description: `Welcome <@${interaction.user.id}>.\n\n✨ Please complete the automated intake questions below. Use \`..help\` at any time if you need staff assistance.\n\n📝 Until a client explicitly requests otherwise, keep all communication inside this ticket to minimize unnecessary human-to-human contact.`,
          color: 0x57f287,
        });

        await ticketChannel.send({
          content: `<@${interaction.user.id}> <@&${process.env.STAFF_ROLE_ID}>`,
          embeds: [welcomeEmbed],
        });

        await createTicket({
          channelId: ticketChannel.id,
          ownerId: interaction.user.id,
          type: selectedType,
          ticketNumber,
        });

        await incrementLifetimeTicketCount(interaction.user.id);

        const initialStep =
          selectedType === "standard" ? "standard_username" : "paid_username";

        await createIntakeSession({
          channelId: ticketChannel.id,
          ownerId: interaction.user.id,
          ticketType: selectedType,
          step: initialStep,
        });

        await sendNextIntakePrompt(ticketChannel, {
          channel_id: ticketChannel.id,
          owner_id: interaction.user.id,
          ticket_type: selectedType,
          step: initialStep,
          status: "active",
          data: {},
        });

        await interaction.reply({
          content: `✅ Your ticket has been created: ${ticketChannel}`,
          ephemeral: true,
        });
      } catch (error) {
        console.error(error);

        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "❌ There was an error creating your ticket.",
            ephemeral: true,
          });
        }
      }
    }

    if (interaction.customId === "intake_open_username_modal") {
      const session = await getIntakeSession(interaction.channel.id);

      if (
        !session ||
        session.status !== "active" ||
        (session.step !== "standard_username" &&
          session.step !== "paid_username")
      ) {
        return interaction.reply({
          content: "This username prompt is no longer active.",
          ephemeral: true,
        });
      }

      if (interaction.user.id !== session.owner_id) {
        return interaction.reply({
          content: "Only the ticket owner can answer this intake prompt.",
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId("intake_username_modal")
        .setTitle("Enter In-Game Username");

      const usernameInput = new TextInputBuilder()
        .setCustomId("username_input")
        .setLabel("In-Game Username")
        .setPlaceholder("Type your in-game username")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

      modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));

      await interaction.showModal(modal);
      return;
    }

    if (interaction.customId === "intake_open_winskills_modal") {
      const session = await getIntakeSession(interaction.channel.id);

      if (
        !session ||
        session.status !== "active" ||
        session.step !== "standard_winskills"
      ) {
        return interaction.reply({
          content: "This wins and kills prompt is no longer active.",
          ephemeral: true,
        });
      }

      if (interaction.user.id !== session.owner_id) {
        return interaction.reply({
          content: "Only the ticket owner can answer this intake prompt.",
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId("intake_winskills_modal")
        .setTitle("Enter Wins & Kills");

      const winsInput = new TextInputBuilder()
        .setCustomId("wins_input")
        .setLabel("Wins")
        .setPlaceholder("Example: 1200")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

      const killsInput = new TextInputBuilder()
        .setCustomId("kills_input")
        .setLabel("Kills")
        .setPlaceholder("Example: 3500")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

      modal.addComponents(
        new ActionRowBuilder().addComponents(winsInput),
        new ActionRowBuilder().addComponents(killsInput),
      );

      await interaction.showModal(modal);
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === "intake_username_modal") {
      const session = await getIntakeSession(interaction.channel.id);

      if (
        !session ||
        session.status !== "active" ||
        (session.step !== "standard_username" &&
          session.step !== "paid_username")
      ) {
        return interaction.reply({
          content: "This username prompt is no longer active.",
          ephemeral: true,
        });
      }

      if (interaction.user.id !== session.owner_id) {
        return interaction.reply({
          content: "Only the ticket owner can answer this intake prompt.",
          ephemeral: true,
        });
      }

      const username = interaction.fields
        .getTextInputValue("username_input")
        .trim();

      if (!username) {
        return interaction.reply({
          embeds: [
            buildBotEmbed({
              title: "❌ Invalid Username",
              description: "Please enter a valid in-game username.",
            }),
          ],
          ephemeral: true,
        });
      }

      const currentData = session.data || {};
      const data = {
        ...currentData,
        pendingUsername: username,
      };

      const nextStep =
        session.step === "standard_username"
          ? "standard_username_confirm"
          : "paid_username_confirm";

      await updateIntakeSession(interaction.channel.id, {
        step: nextStep,
        data,
      });

      await interaction.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ Username Saved",
            description:
              "Please confirm your username with the dropdown in the ticket.",
          }),
        ],
        ephemeral: true,
      });

      await sendNextIntakePrompt(interaction.channel, {
        ...session,
        step: nextStep,
        data,
      });

      return;
    }

    if (interaction.customId === "intake_winskills_modal") {
      const session = await getIntakeSession(interaction.channel.id);

      if (
        !session ||
        session.status !== "active" ||
        session.step !== "standard_winskills"
      ) {
        return interaction.reply({
          content: "This wins and kills prompt is no longer active.",
          ephemeral: true,
        });
      }

      if (interaction.user.id !== session.owner_id) {
        return interaction.reply({
          content: "Only the ticket owner can answer this intake prompt.",
          ephemeral: true,
        });
      }

      const rawWins = interaction.fields.getTextInputValue("wins_input");
      const rawKills = interaction.fields.getTextInputValue("kills_input");

      const wins = parseIntegerInput(rawWins);
      const kills = parseIntegerInput(rawKills);

      if (wins === null || kills === null) {
        return interaction.reply({
          embeds: [
            buildBotEmbed({
              title: "❌ Invalid Wins/Kills Input",
              description:
                "Wins and kills must both be whole numbers. Commas are okay, but no letters or symbols.",
            }),
          ],
          ephemeral: true,
        });
      }

      const data = {
        ...(session.data || {}),
        wins,
        kills,
      };

      await updateIntakeSession(interaction.channel.id, {
        step: "standard_afk",
        data,
      });

      await interaction.reply({
        embeds: [
          buildBotEmbed({
            title: "✅ Wins & Kills Saved",
            description:
              "Your wins and kills were accepted. The next question has been posted in the ticket.",
          }),
        ],
        ephemeral: true,
      });

      await sendNextIntakePrompt(interaction.channel, {
        ...session,
        step: "standard_afk",
        data,
      });

      return;
    }
  }
});

client.on("channelDelete", async (channel) => {
  try {
    const ticketInfo = await getTicketByChannelId(channel.id);
    if (!ticketInfo) return;
    if (ticketInfo.status === "deleted") return;

    if (ticketInfo.is_queued) {
      await clearQueueForClosedOrDeletedTicket(channel.id);
    }

    await deleteTicket(channel.id);

    if (channel.guild) {
      await refreshQueueNames(channel.guild);
    }

    await stopIntakeSession(channel.id);
    clearPendingHelpSelection(channel.id);
  } catch (error) {
    console.error("channelDelete sync error:", error);
  }
});

client.login(process.env.DISCORD_TOKEN);
