const fs = require("fs");
const path = require("path");
const { Telegraf } = require("telegraf");
const { google } = require("googleapis");

// ENV: BOT_TOKEN, MY_TELEGRAM_ID, GOOGLE_CREDENTIALS, GOOGLE_TOKEN
const bot = new Telegraf(process.env.BOT_TOKEN);
const MY_TELEGRAM_ID = parseInt(process.env.MY_TELEGRAM_ID);

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const token = JSON.parse(process.env.GOOGLE_TOKEN);
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);

const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

// فایل برای ذخیره شناسه پیام‌ها
const SENT_MESSAGES_FILE = path.join(__dirname, "sentMessages.json");

let sentMessageIds = new Set();

function loadSentMessages() {
  try {
    if (fs.existsSync(SENT_MESSAGES_FILE)) {
      const data = fs.readFileSync(SENT_MESSAGES_FILE, "utf8");
      const ids = JSON.parse(data);
      sentMessageIds = new Set(ids);
    }
  } catch (err) {
    console.error("Error loading sent messages:", err);
  }
}

function saveSentMessages() {
  try {
    fs.writeFileSync(SENT_MESSAGES_FILE, JSON.stringify(Array.from(sentMessageIds)), "utf8");
  } catch (err) {
    console.error("Error saving sent messages:", err);
  }
}

// Middleware برای اجازه فقط به کاربر خاص
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

      await ctx.reply(`✉️ <b>${subject}</b>\n👤 ${from}\n📝 ${snippet}`, {
        parse_mode: "HTML",
      });
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
});

// تابع ایمن سازی متن برای HTML
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// چک کردن ایمیل هر 1 ثانیه و ارسال ایمیل‌های جدید (غیر تکراری)
async function checkEmails() {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
      q: "is:unread", // فقط ایمیل‌های خوانده نشده
    });

    const messages = res.data.messages || [];
    for (const msg of messages) {
      if (sentMessageIds.has(msg.id)) continue;

      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find(h => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";

      const safeSubject = escapeHtml(subject);
      const safeFrom = escapeHtml(from);
      const safeSnippet = escapeHtml(snippet);

      await bot.telegram.sendMessage(
        MY_TELEGRAM_ID,
        `✉️ <b>${safeSubject}</b>\n👤 ${safeFrom}\n📝 ${safeSnippet}`,
        { parse_mode: "HTML" }
      );

      // علامت زدن پیام به عنوان خوانده شده
      await gmail.users.messages.modify({
        userId: "me",
        id: msg.id,
        resource: {
          removeLabelIds: ["UNREAD"]
        }
      });

      sentMessageIds.add(msg.id);
      saveSentMessages();
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
  }
}

// بارگذاری پیام‌های ارسال شده قدیمی
loadSentMessages();

// چک کردن ایمیل هر 1 ثانیه
setInterval(checkEmails, 1000);

// اجرای ربات
bot.launch();
console.log("📬 Gmail Telegram Bot is running...");
