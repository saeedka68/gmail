const { Telegraf } = require("telegraf");
const fs = require("fs");
const readline = require("readline");
const { google } = require("googleapis");

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = "token.json";

// ربات تلگرام
const bot = new Telegraf(process.env.BOT_TOKEN);

// خواندن credentials
const credentials = JSON.parse(fs.readFileSync("credentials.json"));
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0],
);

// گرفتن توکن دسترسی
function getAccessToken(ctx) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  ctx.reply(`برای اتصال به Gmail روی لینک زیر کلیک کن:\n\n${authUrl}`);
  ctx.reply("بعد از ورود، کدی که بهت می‌ده رو برای من بفرست:");
  ctx.session = { waitingForCode: true };
}

// گرفتن پیام‌های اخیر
async function listMessages(auth) {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: 5,
  });

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

// دستور /inbox
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
        },
      );
    }
  } catch (err) {
    console.error(err);
    ctx.reply("❌ خطا در خواندن ایمیل‌ها.");
  }
});

// دریافت کد از کاربر
bot.on("text", async (ctx) => {
  if (!ctx.session?.waitingForCode) return;
  const code = ctx.message.text.trim();
  ctx.session.waitingForCode = false;

  oAuth2Client.getToken(code, (err, token) => {
    if (err) {
      console.error("Token Error:", err);
      return ctx.reply("❌ خطا در دریافت توکن");
    }

    oAuth2Client.setCredentials(token);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    ctx.reply("✅ اتصال با موفقیت انجام شد. حالا دستور /inbox رو بفرست.");
  });
});

// راه‌اندازی ربات
bot.launch().then(() => {
  console.log("🤖 Gmail bot is running");
});
