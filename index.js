import { Client, GatewayIntentBits, PermissionsBitField, ChannelType } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection
} from "@discordjs/voice";
import ytdl from "ytdl-core";
import yts from "yt-search";
import ffmpeg from "ffmpeg-static";

if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;

const OWNER_ID = process.env.OWNER_ID || "1268018033268621455";

const lockedChannelPerGuild = new Map(); // guildId -> voiceChannelId
const queues = new Map(); // guildId -> { songs, player, playing, volume }

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

function isMod(m) {
  return m.id === OWNER_ID ||
         m.permissions.has(PermissionsBitField.Flags.BanMembers) ||
         m.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.once("ready", () => console.log(`✅ Logged in as ${client.user.tag}`));

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const parts = message.content.trim().split(/\s+/);
  const rawCmd = (parts.shift() || "").toLowerCase();
  const cmd = commandMap.get(rawCmd);
  if (!cmd) return;

  try {
    // تعال @البوت
    if (cmd === "join") {
      if (!isMod(message.member)) return;
      const mentioned = message.mentions.users.first();
      if (!mentioned || mentioned.id !== client.user.id) return;
      const userVc = message.member?.voice?.channel; if (!userVc) return;

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
      case "play":  message.reply("حاضر ياسيدي 😝").catch(()=>{}); return handlePlay(message, parts.join(" "));
      case "skip":  return handleSkip(message);
      case "stop":  return handleStop(message);
      case "pause": return handlePause(message);
      case "resume":return handleResume(message);
      case "queue": return handleQueue(message);
      case "leave": return handleLeave(message);
    }

    // أوامر الأونر (صامتة)
    if (message.author.id !== OWNER_ID) return;
    if (cmd === "setavatar") { const url = parts[0]; if (!url) return; try { await client.user.setAvatar(url); } catch {} return; }
    if (cmd === "setname")   { const name = parts.join(" "); if (!name) return; try { await client.user.setUsername(name); } catch {} return; }
    if (cmd === "setstatus") { const text = parts.join(" "); if (!text) return; client.user.setPresence({ activities: [{ name: text }], status: "online" }); return; }
  } catch (e) { console.error(e); }
});

// ===== Helpers =====
function getOrCreateQueue(guild) {
  let q = queues.get(guild.id);
  if (!q) {
    q = {
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      playing: false,
      volume: 1.0
    };
    queues.set(guild.id, q);

    q.player.on(AudioPlayerStatus.Playing, () => { q.playing = true; });
    q.player.on(AudioPlayerStatus.Idle, () => {
      if (q.songs.length) q.songs.shift();
      if (q.songs.length) playNext(guild, q);
      else q.playing = false;
    });
    q.player.on("error", (err) => {
      console.error("Player error:", err);
      if (q.songs.length) q.songs.shift();
      if (q.songs.length) playNext(guild, q);
      else q.playing = false;
    });
  }
  return q;
}

// ===== Play flow (ytdl-core فقط) =====
async function handlePlay(message, query) {
  if (!query) return;

  // تأكد من الاتصال والاشتراك
  const lockedId = lockedChannelPerGuild.get(message.guild.id);
  let conn = getVoiceConnection(message.guild.id);
  if (!conn && lockedId) {
    conn = joinVoiceChannel({
      channelId: lockedId,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });
  }
  if (conn) {
    // نضمن الاشتراك قبل التشغيل
    const q = getOrCreateQueue(message.guild);
    conn.subscribe(q.player);
  }

  // تنظيف روابط يوتيوب
  if (query.includes("youtube.com") || query.includes("youtu.be")) {
    query = query.split("&")[0];
    if (query.includes("?si")) query = query.split("?si")[0];
  }

  // تحديد الرابط
  let trackUrl = null;
  let title = query;
  try {
    if (/^https?:\/\//i.test(query)) {
      trackUrl = query;
      if (ytdl.validateURL(trackUrl)) {
        const info = await ytdl.getInfo(trackUrl).catch(()=>null);
        if (info) title = info.videoDetails?.title || title;
      }
    } else {
      const res = await yts(query);
      const v = res && res.videos && res.videos[0];
      if (v) { trackUrl = v.url; title = v.title; }
    }
  } catch (e) { console.error("Search error:", e); }

  if (!trackUrl || !ytdl.validateURL(trackUrl)) return;

  const q = getOrCreateQueue(message.guild);
  q.songs.push({ url: trackUrl, title });
  if (!q.playing) playNext(message.guild, q);
}

async function playNext(guild, q) {
  const current = q.songs[0];
  if (!current) return;

  try {
    // تأكد الاشتراك موجود
    let conn = getVoiceConnection(guild.id);
    if (!conn) {
      const lockedId = lockedChannelPerGuild.get(guild.id);
      if (!lockedId) { q.playing = false; return; }
      conn = joinVoiceChannel({
        channelId: lockedId,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator
      });
    }
    conn.subscribe(q.player);

    // ytdl-core stream
    const stream = ytdl(current.url, {
      filter: "audioonly",
      quality: "highestaudio",
      highWaterMark: 1 << 25,     // يمنع الانقطاع السريع
      dlChunkSize: 0               // تدفق مستمر
    });

    const resource = createAudioResource(stream, { inlineVolume: true });
    resource.volume?.setVolume(q.volume ?? 1.0);

    q.player.play(resource);
    q.playing = true;
  } catch (e) {
    console.error("Stream error:", e);
    if (q.songs.length) q.songs.shift();
    if (q.songs.length) playNext(guild, q);
    else q.playing = false;
  }
}

// ===== باقي الأوامر (صامتة) =====
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

client.login(process.env.TOKEN);