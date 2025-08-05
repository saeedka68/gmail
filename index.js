const fs = require("fs");
const path = require("path");
const http = require("http");
const { Telegraf, Markup } = require("telegraf");
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

// فقط اجازه دسترسی به شما
bot.use((ctx, next) => {
  if (ctx.from.id !== MY_TELEGRAM_ID) {
    return ctx.reply("⛔️ شما مجاز به استفاده از این ربات نیستید.");
  }
  return next();
});

// تابع escape برای امنیت HTML
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ✅ اجرای checkEmails فقط زمانی که /start زده شود
bot.start(async (ctx) => {
  await ctx.reply("سلام! آخرین ایمیل‌های خوانده‌نشده برایت فرستاده می‌شوند...");
  await checkEmails(ctx);
});

// ارسال ایمیل‌های جدید فقط در پاسخ به /start
async function checkEmails(ctx) {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
      return ctx.reply("📭 هیچ ایمیل خوانده‌نشده‌ای وجود ندارد.");
    }

    for (const msg of messages) {
      if (sentMessageIds.has(msg.id)) continue;

      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find(h => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";

      await ctx.reply(
        `✉️ <b>${escapeHtml(subject)}</b>\n👤 ${escapeHtml(from)}\n📝 ${escapeHtml(snippet)}`,
        { parse_mode: "HTML" }
      );

      sentMessageIds.add(msg.id);
      saveSentMessages();
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
}

// نمایش ایمیل‌های اخیر
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

      await ctx.reply(`✉️ <b>${escapeHtml(subject)}</b>\n👤 ${escapeHtml(from)}\n📝 ${escapeHtml(snippet)}`, {
        parse_mode: "HTML",
      });
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
});

// نمایش ایمیل‌های خوانده‌نشده همراه با دکمه
bot.command("unread", async (ctx) => {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) return ctx.reply("📭 هیچ ایمیل خوانده‌نشده‌ای وجود ندارد.");

    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find(h => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find(h => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";

      await ctx.reply(
        `✉️ <b>${escapeHtml(subject)}</b>\n👤 ${escapeHtml(from)}\n📝 ${escapeHtml(snippet)}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            Markup.button.callback("✅ علامت‌گذاری به‌عنوان خوانده‌شده", `markread_${msg.id}`)
          ])
        }
      );
    }
  } catch (err) {
    console.error("❌ Gmail unread error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌های خوانده‌نشده.");
  }
});

// دکمه برای علامت‌گذاری ایمیل به عنوان خوانده‌شده
bot.action(/^markread_(.+)$/, async (ctx) => {
  const msgId = ctx.match[1];

  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: msgId,
      resource: {
        removeLabelIds: ["UNREAD"]
      }
    });

    sentMessageIds.add(msgId);
    saveSentMessages();

    await ctx.editMessageReplyMarkup(); // حذف دکمه
    await ctx.reply("✅ ایمیل با موفقیت به‌عنوان خوانده‌شده علامت خورد.");
  } catch (err) {
    console.error("❌ mark as read error:", err);
    await ctx.reply("❗️ خطا در علامت‌گذاری ایمیل.");
  }
});

// بارگذاری پیام‌های قبلی
loadSentMessages();

// ❌ حذف ارسال خودکار:
// setInterval(checkEmails, 60000);

// 🚀 اجرای ربات
bot.launch();
console.log("📬 Gmail Telegram Bot is running...");

// 🌐 Keep-alive server for Render
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running\n");
}).listen(port);
console.log(`🌐 Keep-alive server is running on port ${port}`);
