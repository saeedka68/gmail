const express = require("express");
const { Telegraf } = require("telegraf");
const { google } = require("googleapis");

// مقدارها از ENV خوانده میشن
const bot = new Telegraf(process.env.BOT_TOKEN);
const MY_TELEGRAM_ID = parseInt(process.env.MY_TELEGRAM_ID);

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const token = JSON.parse(process.env.GOOGLE_TOKEN);
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);

const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

// محدود کردن ربات فقط برای یک کاربر
bot.use((ctx, next) => {
  if (ctx.from.id !== MY_TELEGRAM_ID) {
    return ctx.reply("⛔️ شما مجاز به استفاده از این ربات نیستید.");
  }
  return next();
});

// دستور /start
bot.start((ctx) => {
  ctx.reply("سلام! برای مشاهده ایمیل‌ها از دستور /inbox استفاده کن.");
});

// دستور /inbox
bot.command("inbox", async (ctx) => {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
    });

    const messages = res.data.messages;
    if (!messages || messages.length === 0) {
      return ctx.reply("📭 هیچ ایمیلی یافت نشد.");
    }

    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find(h => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";

      // برای جلوگیری از خطای تلگرام، متن را به HTML safe تبدیل می‌کنیم (اینجا ساده)
      const safeSubject = subject.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const safeFrom = from.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const safeSnippet = snippet.replace(/</g, "&lt;").replace(/>/g, "&gt;");

      await ctx.reply(`✉️ <b>${safeSubject}</b>\n👤 ${safeFrom}\n📝 ${safeSnippet}`, {
        parse_mode: "HTML"
      });
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
});

const app = express();

const WEBHOOK_PATH = "/secret-path";  // این مسیر رو میتونی تغییر بدی

app.use(bot.webhookCallback(WEBHOOK_PATH));

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  const webhookUrl = process.env.WEBHOOK_URL + WEBHOOK_PATH;

  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook set to ${webhookUrl}`);
  } catch (error) {
    console.error("Failed to set webhook:", error);
  }
});
