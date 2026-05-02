const { Client, GatewayIntentBits, Events, EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus } = require('@discordjs/voice');
const { Readable } = require('stream');
const prism = require('prism-media');
const axios = require('axios');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const config = require('./config.json');
if (process.env.DISCORD_TOKEN) {
  config.token = process.env.DISCORD_TOKEN;
}

const igMonitor    = require('./services/instagram_monitor');
const imageEditor  = require('./services/image_editor');
const linkRegex = /(https?:\/\/[^\s]+)/i;

const WELCOME_FILE = './welcome.json';
let welcomeConfig = {};
async function loadWelcomeConfig() {
  try {
    const raw = await fsp.readFile(WELCOME_FILE, 'utf-8');
    welcomeConfig = JSON.parse(raw);
  } catch {
    welcomeConfig = {};
  }
}
async function saveWelcomeConfig() {
  await fsp.writeFile(WELCOME_FILE, JSON.stringify(welcomeConfig, null, 2));
}
function getGuildWelcome(guildId) {
  if (!welcomeConfig[guildId]) {
    welcomeConfig[guildId] = { enabled: true, welcomeChannelId: null, rulesChannelId: null, serverName: null };
  }
  return welcomeConfig[guildId];
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ]
});

const offenseMap = new Map();
const voiceConnections = new Map();
const voiceReadyTimeouts = new Map();
const voiceReconnectAttempts = new Map();
const voiceReceiverReady = new Set();
const voiceKeepalivePlayers = new Map();
const pendingVoiceMute = new Map();
let restrictedWords = [];
let hasLoggedVoicePermissions = false;

async function main() {
  console.log('Starting TraderBOT...');
  await ensureFolders();
  restrictedWords = await loadRestrictedWords();
  await loadWelcomeConfig();
  await igMonitor.loadData();
  startControlWebServer();
  if (!config.token || config.token === 'YOUR_DISCORD_BOT_TOKEN_HERE') {
    throw new Error('Discord bot token is missing. Set the DISCORD_TOKEN secret or add it to config.json.');
  }
  Promise.all([
    loadRestrictedHashes().catch((e) => console.warn('Pre-warm restricted hashes failed:', e.message)),
    getOcrWorker().catch((e) => console.warn('Pre-warm OCR worker failed:', e.message)),
    preWarmWelcome().catch((e) => console.warn('Pre-warm welcome assets failed:', e.message)),
  ]).then(() => console.log('Warm-up complete: restricted hashes + OCR worker + welcome assets ready.'));
  await client.login(config.token).catch((error) => {
    console.error('Failed to login to Discord:', error.message);
    process.exit(1);
  });
}

async function ensureFolders() {
  await fsp.mkdir(config.restrictedImageFolder, { recursive: true });
  await fsp.mkdir(path.dirname(config.restrictedWordsFile), { recursive: true });
}

async function loadRestrictedWords() {
  try {
    const file = await fsp.readFile(config.restrictedWordsFile, 'utf-8');
    return file
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn('Restricted words file not found, continuing with empty list.');
    return [];
  }
}

client.on(Events.ClientReady, () => {
  console.log(`Bot ready: ${client.user.tag}`);
  igMonitor.startMonitoring(client);
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

client.on('warn', (warning) => {
  console.warn('Discord client warning:', warning);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    await handleMessage(message);
  } catch (error) {
    console.error('Message handler error:', error);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('Voice state update error:', error);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await handleMemberJoin(member);
  } catch (error) {
    console.error('Member join handler error:', error);
  }
});

function isProtectedFromModeration(message) {
  if (!message.guild || !message.member) return false;
  if (message.author.id === message.guild.ownerId) return true;
  const m = message.member;
  if (m.permissions.has('Administrator')) return true;
  if (m.permissions.has('ManageGuild')) return true;
  if (m.permissions.has('ManageMessages')) return true;
  return false;
}

async function handleMessage(message) {
  const content = message.content || '';

  if (content.startsWith('!') && message.guild) {
    const handled = await handleAdminCommand(message);
    if (handled) return;
    const imageHandled = await handleImageCommand(message);
    if (imageHandled) return;
  }

  if (isProtectedFromModeration(message)) {
    return;
  }

  const embedUrls = message.embeds.flatMap((embed) => {
    const urls = [embed.url, embed.author?.url, embed.image?.url, embed.video?.url, embed.thumbnail?.url];
    if (embed.fields) urls.push(...embed.fields.map((field) => field.value));
    return urls.filter(Boolean);
  }).join(' ');

  const fullText = `${content} ${embedUrls}`.trim();
  const imageAttachments = message.attachments.filter((attachment) => {
    return attachment.contentType?.startsWith('image/') || attachment.url.match(/\.(jpe?g|png|gif|webp)$/i);
  });
  const hasLinkInMessage = linkRegex.test(fullText);

  console.log(`[msg] #${message.channel.name} | ${message.author.tag} | link=${hasLinkInMessage} | images=${imageAttachments.size} | content="${content.slice(0, 80)}"`);

  const foundRestricted = findRestrictedWord(fullText);
  if (foundRestricted) {
    console.log(`Restricted word detected in message ${message.id} from ${message.author.tag}`);
    await safeDelete(message, `<@${message.author.id}> Temporary mute: restricted word detected.`);
    await handleRestrictedMessage(message.member, foundRestricted, message.channel);
    return;
  }

  if (hasLinkInMessage && imageAttachments.size > 0) {
    console.log(`Link + image detected in message ${message.id} from ${message.author.tag} — blurring image.`);
    await handleImageAttachments(message, imageAttachments, true);
    return;
  }

  if (hasLinkInMessage) {
    console.log(`Link detected in message ${message.id} from ${message.author.tag} — deleting.`);
    await safeDelete(message, `<@${message.author.id}> Links are not allowed in this server.`);
    return;
  }

  if (imageAttachments.size > 0) {
    console.log(`Image-only message ${message.id} from ${message.author.tag} — checking against restricted images.`);
    await handleImageAttachments(message, imageAttachments, false);
    return;
  }
}

async function handleImageAttachments(message, attachments, linkDetected) {
  const results = await Promise.all(
    Array.from(attachments.values()).map(async (attachment) => {
      try {
        const buffer = await fetchImageBuffer(attachment.url);
        const baseName = (attachment.name || 'image').replace(/[^\w.\-]/g, '_');

        if (await findRestrictedImage(buffer)) {
          return { status: 'restricted', name: baseName };
        }

        const urlRegions = await detectUrlRegionsInImage(buffer);
        if (urlRegions.length > 0) {
          const blurred = await blurRegionsInImage(buffer, urlRegions);
          return { status: 'url-blurred', name: baseName, file: blurred };
        }

        if (linkDetected) {
          const blurred = await blurImage(buffer);
          return { status: 'fully-blurred', name: baseName, file: blurred };
        }

        return { status: 'clean', name: baseName, file: buffer };
      } catch (err) {
        console.warn(`[image] failed to process ${attachment.name}:`, err.message);
        return { status: 'error', name: attachment.name || 'image' };
      }
    })
  );

  const restricted = results.filter((r) => r.status === 'restricted');
  const urlBlurred = results.filter((r) => r.status === 'url-blurred');
  const fullyBlurred = results.filter((r) => r.status === 'fully-blurred');
  const clean = results.filter((r) => r.status === 'clean');

  const needsAction = linkDetected || restricted.length > 0 || urlBlurred.length > 0;
  if (!needsAction) return;

  const filesToRepost = [];
  for (const r of clean) filesToRepost.push({ attachment: r.file, name: r.name });
  for (const r of urlBlurred) filesToRepost.push({ attachment: r.file, name: `blurred-${r.name.replace(/\.[^.]+$/, '')}.png` });
  for (const r of fullyBlurred) filesToRepost.push({ attachment: r.file, name: `blurred-${r.name.replace(/\.[^.]+$/, '')}.png` });

  const plural = (n, singular, pluralForm) => `${n} ${n === 1 ? singular : pluralForm}`;

  const reasonLines = [];
  if (linkDetected) reasonLines.push('your message contained a link');
  if (restricted.length > 0) reasonLines.push(`${plural(restricted.length, 'restricted image', 'restricted images')} removed`);
  if (urlBlurred.length > 0) reasonLines.push(`${plural(urlBlurred.length, 'image', 'images')} had a visible link and ${urlBlurred.length === 1 ? 'was' : 'were'} blurred`);

  await safeDelete(
    message,
    `<@${message.author.id}> Your original message was removed — ${reasonLines.join('; ')}.`
  );

  if (filesToRepost.length > 0) {
    const summary = [];
    if (clean.length > 0) summary.push(plural(clean.length, 'clean image', 'clean images'));
    if (urlBlurred.length > 0) summary.push(`${plural(urlBlurred.length, 'image', 'images')} blurred (link hidden)`);
    if (fullyBlurred.length > 0) summary.push(`${plural(fullyBlurred.length, 'image', 'images')} blurred`);
    if (restricted.length > 0) summary.push(`${plural(restricted.length, 'restricted image', 'restricted images')} removed`);

    const originalText = (message.content || '').replace(linkRegex, '[link removed]').trim();
    const lines = [`<@${message.author.id}> Reposted on your behalf: ${summary.join(', ')}.`];
    if (originalText) lines.push(`> ${originalText.slice(0, 800)}`);

    const MAX_PER_MSG = 10;
    for (let i = 0; i < filesToRepost.length; i += MAX_PER_MSG) {
      const chunk = filesToRepost.slice(i, i + MAX_PER_MSG);
      const content = i === 0 ? lines.join('\n') : `<@${message.author.id}> (continued)`;
      await message.channel.send({ content, files: chunk }).catch((e) =>
        console.warn('[image] failed to repost:', e.message)
      );
    }
  }
}

let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      console.log('[OCR] initializing persistent worker...');
      const w = await createWorker('eng');
      await w.setParameters({ tessedit_pageseg_mode: 11 });
      console.log('[OCR] worker ready.');
      return w;
    })().catch((e) => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

const ocrQueue = [];
let ocrBusy = false;
async function runOcr(buf) {
  return new Promise((resolve, reject) => {
    ocrQueue.push({ buf, resolve, reject });
    drainOcr();
  });
}
async function drainOcr() {
  if (ocrBusy) return;
  const job = ocrQueue.shift();
  if (!job) return;
  ocrBusy = true;
  try {
    const w = await getOcrWorker();
    const { data } = await w.recognize(job.buf, {}, { tsv: true, text: true });
    job.resolve(data);
  } catch (e) {
    job.reject(e);
  } finally {
    ocrBusy = false;
    drainOcr();
  }
}

async function detectUrlRegionsInImage(buffer) {
  const urlWordPattern = /https?:|www\.|\/\/|\.(com|net|org|io|co|me|ly|gg|uk|de|fr|ru|jp)\b|[a-z]{4,}(com|net|org|io)\b|\/[a-z0-9]{2,}/i;
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || meta.width < 120 || meta.height < 120) {
      return [];
    }
    const targetWidth = Math.max(meta.width, 1200);
    const scale = meta.width / targetWidth;

    const processBuffer = await sharp(buffer)
      .resize({ width: targetWidth, kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();

    const data = await runOcr(processBuffer);

    console.log(`[OCR] Detected text: "${(data.text || '').replace(/\n/g, ' ').slice(0, 300)}"`);

    const tsvLines = (data.tsv || '').split('\n').slice(1);
    const tsvWords = [];
    for (const line of tsvLines) {
      const parts = line.split('\t');
      if (parts.length < 12) continue;
      const level = parseInt(parts[0]);
      if (level !== 5) continue;
      const left = parseInt(parts[6]);
      const top = parseInt(parts[7]);
      const width = parseInt(parts[8]);
      const height = parseInt(parts[9]);
      const text = parts.slice(11).join('\t').trim();
      if (!text) continue;
      tsvWords.push({ text, left, top, width, height });
    }

    const regions = [];
    let urlGroup = [];

    const flushGroup = () => {
      if (urlGroup.length === 0) return;
      const x0 = Math.min(...urlGroup.map((w) => w.left));
      const y0 = Math.min(...urlGroup.map((w) => w.top));
      const x1 = Math.max(...urlGroup.map((w) => w.left + w.width));
      const y1 = Math.max(...urlGroup.map((w) => w.top + w.height));
      const pad = 10;
      regions.push({
        left: Math.max(0, Math.round(x0 * scale) - pad),
        top: Math.max(0, Math.round(y0 * scale) - pad),
        width: Math.max(1, Math.round((x1 - x0) * scale) + pad * 2),
        height: Math.max(1, Math.round((y1 - y0) * scale) + pad * 2)
      });
      urlGroup = [];
    };

    for (const word of tsvWords) {
      if (urlWordPattern.test(word.text)) {
        urlGroup.push(word);
      } else {
        const prev = urlGroup[urlGroup.length - 1];
        const sameRow = prev && Math.abs(word.top - prev.top) < 20 && word.left - (prev.left + prev.width) < 100;
        if (urlGroup.length > 0 && sameRow) {
          urlGroup.push(word);
        } else {
          flushGroup();
        }
      }
    }
    flushGroup();

    console.log(`[OCR] Found ${regions.length} URL region(s) in image.`);
    return regions;
  } catch (err) {
    console.warn('OCR failed, skipping URL region detection:', err.message);
    return [];
  }
}

async function blurRegionsInImage(buffer, regions) {
  const metadata = await sharp(buffer).metadata();
  const imgWidth = metadata.width;
  const imgHeight = metadata.height;

  const composites = await Promise.all(
    regions.map(async (region) => {
      const left = Math.min(region.left, imgWidth - 1);
      const top = Math.min(region.top, imgHeight - 1);
      const width = Math.min(region.width, imgWidth - left);
      const height = Math.min(region.height, imgHeight - top);

      const blurredRegion = await sharp(buffer)
        .extract({ left, top, width, height })
        .blur(18)
        .toBuffer();

      return { input: blurredRegion, left, top };
    })
  );

  return sharp(buffer).composite(composites).png().toBuffer();
}

async function safeDelete(message, reason) {
  try {
    await message.delete();
    console.log(`Deleted message ${message.id} from ${message.author.tag} for reason: ${reason}`);
    if (message.channel && message.channel.isTextBased()) {
      await message.channel.send(reason).catch(() => null);
    }
  } catch (error) {
    console.warn('Unable to delete message or send warning:', error.message);
  }
}

function findRestrictedWord(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  return restrictedWords.find((word) => {
    const normalized = word.toLowerCase();
    return normalized && lower.includes(normalized);
  });
}

async function fetchImageBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function blurImage(buffer) {
  return sharp(buffer).blur(20).toBuffer();
}

async function computeDHash(buffer) {
  const w = 9, h = 8;
  const pixels = await sharp(buffer)
    .removeAlpha()
    .resize(w, h, { fit: 'fill' })
    .grayscale()
    .normalise()
    .raw()
    .toBuffer();

  let hash = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const left = pixels[y * w + x];
      const right = pixels[y * w + x + 1];
      hash += left < right ? '1' : '0';
    }
  }
  return hash;
}

async function computeImageVariants(buffer) {
  const meta = await sharp(buffer).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) return [await computeDHash(buffer)];

  const regions = [
    null,
    { left: Math.round(W * 0.15), top: Math.round(H * 0.15), width: Math.round(W * 0.70), height: Math.round(H * 0.70) },
    { left: 0, top: 0, width: W, height: Math.round(H * 0.5) },
    { left: 0, top: Math.round(H * 0.5), width: W, height: H - Math.round(H * 0.5) },
    { left: 0, top: 0, width: Math.round(W * 0.5), height: H },
    { left: Math.round(W * 0.5), top: 0, width: W - Math.round(W * 0.5), height: H },
  ];

  const hashes = await Promise.all(regions.map(async (r) => {
    try {
      const buf = r ? await sharp(buffer).extract(r).toBuffer() : buffer;
      return await computeDHash(buf);
    } catch (e) {
      return null;
    }
  }));
  return hashes.filter(Boolean);
}

function hammingDistance(hashA, hashB) {
  let distance = 0;
  for (let i = 0; i < Math.min(hashA.length, hashB.length); i++) {
    if (hashA[i] !== hashB[i]) distance += 1;
  }
  return distance;
}

const restrictedHashCache = new Map();

async function loadRestrictedHashes() {
  const files = await fsp.readdir(config.restrictedImageFolder).catch(() => []);
  const validFiles = files.filter((f) => f.match(/\.(jpe?g|png|gif|webp|bmp)$/i));
  for (const file of validFiles) {
    if (restrictedHashCache.has(file)) continue;
    try {
      const buf = await fsp.readFile(path.join(config.restrictedImageFolder, file));
      const variants = await computeImageVariants(buf);
      restrictedHashCache.set(file, variants);
      console.log(`[restricted] cached ${variants.length} hash variants for ${file}`);
    } catch (e) {
      console.warn(`[restricted] failed to hash ${file}:`, e.message);
    }
  }
  for (const cached of restrictedHashCache.keys()) {
    if (!validFiles.includes(cached)) restrictedHashCache.delete(cached);
  }
}

async function findRestrictedImage(buffer) {
  if (restrictedHashCache.size === 0) await loadRestrictedHashes();
  if (restrictedHashCache.size === 0) return false;

  const incoming = await computeImageVariants(buffer);
  const THRESHOLD = 0.78;

  let bestSim = 0;
  let bestFile = null;
  for (const [file, variants] of restrictedHashCache) {
    for (const a of incoming) {
      for (const b of variants) {
        const sim = 1 - hammingDistance(a, b) / a.length;
        if (sim > bestSim) { bestSim = sim; bestFile = file; }
        if (sim >= THRESHOLD) {
          console.log(`[restricted] match ${file} similarity=${sim.toFixed(3)}`);
          return true;
        }
      }
    }
  }
  if (bestFile) console.log(`[restricted] no match (best: ${bestFile} sim=${bestSim.toFixed(3)})`);
  return false;
}

async function handleVoiceStateUpdate(oldState, newState) {
  if (!config.enableVoice) return;
  if (voiceServiceStatus !== 'running') return;
  const guild = newState.guild;
  if (newState.member?.user?.bot) return;

  console.log(`Voice update in guild ${guild.name}: ${oldState.channel?.name || 'none'} -> ${newState.channel?.name || 'none'} for ${newState.member.user.tag}`);

  if (!oldState.channel && newState.channel) {
    await joinChannelIfNeeded(newState.channel);
    await applyPendingVoiceMute(newState);
    return;
  }

  if (oldState.channel && !newState.channel) {
    const connection = voiceConnections.get(guild.id);
    if (!connection) return;
    const usersRemaining = oldState.channel.members.filter((member) => !member.user.bot);
    if (usersRemaining.size === 0) {
      connection.destroy();
      voiceConnections.delete(guild.id);
      console.log(`Disconnected from voice channel in guild ${guild.name}`);
    }
  }
}

async function joinChannelIfNeeded(channel) {
  if (!channel || !channel.guild) return;
  if (voiceConnections.has(channel.guild.id)) return;

  const me = channel.guild.members.me;
  if (!me) {
    console.warn(`Bot member object unavailable in guild ${channel.guild.name}. Cannot verify voice permissions.`);
  } else {
    const missing = [];
    const perms = channel.permissionsFor(me);
    if (!perms.has('Connect')) missing.push('Connect');
    if (!perms.has('Speak')) missing.push('Speak');
    if (!hasLoggedVoicePermissions) {
      console.log(`Bot voice permissions in channel ${channel.name}: ${perms.toArray().sort().join(', ')}`);
      hasLoggedVoicePermissions = true;
    }
    if (missing.length > 0) {
      console.warn(`Missing voice permissions for bot in channel ${channel.name} of guild ${channel.guild.name}: ${missing.join(', ')}`);
      return;
    }
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false
  });

  voiceConnections.set(channel.guild.id, connection);
  console.log(`Joined voice channel ${channel.name} in guild ${channel.guild.name}`);
  console.log(`Bot joined voice channel and will play a join sound once the connection is ready.`);
  scheduleVoiceReadyCheck(connection, channel);

  connection.on('error', (error) => {
    console.error(`Voice connection error for guild ${channel.guild.name}:`, error);
  });

  connection.on('debug', (message) => {
    console.log(`Voice connection debug for guild ${channel.guild.name}: ${message}`);
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`Voice connection state changed for guild ${channel.guild.name}: ${oldState.status} -> ${newState.status}`);
    if (newState.status === 'ready' && oldState.status !== 'ready') {
      console.log(`Voice connection is READY in guild ${channel.guild.name}. Audio receive should now work.`);
      clearVoiceReadyCheck(channel.guild.id);
      voiceReconnectAttempts.delete(channel.guild.id);
      setupVoiceKeepAlive(connection, channel);
      setupVoiceReceiver(connection, channel);
      playJoinSound(connection, channel);
    }
    if (newState.status === 'disconnected') {
      console.log(`Voice connection is DISCONNECTED in guild ${channel.guild.name}. Waiting or reconnecting may be needed.`);
    }
    if (newState.status === 'destroyed') {
      console.log(`Voice connection was DESTROYED in guild ${channel.guild.name}.`);
      clearVoiceReadyCheck(channel.guild.id);
      voiceReceiverReady.delete(channel.guild.id);
      cleanupVoiceKeepAlive(channel.guild.id);
    }
  });
}

function setupVoiceReceiver(connection, channel) {
  const guildId = channel.guild.id;
  if (voiceReceiverReady.has(guildId)) {
    console.log(`Voice receiver already initialized for guild ${channel.guild.name}`);
    return;
  }
  voiceReceiverReady.add(guildId);

  const receiver = connection.receiver;
  if (!receiver) {
    console.warn(`Voice receiver not available yet for guild ${channel.guild.name}. Rechecking later...`);
    voiceReceiverReady.delete(guildId);
    return;
  }

  receiver.speaking.on('start', async (userId) => {
    if (userId === client.user.id) return;
    const guild = channel.guild;
    let member = guild.members.cache.get(userId);
    console.log(`User ${userId} started speaking in ${channel.name}`);
    if (!member) {
      try {
        member = await guild.members.fetch(userId);
        console.log(`Fetched member ${userId} from guild ${guild.name}`);
      } catch (fetchError) {
        console.warn(`Unable to resolve member for userId ${userId}: ${fetchError.message}`);
      }
    }
    if (!member) {
      return;
    }
    startVoiceCapture(receiver, userId, member, guild);
  });

  receiver.speaking.on('end', (userId) => {
    if (userId === client.user.id) return;
    console.log(`User ${userId} stopped speaking in ${channel.name}`);
  });
}

function setupVoiceKeepAlive(connection, channel) {
  const guildId = channel.guild.id;
  if (voiceKeepalivePlayers.has(guildId)) return;

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play
    }
  });

  const silenceStream = new Readable({
    read(size) {
      this.push(Buffer.alloc(size, 0));
    }
  });

  const resource = createAudioResource(silenceStream, {
    inputType: StreamType.Raw
  });

  const subscription = connection.subscribe(player);
  player.play(resource);
  voiceKeepalivePlayers.set(guildId, { player, subscription, silenceStream });

  player.on('error', (error) => {
    console.error(`Voice keepalive player error for guild ${channel.guild.name}:`, error);
  });

  console.log(`Started voice keepalive for guild ${channel.guild.name}.`);
}

function createJoinTone(durationMs = 1200, frequency = 880) {
  const sampleRate = 48000;
  const channels = 2;
  const totalSamples = Math.floor((durationMs / 1000) * sampleRate);
  let sentSamples = 0;

  return new Readable({
    read(size) {
      if (sentSamples >= totalSamples) {
        this.push(null);
        return;
      }

      const samplesToSend = Math.min(totalSamples - sentSamples, Math.floor(size / (channels * 2)));
      const buffer = Buffer.alloc(samplesToSend * channels * 2);

      for (let i = 0; i < samplesToSend; i++) {
        const t = (sentSamples + i) / sampleRate;
        const sampleValue = Math.sin(2 * Math.PI * frequency * t) * 0.3;
        const intValue = Math.floor(sampleValue * 32767);
        buffer.writeInt16LE(intValue, i * 4);
        buffer.writeInt16LE(intValue, i * 4 + 2);
      }

      sentSamples += samplesToSend;
      this.push(buffer);
    }
  });
}

function muteBotInGuildVoice(guild) {
  const me = guild.members.me;
  if (!me || !me.voice.channel) return;
  me.voice.setMute(true).catch((error) => {
    console.warn(`Unable to restore bot mute in guild ${guild.name}: ${error.message}`);
  });
}

function playJoinSound(connection, channel) {
  const guildId = channel.guild.id;
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause
    }
  });

  const resource = createAudioResource(createJoinTone(), {
    inputType: StreamType.Raw
  });

  const subscription = connection.subscribe(player);
  player.play(resource);

  player.on('error', (error) => {
    console.error(`Join sound player error for guild ${channel.guild.name}:`, error);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    subscription?.unsubscribe();
    console.log(`Join sound completed for guild ${channel.guild.name}. Restoring server mute.`);
    muteBotInGuildVoice(channel.guild);
  });

  console.log(`Playing join sound in ${channel.name} for guild ${channel.guild.name}.`);
}

function cleanupVoiceKeepAlive(guildId) {
  const keepalive = voiceKeepalivePlayers.get(guildId);
  if (!keepalive) return;

  try {
    keepalive.subscription?.unsubscribe();
  } catch (error) {
    console.warn(`Failed to unsubscribe keepalive for guild ${guildId}: ${error.message}`);
  }

  try {
    keepalive.player?.stop();
  } catch (error) {
    console.warn(`Failed to stop keepalive player for guild ${guildId}: ${error.message}`);
  }

  voiceKeepalivePlayers.delete(guildId);
}

function startVoiceCapture(receiver, userId, member, guild) {
  console.log(`Creating voice subscription for ${member.user.tag} (${userId}) with opus mode`);
  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1200
    },
    mode: 'opus'
  });

  console.log(`Subscribed to voice stream for ${member.user.tag} (${userId}) in guild ${guild.name}`);

  const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
  const chunks = [];
  audioStream.pipe(decoder);

  audioStream.on('error', (error) => {
    console.error(`Audio stream error for ${member.user.tag} (${userId}):`, error);
  });

  decoder.on('data', (chunk) => {
    chunks.push(chunk);
  });

  decoder.on('error', (error) => {
    console.error(`Decoder error for ${member.user.tag} (${userId}):`, error);
  });

  decoder.on('end', async () => {
    try {
      console.log(`Voice stream ended for ${member.user.tag} (${userId}), chunks: ${chunks.length}`);
      if (!chunks.length) {
        console.log(`No audio captured for ${member.user.tag}`);
        return;
      }
      const pcmData = Buffer.concat(chunks);
      const wavBuffer = buildWav(pcmData, 16000, 1);
      const transcript = await transcribeAudio(wavBuffer);
      console.log(`Transcription for ${member.user.tag}: ${transcript || '[empty]'}`);
      if (transcript) {
        const badWord = findRestrictedWord(transcript);
        if (badWord) {
          console.log(`Restricted word detected in voice from ${member.user.tag}: ${badWord}`);
          await handleRestrictedSpeech(member, badWord, guild);
        }
      }
    } catch (error) {
      console.error('Voice capture error:', error);
    }
  });
}

function buildWav(samples, sampleRate, channels) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44 + samples.length);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length, 40);
  samples.copy(buffer, 44);
  return buffer;
}

async function transcribeAudio(wavBuffer) {
  try {
    const response = await axios.post(
      `http://127.0.0.1:${config.voiceServicePort}/transcribe`,
      wavBuffer,
      { headers: { 'Content-Type': 'audio/wav' }, timeout: 10000 }
    );
    const transcript = response.data.transcript || '';
    console.log(`Transcription service returned: ${transcript}`);
    return transcript;
  } catch (error) {
    console.warn('Voice transcription failed:', error.message);
    return '';
  }
}

async function handleRestrictedMessage(member, restrictedWord, sourceChannel) {
  if (!member) return;
  await takeDiscipline(member, restrictedWord, 'text', null, sourceChannel);
}

async function handleRestrictedSpeech(member, restrictedWord, guild) {
  if (!member) return;
  await takeDiscipline(member, restrictedWord, 'voice', guild);
}

async function takeDiscipline(member, restrictedWord, source, guild = null, sourceChannel = null) {
  const key = `${member.guild.id}:${member.id}`;
  const count = offenseMap.get(key) || 0;
  const nextCount = count + 1;
  offenseMap.set(key, nextCount);

  const channel = sourceChannel || getModerationChannel(member.guild);
  const mention = `<@${member.id}>`;

  if (nextCount < 3) {
    const duration = config.muteDurations.warn || 30;
    if (member.voice.channel) {
      try {
        await member.voice.setMute(true, 'Restricted word detected');
      } catch (error) {
        console.warn('Unable to mute member:', error.message);
      }
      setTimeout(async () => {
        try {
          if (member.voice.channel && member.voice.serverMute) {
            await member.voice.setMute(false, 'Temporary mute expired');
          } else {
            console.log(`Skipping unmute for ${member.user.tag}: not connected or not server-muted.`);
          }
        } catch (error) {
          console.warn('Unable to unmute member:', error.message);
        }
      }, duration * 1000);
    } else {
      const expiresAt = Date.now() + duration * 1000;
      pendingVoiceMute.set(key, { expiresAt, duration: duration * 1000 });
      console.log(`Member ${member.user.tag} not connected to voice; will apply pending voice mute until ${new Date(expiresAt).toISOString()}`);
    }

    if (channel) {
      await channel.send(
        `${mention} has been temporarily muted for ${duration}s for saying a restricted word in ${source}.`
      );
    }
  } else {
    const timeoutSeconds = config.muteDurations.timeout || 60;
    try {
      await member.timeout(timeoutSeconds * 1000, 'Repeated restricted language');
    } catch (error) {
      console.warn('Unable to timeout member:', error.message);
    }
    if (member.voice.channel) {
      try {
        await member.voice.disconnect();
      } catch (error) {
        console.warn('Unable to disconnect member from voice:', error.message);
      }
    }
    if (channel) {
      await channel.send(
        `${mention} has been timed out for ${timeoutSeconds}s for repeated restricted language.`
      );
    }
    offenseMap.set(key, 0);
  }
}

function getModerationChannel(guild) {
  const me = guild.members.me;
  if (!me) return null;
  const systemChannel = guild.systemChannel;
  if (systemChannel && systemChannel.permissionsFor(me).has('SendMessages')) {
    return systemChannel;
  }

  return guild.channels.cache
    .filter((channel) => channel.isTextBased() && channel.permissionsFor(me).has('SendMessages'))
    .first() || null;
}

function clearVoiceReadyCheck(guildId) {
  const timeout = voiceReadyTimeouts.get(guildId);
  if (timeout) {    clearTimeout(timeout);
    voiceReadyTimeouts.delete(guildId);
  }
}

async function scheduleVoiceReadyCheck(connection, channel) {
  const guildId = channel.guild.id;
  clearVoiceReadyCheck(guildId);

  const timeout = setTimeout(async () => {
    const status = connection.state.status;
    if (status !== 'ready' && status !== 'destroyed') {
      console.log(`Voice connection still not READY after 10s in guild ${channel.guild.name} (status=${status}). Reconnecting...`);
      const attempt = (voiceReconnectAttempts.get(guildId) || 0) + 1;
      voiceReconnectAttempts.set(guildId, attempt);

      if (attempt <= 3) {
        try {
          connection.destroy();
        } catch (error) {
          console.warn(`Error destroying stale voice connection for guild ${channel.guild.name}: ${error.message}`);
        }
        voiceConnections.delete(guildId);
        console.log(`Rejoin attempt ${attempt} for guild ${channel.guild.name}`);
        await joinChannelIfNeeded(channel);
      } else {
        voiceConnections.delete(guildId);
        console.warn(`Max voice reconnect attempts reached for guild ${channel.guild.name}. Stopping reconnects.`);
        console.warn(`Voice connection could not reach READY state. This is likely because Discord voice requires UDP traffic, which may be blocked in this hosting environment. Voice monitoring will be unavailable.`);
      }
    } else {
      if (status === 'ready') {
        console.log(`Voice connection became READY in guild ${channel.guild.name}.`);
      }
      voiceReconnectAttempts.delete(guildId);
    }
  }, 10000);

  voiceReadyTimeouts.set(guildId, timeout);
}

async function applyPendingVoiceMute(voiceState) {
  const member = voiceState.member;
  if (!member || member.user.bot) return;
  const key = `${voiceState.guild.id}:${member.id}`;
  const pending = pendingVoiceMute.get(key);
  if (!pending) return;

  const now = Date.now();
  if (now >= pending.expiresAt) {
    pendingVoiceMute.delete(key);
    console.log(`Pending voice mute expired before ${member.user.tag} joined in guild ${voiceState.guild.name}. No action needed.`);
    return;
  }

  const remainingMs = pending.expiresAt - now;
  pendingVoiceMute.delete(key);
  console.log(`Applying pending voice mute for ${member.user.tag} for ${Math.ceil(remainingMs / 1000)}s after they joined voice.`);

  try {
    await member.voice.setMute(true, 'Pending restricted voice mute');
  } catch (error) {
    console.warn(`Unable to apply pending mute for ${member.user.tag}:`, error.message);
    return;
  }

  setTimeout(async () => {
    try {
      if (member.voice.channel && member.voice.serverMute) {
        await member.voice.setMute(false, 'Pending temporary mute expired');
      } else {
        console.log(`Pending mute expired but ${member.user.tag} is not connected or not server-muted.`);
      }
    } catch (error) {
      console.warn(`Unable to unmute pending member ${member.user.tag}:`, error.message);
    }
  }, remainingMs);
}

let voiceServiceProcess = null;
let voiceServiceStatus = 'not started';

function startPythonVoiceService() {
  if (voiceServiceProcess) {
    console.log('[voice-service] already running, ignoring start request.');
    return;
  }
  voiceServiceStatus = 'starting';
  const scriptPath = path.join(__dirname, 'services', 'voice_service.py');
  const pythonProcess = spawn('python', [scriptPath], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  voiceServiceProcess = pythonProcess;
  voiceServiceStatus = 'running';

  pythonProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[voice-service] ${chunk}`);
  });
  pythonProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[voice-service] ${chunk}`);
  });
  pythonProcess.on('close', (code) => {
    console.log(`Voice service exited with code ${code}`);
    voiceServiceProcess = null;
    voiceServiceStatus = 'stopped';
  });
}

function stopPythonVoiceService() {
  if (!voiceServiceProcess) return;
  console.log('[voice-service] stopping...');
  try { voiceServiceProcess.kill('SIGTERM'); } catch {}
  voiceServiceStatus = 'stopping';
}

let controlServer = null;
let controlChoiceMade = false;

function shutdownControlServer(reason) {
  if (!controlServer) return;
  console.log(`[control] shutting down web server (${reason}).`);
  try { controlServer.close(); } catch {}
  controlServer = null;
}

function startControlWebServer() {
  const port = parseInt(process.env.PORT || '5050', 10);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/voice/start') {
      controlChoiceMade = true;
      startPythonVoiceService();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Voice service starting</title>
        <style>body{font-family:system-ui,sans-serif;background:#0f0f1e;color:#eee;margin:0;padding:40px;text-align:center}
        .card{max-width:480px;margin:0 auto;background:#1a1a2e;border:1px solid #2d2d4a;border-radius:14px;padding:32px}
        h1{color:#16a34a}</style></head><body><div class="card">
        <h1>Voice service is starting</h1><p>This control page is now closing. The bot keeps running.</p>
        </div></body></html>`);
      setTimeout(() => shutdownControlServer('user chose YES'), 500);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/voice/stop') {
      controlChoiceMade = true;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Voice service skipped</title>
        <style>body{font-family:system-ui,sans-serif;background:#0f0f1e;color:#eee;margin:0;padding:40px;text-align:center}
        .card{max-width:480px;margin:0 auto;background:#1a1a2e;border:1px solid #2d2d4a;border-radius:14px;padding:32px}
        h1{color:#dc2626}</style></head><body><div class="card">
        <h1>Voice service skipped</h1><p>Vosk will not load. This control page is now closing. The bot keeps running.</p>
        </div></body></html>`);
      setTimeout(() => shutdownControlServer('user chose NO'), 500);
      return;
    }

    const botStatus = client.isReady() ? `online as ${client.user.tag}` : 'connecting...';
    const guilds = client.isReady() ? client.guilds.cache.size : 0;
    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>TraderBOT Control</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0f0f1e;color:#eee;margin:0;padding:24px;display:flex;justify-content:center}
  .card{max-width:560px;width:100%;background:#1a1a2e;border:1px solid #2d2d4a;border-radius:14px;padding:28px;box-shadow:0 6px 24px rgba(0,0,0,.4)}
  h1{margin:0 0 6px;font-size:24px}
  .sub{color:#9aa;font-size:13px;margin-bottom:22px}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-top:1px solid #2d2d4a}
  .row:first-of-type{border-top:none}
  .label{color:#9aa}
  .val{color:#fff;font-weight:600}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .ok{background:#15803d;color:#fff}.warn{background:#b45309;color:#fff}.off{background:#3a3a4a;color:#ddd}
  .actions{margin-top:22px;display:flex;gap:10px;flex-wrap:wrap}
  button{flex:1;min-width:160px;border:0;border-radius:10px;padding:14px 16px;font-size:15px;font-weight:600;cursor:pointer}
  .yes{background:#16a34a;color:#fff}.yes:hover{background:#15803d}
  .no{background:#dc2626;color:#fff}.no:hover{background:#b91c1c}
  .note{margin-top:18px;font-size:12px;color:#778;line-height:1.5}
  form{margin:0;flex:1}
</style></head><body><div class="card">
  <h1>TraderBOT Control</h1>
  <div class="sub">Manage your Discord bot's voice service.</div>

  <div class="row"><span class="label">Bot</span><span class="val">${botStatus}</span></div>
  <div class="row"><span class="label">Guilds</span><span class="val">${guilds}</span></div>
  <div class="row"><span class="label">Voice service</span>
    <span class="val">
      <span class="pill ${voiceServiceStatus === 'running' ? 'ok' : voiceServiceStatus === 'starting' || voiceServiceStatus === 'stopping' ? 'warn' : 'off'}">${voiceServiceStatus}</span>
    </span>
  </div>

  <h3 style="margin-top:24px;margin-bottom:8px">Do you want to start the Vosk voice service?</h3>
  <div class="actions">
    <form method="post" action="/voice/start"><button class="yes" type="submit">Yes, start it</button></form>
    <form method="post" action="/voice/stop"><button class="no" type="submit">No, keep it off</button></form>
  </div>
  <div class="note">
    Vosk loads a speech model and tries to join voice channels for offline transcription.
    On hosts that block UDP traffic (like some cloud sandboxes), voice will fail to connect — the bot will keep running normally without it.
  </div>
</div></body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  controlServer = server;
  server.listen(port, '0.0.0.0', () => {
    console.log(`[control] web server listening on http://0.0.0.0:${port} — open it to choose YES/NO for the voice service. The page will close itself once you decide.`);
  });
  server.on('error', (err) => console.error('[control] server error:', err.message));
}

function isAdmin(member) {
  if (!member) return false;
  return member.permissions.has('Administrator') ||
         member.permissions.has('ManageGuild') ||
         member.permissions.has('ManageChannels');
}

async function downloadBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

function getImageAttachments(message) {
  return [...message.attachments.values()].filter(
    a => a.contentType?.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(a.url)
  );
}

async function handleImageCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  if (parts[0].toLowerCase() !== '!image') return false;

  const sub  = parts[1]?.toLowerCase() || 'editor';
  const atts = getImageAttachments(message);

  // ── Menu ──────────────────────────────────────────────────────────────────
  if (!parts[1] || sub === 'editor') {
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🖼️ Image Editor — Available Tools')
      .setDescription('Attach an image to any command below and the bot will process it instantly.\n_No external APIs — everything runs locally._')
      .addFields(
        {
          name: '🪄  Background Remover',
          value: '`!image bg` — automatically removes the image background with AI accuracy.\nNo prompt needed — just attach the image.',
        },
        {
          name: '🧹  Object Remover',
          value: '`!image remove [object]` — removes a specific object from the image.\n• With text: `!image remove person` → targets that object.\n• Without text → the bot detects all objects and shows a numbered list to pick from.',
        },
        {
          name: '🔄  Face Changer',
          value: '`!image faceswap` — attach **two images** in one message.\n• **First** = original image (face to replace).\n• **Second** = face to apply.',
        },
        {
          name: '🔍  Image Upscaler',
          value: '`!image upscale [2/4]` — upscales with Lanczos3 resampling + adaptive sharpening.\nDefault: **4×**  •  Max output: 4K',
        }
      )
      .setFooter({ text: 'Available to all users • All processing is done locally' });
    await message.reply({ embeds: [embed] }).catch(() => null);
    return true;
  }

  // ── Background Removal ────────────────────────────────────────────────────
  if (sub === 'bg') {
    if (atts.length === 0) {
      await message.reply('Please attach an image to use the **Background Remover**.').catch(() => null);
      return true;
    }
    const status = await message.reply('⏳ Removing background… this may take a moment on first run (model loading).').catch(() => null);
    try {
      const buf    = await downloadBuffer(atts[0].url);
      const result = await imageEditor.removeBackground(buf);
      if (status) await status.delete().catch(() => null);
      await message.channel.send({
        content: `✅ <@${message.author.id}> — Background removed!`,
        files: [{ attachment: result, name: 'no_background.png' }],
      }).catch(() => null);
    } catch (e) {
      console.error('[image-editor] bg error:', e);
      if (status) await status.delete().catch(() => null);
      await message.reply(`❌ Background removal failed: ${e.message}`).catch(() => null);
    }
    return true;
  }

  // ── Upscaler ──────────────────────────────────────────────────────────────
  if (sub === 'upscale') {
    if (atts.length === 0) {
      await message.reply('Please attach an image to use the **Upscaler**.').catch(() => null);
      return true;
    }
    const scaleArg = parseInt(parts[2]);
    const scale    = [2, 4].includes(scaleArg) ? scaleArg : 4;
    const status   = await message.reply(`⏳ Upscaling image ${scale}×…`).catch(() => null);
    try {
      const buf    = await downloadBuffer(atts[0].url);
      const result = await imageEditor.upscaleImage(buf, scale);
      if (status) await status.delete().catch(() => null);
      await message.channel.send({
        content: `✅ <@${message.author.id}> — Upscaled **${scale}×**!`,
        files: [{ attachment: result, name: `upscaled_${scale}x.png` }],
      }).catch(() => null);
    } catch (e) {
      console.error('[image-editor] upscale error:', e);
      if (status) await status.delete().catch(() => null);
      await message.reply(`❌ Upscale failed: ${e.message}`).catch(() => null);
    }
    return true;
  }

  // ── Object Removal ────────────────────────────────────────────────────────
  if (sub === 'remove') {
    if (atts.length === 0) {
      await message.reply('Please attach an image to use the **Object Remover**.').catch(() => null);
      return true;
    }
    const prompt = parts.slice(2).join(' ').trim().toLowerCase();
    const status = await message.reply('🔍 Analyzing image… detecting objects.').catch(() => null);
    try {
      const buf     = await downloadBuffer(atts[0].url);
      const objects = await imageEditor.detectObjects(buf);

      if (objects.length === 0) {
        if (status) await status.delete().catch(() => null);
        await message.reply('❌ No recognisable objects were detected in this image.').catch(() => null);
        return true;
      }

      let selected = [];

      if (prompt) {
        selected = objects.filter(o => o.label.toLowerCase().includes(prompt));
        if (selected.length === 0) {
          const found = objects.map((o, i) => `**${i + 1}.** ${o.label} (${o.score}%)`).join('\n');
          if (status) await status.delete().catch(() => null);
          await message.reply(`❌ No object matching "**${prompt}**" was found.\n\n**Detected objects:**\n${found}`).catch(() => null);
          return true;
        }
      } else {
        const list = objects.map((o, i) => `**${i + 1}.** ${o.label} — ${o.score}% confidence`).join('\n');
        if (status) await status.edit(
          `📋 **Detected ${objects.length} object(s):**\n${list}\n\n` +
          `Reply with the number(s) to remove (e.g. \`1\` or \`1 3\`). Waiting 30 s…`
        ).catch(() => null);

        try {
          const collected = await message.channel.awaitMessages({
            filter: m => m.author.id === message.author.id,
            max: 1,
            time: 30_000,
            errors: ['time'],
          });
          const reply = collected.first();
          await reply.delete().catch(() => null);
          const nums = reply.content.trim().split(/\s+/)
            .map(n => parseInt(n))
            .filter(n => !isNaN(n) && n >= 1 && n <= objects.length);
          if (nums.length === 0) {
            if (status) await status.edit('❌ Invalid selection. Object removal cancelled.').catch(() => null);
            return true;
          }
          selected = nums.map(n => objects[n - 1]);
        } catch {
          if (status) await status.edit('⏰ No response received. Object removal cancelled.').catch(() => null);
          return true;
        }
      }

      if (status) await status.edit(`⏳ Removing **${selected.length}** object(s)…`).catch(() => null);
      const result = await imageEditor.removeObjects(buf, selected.map(o => o.bbox));
      if (status) await status.delete().catch(() => null);
      const labels = selected.map(o => o.label).join(', ');
      await message.channel.send({
        content: `✅ <@${message.author.id}> — Removed: **${labels}**`,
        files: [{ attachment: result, name: 'object_removed.png' }],
      }).catch(() => null);
    } catch (e) {
      console.error('[image-editor] remove error:', e);
      if (status) await status.delete().catch(() => null);
      await message.reply(`❌ Object removal failed: ${e.message}`).catch(() => null);
    }
    return true;
  }

  // ── Face Swap ─────────────────────────────────────────────────────────────
  if (sub === 'faceswap') {
    if (atts.length < 2) {
      await message.reply(
        'Please attach **two images** in one message:\n' +
        '• **First image** — original (face to be replaced)\n' +
        '• **Second image** — the face to apply'
      ).catch(() => null);
      return true;
    }
    const status = await message.reply('⏳ Detecting faces and swapping… this may take a moment on first run.').catch(() => null);
    try {
      const [targetBuf, faceBuf] = await Promise.all([
        downloadBuffer(atts[0].url),
        downloadBuffer(atts[1].url),
      ]);
      const result = await imageEditor.swapFace(faceBuf, targetBuf);
      if (status) await status.delete().catch(() => null);
      await message.channel.send({
        content: `✅ <@${message.author.id}> — Face swapped!`,
        files: [{ attachment: result, name: 'face_swapped.png' }],
      }).catch(() => null);
    } catch (e) {
      console.error('[image-editor] faceswap error:', e);
      if (status) await status.delete().catch(() => null);
      await message.reply(`❌ Face swap failed: ${e.message}`).catch(() => null);
    }
    return true;
  }

  // ── Unknown sub-command ───────────────────────────────────────────────────
  await message.reply('Unknown image command. Use `!image editor` to see all available tools.').catch(() => null);
  return true;
}

async function handleAdminCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const welcomeCommands = ['!setwelcome', '!setrules', '!setservername', '!testwelcome', '!disablewelcome', '!enablewelcome', '!welcomeinfo', '!welcomehelp'];
  const igCommands = ['!ig', '!add', '!remove', '!set', '!monitor'];
  const allCommands = [...welcomeCommands, ...igCommands, '!help'];
  if (!allCommands.includes(cmd)) return false;

  if (!isAdmin(message.member)) {
    await message.reply('You need Administrator or Manage Server permission to use this command.').catch(() => null);
    return true;
  }

  if (cmd === '!help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('TraderBOT — Command Reference')
      .setDescription('All commands are restricted to admins and server owner.')
      .addFields(
        {
          name: '📸 Instagram Monitor',
          value: [
            '`!add ig monitor` — add a new Instagram account to monitor',
            '`!remove ig monitor` — remove a monitored account',
            '`!ig monitor info` — list all monitored accounts with status',
            '`!set monitor interval` — change how often the bot checks accounts',
            '`!monitor on` / `!monitor off` — pause or resume the monitoring service',
          ].join('\n'),
        },
        {
          name: '👋 Welcome System',
          value: [
            '`!setwelcome [#channel]` — set the welcome channel (defaults to current)',
            '`!setrules #channel` — set the rules channel shown in welcome messages',
            '`!setservername <name>` — set the name shown on the welcome banner',
            '`!enablewelcome` — turn welcome messages on',
            '`!disablewelcome` — turn welcome messages off',
            '`!testwelcome` — preview the welcome message using yourself',
            '`!welcomeinfo` — show current welcome settings',
          ].join('\n'),
        },
        {
          name: '🖼️ Image Editor',
          value: [
            '`!image editor` — show all image editing tools',
            '`!image bg` — remove background (attach image)',
            '`!image upscale [2/4]` — upscale image to 2× or 4× (attach image)',
            '`!image remove [object]` — remove an object (attach image, text optional)',
            '`!image faceswap` — swap faces between two images (attach 2 images)',
            '_Available to all users, no external APIs used._',
          ].join('\n'),
        },
        {
          name: '❓ Help',
          value: '`!help` — show this command list',
        }
      )
      .setFooter({ text: 'TraderBOT • Admin only' })
      .setTimestamp();
    await message.reply({ embeds: [embed] }).catch(() => null);
    return true;
  }

  if (cmd === '!ig' || cmd === '!add' || cmd === '!remove' || cmd === '!set' || cmd === '!monitor') {
    await handleIgCommand(message, parts);
    return true;
  }

  const gw = getGuildWelcome(message.guild.id);

  switch (cmd) {
    case '!setwelcome': {
      const channel = message.mentions.channels.first() || message.channel;
      gw.welcomeChannelId = channel.id;
      await saveWelcomeConfig();
      await message.reply(`Welcome messages will be sent to <#${channel.id}>.`).catch(() => null);
      return true;
    }
    case '!setrules': {
      const channel = message.mentions.channels.first();
      if (!channel) {
        await message.reply('Usage: `!setrules #channel`').catch(() => null);
        return true;
      }
      gw.rulesChannelId = channel.id;
      await saveWelcomeConfig();
      await message.reply(`Rules channel set to <#${channel.id}>.`).catch(() => null);
      return true;
    }
    case '!setservername': {
      const name = parts.slice(1).join(' ').trim();
      if (!name) {
        await message.reply('Usage: `!setservername <name shown in welcome message>`').catch(() => null);
        return true;
      }
      gw.serverName = name.slice(0, 80);
      await saveWelcomeConfig();
      await message.reply(`Welcome banner will say "${gw.serverName}".`).catch(() => null);
      return true;
    }
    case '!enablewelcome': {
      gw.enabled = true;
      await saveWelcomeConfig();
      await message.reply('Welcome messages enabled.').catch(() => null);
      return true;
    }
    case '!disablewelcome': {
      gw.enabled = false;
      await saveWelcomeConfig();
      await message.reply('Welcome messages disabled.').catch(() => null);
      return true;
    }
    case '!testwelcome': {
      await sendWelcome(message.member, true);
      return true;
    }
    case '!welcomeinfo': {
      const ch = gw.welcomeChannelId ? `<#${gw.welcomeChannelId}>` : 'not set';
      const rules = gw.rulesChannelId ? `<#${gw.rulesChannelId}>` : 'not set';
      const sname = gw.serverName || message.guild.name;
      await message.reply(
        `**Welcome settings**\n` +
        `Status: ${gw.enabled ? 'enabled' : 'disabled'}\n` +
        `Welcome channel: ${ch}\n` +
        `Rules channel: ${rules}\n` +
        `Server name: ${sname}`
      ).catch(() => null);
      return true;
    }
    case '!welcomehelp': {
      await message.reply(
        `**Welcome commands** (admin only)\n` +
        '`!setwelcome` — set this channel (or mention one) as the welcome channel\n' +
        '`!setrules #channel` — set the rules channel shown in the message\n' +
        '`!setservername <name>` — customise the name shown on the welcome banner\n' +
        '`!enablewelcome` / `!disablewelcome` — turn welcome messages on/off\n' +
        '`!testwelcome` — preview the welcome message using yourself\n' +
        '`!welcomeinfo` — show current settings\n\n' +
        'Tip: drop a custom background image at `assets/welcome_bg.png` (1024×450 recommended).'
      ).catch(() => null);
      return true;
    }
  }
  return false;
}

async function handleIgCommand(message, parts) {
  const sub = parts.slice(1).map((p) => p.toLowerCase()).join(' ');

  if (parts[0].toLowerCase() === '!ig' && sub === 'monitor info') {
    const accounts = igMonitor.getGuildAccounts(message.guild.id);
    if (accounts.length === 0) {
      await message.reply('No Instagram accounts are being monitored yet. Use `!add ig monitor` to add one.').catch(() => null);
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(0xe1306c)
      .setTitle('Instagram Monitor — Accounts')
      .setDescription(
        accounts
          .map((a, i) => {
            const status = a.enabled ? '🟢 Enabled' : '🔴 Disabled';
            const privacy = a.isPrivate ? '🔒 Private' : '🌐 Public';
            return `**${i + 1}. @${a.username}**\nStatus: ${status} | ${privacy} | <#${a.channelId}>`;
          })
          .join('\n\n')
      )
      .setFooter({ text: `${accounts.length} account(s) monitored` })
      .setTimestamp();
    await message.reply({ embeds: [embed] }).catch(() => null);
    return;
  }

  if (parts[0].toLowerCase() === '!add' && sub === 'ig monitor') {
    const ask = await message.reply('Please reply with the **Instagram username** you want to monitor (just the username, no @).').catch(() => null);
    if (!ask) return;

    const filter = (m) => m.author.id === message.author.id && m.channel.id === message.channel.id;
    let collected;
    try {
      collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
    } catch {
      await message.channel.send(`<@${message.author.id}> No username provided — request timed out.`).catch(() => null);
      return;
    }

    const usernameRaw = collected.first().content.trim().replace(/^@/, '');
    if (!usernameRaw || usernameRaw.includes(' ')) {
      await message.channel.send(`<@${message.author.id}> That doesn't look like a valid Instagram username.`).catch(() => null);
      return;
    }

    const checkMsg = await message.channel.send(`🔍 Checking **@${usernameRaw}**…`).catch(() => null);

    const result = await igMonitor.addAccount(message.guild.id, usernameRaw, client);

    if (result.success) {
      await checkMsg?.edit(`✅ **Connected successfully!** Channel <#${result.channel.id}> has been created for **@${result.profile.username}**.`).catch(() => null);
    } else if (result.reason === 'already_exists') {
      await checkMsg?.edit(`⚠️ **@${usernameRaw}** is already being monitored.`).catch(() => null);
    } else {
      await checkMsg?.edit(`❌ **Connection failed.** Please check the username and try again.\n> ${result.error || result.reason}`).catch(() => null);
    }
    return;
  }

  if (parts[0].toLowerCase() === '!remove' && sub === 'ig monitor') {
    const accounts = igMonitor.getGuildAccounts(message.guild.id);
    if (accounts.length === 0) {
      await message.reply('There are no monitored Instagram accounts to remove.').catch(() => null);
      return;
    }

    const list = accounts.map((a, i) => `**${i + 1}.** @${a.username}`).join('\n');
    await message.reply(
      `Which Instagram account do you want to remove? Reply with the **username**.\n\n${list}`
    ).catch(() => null);

    const filter = (m) => m.author.id === message.author.id && m.channel.id === message.channel.id;
    let collected;
    try {
      collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
    } catch {
      await message.channel.send(`<@${message.author.id}> No reply received — removal cancelled.`).catch(() => null);
      return;
    }

    const usernameRaw = collected.first().content.trim().replace(/^@/, '').toLowerCase();
    const match = accounts.find((a) => a.username.toLowerCase() === usernameRaw);
    if (!match) {
      await message.channel.send(`<@${message.author.id}> Account **@${usernameRaw}** is not in the monitored list.`).catch(() => null);
      return;
    }

    const confirmMsg = await message.channel.send(
      `Are you sure you want to remove **@${match.username}** from monitoring? Reply **yes** to confirm or anything else to cancel.`
    ).catch(() => null);

    let confirmed;
    try {
      confirmed = await message.channel.awaitMessages({ filter, max: 1, time: 20000, errors: ['time'] });
    } catch {
      await confirmMsg?.edit('Removal cancelled — no confirmation received.').catch(() => null);
      return;
    }

    if (confirmed.first().content.trim().toLowerCase() !== 'yes') {
      await message.channel.send('Removal cancelled.').catch(() => null);
      return;
    }

    const result = await igMonitor.removeAccount(message.guild.id, match.username);
    if (result.success) {
      await message.channel.send(
        `✅ **@${match.username}** has been removed from monitoring.\n` +
        `The channel <#${result.channelId}> has been kept — delete it manually if you no longer need it.`
      ).catch(() => null);
    } else {
      await message.channel.send(`❌ Could not remove **@${match.username}**: ${result.reason}`).catch(() => null);
    }
    return;
  }

  if (parts[0].toLowerCase() === '!set' && sub === 'monitor interval') {
    const currentMs = igMonitor.getCurrentIntervalMs();
    const curSecs = Math.floor(currentMs / 1000);
    const curMins = Math.floor(curSecs / 60);
    const curRemSecs = curSecs % 60;
    const currentDisplay = curMins > 0 && curRemSecs > 0
      ? `${curMins}m ${curRemSecs}s`
      : curMins > 0 ? `${curMins}m` : `${curSecs}s`;

    const prompt = await message.reply(
      `⏱️ **Current interval: ${currentDisplay}**\n\n` +
      `How often should the bot check Instagram accounts?\n` +
      `Reply using **m** for minutes and **s** for seconds (minutes must come first):\n\n` +
      `\`10s\` → 10 seconds\n` +
      `\`30s\` → 30 seconds\n` +
      `\`1m\` → 1 minute\n` +
      `\`5m\` → 5 minutes\n` +
      `\`5m 30s\` → 5 minutes 30 seconds\n` +
      `\`1m 10s\` → 1 minute 10 seconds\n\n` +
      `*(Minimum: 10s — lowercase only, minutes must come before seconds)*`
    ).catch(() => null);
    if (!prompt) return;

    const filter = (m) => m.author.id === message.author.id && m.channel.id === message.channel.id;
    let collected;
    try {
      collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
    } catch {
      await prompt.edit(`⏱️ **Current interval: ${currentDisplay}**\n\n❌ No response received — interval unchanged.`).catch(() => null);
      return;
    }

    const userMsg = collected.first();
    const input = userMsg.content.trim();

    await userMsg.delete().catch(() => null);

    const onlySeconds = input.match(/^(\d+)s$/);
    const onlyMinutes = input.match(/^(\d+)m$/);
    const minsAndSecs = input.match(/^(\d+)m\s+(\d+)s$/);
    const wrongOrder = input.match(/^\d+s\s+\d+m/);

    if (wrongOrder) {
      await prompt.edit(
        `⏱️ **Current interval: ${currentDisplay}**\n\n` +
        `❌ Wrong order — minutes must come **before** seconds (e.g. \`5m 10s\`, not \`10s 5m\`).`
      ).catch(() => null);
      return;
    }

    let totalMs = 0;
    let displayStr = '';

    if (minsAndSecs) {
      const mins = parseInt(minsAndSecs[1], 10);
      const secs = parseInt(minsAndSecs[2], 10);
      totalMs = (mins * 60 + secs) * 1000;
      displayStr = `${mins} minute${mins !== 1 ? 's' : ''} ${secs} second${secs !== 1 ? 's' : ''}`;
    } else if (onlyMinutes) {
      const mins = parseInt(onlyMinutes[1], 10);
      totalMs = mins * 60 * 1000;
      displayStr = `${mins} minute${mins !== 1 ? 's' : ''}`;
    } else if (onlySeconds) {
      const secs = parseInt(onlySeconds[1], 10);
      totalMs = secs * 1000;
      displayStr = `${secs} second${secs !== 1 ? 's' : ''}`;
    } else {
      await prompt.edit(
        `⏱️ **Current interval: ${currentDisplay}**\n\n` +
        `❌ Invalid format. Examples: \`30s\`, \`2m\`, \`5m 10s\` (lowercase only, minutes before seconds).`
      ).catch(() => null);
      return;
    }

    const result = igMonitor.updateMonitorInterval(totalMs);
    if (!result.success) {
      await prompt.edit(
        `⏱️ **Current interval: ${currentDisplay}**\n\n` +
        `❌ Minimum allowed interval is **10 seconds**. \`${input}\` is too short — please try again.`
      ).catch(() => null);
      return;
    }

    await prompt.edit(
      `✅ **Monitoring interval updated to ${displayStr}.**\nThe bot will now check all Instagram accounts every ${displayStr}.`
    ).catch(() => null);
    return;
  }

  if (parts[0].toLowerCase() === '!monitor') {
    const action = parts[1]?.toLowerCase();

    if (action === 'off') {
      const wasActive = igMonitor.pauseMonitoring();
      if (!wasActive) {
        await message.reply('⏸️ Monitoring is **already off**.').catch(() => null);
      } else {
        await message.reply('🔴 **Monitoring turned OFF.** The bot will stop checking Instagram accounts until you turn it back on.').catch(() => null);
      }
      return;
    }

    if (action === 'on') {
      const wasResumed = igMonitor.resumeMonitoring();
      if (!wasResumed) {
        const active = igMonitor.isMonitoringActive();
        if (active) {
          await message.reply('▶️ Monitoring is **already on**.').catch(() => null);
        } else {
          await message.reply('❌ Could not resume — no client available. Try restarting the bot.').catch(() => null);
        }
      } else {
        const ms = igMonitor.getCurrentIntervalMs();
        const secs = Math.floor(ms / 1000);
        const mins = Math.floor(secs / 60);
        const remSecs = secs % 60;
        const intervalDisplay = mins > 0 && remSecs > 0
          ? `${mins}m ${remSecs}s`
          : mins > 0 ? `${mins}m` : `${secs}s`;
        await message.reply(`🟢 **Monitoring turned ON.** The bot will check all accounts every **${intervalDisplay}**.`).catch(() => null);
      }
      return;
    }

    const status = igMonitor.isMonitoringActive() ? '🟢 **ON**' : '🔴 **OFF**';
    await message.reply(
      `Monitoring is currently ${status}.\n\n` +
      '`!monitor on` — resume monitoring\n' +
      '`!monitor off` — pause monitoring'
    ).catch(() => null);
    return;
  }

  await message.reply(
    '**Instagram Monitor commands** (admin only)\n' +
    '`!ig monitor info` — list all monitored accounts\n' +
    '`!add ig monitor` — add a new Instagram account to monitor\n' +
    '`!remove ig monitor` — remove a monitored account\n' +
    '`!set monitor interval` — change how often the bot checks accounts\n' +
    '`!monitor on` / `!monitor off` — pause or resume the monitoring service'
  ).catch(() => null);
}

async function handleMemberJoin(member) {
  if (member.user.bot) return;
  const gw = getGuildWelcome(member.guild.id);
  if (!gw.enabled || !gw.welcomeChannelId) return;
  await sendWelcome(member, false);
}

async function sendWelcome(member, isTest) {
  const gw = getGuildWelcome(member.guild.id);
  const channelId = gw.welcomeChannelId;
  if (!channelId) {
    console.log(`[welcome] no channel configured for ${member.guild.name}`);
    return;
  }
  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.log(`[welcome] channel ${channelId} not found or not text channel`);
    return;
  }

  const serverName = gw.serverName || member.guild.name;
  const rulesMention = gw.rulesChannelId ? `<#${gw.rulesChannelId}>` : '`#rules`';

  let bannerAttachment = null;
  try {
    const banner = await generateWelcomeBanner(member, serverName);
    bannerAttachment = { attachment: banner, name: 'welcome.png' };
  } catch (err) {
    console.warn('[welcome] banner generation failed:', err.message);
  }

  const lines = [
    `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
    `\uD83D\uDC96 Welcome to **${serverName}** \uD83D\uDC96`,
    ``,
    `Hope you have a good time here <@${member.id}>`,
    ``,
    `Check ${rulesMention} \u2705`,
    `\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`,
  ];

  const payload = { content: lines.join('\n') };
  if (bannerAttachment) payload.files = [bannerAttachment];

  await channel.send(payload).catch((e) => console.warn('[welcome] failed to send:', e.message));
  console.log(`[welcome] sent for ${member.user.tag}${isTest ? ' (test)' : ''} in ${channel.name}`);
}

const WELCOME_W = 1024, WELCOME_H = 450;
let welcomeBaseImageBuf = null;
let welcomeDimOverlayBuf = null;
let welcomeRingBuf = null;
let welcomeBaseImageMtime = 0;

async function buildWelcomeBaseImage() {
  const bgPath = path.join(__dirname, 'assets', 'welcome_bg.png');
  let mtime = 0;
  try { mtime = (await fsp.stat(bgPath)).mtimeMs; } catch {}
  if (welcomeBaseImageBuf && mtime === welcomeBaseImageMtime) return welcomeBaseImageBuf;

  if (mtime > 0) {
    welcomeBaseImageBuf = await sharp(bgPath).resize(WELCOME_W, WELCOME_H, { fit: 'cover' }).toBuffer();
  } else {
    const gradientSvg = `<svg width="${WELCOME_W}" height="${WELCOME_H}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1a1a2e"/>
        <stop offset="50%" stop-color="#3d2c5e"/>
        <stop offset="100%" stop-color="#0f0f1e"/>
      </linearGradient></defs>
      <rect width="${WELCOME_W}" height="${WELCOME_H}" fill="url(#g)"/>
    </svg>`;
    welcomeBaseImageBuf = await sharp(Buffer.from(gradientSvg)).png().toBuffer();
  }
  welcomeBaseImageMtime = mtime;
  return welcomeBaseImageBuf;
}

async function buildWelcomeStaticOverlays() {
  if (!welcomeDimOverlayBuf) {
    welcomeDimOverlayBuf = await sharp({
      create: { width: WELCOME_W, height: WELCOME_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.35 } }
    }).png().toBuffer();
  }
  if (!welcomeRingBuf) {
    const AV = 200;
    const ringSize = AV + 16;
    const ringSvg = Buffer.from(
      `<svg width="${ringSize}" height="${ringSize}">
        <circle cx="${ringSize/2}" cy="${ringSize/2}" r="${ringSize/2 - 4}" fill="none" stroke="#22c55e" stroke-width="6"/>
      </svg>`
    );
    welcomeRingBuf = await sharp(ringSvg).png().toBuffer();
  }
}

async function preWarmWelcome() {
  await buildWelcomeBaseImage();
  await buildWelcomeStaticOverlays();
  console.log('[welcome] pre-warmed banner assets.');
}

async function generateWelcomeBanner(member, serverName) {
  const W = WELCOME_W, H = WELCOME_H;
  const baseImage = await buildWelcomeBaseImage();
  await buildWelcomeStaticOverlays();
  const dimOverlay = welcomeDimOverlayBuf;

  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
  const avatarBuf = await fetchImageBuffer(avatarUrl);
  const AV = 200;
  const avatarResized = await sharp(avatarBuf).resize(AV, AV, { fit: 'cover' }).png().toBuffer();
  const circleMask = Buffer.from(
    `<svg width="${AV}" height="${AV}"><circle cx="${AV/2}" cy="${AV/2}" r="${AV/2}" fill="white"/></svg>`
  );
  const avatarRound = await sharp(avatarResized)
    .composite([{ input: circleMask, blend: 'dest-in' }])
    .png().toBuffer();

  const ringSize = AV + 16;
  const ring = welcomeRingBuf;

  const username = (member.displayName || member.user.username).slice(0, 28);
  const safeName = username.replace(/[<>&"']/g, '');
  const safeServer = serverName.replace(/[<>&"']/g, '').slice(0, 50);

  const textSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <style>
      .welcome { font: bold 78px sans-serif; fill: #ffffff; }
      .name { font: bold 44px sans-serif; fill: #ff6b9d; }
      .server { font: 600 28px sans-serif; fill: #e0e0e0; }
    </style>
    <text x="50%" y="320" text-anchor="middle" class="welcome">WELCOME</text>
    <text x="50%" y="370" text-anchor="middle" class="name">${safeName}</text>
    <text x="50%" y="412" text-anchor="middle" class="server">${safeServer} \u2705</text>
  </svg>`;

  const avatarX = Math.round((W - ringSize) / 2);
  const avatarY = 30;

  return sharp(baseImage)
    .composite([
      { input: dimOverlay, top: 0, left: 0 },
      { input: ring, top: avatarY, left: avatarX },
      { input: avatarRound, top: avatarY + 8, left: avatarX + 8 },
      { input: Buffer.from(textSvg), top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
