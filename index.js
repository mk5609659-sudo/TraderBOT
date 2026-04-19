const { Client, GatewayIntentBits, Events } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType, createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior, AudioPlayerStatus } = require('@discordjs/voice');
const { Readable } = require('stream');
const prism = require('prism-media');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const config = require('./config.json');
if (process.env.DISCORD_TOKEN) {
  config.token = process.env.DISCORD_TOKEN;
}
const linkRegex = /(https?:\/\/[^\s]+)/i;

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
  if (!config.token || config.token === 'YOUR_DISCORD_BOT_TOKEN_HERE') {
    throw new Error('Discord bot token is missing. Set the DISCORD_TOKEN secret or add it to config.json.');
  }
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
  if (config.startPythonVoiceService) {
    startPythonVoiceService();
  }
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

async function handleMessage(message) {
  const content = message.content || '';
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
  for (const attachment of attachments.values()) {
    const buffer = await fetchImageBuffer(attachment.url);
    const restricted = await findRestrictedImage(buffer);
    if (restricted) {
      await safeDelete(message, `<@${message.author.id}> Restricted image detected and removed.`);
      return;
    }

    if (linkDetected) {
      const blurred = await blurImage(buffer);
      await safeDelete(message, `<@${message.author.id}> Image with link was blurred and reposted.`);
      await message.channel.send({
        content: `<@${message.author.id}> Here is the blurred version of the image with the link removed.`,
        files: [{ attachment: blurred, name: 'blurred.png' }]
      });
      return;
    }
  }
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

async function computeImageHash(buffer) {
  const resized = await sharp(buffer)
    .resize(16, 16, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer();

  const total = resized.reduce((sum, v) => sum + v, 0);
  const average = total / resized.length;
  return Array.from(resized)
    .map((value) => (value > average ? '1' : '0'))
    .join('');
}

function hammingDistance(hashA, hashB) {
  let distance = 0;
  for (let i = 0; i < Math.min(hashA.length, hashB.length); i++) {
    if (hashA[i] !== hashB[i]) distance += 1;
  }
  return distance;
}

async function findRestrictedImage(buffer) {
  const imageHash = await computeImageHash(buffer);
  const files = await fsp.readdir(config.restrictedImageFolder).catch(() => []);
  for (const file of files) {
    if (!file.match(/\.(jpe?g|png|gif|webp|bmp)$/i)) continue;
    const otherBuffer = await fsp.readFile(path.join(config.restrictedImageFolder, file));
    const otherHash = await computeImageHash(otherBuffer);
    const distance = hammingDistance(imageHash, otherHash);
    const similarity = 1 - distance / imageHash.length;
    if (similarity >= 0.95) {
      return true;
    }
  }
  return false;
}

async function handleVoiceStateUpdate(oldState, newState) {
  if (!config.enableVoice) return;
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
  if (timeout) {
    clearTimeout(timeout);
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

function startPythonVoiceService() {
  const scriptPath = path.join(__dirname, 'services', 'voice_service.py');
  const pythonProcess = spawn('python', [scriptPath], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  pythonProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[voice-service] ${chunk}`);
  });
  pythonProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[voice-service] ${chunk}`);
  });
  pythonProcess.on('close', (code) => {
    console.log(`Voice service exited with code ${code}`);
  });
}

main().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
