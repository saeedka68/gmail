const { Telegraf, session } = require("telegraf");
const fs = require("fs");
const { google } = require("googleapis");
const readline = require("readline");

// بارگذاری .env
require("dotenv").config();

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const TOKEN_PATH = "token.json";
const credentials = JSON.parse(fs.readFileSync("credentials.json"));

const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// گرفتن لینک تأیید از گوگل
function getAuthUrl() {
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
}

// دریافت توکن از کد
async function getAccessTokenFromCode(code) {
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  return tokens;
}

// بررسی و بارگذاری توکن
function loadSavedToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    return true;
  }
  return false;
}

// گرفتن ایمیل‌ها
async function listMessages(ctx) {
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  const res = await gmail.users.messages.list({
    userId: "me",
    maxResults: 5,
  });

  const messages = res.data.messages || [];
  if (messages.length === 0) return ctx.reply("📭 هیچ ایمیلی پیدا نشد.");

  for (let i = 0; i < messages.length; i++) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messages[i].id,
    });

    const headers = msg.data.payload.headers;
    const subject =
      headers.find((h) => h.name === "Subject")?.value || "بدون موضوع";
    const from =
      headers.find((h) => h.name === "From")?.value || "فرستنده ناشناس";
    const date = headers.find((h) => h.name === "Date")?.value || "";

    await ctx.reply(
      `✉️ *${subject}*\n👤 ${from}\n🕒 ${date}\n\n📝 ${msg.data.snippet}`,
      { parse_mode: "Markdown" }
    );
  }
}

// وقتی کاربر دستور /inbox داد
bot.command("inbox", async (ctx) => {
  if (loadSavedToken()) {
    await ctx.reply("📥 دریافت ایمیل‌ها...");
    return listMessages(ctx);
  } else {
    const url = getAuthUrl();
    ctx.session.waitingForCode = true;
    return ctx.reply(`🔐 برای دسترسی، روی لینک زیر کلیک کن:\n${url}`);
  }
});

// وقتی کاربر کد تأیید را فرستاد
bot.on("text", async (ctx) => {
  if (ctx.session.waitingForCode) {
    try {
      await getAccessTokenFromCode(ctx.message.text.trim());
      ctx.session.waitingForCode = false;
      await ctx.reply("✅ دسترسی برقرار شد! حالا دوباره /inbox رو بفرست.");
    } catch (err) {
      console.error(err);
      ctx.reply("❌ خطا در گرفتن توکن. لطفاً کد درست وارد کن.");
    }
  }
});

bot.launch();
console.log("🤖 Gmail bot launched.");
