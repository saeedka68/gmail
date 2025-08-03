const { Telegraf } = require("telegraf");
const express = require("express");
const fs = require("fs");
const axios = require("axios");
const path = require("path");
const { google } = require("googleapis");

// ربات و شناسه کاربر مجاز
const bot = new Telegraf(process.env.BOT_TOKEN);
const MY_TELEGRAM_ID = parseInt(process.env.MY_TELEGRAM_ID);

// تنظیمات گوگل درایو
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const token = JSON.parse(process.env.GOOGLE_TOKEN);
const auth = new google.auth.OAuth2(
  credentials.installed.client_id,
  credentials.installed.client_secret,
  credentials.installed.redirect_uris[0]
);
auth.setCredentials(token);
const drive = google.drive({ version: "v3", auth });

// محدود کردن به فقط کاربر مجاز
bot.use((ctx, next) => {
  if (ctx.from.id !== MY_TELEGRAM_ID) {
    return ctx.reply("❌ دسترسی غیرمجاز");
  }
  return next();
});

// تابع آپلود
async function handleFile(ctx, fileId, fileName) {
  try {
    await ctx.reply(`⬇️ دریافت فایل ${fileName}...`);

    const fileLink = await ctx.telegram.getFileLink(fileId);
    const res = await axios({
      url: fileLink.href,
      method: "GET",
      responseType: "stream",
    });

    const tempPath = path.join(__dirname, fileName);
    const writer = fs.createWriteStream(tempPath);
    res.data.pipe(writer);

    writer.on("finish", async () => {
      const driveRes = await drive.files.create({
        requestBody: { name: fileName },
        media: { body: fs.createReadStream(tempPath) },
        fields: "id",
      });

      await drive.permissions.create({
        fileId: driveRes.data.id,
        requestBody: {
          type: "anyone",
          role: "reader",
        },
      });

      const link = `https://drive.google.com/file/d/${driveRes.data.id}/view`;
      await ctx.reply(`✅ آپلود شد!\n🔗 ${link}`);

      fs.unlinkSync(tempPath);
    });

    writer.on("error", () => {
      ctx.reply("❌ خطا در ذخیره فایل");
    });
  } catch (err) {
    console.error(err);
    ctx.reply("❌ خطا در آپلود فایل");
  }
}

// پشتیبانی از انواع فایل
bot.on("document", (ctx) => {
  const file = ctx.message.document;
  handleFile(ctx, file.file_id, file.file_name);
});

bot.on("photo", (ctx) => {
  const photo = ctx.message.photo.at(-1);
  const fileName = `photo_${photo.file_unique_id}.jpg`;
  handleFile(ctx, photo.file_id, fileName);
});

bot.on("video", (ctx) => {
  const video = ctx.message.video;
  const fileName = video.file_name || `video_${video.file_unique_id}.mp4`;
  handleFile(ctx, video.file_id, fileName);
});

bot.on("audio", (ctx) => {
  const audio = ctx.message.audio;
  const fileName = audio.file_name || `audio_${audio.file_unique_id}.mp3`;
  handleFile(ctx, audio.file_id, fileName);
});

bot.on("voice", (ctx) => {
  const voice = ctx.message.voice;
  const fileName = `voice_${voice.file_unique_id}.ogg`;
  handleFile(ctx, voice.file_id, fileName);
});

bot.on("video_note", (ctx) => {
  const videoNote = ctx.message.video_note;
  const fileName = `video_note_${videoNote.file_unique_id}.mp4`;
  handleFile(ctx, videoNote.file_id, fileName);
});

// راه‌اندازی Express برای Webhook
const app = express();
app.use(bot.webhookCallback("/webhook"));

// Webhook را ست کن
bot.telegram.setWebhook(`${process.env.RENDER_URL}/webhook`); // رندر URL در env

// روت ساده برای تست
app.get("/", (req, res) => {
  res.send("🤖 Bot is running!");
});

// اجرای سرور
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
