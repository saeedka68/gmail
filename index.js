const express = require("express");
const { Telegraf } = require("telegraf");
const { google } = require("googleapis");

// ENV: BOT_TOKEN, MY_TELEGRAM_ID, GOOGLE_CREDENTIALS, GOOGLE_TOKEN, WEBHOOK_URL
const bot = new Telegraf(process.env.BOT_TOKEN);
const MY_TELEGRAM_ID = parseInt(process.env.MY_TELEGRAM_ID);

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const token = JSON.parse(process.env.GOOGLE_TOKEN);
const { client_secret, client_id, redirect_uris } = credentials.installed;

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

// تابع فرار دادن (escape) کاراکترهای خاص HTML
function escapeHTML(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// مجوز فقط برای کاربر خاص
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

      await ctx.reply(`✉️ <b>${escapeHTML(subject)}</b>\n👤 ${escapeHTML(from)}\n📝 ${escapeHTML(snippet)}`, {
        parse_mode: "HTML",
      });
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
});

// تنظیم Express برای webhook
const app = express();
app.use(express.json());

// Webhook مسیر برای تلگرام
app.post(`/secret-path`, async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  // ست کردن webhook به تلگرام
  const webhookUrl = process.env.WEBHOOK_URL; // باید مثل https://yourdomain.com/secret-path باشه
  if (!webhookUrl) {
    console.error("❌ WEBHOOK_URL is not set in environment variables.");
    process.exit(1);
  }

  try {
    await bot.telegram.setWebhook(`${webhookUrl}/secret-path`);
    console.log("Webhook set successfully.");
  } catch (err) {
    console.error("Failed to set webhook:", err);
  }
});

// تابع بررسی ایمیل‌ها (مثلاً هر 10 ثانیه)
async function checkEmails() {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
    });

    const messages = res.data.messages;
    if (!messages || messages.length === 0) {
      return;
    }

    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find(h => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";

      await bot.telegram.sendMessage(
        MY_TELEGRAM_ID,
        `✉️ <b>${escapeHTML(subject)}</b>\n👤 ${escapeHTML(from)}\n📝 ${escapeHTML(snippet)}`,
        { parse_mode: "HTML" }
      );
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
  }
}

// چک کردن ایمیل هر 10 ثانیه (مثلا)
setInterval(checkEmails, 10000);
