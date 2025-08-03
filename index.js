const { Telegraf, session } = require("telegraf");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = path.join(__dirname, "token.json");

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const { client_secret, client_id, redirect_uris } = credentials.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

function getAccessToken(ctx) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  ctx.reply(`برای اتصال به Gmail روی لینک زیر کلیک کن:\n\n${authUrl}`);
  ctx.reply("بعد از ورود، کدی که بهت می‌ده رو برای من بفرست:");
  ctx.session.waitingForCode = true;
}

async function listMessages(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: 5,
  });

  if (!res.data.messages) return [];

  const messages = [];

  for (const message of res.data.messages) {
    const fullMsg = await gmail.users.messages.get({
      userId: "me",
      id: message.id,
    });

    const headers = fullMsg.data.payload.headers;
    const subject =
      headers.find((h) => h.name === "Subject")?.value || "No Subject";
    const from =
      headers.find((h) => h.name === "From")?.value || "Unknown Sender";
    const date =
      headers.find((h) => h.name === "Date")?.value || "Unknown Date";
    const snippet = fullMsg.data.snippet;

    messages.push({ subject, from, date, snippet });
  }

  return messages;
}

bot.command("inbox", async (ctx) => {
  if (!fs.existsSync(TOKEN_PATH)) {
    return getAccessToken(ctx);
  }

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oAuth2Client.setCredentials(token);

  try {
    const messages = await listMessages(oAuth2Client);
    if (!messages.length) return ctx.reply("📭 هیچ ایمیلی یافت نشد.");

    for (const msg of messages) {
      await ctx.reply(
        `📩 *Subject*: ${msg.subject}\n👤 *From*: ${msg.from}\n📅 *Date*: ${msg.date}\n📝 ${msg.snippet}`,
        {
          parse_mode: "Markdown",
        }
      );
    }
  } catch (err) {
    console.error(err);
    ctx.reply("❌ خطا در خواندن ایمیل‌ها. لطفا دوباره اتصال رو برقرار کن (/inbox)");
  }
});

bot.on("text", async (ctx) => {
  if (!ctx.session?.waitingForCode) return;

  const code = ctx.message.text.trim();
  ctx.session.waitingForCode = false;

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    ctx.reply("✅ اتصال با موفقیت انجام شد. حالا دستور /inbox رو بفرست.");
  } catch (err) {
    console.error("Token Error:", err);
    ctx.reply("❌ خطا در دریافت توکن. لطفا دوباره کد رو ارسال کن.");
    ctx.session.waitingForCode = true;
  }
});

// ----------------------------
// Express + Webhook setup 👇
// ----------------------------

const app = express();
const PORT = process.env.PORT || 3000;

// آدرس امن برای webhook
const WEBHOOK_PATH = "/telegraf-417x"; // می‌تونی عوضش کنی

// تنظیم webhook تلگرام
bot.telegram.setWebhook(`https://gmail-zzge.onrender.com${WEBHOOK_PATH}`);

// اتصال Telegraf به Express
app.use(bot.webhookCallback(WEBHOOK_PATH));

// یک روت ساده برای تست
app.get("/", (req, res) => {
  res.send("🤖 Gmail bot with Webhook is running!");
});

// اجرای سرور
app.listen(PORT, () => {
  console.log(`🚀 Server is listening on port ${PORT}`);
});
