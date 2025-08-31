
import { Client, GatewayIntentBits, PermissionsBitField, ChannelType } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection
} from "@discordjs/voice";
import * as play from "play-dl";
import ffmpeg from "ffmpeg-static";

if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;

// ID حقك (غيره لو تبي)
const OWNER_ID = process.env.OWNER_ID || "1268018033268621455";

// تخزين الروم المثبت
const lockedChannelPerGuild = new Map();
const queues = new Map();

const commandMap = new Map([
  ["join","join"], ["تعال","join"],
  ["play","play"], ["شغل","play"], ["شغّل","play"],
  ["skip","skip"], ["تخطي","skip"],
  ["stop","stop"], ["ايقاف","stop"], ["إيقاف","stop"],
  ["pause","pause"], ["وقف","pause"],
  ["resume","resume"], ["كمل","resume"], ["استئناف","resume"],
  ["queue","queue"], ["قائمة","queue"], ["صف","queue"],
  ["leave","leave"], ["اطلع","leave"], ["اخرج","leave"],
  ["غيرافتار","setavatar"], ["غيراسم","setname"], ["غيرحالة","setstatus"]
]);

function isMod(member) {
  return member.id === OWNER_ID ||
         member.permissions.has(PermissionsBitField.Flags.BanMembers) ||
         member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const parts = message.content.trim().split(/\s+/);
  const rawCmd = (parts.shift() || "").toLowerCase();
  const cmd = commandMap.get(rawCmd);
  if (!cmd) return;

  try {
    if (cmd === "join") {
      if (!isMod(message.member)) return;
      const mentioned = message.mentions.users.first();
      if (!mentioned || mentioned.id !== client.user.id) return;
      const userVc = message.member?.voice?.channel;
      if (!userVc) return;

      joinVoiceChannel({
        channelId: userVc.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });
      lockedChannelPerGuild.set(message.guild.id, userVc.id);

      const me = await message.guild.members.fetch(client.user.id).catch(()=>null);
      if (userVc.type === ChannelType.GuildStageVoice && me?.voice?.suppress) {
        try { await me.voice.setSuppressed(false); } catch {}
      }
      return;
    }

    const musicCommands = new Set(["play","skip","stop","pause","resume","queue","leave"]);
    if (musicCommands.has(cmd)) {
      if (!isMod(message.member)) return;
      const lockedId = lockedChannelPerGuild.get(message.guild.id);
      if (!lockedId) return;
      const userVcId = message.member?.voice?.channelId;
      if (userVcId !== lockedId) return;
    }

    switch (cmd) {
      case "play": {
        message.reply("حاضر ياسيدي 😝").catch(()=>{});
        return handlePlay(message, parts.join(" "));
      }
      case "skip":   return handleSkip(message);
      case "stop":   return handleStop(message);
      case "pause":  return handlePause(message);
      case "resume": return handleResume(message);
      case "queue":  return handleQueue(message);
      case "leave":  return handleLeave(message);
    }

    if (message.author.id !== OWNER_ID) return;
    if (cmd === "setavatar") {
      const url = parts[0]; if (!url) return;
      try { await client.user.setAvatar(url); } catch {}
      return;
    }
    if (cmd === "setname") {
      const name = parts.join(" "); if (!name) return;
      try { await client.user.setUsername(name); } catch {}
      return;
    }
    if (cmd === "setstatus") {
      const text = parts.join(" "); if (!text) return;
      client.user.setPresence({ activities: [{ name: text }], status: "online" });
      return;
    }
  } catch (e) {
    console.error(e);
  }
});

// ===== Functions =====
function getOrCreateQueue(guild, channel) {
  let q = queues.get(guild.id);
  if (!q) {
    q = {
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      textChannel: channel,
      playing: false,
      volume: 1.0
    };
    queues.set(guild.id, q);

    q.player.on(AudioPlayerStatus.Idle, () => {
      q.songs.shift();
      if (q.songs.length) playNext(guild, q);
      else q.playing = false;
    });

    q.player.on("error", (err) => {
      console.error("Player error:", err);
      q.songs.shift();
      if (q.songs.length) playNext(guild, q);
      else q.playing = false;
    });
  }
  return q;
}

async function handlePlay(message, query) {
  if (!query) return;

  const lockedId = lockedChannelPerGuild.get(message.guild.id);
  let conn = getVoiceConnection(message.guild.id);
  if (!conn && lockedId) {
    conn = joinVoiceChannel({
      channelId: lockedId,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });
  }

  if (query.includes("youtube.com") || query.includes("youtu.be")) {
    query = query.split("&")[0];
    if (query.includes("?si")) query = query.split("?si")[0];
  }

  let trackUrl = null;
  let title = query;
  try {
    if (/^https?:\/\//i.test(query)) {
      trackUrl = query;
    } else {
      const s = await play.search(query, { limit: 1, source: { youtube: "video" } });
      if (s?.length) { trackUrl = s[0].url; title = s[0].title; }
    }
  } catch (e) { console.error("Search error:", e); }

  if (!trackUrl) return;
  const q = getOrCreateQueue(message.guild, message.channel);
  q.songs.push({ url: trackUrl, title });
  if (!q.playing) playNext(message.guild, q);
}

async function playNext(guild, q) {
  const current = q.songs[0];
  if (!current) return;
  try {
    const stream = await play.stream(current.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true
    });
    resource.volume?.setVolume(q.volume ?? 1.0);

    q.player.play(resource);
    q.playing = true;

    let conn = getVoiceConnection(guild.id);
    if (conn) conn.subscribe(q.player);
  } catch (e) {
    console.error("Stream error:", e);
    q.songs.shift();
    if (q.songs.length) playNext(guild, q);
    else q.playing = false;
  }
}

function handleSkip(message) {
  const q = queues.get(message.guild.id);
  if (q && q.playing) q.player.stop(true);
}
function handleStop(message) {
  const q = queues.get(message.guild.id);
  if (!q) return;
  q.songs = [];
  q.player.stop(true);
}
function handlePause(message) {
  const q = queues.get(message.guild.id);
  if (q && q.playing) q.player.pause();
}
function handleResume(message) {
  const q = queues.get(message.guild.id);
  if (q) q.player.unpause();
}
function handleQueue(message) { /* صامت */ }
function handleLeave(message) {
  const conn = getVoiceConnection(message.guild.id);
  if (conn) conn.destroy();
  queues.delete(message.guild.id);
  lockedChannelPerGuild.delete(message.guild.id);
}

// ===== Login =====
client.login(process.env.TOKEN);
