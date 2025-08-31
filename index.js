
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection
} from "@discordjs/voice";
import * as play from "play-dl";

const OWNER_ID = process.env.OWNER_ID || "1268018033268621455";

// نخزن الروم المثبت لكل سيرفر
const lockedChannelPerGuild = new Map();

// صف التشغيل
const queues = new Map();
// { songs:[{url,title}], player, textChannel, connection, playing, volume }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// أوامر
const commandMap = new Map([
  ["join","join"], ["تعال","join"],
  ["play","play"], ["شغل","play"], ["شغّل","play"],
  ["skip","skip"], ["تخطي","skip"],
  ["stop","stop"], ["ايقاف","stop"], ["إيقاف","stop"],
  ["pause","pause"], ["وقف","pause"],
  ["resume","resume"], ["كمل","resume"], ["استئناف","resume"],
  ["queue","queue"], ["قائمة","queue"], ["صف","queue"],
  ["leave","leave"], ["اطلع","leave"], ["اخرج","leave"],
  // أوامر الأونر
  ["غيرافتار","setavatar"], ["غيراسم","setname"], ["غيرحالة","setstatus"]
]);

function isMod(member) {
  return member.permissions.has("BanMembers") ||
         member.permissions.has("ManageGuild") ||
         member.id === OWNER_ID;
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const parts = message.content.trim().split(/\s+/);
  const rawCmd = (parts.shift() || "").toLowerCase();
  const cmd = commandMap.get(rawCmd);
  if (!cmd) return;

  try {
    // —— أمر join (تعال) —— //
    if (cmd === "join") {
      if (!isMod(message.member)) return; // بس للأدمن
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
      return;
    }

    // أوامر الموسيقى
    const musicCommands = new Set(["play","skip","stop","pause","resume","queue","leave"]);
    if (musicCommands.has(cmd)) {
      if (!isMod(message.member)) return; // بس للأدمن
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

    // أوامر الأونر فقط
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

// ================= Functions =================

function getOrCreateQueue(guild, channel) {
  let q = queues.get(guild.id);
  if (!q) {
    q = {
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      textChannel: channel,
      connection: getVoiceConnection(guild.id),
      playing: false,
      volume: 1.0,
      loop: "off"
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
    });

    const conn = getVoiceConnection(guild.id);
    if (conn) conn.subscribe(q.player);
  }
  return q;
}

async function handlePlay(message, query) {
  if (!query) return;
  const lockedId = lockedChannelPerGuild.get(message.guild.id);
  let conn = getVoiceConnection(message.guild.id);
  if (!conn) {
    joinVoiceChannel({
      channelId: lockedId,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });
    conn = getVoiceConnection(message.guild.id);
  }

  if (query.includes("youtube.com") || query.includes("youtu.be")) {
    query = query.split("&")[0];
    if (query.includes("?si")) query = query.split("?si")[0];
  }

  const q = getOrCreateQueue(message.guild, message.channel);
  let trackUrl = null;
  let title = query;
  try {
    if (/^https?:\/\//i.test(query)) {
      const kind = play.validate(query);
      if (kind === "sp_track") {
        const sp = await play.spotify(query);
        title = `${sp.name} ${sp.artists?.[0]?.name || ""}`;
        const s = await play.search(title, { limit: 1, source: { youtube: "video" } });
        if (s?.length) { trackUrl = s[0].url; title = s[0].title || title; }
      } else {
        trackUrl = query;
      }
    } else {
      const s = await play.search(query, { limit: 1, source: { youtube: "video" } });
      if (s?.length) { trackUrl = s[0].url; title = s[0].title || query; }
    }
  } catch {}

  if (!trackUrl) return;

  q.songs.push({ url: trackUrl, title });
  if (!q.playing) playNext(message.guild, q);
}

async function playNext(guild, q) {
  const current = q.songs[0];
  if (!current) return;
  try {
    const stream = await play.stream(current.url);
    const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
    resource.volume?.setVolume(q.volume);
    q.player.play(resource);
    q.playing = true;

    const conn = getVoiceConnection(guild.id);
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
  if (!q || !q.playing) return;
  q.player.stop(true);
}

function handleStop(message) {
  const q = queues.get(message.guild.id);
  if (!q) return;
  q.songs = [];
  q.player.stop(true);
}

function handlePause(message) {
  const q = queues.get(message.guild.id);
  if (!q || !q.playing) return;
  q.player.pause();
}

function handleResume(message) {
  const q = queues.get(message.guild.id);
  if (!q) return;
  q.player.unpause();
}

function handleQueue(message) {
  const q = queues.get(message.guild.id);
  if (!q || !q.songs.length) return;
  // ما نطبع ولا شي عالشات (صامت)
}

function handleLeave(message) {
  const conn = getVoiceConnection(message.guild.id);
  if (conn) conn.destroy();
  queues.delete(message.guild.id);
  lockedChannelPerGuild.delete(message.guild.id);
}

client.login(process.env.TOKEN);
