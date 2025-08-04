const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

// تنظیمات از متغیر محیطی
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('Error: TELEGRAM_TOKEN and CHAT_ID must be set as environment variables');
  process.exit(1);
}

// ایجاد بات تلگرام
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// مسیر فایل‌ها (اگر لازم داری داخل رندر آپلود کنی)
// پیشنهاد: این دو فایل رو در ریشه پروژه باشه
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

// ... (بقیه کلاس GmailTelegramBot و توابع مثل قبل)
// فقط قسمت تعریف توکن و چت آیدی تغییر کرده به process.env

// اضافه کردن یک سرور ساده برای جلوگیری از خاموش شدن اپ در Render
const port = process.env.PORT || 3000;
require('http').createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

console.log('🚀 Starting Gmail Telegram Bot...');

// بقیه کد همون کد اصلیت باشه، فقط متغیرها رو از process.env بخون
