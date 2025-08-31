
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

// ====== إعدادات أمان بسيطة ======
const OWNER_ID = process.env.OWNER_ID || "1268018033268621455"; // غيّرها إذا لزم
// =================================

// خريطة: لكل سيرفر، الروم اللي "مقفل" عليه هذا البوت
// key = guildId, value = voiceChannelId
const lockedChannelPerGuild = new Map();

// خريطة أوامر عربي/إنجليزي بدون بريفكس
const commandMap = new Map([
  // انضمام بالروم عبر منشن
  ["join", "join"], ["تعال", "join"],

  // موسيقى
  ["play","play"], ["شغل","play"], ["شغّل","play"],
  ["skip","skip"], ["تخطي","skip"],
  ["stop","stop"], ["ايقاف","stop"], ["إيقاف","stop"],
  ["pause","pause"], ["وقف","pause"],
  ["resume","resume"], ["كمل","resume"], ["استئناف","resume"],
  ["queue","queue"], ["قائمة","queue"], ["صف","queue"],
  ["leave","leave"], ["اطلع","leave"], ["اخرج","leave"],

  // مالك البوت
  ["غيرافتار","setavatar"], ["غيراسم","setname"], ["غيرحالة","setstatus"]
]);

// صف التشغيل لكل سيرفر
const queues = new Map();
// model: queues.set(guildId, { songs: [{url,title}], player, textChannel, connection, playing, volume:1.0, loop:'off' })

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
  if (message.author.bot || !message.guild) return;

  const parts = message.content.trim().split(/\s+/);
  const rawCmd = (parts.shift() || "").toLowerCase();
  const cmd = commandMap.get(rawCmd);
  if (!cmd) return;

  try {
    // —— أمر الانضمام: لازم منشن للبوت عشان ما يجي كل البوتات ——
    if (cmd === "join") {
      // شيّك المنشن
      const mentioned = message.mentions.users.first();
      if (!mentioned) return message.reply("اذكر البوت بالمنشن: `تعال @اسم_البوت`");
      if (mentioned.id !== client.user.id) return; // مو أنا → أتجاهل

      const userVc = message.member?.voice?.channel;
      if (!userVc) return message.reply("ادخل روم صوتي أولًا.");

      // ادخل الروم وثبّت القناة لهذا السيرفر
      joinVoiceChannel({
        channelId: userVc.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });
      lockedChannelPerGuild.set(message.guild.id, userVc.id);
      return message.reply(`✅ دخلت الروم: **${userVc.name}** وبجلس فيه لين تقول \`اطلع\`.`);
    }

    // —— أوامر الموسيقى والأوامر الخاصة —— //
    const ownerOnly = new Set(["setavatar","setname","setstatus"]);
    const musicCommands = new Set(["play","skip","stop","pause","resume","queue","leave"]);

    // لو أمر موسيقى: لازم الكاتب والبوت في نفس الروم المقفول
    if (musicCommands.has(cmd)) {
      const lockedId = lockedChannelPerGuild.get(message.guild.id);
      if (!lockedId) {
        return message.reply("ما عندي روم مثبت. قل: `تعال @اسم_البوت` وأنا أجيك وأثبت الروم.");
      }
      const userVcId = message.member?.voice?.channelId;
      if (userVcId !== lockedId) {
        return message.reply("الأوامر تشتغل فقط في الروم اللي أنا مثبت فيه. تعال عندي هناك 🎧");
      }
    }

    // نفذ الأوامر
    switch (cmd) {
      case "play":   return handlePlay(message, parts.join(" "));
      case "skip":   return handleSkip(message);
      case "stop":   return handleStop(message);
      case "pause":  return handlePause(message);
      case "resume": return handleResume(message);
      case "queue":  return handleQueue(message);
      case "leave":  return handleLeave(message);

      case "setavatar":
      case "setname":
      case "setstatus": {
        if (message.author.id !== OWNER_ID) return message.reply("❌ هذا الأمر لصاحب البوت فقط.");
        if (cmd === "setavatar") {
          const url = parts[0];
          if (!url) return message.reply("حط رابط صورة.");
          try { await client.user.setAvatar(url); return message.reply("✅ تم تغيير صورة البوت."); }
          catch { return message.reply("❌ فشل تغيير الصورة."); }
        }
        if (cmd === "setname") {
          const newName = parts.join(" ");
          if (!newName) return message.reply("حط اسم جديد.");
          try { await client.user.setUsername(newName); return message.reply(`✅ الاسم صار: ${newName}`); }
          catch { return message.reply("❌ فشل تغيير الاسم (قد يكون فيه حد زمني)."); }
        }
        if (cmd === "setstatus") {
          const text = parts.join(" ");
          if (!text) return message.reply("حط حالة جديدة.");
          client.user.setPresence({ activities: [{ name: text }], status: "online" });
          return message.reply("✅ تم تحديث الحالة.");
        }
      }
    }
  } catch (e) {
    console.error(e);
    return message.reply("صار خطأ غير متوقع 🥲");
  }
});

// —————— وظائف الموسيقى ——————
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
      // تكرار
      if (q.loop === "one") {
        // لا نحذف الحالي
      } else if (q.loop === "all" && q.songs.length > 0) {
        q.songs.push(q.songs.shift());
      } else {
        q.songs.shift();
      }
      if (q.songs.length) playNext(guild, q);
      else q.playing = false;
    });

    q.player.on("error", (err) => {
      console.error("Player error:", err);
      q.textChannel?.send("في مشكلة بالصوت، بتخطى.");
      q.songs.shift();
      if (q.songs.length) playNext(guild, q);
    });

    // اشترك لو فيه اتصال
    const conn = getVoiceConnection(guild.id);
    if (conn) conn.subscribe(q.player);
  }
  return q;
}

async function handlePlay(message, query) {
  if (!query) return message.reply("اكتب رابط أو كلمات بحث بعد الأمر.");

  // لازم أكون داخل الروم المقفول
  const lockedId = lockedChannelPerGuild.get(message.guild.id);
  let conn = getVoiceConnection(message.guild.id);
  if (!conn) {
    // ادخل الروم المثبّت (لو مو متصل)
    joinVoiceChannel({
      channelId: lockedId,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });
    conn = getVoiceConnection(message.guild.id);
  }

  // نظّف روابط يوتيوب من ?si والمعلمات
  if (query.includes("youtube.com") || query.includes("youtu.be")) {
    query = query.split("&")[0];
    if (query.includes("?si")) query = query.split("?si")[0];
  }

  const q = getOrCreateQueue(message.guild, message.channel);

  // حدّد المصدر: رابط/بحث
  let trackUrl = null;
  let title = query;
  try {
    if (/^https?:\/\//i.test(query)) {
      const kind = play.validate(query);
      if (kind === "sp_track") {
        // سبوتيفاي → نجيب أقرب نتيجة من يوتيوب
        const sp = await play.spotify(query);
        title = `${sp.name} ${sp.artists?.[0]?.name || ""}`;
        const s = await play.search(title, { limit: 1, source: { youtube: "video" } });
        if (s?.length) { trackUrl = s[0].url; title = s[0].title || title; }
      } else {
        // يوتيوب/ساوندكلاود/رابط مباشر
        trackUrl = query;
      }
    } else {
      // بحث بالاسم
      const s = await play.search(query, { limit: 1, source: { youtube: "video" } });
      if (s?.length) { trackUrl = s[0].url; title = s[0].title || query; }
    }
  } catch {}

  if (!trackUrl) return message.reply("ما قدرت أجد مصدر صالح للتشغيل.");

  q.songs.push({ url: trackUrl, title });
  message.channel.send(`🎶 أضفت للصف: **${title}**`);
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

    // تأكد من الاشتراك
    const conn = getVoiceConnection(guild.id);
    if (conn) conn.subscribe(q.player);

    q.textChannel?.send(`▶️ الآن يشغَّل: **${current.title || current.url}**`);
  } catch (e) {
    console.error("Stream error:", e);
    q.textChannel?.send("تعذر تشغيل المقطع، بتخطى.");
    q.songs.shift();
    if (q.songs.length) playNext(guild, q);
    else q.playing = false;
  }
}

function handleSkip(message) {
  const q = queues.get(message.guild.id);
  if (!q || !q.playing) return message.reply("ما فيه تشغيل.");
  q.player.stop(true);
  message.channel.send("⏭️ تخطيت للمقطع اللي بعده.");
}

function handleStop(message) {
  const q = queues.get(message.guild.id);
  if (!q) return message.reply("ما فيه صف.");
  q.songs = [];
  q.player.stop(true);
  message.channel.send("⏹️ وقفت التشغيل.");
}

function handlePause(message) {
  const q = queues.get(message.guild.id);
  if (!q || !q.playing) return message.reply("ما فيه تشغيل.");
  if (q.player.pause()) message.channel.send("⏸️ موقف مؤقت.");
}

function handleResume(message) {
  const q = queues.get(message.guild.id);
  if (!q) return message.reply("ما فيه صف.");
  if (q.player.unpause()) message.channel.send("▶️ كملنا التشغيل.");
}

function handleQueue(message) {
  const q = queues.get(message.guild.id);
  if (!q || !q.songs.length) return message.reply("الصف فاضي.");
  const list = q.songs.map((s, i) => `${i===0?"**(الحالي)**":`${i}.`} ${s.title || s.url}`).slice(0,10).join("\n");
  message.channel.send(`📜 الصف:\n${list}`);
}

function handleLeave(message) {
  const conn = getVoiceConnection(message.guild.id);
  if (conn) conn.destroy();
  queues.delete(message.guild.id);
  lockedChannelPerGuild.delete(message.guild.id);
  message.channel.send("👋 طلعت من الروم. إذا تبيني أرجع قل: `تعال @اسم_البوت`");
}

client.login(process.env.TOKEN);
