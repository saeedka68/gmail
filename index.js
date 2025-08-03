const express = require("express");
const { Telegraf } = require("telegraf");
const { google } = require("googleapis");

// متغیرهای محیطی
const bot = new Telegraf(process.env.BOT_TOKEN);
const MY_TELEGRAM_ID = parseInt(process.env.MY_TELEGRAM_ID);

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const token = JSON.parse(process.env.GOOGLE_TOKEN);
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);

const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

// مجوز فقط برای کاربر خاص
bot.use((ctx, next) => {
  if (ctx.from.id !== MY_TELEGRAM_ID) {
    return ctx.reply("⛔️ شما مجاز به استفاده از این ربات نیستید.");
  }
  return next();
});

bot.start((ctx) => {
  ctx.reply("سلام! برای مشاهده ایمیل‌ها از دستور /inbox استفاده کن.");
});

bot.command("inbox", async (ctx) => {
  try {
    const res = await gmail.users.messages.list({ userId: "me", maxResults: 5 });
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

      await ctx.reply(`✉️ <b>${subject}</b>\n👤 ${from}\n📝 ${snippet}`, {
        parse_mode: "HTML"
      });
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
});

// تابع polling برای چک کردن ایمیل هر 10 ثانیه
async function checkEmails() {
  try {
    const res = await gmail.users.messages.list({ userId: "me", maxResults: 5 });
    const messages = res.data.messages;
    if (!messages || messages.length === 0) {
      console.log("📭 هیچ ایمیلی یافت نشد.");
      return;
    }

    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find(h => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";

      // ارسال پیام به تلگرام
      await bot.telegram.sendMessage(
        MY_TELEGRAM_ID,
        `✉️ <b>${subject}</b>\n👤 ${from}\n📝 ${snippet}`,
        { parse_mode: "HTML" }
      );
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
  }
}

// هر 10 ثانیه اجرا میشه
setInterval(checkEmails, 10000);

// راه‌اندازی express و webhook تلگرام
const app = express();
app.use(express.json());

app.post(`/bot${process.env.BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res).catch(console.error);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  const url = process.env.WEBHOOK_URL; // مثلاً https://yourdomain.com/bot<TOKEN>
  if (!url) {
    console.error("WEBHOOK_URL در env تعریف نشده!");
    process.exit(1);
  }

  try {
    await bot.telegram.setWebhook(`${url}/bot${process.env.BOT_TOKEN}`);
    console.log("Webhook set successfully");
  } catch (error) {
    console.error("Failed to set webhook:", error);
  }
});
