const fs = require("fs");
const path = require("path");
const http = require("http");
const stream = require("stream");
const { Telegraf, Markup } = require("telegraf");
const { google } = require("googleapis");
const jalaali = require("jalaali-js");

const bot = new Telegraf(process.env.BOT_TOKEN);
const MY_TELEGRAM_ID = parseInt(process.env.MY_TELEGRAM_ID);
const DRIVE_FILE_ID = process.env.DRIVE_FILE_ID;

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const token = JSON.parse(process.env.GOOGLE_TOKEN);
const { client_secret, client_id, redirect_uris } = credentials.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);
oAuth2Client.setCredentials(token);

const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
const drive = google.drive({ version: "v3", auth: oAuth2Client });

let sentMessageIds = new Set();

// بارگذاری پیام‌های ارسال‌شده از فایل Google Drive
async function loadSentMessagesFromDrive() {
  try {
    const res = await drive.files.get(
      { fileId: DRIVE_FILE_ID, alt: "media" },
      { responseType: "stream" }
    );

    let data = "";
    return new Promise((resolve, reject) => {
      res.data
        .on("data", (chunk) => (data += chunk))
        .on("end", () => {
          try {
            const ids = JSON.parse(data);
            resolve(new Set(ids));
          } catch (err) {
            console.error("❌ خطا در تبدیل داده‌ها:", err);
            resolve(new Set());
          }
        })
        .on("error", (err) => {
          console.error("❌ خطا در خواندن فایل:", err);
          reject(new Set());
        });
    });
  } catch (err) {
    console.error("❌ خطا در بارگذاری فایل از Google Drive:", err);
    return new Set();
  }
}

// ذخیره پیام‌های ارسال‌شده در Google Drive با استفاده از update
async function saveSentMessagesToDrive(sentSet) {
  const bufferStream = new stream.PassThrough();
  bufferStream.end(Buffer.from(JSON.stringify(Array.from(sentSet))));

  try {
    await drive.files.update({
      fileId: DRIVE_FILE_ID,
      media: {
        mimeType: "application/json",
        body: bufferStream,
      },
    });
  } catch (err) {
    console.error("❌ خطا در به‌روزرسانی فایل در Drive:", err);
  }
}

async function loadSentMessages() {
  sentMessageIds = await loadSentMessagesFromDrive();
}

function saveSentMessages() {
  saveSentMessagesToDrive(sentMessageIds);
}

// بررسی مجاز بودن کاربر
bot.use((ctx, next) => {
  if (ctx.from.id !== MY_TELEGRAM_ID) {
    return ctx.reply("⛔️ شما مجاز به استفاده از این ربات نیستید.");
  }
  return next();
});

// جلوگیری از HTML Injection
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// اجرای اولیه با دستور /start
bot.start(async (ctx) => {
  await ctx.reply("سلام! آخرین ایمیل‌های خوانده‌نشده برایت فرستاده می‌شوند...");
  await checkEmails(ctx);
});

bot.command("help", (ctx) => {
  ctx.reply(`📌 دستورات قابل استفاده:
  /start - بررسی ایمیل‌های خوانده‌نشده
  /inbox - نمایش آخرین ایمیل‌ها
  /unread - نمایش ایمیل‌های خوانده‌نشده با دکمه خواندن`);
});

// توابع استخراج تاریخ میلادی و شمسی
function getFormattedDates(dateStr) {
  if (!dateStr) return { formattedDateGregorian: "تاریخ نامشخص", formattedDateJalali: "تاریخ نامشخص" };

  const date = new Date(dateStr);
  if (isNaN(date)) return { formattedDateGregorian: "تاریخ نامشخص", formattedDateJalali: "تاریخ نامشخص" };

  const formattedDateGregorian = date.toLocaleString("en-US", { timeZone: "Asia/Tehran" });
  const jDate = jalaali.toJalaali(date);
  const formattedDateJalali = `${jDate.jy}/${jDate.jm.toString().padStart(2, "0")}/${jDate.jd.toString().padStart(2, "0")}`;

  return { formattedDateGregorian, formattedDateJalali };
}

// بررسی ایمیل‌های خوانده‌نشده
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
      const subject = headers.find((h) => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find((h) => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";
      const dateStr = headers.find((h) => h.name === "Date")?.value || "";

      const { formattedDateGregorian, formattedDateJalali } = getFormattedDates(dateStr);

      await ctx.reply(
        `✉️ <b>${escapeHtml(subject)}</b>\n👤 ${escapeHtml(from)}\n🕒 تاریخ میلادی: ${formattedDateGregorian}\n🕒 تاریخ شمسی: ${formattedDateJalali}\n📝 ${escapeHtml(snippet)}`,
        { parse_mode: "HTML" }
      );

      sentMessageIds.add(msg.id);
      saveSentMessages();
    }
  } catch (err) {
    console.error("❌ خطا در دریافت ایمیل‌ها:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
}

bot.command("inbox", async (ctx) => {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) return ctx.reply("📭 هیچ ایمیلی یافت نشد.");

    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find((h) => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find((h) => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";
      const dateStr = headers.find((h) => h.name === "Date")?.value || "";

      const { formattedDateGregorian, formattedDateJalali } = getFormattedDates(dateStr);

      await ctx.reply(
        `✉️ <b>${escapeHtml(subject)}</b>\n👤 ${escapeHtml(from)}\n🕒 تاریخ میلادی: ${formattedDateGregorian}\n🕒 تاریخ شمسی: ${formattedDateJalali}\n📝 ${escapeHtml(snippet)}`,
        { parse_mode: "HTML" }
      );
    }
  } catch (err) {
    console.error("❌ خطا در inbox:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
});

bot.command("unread", async (ctx) => {
  try {
    const res = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
      q: "is:unread",
    });

    const messages = res.data.messages || [];
    if (messages.length === 0)
      return ctx.reply("📭 هیچ ایمیل خوانده‌نشده‌ای وجود ندارد.");

    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: "me", id: msg.id });
      const headers = full.data.payload.headers;
      const subject = headers.find((h) => h.name === "Subject")?.value || "بدون موضوع";
      const from = headers.find((h) => h.name === "From")?.value || "نامعلوم";
      const snippet = full.data.snippet || "";
      const dateStr = headers.find((h) => h.name === "Date")?.value || "";

      const { formattedDateGregorian, formattedDateJalali } = getFormattedDates(dateStr);

      await ctx.reply(
        `✉️ <b>${escapeHtml(subject)}</b>\n👤 ${escapeHtml(from)}\n🕒 تاریخ میلادی: ${formattedDateGregorian}\n🕒 تاریخ شمسی: ${formattedDateJalali}\n📝 ${escapeHtml(snippet)}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            Markup.button.callback(
              "✅ علامت‌گذاری به‌عنوان خوانده‌شده",
              `markread_${msg.id}`
            ),
          ]),
        }
      );
    }
  } catch (err) {
    console.error("❌ خطا در unread:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌های خوانده‌نشده.");
  }
});

bot.action(/^markread_(.+)$/, async (ctx) => {
  const msgId = ctx.match[1];

  try {
    await gmail.users.messages.modify({
      userId: "me",
      id: msgId,
      resource: {
        removeLabelIds: ["UNREAD"],
      },
    });

    sentMessageIds.add(msgId);
    saveSentMessages();

    await ctx.editMessageReplyMarkup();
    await ctx.reply("✅ ایمیل با موفقیت به‌عنوان خوانده‌شده علامت خورد.");
  } catch (err) {
    console.error("❌ خطا در mark as read:", err);
    ctx.reply("❗️ خطا در علامت‌گذاری ایمیل.");
  }
});

// راه‌اندازی بات
(async () => {
  await loadSentMessages();
  bot
    .launch()
    .then(() => {
      console.log("📬 Gmail Telegram Bot is running...");
    })
    .catch((err) => {
      console.error("❌ Bot failed to launch:", err);
    });
})();

// Keep-alive server برای Render یا پلتفرم‌های هاستینگ
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running\n");
  })
  .listen(port);
console.log(`🌐 Keep-alive server is running on port ${port}`);
