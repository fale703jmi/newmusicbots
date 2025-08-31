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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

const prefix = "!";
const queues = new Map();

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(prefix)) return;
  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const cmd = args.shift()?.toLowerCase();

  try {
    if (cmd === "play") return handlePlay(message, args.join(" "));
    if (cmd === "skip") return handleSkip(message);
    if (cmd === "stop") return handleStop(message);
    if (cmd === "pause") return handlePause(message);
    if (cmd === "resume") return handleResume(message);
    if (cmd === "queue") return handleQueue(message);
    if (cmd === "leave") return handleLeave(message);
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
      if (queue.songs.length) {
        playSong(guildId);
      } else {
        queue.playing = false;
      }
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
  } catch (e) {
    return message.reply("تعذر جلب الفيديو.");
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
  const stream = ytdl(current.url, { filter: "audioonly", highWaterMark: 1 << 25, quality: "highestaudio" });
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
