
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
import yts from "yt-search";

// ====== Env ======
const OWNER_ID    = process.env.OWNER_ID    || "1268018033268621455";
const GUILD_ID    = process.env.GUILD_ID    || "PUT_GUILD_ID";
const FIXED_VC_ID = process.env.FIXED_VC_ID || "PUT_VOICE_CHANNEL_ID";
// ==================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// أوامر عربي + إنجليزي بدون بادئة
const commandMap = new Map([
  ["play","play"], ["شغل","play"], ["شغّل","play"],
  ["skip","skip"], ["تخطي","skip"],
  ["stop","stop"], ["ايقاف","stop"], ["إيقاف","stop"],
  ["pause","pause"], ["وقف","pause"],
  ["resume","resume"], ["كمل","resume"], ["استئناف","resume"],
  ["queue","queue"], ["قائمة","queue"], ["صف","queue"],
  ["leave","leave"], ["اطلع","leave"], ["اخرج","leave"],
  // features
  ["volume","volume"], ["صوت","volume"],
  ["loop","loop"], ["تكرار","loop"],
  ["shuffle","shuffle"], ["عشوائي","shuffle"],
  ["now","nowplaying"], ["الان","nowplaying"], ["الحين","nowplaying"], ["nowplaying","nowplaying"], ["شيلة؟","nowplaying"],
  ["remove","remove"], ["شيل","remove"],
  ["jump","jump"], ["اقفز","jump"],
  ["seek","seek"], ["قدّم","seek"], ["قدم","seek"],
  ["clear","clear"], ["نظف","clear"],
  // Owner
  ["غيرافتار","setavatar"], ["غيراسم","setname"], ["غيرحالة","setstatus"]
]);

const queues = new Map();
// queue model: { songs: [{url,title,duration}], player, textChannel, connection, playing, volume, loop: 'off'|'one'|'all', startTimeSec: 0 }

function ensureFixedConnection() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return console.log("❌ السيرفر غير موجود (GUILD_ID).");
  const channel = guild.channels.cache.get(FIXED_VC_ID);
  if (!channel) return console.log("❌ الروم غير موجود (FIXED_VC_ID).");
  let conn = getVoiceConnection(GUILD_ID);
  if (!conn) {
    conn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
    console.log(`🎧 دخلت الروم الثابت: ${channel.name}`);
  }
  return conn;
}

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  ensureFixedConnection();
  setInterval(() => ensureFixedConnection(), 60_000 * 5);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const parts = message.content.trim().split(/\s+/);
  const rawCmd = (parts.shift() || "").toLowerCase();
  const cmd = commandMap.get(rawCmd);
  if (!cmd) return;

  try {
    const musicCommands = new Set(["play","skip","stop","pause","resume","queue","leave","volume","loop","shuffle","nowplaying","remove","jump","seek","clear"]);
    if (musicCommands.has(cmd)) {
      const memberVcId = message.member?.voice?.channelId;
      if (memberVcId !== FIXED_VC_ID) {
        return message.reply("🔒 الأوامر تشتغل فقط في الروم المخصص للبوت. تعال عندي هناك 🎧");
      }
    }

    switch (cmd) {
      case "play": return handlePlay(message, parts.join(" "));
      case "skip": return handleSkip(message);
      case "stop": return handleStop(message);
      case "pause": return handlePause(message);
      case "resume": return handleResume(message);
      case "queue": return handleQueue(message);
      case "leave": return handleLeave(message);
      case "volume": return handleVolume(message, parts[0]);
      case "loop": return handleLoop(message, parts[0]);
      case "shuffle": return handleShuffle(message);
      case "nowplaying": return handleNowPlaying(message);
      case "remove": return handleRemove(message, parts[0]);
      case "jump": return handleJump(message, parts[0]);
      case "seek": return handleSeek(message, parts[0]);
      case "clear": return handleClear(message);
    }

    // Owner only
    if (message.author.id !== OWNER_ID) return message.reply("❌ هذا الأمر مخصص لصاحب البوت فقط.");
    if (cmd === "setavatar") {
      const url = parts[0]; if (!url) return message.reply("حط رابط صورة.");
      try { await client.user.setAvatar(url); return message.reply("✅ تم تغيير صورة البوت."); } catch { return message.reply("❌ فشل تغيير الصورة."); }
    }
    if (cmd === "setname") {
      const name = parts.join(" "); if (!name) return message.reply("حط اسم جديد.");
      try { await client.user.setUsername(name); return message.reply(`✅ الاسم صار: ${name}`); } catch { return message.reply("❌ فشل تغيير الاسم."); }
    }
    if (cmd === "setstatus") {
      const text = parts.join(" "); if (!text) return message.reply("حط حالة جديدة.");
      client.user.setPresence({ activities: [{ name: text }], status: "online" });
      return message.reply("✅ تم تحديث الحالة.");
    }
  } catch (e) {
    console.error(e);
    return message.reply("صار خطأ غير متوقع 🥲");
  }
});

// ——— Helpers ———
function getOrCreateQueue(channel) {
  let q = queues.get(GUILD_ID);
  if (!q) {
    q = {
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      textChannel: channel,
      connection: getVoiceConnection(GUILD_ID) || ensureFixedConnection(),
      playing: false,
      volume: 1.0,
      loop: "off",
      startTimeSec: 0
    };
    queues.set(GUILD_ID, q);

    q.player.on(AudioPlayerStatus.Idle, () => {
      if (q.loop === "one") {
        // لا تزيل الأغنية، فقط أعد تشغيلها
      } else if (q.loop === "all" && q.songs.length > 0) {
        q.songs.push(q.songs.shift());
      } else {
        q.songs.shift();
      }
      if (q.songs.length) playNext(q);
      else q.playing = false;
    });

    q.player.on("error", (err) => {
      console.error("Player error:", err);
      q.textChannel?.send("في مشكلة بالصوت، بتخطى.");
      q.songs.shift();
      if (q.songs.length) playNext(q);
    });

    q.connection?.subscribe(q.player);
  }
  return q;
}

function parseTimeToSeconds(input) {
  if (!input) return 0;
  if (/^\d+$/.test(input)) return parseInt(input, 10);
  const m = input.split(":").map(n => parseInt(n,10));
  if (m.length === 2) return m[0]*60 + m[1];
  if (m.length === 3) return m[0]*3600 + m[1]*60 + m[2];
  return 0;
}

// ——— Music Actions ———
async function handlePlay(message, query) {
  if (!query) return message.reply("اكتب رابط أو كلمات بحث بعد الأمر.");
  ensureFixedConnection();

  // تنظيف روابط يوتيوب من ?si والمعلمات
  if (query.includes("youtube.com") || query.includes("youtu.be")) {
    query = query.split("&")[0];
    if (query.includes("?si")) query = query.split("?si")[0];
  }

  const q = getOrCreateQueue(message.channel);

  // ابحث/جهز الرابط
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

  if (!trackUrl) return message.reply("ما قدرت أجد مصدر صالح للتشغيل.");

  q.songs.push({ url: trackUrl, title });
  message.channel.send(`🎶 أضفت للصف: **${title}**`);
  if (!q.playing) playNext(q);
}

async function playNext(q, seekSec = 0) {
  const current = q.songs[0];
  if (!current) return;
  try {
    const stream = await play.stream(current.url, seekSec ? { seek: seekSec } : undefined);
    const resource = createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
    resource.volume?.setVolume(q.volume);
    q.player.play(resource);
    q.playing = true;
    q.startTimeSec = seekSec;
    q.textChannel?.send(`▶️ الآن يشغَّل: **${current.title || current.url}**`);
  } catch (e) {
    console.error("Stream error:", e);
    q.textChannel?.send("تعذر تشغيل المقطع، بتخطى.");
    q.songs.shift();
    if (q.songs.length) playNext(q);
    else q.playing = false;
  }
}

function handleSkip(message) {
  const q = queues.get(GUILD_ID);
  if (!q || !q.playing) return message.reply("ما فيه تشغيل.");
  q.player.stop(true);
  message.channel.send("⏭️ تخطيت للمقطع اللي بعده.");
}
function handleStop(message) {
  const q = queues.get(GUILD_ID);
  if (!q) return message.reply("ما فيه صف.");
  q.songs = [];
  q.player.stop(true);
  message.channel.send("⏹️ وقفت التشغيل.");
}
function handlePause(message) {
  const q = queues.get(GUILD_ID);
  if (!q || !q.playing) return message.reply("ما فيه تشغيل.");
  if (q.player.pause()) message.channel.send("⏸️ موقف مؤقت.");
}
function handleResume(message) {
  const q = queues.get(GUILD_ID);
  if (!q) return message.reply("ما فيه صف.");
  if (q.player.unpause()) message.channel.send("▶️ كملنا التشغيل.");
}
function handleQueue(message) {
  const q = queues.get(GUILD_ID);
  if (!q || !q.songs.length) return message.reply("الصف فاضي.");
  const list = q.songs.map((s, i) => `${i===0?"**(الحالي)**":`${i}.`} ${s.title || s.url}`).slice(0,10).join("\n");
  message.channel.send(`📜 الصف:\n${list}`);
}
function handleLeave(message) {
  const conn = getVoiceConnection(GUILD_ID);
  if (conn) conn.destroy();
  queues.delete(GUILD_ID);
  message.channel.send("👋 طلعت من الروم (وسأعود تلقائيًا لأنه 24/7).");
  setTimeout(() => ensureFixedConnection(), 5000);
}
function handleVolume(message, value) {
  const q = queues.get(GUILD_ID);
  if (!q) return message.reply("ما فيه صف.");
  let v = parseInt(value,10);
  if (isNaN(v)) return message.reply("اكتب قيمة بين 0 و 200.");
  v = Math.max(0, Math.min(200, v));
  q.volume = v / 100;
  if (q.player.state?.resource?.volume) q.player.state.resource.volume.setVolume(q.volume);
  message.reply(`🔊 الصوت: ${v}%`);
}
function handleLoop(message, modeRaw) {
  const q = queues.get(GUILD_ID);
  if (!q) return message.reply("ما فيه صف.");
  const m = (modeRaw||"off").toLowerCase();
  if (!["off","one","all","اطف","واحد","الكل"].includes(m) && !["ايقاف","إيقاف"].includes(m)) {
    return message.reply("اختر: off / one / all");
  }
  const map = { "off":"off", "one":"one", "all":"all", "اطف":"off", "ايقاف":"off", "إيقاف":"off", "واحد":"one", "الكل":"all" };
  q.loop = map[m] || "off";
  message.reply(`🔁 وضع التكرار: ${q.loop}`);
}
function handleShuffle(message) {
  const q = queues.get(GUILD_ID);
  if (!q || q.songs.length < 2) return message.reply("الصف قصير.");
  const first = q.songs.shift();
  for (let i = q.songs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q.songs[i], q.songs[j]] = [q.songs[j], q.songs[i]];
  }
  q.songs.unshift(first);
  message.reply("🔀 خلطت الصف.");
}
function handleNowPlaying(message) {
  const q = queues.get(GUILD_ID);
  if (!q || !q.songs.length) return message.reply("ما فيه تشغيل.");
  const current = q.songs[0];
  message.reply(`🎧 الآن: **${current.title || current.url}** | Loop: ${q.loop} | Volume: ${Math.round(q.volume*100)}%`);
}
function handleRemove(message, numRaw) {
  const q = queues.get(GUILD_ID);
  if (!q || q.songs.length < 2) return message.reply("ما فيه عناصر لإزالتها (عدا الحالي).");
  const n = parseInt(numRaw,10);
  if (isNaN(n) || n < 1 || n >= q.songs.length) return message.reply("اكتب رقم عنصر صحيح من القائمة (غير العنصر 0).");
  const removed = q.songs.splice(n,1)[0];
  message.reply(`🗑️ حذفت: ${removed.title || removed.url}`);
}
function handleJump(message, numRaw) {
  const q = queues.get(GUILD_ID);
  if (!q || q.songs.length < 2) return message.reply("الصف قصير.");
  const n = parseInt(numRaw,10);
  if (isNaN(n) || n < 1 || n >= q.songs.length) return message.reply("اكتب رقم صحيح في الصف.");
  const target = q.songs.splice(n,1)[0];
  q.songs.unshift(target);
  q.player.stop(true);
  message.reply(`⏩ قفزت إلى: ${target.title || target.url}`);
}
function handleSeek(message, timeRaw) {
  const q = queues.get(GUILD_ID);
  if (!q || !q.songs.length) return message.reply("ما فيه تشغيل.");
  const sec = parseTimeToSeconds(timeRaw);
  if (!sec || sec < 0) return message.reply("اكتب وقت بصيغة ثواني أو mm:ss");
  playNext(q, sec);
  message.reply(`⏱️ تقدّمت إلى ${timeRaw}`);
}
function handleClear(message) {
  const q = queues.get(GUILD_ID);
  if (!q) return message.reply("ما فيه صف.");
  const keep = q.songs[0] ? [q.songs[0]] : [];
  q.songs = keep;
  message.reply("🧹 نظفت الصف وأبقيت المقطع الحالي فقط.");
}

client.login(process.env.TOKEN);
