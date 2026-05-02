const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const { EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');

const DATA_FILE = path.join(__dirname, '..', 'ig_monitor_data.json');
const MONITOR_INTERVAL_MS = 5 * 60 * 1000;

const IG_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'x-ig-app-id': '936619743392459',
  'Referer': 'https://www.instagram.com/',
};

let monitorData = { accounts: {} };
let monitorInterval = null;

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8');
    monitorData = JSON.parse(raw);
    if (!monitorData.accounts) monitorData.accounts = {};
  } catch {
    monitorData = { accounts: {} };
  }
}

async function saveData() {
  await fs.writeFile(DATA_FILE, JSON.stringify(monitorData, null, 2));
}

function accountKey(guildId, username) {
  return `${guildId}:${username.toLowerCase()}`;
}

async function fetchProfile(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const res = await axios.get(url, { headers: IG_HEADERS, timeout: 15000 });
  const user = res.data?.data?.user;
  if (!user) throw new Error('User not found');
  return user;
}

async function getOrCreateCategory(guild) {
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'instagram monitor'
  );
  if (!category) {
    const allCategories = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory);
    const maxPos = allCategories.reduce((max, c) => Math.max(max, c.position), 0);
    category = await guild.channels.create({
      name: 'Instagram Monitor',
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      ],
      position: maxPos + 100,
    });
  }
  return category;
}

async function buildAdminOverwrites(guild) {
  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
  ];
  guild.members.cache.forEach((member) => {
    if (
      member.id === guild.ownerId ||
      member.permissions.has('Administrator') ||
      member.permissions.has('ManageGuild')
    ) {
      overwrites.push({ id: member, allow: [PermissionsBitField.Flags.ViewChannel] });
    }
  });
  return overwrites;
}

async function fetchProfilePicBuffer(user) {
  const picUrl = user.profile_pic_url_hd || user.profile_pic_url;
  if (!picUrl) return null;
  try {
    const res = await axios.get(picUrl, {
      headers: { ...IG_HEADERS, Referer: 'https://www.instagram.com/' },
      responseType: 'arraybuffer',
      timeout: 10000,
    });
    return Buffer.from(res.data);
  } catch (e) {
    console.warn('[ig] could not download profile pic:', e.message);
    return null;
  }
}

function buildProfileEmbed(user, hasPic = false) {
  const accountType = user.is_private ? '🔒 Private' : '🌐 Public';
  const embed = new EmbedBuilder()
    .setColor(0xe1306c)
    .setTitle(`@${user.username}`)
    .setURL(`https://www.instagram.com/${user.username}/`)
    .addFields(
      { name: 'Name', value: user.full_name || 'N/A', inline: true },
      { name: 'Account Type', value: accountType, inline: true },
      { name: 'Verified', value: user.is_verified ? '✅ Yes' : 'No', inline: true },
      { name: 'Followers', value: (user.edge_followed_by?.count ?? 0).toLocaleString(), inline: true },
      { name: 'Following', value: (user.edge_follow?.count ?? 0).toLocaleString(), inline: true },
      { name: 'Posts', value: (user.edge_owner_to_timeline_media?.count ?? 0).toLocaleString(), inline: true },
      { name: 'Bio', value: user.biography || '*(no bio)*', inline: false }
    )
    .setFooter({ text: 'Instagram Monitor' })
    .setTimestamp();
  if (hasPic) embed.setThumbnail('attachment://profile.jpg');
  return embed;
}

async function sendProfileMessage(channel, label, user) {
  const picBuf = await fetchProfilePicBuffer(user);
  const embed = buildProfileEmbed(user, !!picBuf);
  const payload = { content: label, embeds: [embed] };
  if (picBuf) payload.files = [{ attachment: picBuf, name: 'profile.jpg' }];
  await channel.send(payload);
}

function buildPostEmbed(node, username) {
  const isVideo = node.is_video;
  const isAlbum = node.__typename === 'GraphSidecar';
  const postUrl = `https://www.instagram.com/p/${node.shortcode}/`;
  const typeLabel = isAlbum ? '📎 Album' : isVideo ? '🎬 Reel / Video' : '📷 Photo';
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || '';

  return new EmbedBuilder()
    .setColor(0xe1306c)
    .setAuthor({ name: `@${username}`, url: `https://www.instagram.com/${username}/` })
    .setTitle(typeLabel)
    .setURL(postUrl)
    .setDescription(caption ? caption.slice(0, 350) + (caption.length > 350 ? '…' : '') : null)
    .setImage(node.display_url)
    .setTimestamp(new Date((node.taken_at_timestamp || 0) * 1000));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postNodes(channel, nodes, username) {
  for (const node of nodes) {
    await channel.send({ embeds: [buildPostEmbed(node, username)] }).catch((e) =>
      console.warn('[ig] failed to send post embed:', e.message)
    );
    await sleep(600);
  }
}

async function addAccount(guildId, username, discordClient) {
  const key = accountKey(guildId, username);

  if (monitorData.accounts[key]) {
    return { success: false, reason: 'already_exists' };
  }

  let profile;
  try {
    profile = await fetchProfile(username);
  } catch (e) {
    return { success: false, reason: 'fetch_failed', error: e.message };
  }

  const guild = discordClient.guilds.cache.get(guildId);
  if (!guild) return { success: false, reason: 'guild_not_found' };

  await guild.members.fetch().catch(() => null);

  const category = await getOrCreateCategory(guild);
  const permOverwrites = await buildAdminOverwrites(guild);

  const chanName = profile.username.toLowerCase().replace(/[^a-z0-9_]/g, '-').slice(0, 100);
  const channel = await guild.channels.create({
    name: chanName,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: permOverwrites,
    topic: `Instagram monitoring for @${profile.username}`,
  });

  const postEdges = profile.edge_owner_to_timeline_media?.edges || [];
  const postIds = postEdges.map((e) => e.node.id);

  monitorData.accounts[key] = {
    username: profile.username,
    guildId,
    channelId: channel.id,
    enabled: true,
    isPrivate: profile.is_private,
    lastBio: profile.biography || '',
    lastName: profile.full_name || '',
    lastPostIds: postIds,
    addedAt: new Date().toISOString(),
  };
  await saveData();

  await sendProfileMessage(channel, '📊 **Account connected — current profile:**', profile);

  if (profile.is_private) {
    await channel.send('🔒 This account is **private**. Posts will not be fetched until it becomes public.');
  } else if (postEdges.length > 0) {
    await channel.send(`📸 **Loading recent posts…**`).catch(() => null);
    await postNodes(channel, postEdges.slice(0, 6).map((e) => e.node), profile.username);
  }

  return { success: true, channel, profile };
}

function getGuildAccounts(guildId) {
  return Object.values(monitorData.accounts).filter((a) => a.guildId === guildId);
}

async function checkAccount(acc, discordClient) {
  if (!acc.enabled) return;

  const guild = discordClient.guilds.cache.get(acc.guildId);
  if (!guild) return;
  const channel = guild.channels.cache.get(acc.channelId);
  if (!channel) return;

  let profile;
  try {
    profile = await fetchProfile(acc.username);
  } catch (e) {
    console.warn(`[ig] fetch failed for @${acc.username}:`, e.message);
    return;
  }

  const newBio = profile.biography || '';
  const newName = profile.full_name || '';

  if (newBio !== acc.lastBio) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffa500)
          .setTitle(`@${acc.username} changed their bio`)
          .addFields(
            { name: 'Old Bio', value: acc.lastBio || '*(empty)*' },
            { name: 'New Bio', value: newBio || '*(empty)*' }
          )
          .setTimestamp(),
      ],
    }).catch(() => null);
    acc.lastBio = newBio;
  }

  if (newName !== acc.lastName) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xffa500)
          .setTitle(`@${acc.username} changed their name`)
          .addFields(
            { name: 'Old Name', value: acc.lastName || '*(empty)*' },
            { name: 'New Name', value: newName || '*(empty)*' }
          )
          .setTimestamp(),
      ],
    }).catch(() => null);
    acc.lastName = newName;
  }

  if (acc.isPrivate && !profile.is_private) {
    acc.isPrivate = false;
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x00c853)
          .setTitle(`@${acc.username} is now PUBLIC`)
          .setDescription('The account changed from **Private** to **Public**. Starting full monitoring now.')
          .setTimestamp(),
      ],
    }).catch(() => null);
  } else if (!acc.isPrivate && profile.is_private) {
    acc.isPrivate = true;
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff1744)
          .setTitle(`@${acc.username} is now PRIVATE`)
          .setDescription('The account changed from **Public** to **Private**. Post monitoring paused.')
          .setTimestamp(),
      ],
    }).catch(() => null);
  }

  if (!profile.is_private) {
    const edges = profile.edge_owner_to_timeline_media?.edges || [];
    const newEdges = edges.filter((e) => !acc.lastPostIds.includes(e.node.id));
    if (newEdges.length > 0) {
      await channel.send(`📣 **@${acc.username}** has ${newEdges.length} new post(s):`).catch(() => null);
      await postNodes(channel, newEdges.map((e) => e.node), acc.username);
    }
    acc.lastPostIds = edges.map((e) => e.node.id);
  }
}

async function runMonitorCycle(discordClient) {
  const accounts = Object.values(monitorData.accounts);
  if (accounts.length === 0) return;
  console.log(`[ig] monitor cycle — checking ${accounts.length} account(s)`);
  await Promise.allSettled(accounts.map((acc) => checkAccount(acc, discordClient)));
  await saveData();
}

function startMonitoring(discordClient) {
  if (monitorInterval) return;
  monitorInterval = setInterval(() => {
    runMonitorCycle(discordClient).catch((e) => console.error('[ig] monitor cycle error:', e));
  }, MONITOR_INTERVAL_MS);
  console.log('[ig] monitoring started — interval: 5 minutes');
}

module.exports = { loadData, addAccount, getGuildAccounts, startMonitoring, accountKey, monitorData };
