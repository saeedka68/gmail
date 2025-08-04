const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

// دریافت توکن و چت آیدی از متغیرهای محیطی
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('Error: TELEGRAM_TOKEN and CHAT_ID must be set as environment variables');
  process.exit(1);
}

// ساخت بات تلگرام
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// مسیر فایل‌ها
const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

class GmailTelegramBot {
  constructor() {
    this.gmail = null;
    this.auth = null;
    this.lastEmails = [];
    this.isInitialized = false;
    this.init();
  }

  async init() {
    try {
      await this.authorize();
      this.startPeriodicCheck();
      this.isInitialized = true;
      console.log('✅ Bot initialized successfully!');
    } catch (error) {
      console.error('❌ Initialization error:', error);
    }
  }

  async authorize() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      throw new Error(`Credentials file not found: ${CREDENTIALS_PATH}`);
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (fs.existsSync(TOKEN_PATH)) {
      const token = fs.readFileSync(TOKEN_PATH);
      oAuth2Client.setCredentials(JSON.parse(token));
      try {
        await oAuth2Client.getAccessToken();
      } catch (error) {
        console.log('Token expired, getting new token...');
        await this.getAccessToken(oAuth2Client);
      }
    } else {
      await this.getAccessToken(oAuth2Client);
    }

    this.auth = oAuth2Client;
    this.gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
  }

  async getAccessToken(oAuth2Client) {
    const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });

    console.log('Please open this link and authorize the application:');
    console.log(authUrl);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve, reject) => {
      rl.question('Enter the authorization code: ', async (code) => {
        rl.close();
        try {
          const { tokens } = await oAuth2Client.getToken(code);
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
          console.log('Token saved to:', TOKEN_PATH);
          resolve();
        } catch (error) {
          console.error('Token retrieval error:', error);
          reject(error);
        }
      });
    });
  }

  async getUnreadEmails() {
    try {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: 10
      });

      const messages = response.data.messages || [];
      const emailDetails = [];

      for (const message of messages) {
        const detail = await this.gmail.users.messages.get({
          userId: 'me',
          id: message.id
        });

        const headers = detail.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
        const from = headers.find(h => h.name === 'From')?.value || 'Unknown Sender';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        let body = this.extractEmailBody(detail.data.payload);
        body = body.substring(0, 200) + (body.length > 200 ? '...' : '');

        emailDetails.push({
          id: message.id,
          subject,
          from,
          date,
          body: body || '[No text content]'
        });
      }

      return emailDetails;
    } catch (error) {
      console.error('Error fetching emails:', error);
      return [];
    }
  }

  async getFullEmailContent(emailId) {
    try {
      const detail = await this.gmail.users.messages.get({
        userId: 'me',
        id: emailId,
        format: 'full'
      });

      return this.extractEmailBody(detail.data.payload) || '[No text content available]';
    } catch (error) {
      console.error('Error fetching full content:', error);
      return 'Error retrieving content';
    }
  }

  extractEmailBody(payload) {
    let body = '';

    const extractFromPart = (part) => {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      if (part.mimeType === 'text/html' && part.body?.data && !body) {
        const htmlContent = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return htmlContent.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      }
      return '';
    };

    if (payload.parts) {
      for (const part of payload.parts) {
        if (part.parts) {
          for (const nestedPart of part.parts) {
            const text = extractFromPart(nestedPart);
            if (text) body += text;
          }
        } else {
          const text = extractFromPart(part);
          if (text) body += text;
        }
      }
    } else if (payload.body?.data) {
      body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    return body.trim();
  }

  async sendEmailsToTelegram(emails) {
    if (emails.length === 0) {
      await bot.sendMessage(CHAT_ID, 'No unread emails!');
      return;
    }

    this.lastEmails = emails;

    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      let message = `📧 *Unread Email ${i + 1}*\n\n`;
      message += `📩 *Subject:* ${this.escapeMarkdown(email.subject)}\n`;
      message += `👤 *From:* ${this.escapeMarkdown(email.from)}\n`;
      message += `📅 *Date:* ${this.escapeMarkdown(email.date)}\n`;
      message += `📝 *Preview:* ${this.escapeMarkdown(email.body)}\n`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Mark Read', callback_data: `mark_read_${i}` },
            { text: '📖 View Full', callback_data: `view_full_${i}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `delete_${i}` },
            { text: '⭐ Star', callback_data: `star_${i}` }
          ]
        ]
      };

      try {
        await bot.sendMessage(CHAT_ID, message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
      } catch (error) {
        console.error('Error sending message:', error);
        await bot.sendMessage(CHAT_ID, message.replace(/[*_`]/g, ''), {
          reply_markup: keyboard
        });
      }
    }

    const summaryKeyboard = {
      inline_keyboard: [
        [{ text: '✅ Mark All Read', callback_data: 'mark_all_read' }],
        [{ text: '🔄 Refresh', callback_data: 'refresh_emails' }]
      ]
    };

    await bot.sendMessage(CHAT_ID, `📊 Total: ${emails.length} unread emails`, {
      reply_markup: summaryKeyboard
    });
  }

  escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/([*_`\[\]()])/g, '\\$1');
  }

  startPeriodicCheck() {
    setInterval(async () => {
      if (!this.isInitialized) return;

      console.log('Checking for new emails...');
      try {
        const emails = await this.getUnreadEmails();
        if (emails.length > 0) {
          console.log(`Found ${emails.length} unread emails`);
          await this.sendEmailsToTelegram(emails);
        }
      } catch (error) {
        console.error('Error in periodic check:', error);
      }
    }, 5 * 60 * 1000);
  }

  async markEmailAsRead(emailId) {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: emailId,
        requestBody: { removeLabelIds: ['UNREAD'] }
      });
      return true;
    } catch (error) {
      console.error('Error marking email as read:', error);
      return false;
    }
  }

  async deleteEmail(emailId) {
    try {
      await this.gmail.users.messages.delete({
        userId: 'me',
        id: emailId
      });
      return true;
    } catch (error) {
      console.error('Error deleting email:', error);
      return false;
    }
  }

  async starEmail(emailId) {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: emailId,
        requestBody: { addLabelIds: ['STARRED'] }
      });
      return true;
    } catch (error) {
      console.error('Error starring email:', error);
      return false;
    }
  }
}

const gmailBot = new GmailTelegramBot();

bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const from = callbackQuery.from.id;

  if (from.toString() !== CHAT_ID) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Access denied.' });
    return;
  }

  if (!gmailBot.lastEmails.length) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'No emails to interact with.' });
    return;
  }

  if (data.startsWith('mark_read_')) {
    const index = parseInt(data.split('_')[2]);
    const email = gmailBot.lastEmails[index];
    if (email) {
      const success = await gmailBot.markEmailAsRead(email.id);
      if (success) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Marked as read.' });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to mark as read.' });
      }
    }
  } else if (data.startsWith('delete_')) {
    const index = parseInt(data.split('_')[1]);
    const email = gmailBot.lastEmails[index];
    if (email) {
      const success = await gmailBot.deleteEmail(email.id);
      if (success) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Deleted email.' });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to delete email.' });
      }
    }
  } else if (data.startsWith('star_')) {
    const index = parseInt(data.split('_')[1]);
    const email = gmailBot.lastEmails[index];
    if (email) {
      const success = await gmailBot.starEmail(email.id);
      if (success) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Starred email.' });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to star email.' });
      }
    }
  } else if (data.startsWith('view_full_')) {
    const index = parseInt(data.split('_')[2]);
    const email = gmailBot.lastEmails[index];
    if (email) {
      const fullContent = await gmailBot.getFullEmailContent(email.id);
      try {
        await bot.sendMessage(CHAT_ID, `📖 *Full Email Content:*\n\n${gmailBot.escapeMarkdown(fullContent)}`, { parse_mode: 'Markdown' });
      } catch {
        await bot.sendMessage(CHAT_ID, `📖 Full Email Content:\n\n${fullContent}`);
      }
      await bot.answerCallbackQuery(callbackQuery.id);
    }
  } else if (data === 'mark_all_read') {
    let successCount = 0;
    for (const email of gmailBot.lastEmails) {
      const success = await gmailBot.markEmailAsRead(email.id);
      if (success) successCount++;
    }
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Marked ${successCount} emails as read.` });
  } else if (data === 'refresh_emails') {
    const emails = await gmailBot.getUnreadEmails();
    await gmailBot.sendEmailsToTelegram(emails);
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Refreshed emails.' });
  } else {
    await bot.answerCallbackQuery(callbackQuery.id, { text: 'Unknown action.' });
  }
});

// سرور ساده برای جلوگیری از خاموش شدن در Render
const port = process.env.PORT || 3000;
require('http').createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running');
}).listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
