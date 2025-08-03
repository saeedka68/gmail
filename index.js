const { Telegraf } = require("telegraf");
const { google } = require("googleapis");

// ENV: BOT_TOKEN, MY_TELEGRAM_ID, GOOGLE_CREDENTIALS, GOOGLE_TOKEN
const bot = new Telegraf(process.env.BOT_TOKEN);
const MY_TELEGRAM_ID = parseInt(process.env.MY_TELEGRAM_ID);

// گوگل OAuth2 کلاینت از ENV
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const token = JSON.parse(process.env.GOOGLE_TOKEN);
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);

// Gmail API
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

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

      await ctx.reply(`✉️ <b>${subject}</b>\n👤 ${from}\n📝 ${snippet}`, {
        parse_mode: "HTML"
      });
    }
  } catch (err) {
    console.error("❌ Gmail error:", err);
    ctx.reply("❗️ خطا در دریافت ایمیل‌ها.");
  }
});

// اجرا
bot.launch();
console.log("📬 Gmail Telegram Bot is running...");
