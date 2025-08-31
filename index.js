
// ==== Imports ====
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

// اجعل FFmpeg متاح للمكتبات
if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;

// ==== Env / Config ====
const OWNER_ID = process.env.OWNER_ID || "1268018033268621455";

// لكل سيرفر: الروم اللي البوت "مثبّت" نفسه فيه بعد تعال @البوت
const lockedChannelPerGuild = new Map(); // guildId -> voiceChannelId

// صف التشغيل لكل سيرفر
const queues = new Map(); // guildId -> { songs, player, textChannel, playing, volume, loop }

// — أوامر بدون بريفكس (عربي/إنجليزي)
const commandMap = new Map([
  ["join","join"], ["تعال","join"],

  ["play","play"], ["شغل","play"], ["شغّل","play"],
  ["skip","skip"], ["تخطي","skip"],
  ["stop","stop"], ["ايقاف","stop"], ["إيقاف","stop"],
  ["pause","pause"], ["وقف","pause"],
  ["resume","resume"], ["كمل","resume"], ["استئناف","resume"],
  ["queue","queue"], ["قائمة","queue"], ["صف","queue"],
  ["leave","leave"], ["اطلع","leave"], ["اخرج","leave"],

  // أوامر الأونر (صامتة)
  ["غيرافتار","setavatar"], ["غيراسم","setname"], ["غيرحالة","setstatus"]
]);

// صلاحيات الأدمن/مود
function isMod(member) {
  return member.id === OWNER_ID ||
         member.permissions.has(PermissionsBitField.Flags.BanMembers) ||
         member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

// ==== Client ====
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

// ==== Message Handler ====
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  const parts = message.content.trim().split(/\s+/);
  const rawCmd = (parts.shift() || "").toLowerCase();
  const cmd = commandMap.get(rawCmd);
  if (!cmd) return;

  try {
    // ----- أمر الانضمام: "تعال @البوت" -----
    if (cmd === "join") {
      if (!isMod(message.member)) return;                 // بس للإداري/الأونر
      const mentioned = message.mentions.users.first();
      if (!mentioned || mentioned.id !== client.user.id) return; // لازم منشن لنفس البوت
      const userVc = message.member?.voice?.channel;
      if (!userVc) return;

      joinVoiceChannel({
        channelId: userVc.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });
      lockedChannelPerGuild.set(message.guild.id, userVc.id);

      // لو القناة Stage، حاول فك الكتم للمتحدث
      const me = await message.guild.members.fetch(client.user.id).catch(()=>null);
      if (userVc.type === ChannelType.GuildStageVoice && me?.voice?.suppress) {
        try { await me.voice.setSuppressed(false); } catch {}
      }
      return; // صامت
    }

    // ----- أوامر الموسيقى (صامتة إلا "play" يرد بجملة وحدة) -----
    const musicCommands = new Set(["play","skip","stop","pause","resume","queue","leave"]);
    if (musicCommands.has(cmd)) {
      if (!isMod(message.member)) return; // بس للإداري/الأونر

      const lockedId = lockedChannelPerGuild.get(message.guild.id);
      if (!lockedId) return; // ما فيه روم مثبت
      const userVcId = message.member?.voice?.channelId;
      if (userVcId !== lockedId) return; // لازم تكون بنفس الروم المثبت
    }

    switch (cmd) {
      case "play": {
        // الرد الوحيد المسموح
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

    // ----- أوامر الأونر فقط (بدون أي ردود) -----
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

// ==== Queue helpers ====
function getOrCreateQueue(guild, channel) {
  let q = queues.get(guild.id);
  if (!q) {
    q = {
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      textChannel: channel,
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
      else q.playing = false;
    });

    // الاشتراك يتم داخل playNext لضمان الاتصال موجود
  }
  return q;
}

// ==== Music actions ====
async function handlePlay(message, query) {
  if (!query) return;

  const lockedId = lockedChannelPerGuild.get(message.guild.id);
  // تأكد متصل بالقناة المثبتة
  let conn = getVoiceConnection(message.guild.id);
  if (!conn) {
    conn = joinVoiceChannel({
      channelId: lockedId,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });
  }

  // تنظيف روابط يوتيوب من الباراميترات المسببة للمشاكل
  if (query.includes("youtube.com") || query.includes("youtu.be")) {
    query = query.split("&")[0];
    if (query.includes("?si")) query = query.split("?si")[0];
  }

  // حدد المصدر: رابط/بحث + دعم Spotify => Youtube
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
        trackUrl = query; // يوتيوب/ساوندكلاود/رابط مباشر
      }
    } else {
      const s = await play.search(query, { limit: 1, source: { youtube: "video" } });
      if (s?.length) { trackUrl = s[0].url; title = s[0].title || query; }
    }
  } catch (e) {
    console.error("Search error:", e);
  }

  if (!trackUrl) return;

  const q = getOrCreateQueue(message.guild, message.channel);
  q.songs.push({ url: trackUrl, title });
  if (!q.playing) playNext(message.guild, q);
}

async function playNext(guild, q) {
  const current = q.songs[0];
  if (!current) return;
  try {
    // stream عبر play-dl
    const stream = await play.stream(current.url);
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type,
      inlineVolume: true
    });
    resource.volume?.setVolume(q.volume ?? 1.0);

    q.player.play(resource);
    q.playing = true;

    // اشترك بعد التشغيل لضمان الربط
    let conn = getVoiceConnection(guild.id);
    if (!conn) {
      // محاولة أخيرة لو انقطع الاتصال لأي سبب (ينبغي أن يكون مقفول على lockedId)
      const lockedId = lockedChannelPerGuild.get(guild.id);
      if (lockedId) {
        conn = joinVoiceChannel({
          channelId: lockedId,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator
        });
      }
    }
    if (conn) conn.subscribe(q.player);
  } catch (e) {
    console.error("Stream error:", e);
    q.songs.shift();
    if (q.songs.length) playNext(guild, q);
    else q.playing = false;
  }
}

// أوامر أخرى (صامتة)
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
  // صامت: ما نطبع الصف في الشات
}
function handleLeave(message) {
  const conn = getVoiceConnection(message.guild.id);
  if (conn) conn.destroy();
  queues.delete(message.guild.id);
  lockedChannelPerGuild.delete(message.guild.id);
}

// ==== Login ====
client.login(process.env.TOKEN);
