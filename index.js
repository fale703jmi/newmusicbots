import { Client, GatewayIntentBits } from "discord.js";
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

// ✅ ID صاحب البوت (إنت)
const OWNER_ID = "1268018033268621455";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

// ✅ أوامر عربي + إنجليزي بدون بادئة
const commandMap = new Map([
  // تشغيل
  ["play", "play"], ["شغل", "play"], ["شغّل", "play"],
  // تخطي
  ["skip", "skip"], ["تخطي", "skip"],
  // إيقاف كامل
  ["stop", "stop"], ["ايقاف", "stop"], ["إيقاف", "stop"],
  // إيقاف مؤقت
  ["pause", "pause"], ["وقف", "pause"],
  // استئناف
  ["resume", "resume"], ["كمل", "resume"], ["استئناف", "resume"],
  // قائمة
  ["queue", "queue"], ["قائمة", "queue"], ["صف", "queue"],
  // خروج
  ["leave", "leave"], ["اطلع", "leave"], ["اخرج", "leave"],
  // أوامر الأونر
  ["غيرافتار", "setavatar"],
  ["غيراسم", "setname"],
  ["غيرحالة", "setstatus"]
]);

const queues = new Map();

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const parts = message.content.trim().split(/\s+/);
  const rawCmd = (parts.shift() || "").toLowerCase();
  const cmd = commandMap.get(rawCmd);
  if (!cmd) return;

  try {
    // 🎶 أوامر الميوزك
    if (cmd === "play") return handlePlay(message, parts.join(" "));
    if (cmd === "skip") return handleSkip(message);
    if (cmd === "stop") return handleStop(message);
    if (cmd === "pause") return handlePause(message);
    if (cmd === "resume") return handleResume(message);
    if (cmd === "queue") return handleQueue(message);
    if (cmd === "leave") return handleLeave(message);

    // 👑 أوامر الأونر الخاصة
    if (message.author.id !== OWNER_ID) {
      return message.reply("❌ هذا الأمر مخصص لصاحب البوت فقط.");
    }

    if (cmd === "setavatar") {
      const url = parts[0];
      if (!url) return message.reply("حط رابط صورة.");
      try {
        await client.user.setAvatar(url);
        return message.reply("✅ تم تغيير صورة البوت.");
      } catch (e) {
        console.error(e);
        return message.reply("❌ ما قدرت أغير الصورة (جرب رابط صحيح أو انتظر شوية).");
      }
    }

    if (cmd === "setname") {
      const newName = parts.join(" ");
      if (!newName) return message.reply("حط اسم جديد.");
      try {
        await client.user.setUsername(newName);
        return message.reply(`✅ تم تغيير اسم البوت إلى: ${newName}`);
      } catch (e) {
        console.error(e);
        return message.reply("❌ ما قدرت أغير الاسم (فيه حد زمني لتغيير الاسم).");
      }
    }

    if (cmd === "setstatus") {
      const newStatus = parts.join(" ");
      if (!newStatus) return message.reply("حط حالة جديدة.");
      try {
        client.user.setPresence({
          activities: [{ name: newStatus }],
          status: "online"
        });
        return message.reply("✅ تم تحديث الحالة.");
      } catch (e) {
        console.error(e);
        return message.reply("❌ ما قدرت أغير الحالة.");
      }
    }
  } catch (e) {
    console.error(e);
    return message.reply("صار خطأ غير متوقع 🥲");
  }
});

async function handlePlay(message, query) {
  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) return message.reply("ادخل روم صوتي أولًا 👂");
  if (!query) return message.reply("اكتب رابط يوتيوب أو كلمات بحث بعد الأمر.");

  let url = query;
  if (!ytdl.validateURL(query)) {
    const res = await yts(query);
    const vid = res.videos[0];
    if (!vid) return message.reply("ما لقيت نتيجة مناسبة.");
    url = vid.url;
  }

  const guildId = message.guild.id;
  let queue = queues.get(guildId);

  if (!queue) {
    queue = {
      songs: [],
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      textChannel: message.channel,
      voiceChannel: voiceChannel,
      connection: null,
      playing: false
    };
    queues.set(guildId, queue);

    queue.player.on(AudioPlayerStatus.Idle, () => {
      queue.songs.shift();
      if (queue.songs.length) playSong(guildId);
      else queue.playing = false;
    });

    queue.player.on("error", (err) => {
      console.error("Player error:", err);
      queue.textChannel.send("في مشكلة بالصوت.");
      queue.songs.shift();
      if (queue.songs.length) playSong(guildId);
    });
  }

  let info;
  try {
    info = await ytdl.getInfo(url);
  } catch {
    return message.reply("تعذر جلب معلومات الفيديو. جرّب رابط/بحث مختلف.");
  }
  const title = info.videoDetails.title;

  queue.songs.push({ url, title, requestedBy: message.author.username });
  message.channel.send(`🎶 أضفت للصف: **${title}**`);

  if (!queue.connection) {
    queue.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });
    queue.connection.subscribe(queue.player);
  }

  if (!queue.playing) playSong(guildId);
}

function playSong(guildId) {
  const queue = queues.get(guildId);
  if (!queue || !queue.songs.length) return;

  const current = queue.songs[0];
  const stream = ytdl(current.url, {
    filter: "audioonly",
    highWaterMark: 1 << 25,
    quality: "highestaudio"
  });
  const resource = createAudioResource(stream);
  queue.player.play(resource);
  queue.playing = true;
  queue.textChannel.send(`▶️ الآن يشغَّل: **${current.title}** (طلب: ${current.requestedBy})`);
}

function handleSkip(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.playing) return message.reply("ما فيه تشغيل.");
  queue.player.stop(true);
  message.channel.send("⏭️ تخطيت للمقطع اللي بعده.");
}

function handleStop(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply("ما فيه صف.");
  queue.songs = [];
  queue.player.stop(true);
  message.channel.send("⏹️ وقفت التشغيل.");
}

function handlePause(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.playing) return message.reply("ما فيه تشغيل.");
  if (queue.player.pause()) message.channel.send("⏸️ موقف مؤقت.");
}

function handleResume(message) {
  const queue = queues.get(message.guild.id);
  if (!queue) return message.reply("ما فيه صف.");
  if (queue.player.unpause()) message.channel.send("▶️ كملنا التشغيل.");
}

function handleQueue(message) {
  const queue = queues.get(message.guild.id);
  if (!queue || !queue.songs.length) return message.reply("الصف فاضي.");
  const list = queue.songs.map((s, i) => `${i === 0 ? "**(الحالي)**" : `${i}.`} ${s.title}`).join("\n");
  message.channel.send(`📜 الصف:\n${list}`);
}

function handleLeave(message) {
  const guildId = message.guild.id;
  const queue = queues.get(guildId);
  const conn = getVoiceConnection(guildId);
  if (conn) conn.destroy();
  if (queue) queues.delete(guildId);
  message.channel.send("👋 طلعت من الروم.");
}

client.login(process.env.TOKEN);
