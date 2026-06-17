const net = require('net');
const dns = require('dns').promises;
const { spawn } = require('child_process');

const express = require('express');
const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;

const COMMON_PORTS = {
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  80: 'HTTP',
  110: 'POP3',
  143: 'IMAP',
  443: 'HTTPS',
  445: 'SMB',
  3306: 'MySQL',
  3389: 'RDP',
  8080: 'HTTP-Alt',
  8443: 'HTTPS-Alt',
};

const HISTORY_LIMIT = 5;

// in-memory state (با ری‌استارت سرویس خالی می‌شود)
const historyStore = new Map(); // chatId -> [{ip, original}]
const awaitingPort = new Map(); // chatId -> ip

// ---------------------------------------------------------------------------
// Health-check server. Render نیاز دارد سرویس روی یک پورت گوش بدهد، حتی اگر
// ربات فقط با polling کار می‌کند.
// ---------------------------------------------------------------------------
const app = express();
app.get('/', (req, res) => res.send('Bot is running ✅'));
app.listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

// ---------------------------------------------------------------------------
// Helpers: resolve / private-ip / geo info
// ---------------------------------------------------------------------------
function isPrivateIP(ip) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  return false;
}

async function resolveTarget(text) {
  text = text.trim();
  if (net.isIP(text)) {
    return { ip: text, original: text };
  }
  try {
    const { address } = await dns.lookup(text);
    return { ip: address, original: text };
  } catch (e) {
    return { ip: null, original: text };
  }
}

async function getIpInfo(ip) {
  if (isPrivateIP(ip)) return { private: true };
  try {
    const url =
      `http://ip-api.com/json/${ip}?fields=status,message,country,regionName,` +
      `city,zip,isp,org,as,timezone,reverse,proxy,hosting,query`;
    const { data } = await axios.get(url, { timeout: 6000 });
    if (data.status !== 'success') {
      return { error: data.message || 'اطلاعاتی برای این IP پیدا نشد' };
    }
    return data;
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Helpers: ping (ICMP با fallback به TCP)
// ---------------------------------------------------------------------------
function icmpPing(ip, count = 4, timeout = 2) {
  return new Promise((resolve) => {
    let resolved = false;
    let proc;
    try {
      proc = spawn('ping', ['-c', String(count), '-W', String(timeout), ip]);
    } catch (e) {
      resolve(null);
      return;
    }

    let output = '';
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.on('error', () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });
    proc.on('close', () => {
      if (resolved) return;
      resolved = true;
      const lossMatch = output.match(/(\d+)% packet loss/);
      const rttMatch = output.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/);
      if (rttMatch) {
        resolve({
          method: 'icmp',
          loss: lossMatch ? lossMatch[1] : null,
          min: rttMatch[1],
          avg: rttMatch[2],
          max: rttMatch[3],
          mdev: rttMatch[4],
        });
      } else {
        resolve(null);
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try {
          proc.kill();
        } catch (e) {
          /* ignore */
        }
        resolve(null);
      }
    }, (count * timeout + 5) * 1000);
  });
}

function tcpConnectTime(ip, port, timeout = 2000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      const elapsed = Date.now() - start;
      socket.destroy();
      resolve(elapsed);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(null);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(null);
    });
    socket.connect(port, ip);
  });
}

async function tcpPing(ip, ports = [443, 80]) {
  for (const port of ports) {
    const elapsed = await tcpConnectTime(ip, port);
    if (elapsed !== null) return { method: 'tcp', port, avg: elapsed };
  }
  return null;
}

async function pingTarget(ip) {
  const result = await icmpPing(ip);
  if (result) return result;
  // اگر ICMP مجاز نبود (حالت معمول در Render)، با TCP تست می‌کنیم
  return await tcpPing(ip);
}

// ---------------------------------------------------------------------------
// Helpers: port scan / single port check
// ---------------------------------------------------------------------------
function checkPort(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let connected = false;
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      connected = true;
      socket.destroy();
    });
    socket.once('timeout', () => socket.destroy());
    socket.once('error', () => socket.destroy());
    socket.once('close', () => resolve(connected));
    socket.connect(port, ip);
  });
}

async function scanCommonPorts(ip) {
  const ports = Object.keys(COMMON_PORTS).map(Number);
  const results = await Promise.all(ports.map((p) => checkPort(ip, p)));
  const map = {};
  ports.forEach((p, i) => (map[p] = results[i]));
  return map;
}

// ---------------------------------------------------------------------------
// Helpers: whois (RDAP - شبکه، نه ثبت دامنه)
// ---------------------------------------------------------------------------
async function getWhoisInfo(ip) {
  if (isPrivateIP(ip)) {
    return { error: 'این IP خصوصی/داخلی است و رکورد Whois عمومی ندارد' };
  }
  try {
    const { data } = await axios.get(`https://rdap.org/ip/${ip}`, {
      timeout: 8000,
      headers: { Accept: 'application/rdap+json' },
    });
    return {
      name: data.name || '-',
      handle: data.handle || '-',
      country: data.country || '-',
      startAddress: data.startAddress || '-',
      endAddress: data.endAddress || '-',
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Keyboard / history helpers
// ---------------------------------------------------------------------------
function buildActionKeyboard(ip) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔌 اسکن پورت‌های رایج', `scan:${ip}`),
      Markup.button.callback('🔢 بررسی پورت خاص', `port:${ip}`),
    ],
    [
      Markup.button.callback('📋 Whois', `whois:${ip}`),
      Markup.button.callback('🔁 بررسی دوباره', `recheck:${ip}`),
    ],
  ]);
}

function saveHistory(chatId, ip, original) {
  let history = historyStore.get(chatId) || [];
  history = history.filter((h) => h.ip !== ip);
  history.unshift({ ip, original });
  history = history.slice(0, HISTORY_LIMIT);
  historyStore.set(chatId, history);
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------
async function buildReport(ip, original) {
  const [info, pingResult] = await Promise.all([getIpInfo(ip), pingTarget(ip)]);

  const lines = [`🔎 نتیجه برای: \`${original}\``];
  if (original !== ip) {
    lines.push(`➡️ IP: \`${ip}\``);
  }

  if (info.private) {
    lines.push('\n⚠️ این یک آدرس IP خصوصی/داخلی است، اطلاعات جغرافیایی موجود نیست.');
  } else if (info.error) {
    lines.push(`\n⚠️ خطا در گرفتن اطلاعات: ${info.error}`);
  } else {
    lines.push(
      `\n📍 موقعیت: ${info.city || '-'}, ${info.regionName || '-'} - ${info.country || '-'}`
    );
    lines.push(`🏢 ISP: ${info.isp || '-'}`);
    lines.push(`🏛 سازمان: ${info.org || '-'}`);
    lines.push(`🛰 AS: ${info.as || '-'}`);
    lines.push(`🕐 تایم‌زون: ${info.timezone || '-'}`);
    if (info.reverse) lines.push(`🔁 Reverse DNS: ${info.reverse}`);
    if (info.proxy) lines.push('🛑 این IP به‌عنوان پراکسی/VPN شناخته شده');
    if (info.hosting) lines.push('☁️ این IP مربوط به یک دیتاسنتر/هاستینگ است');
  }

  lines.push('');
  if (!pingResult) {
    lines.push('📡 پینگ: پاسخی دریافت نشد (Host Unreachable)');
  } else if (pingResult.method === 'icmp') {
    lines.push(`📡 پینگ (ICMP): میانگین ${pingResult.avg} ms | پکت‌لاس ${pingResult.loss}%`);
  } else {
    lines.push(`📡 پینگ (TCP پورت ${pingResult.port}): ${pingResult.avg} ms`);
    lines.push('ℹ️ پینگ ICMP در محیط سرور مجاز نبود، از TCP استفاده شد.');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------
if (!BOT_TOKEN) {
  throw new Error('متغیر BOT_TOKEN تنظیم نشده است. آن را در Environment Variables رندر اضافه کن.');
}

const bot = new Telegraf(BOT_TOKEN);

const START_TEXT =
  'سلام 👋\n' +
  'یک آدرس IP یا دامنه برام بفرست تا:\n' +
  '📍 موقعیت جغرافیایی\n' +
  '🏢 ISP و سازمان مربوطه\n' +
  '📡 وضعیت پینگ\n' +
  'رو بهت بدم.\n\n' +
  'بعدش با دکمه‌های زیر پیام می‌تونی:\n' +
  '🔌 پورت‌های رایج رو اسکن کنی\n' +
  '🔢 یک پورت خاص رو چک کنی\n' +
  '📋 Whois (شبکه) بگیری\n' +
  '🔁 دوباره بررسی کنی\n\n' +
  'برای دیدن تاریخچه: /history\n\n' +
  'مثال: 8.8.8.8';

bot.start((ctx) => ctx.reply(START_TEXT));
bot.help((ctx) => ctx.reply(START_TEXT));

bot.command('history', (ctx) => {
  const history = historyStore.get(ctx.chat.id) || [];
  if (history.length === 0) {
    return ctx.reply('📜 هنوز تاریخچه‌ای ثبت نشده.');
  }
  const buttons = history.map((h) => [Markup.button.callback(`🔁 ${h.original}`, `recheck:${h.ip}`)]);
  return ctx.reply('📜 تاریخچه بررسی‌ها (روی هرکدوم بزن تا دوباره چک شه):', Markup.inlineKeyboard(buttons));
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();

  // اگر منتظر شماره‌ی پورت برای یک IP خاص هستیم
  const awaitingIp = awaitingPort.get(chatId);
  if (awaitingIp) {
    const port = Number(text);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      awaitingPort.delete(chatId);
      const msg = await ctx.reply(`⏳ در حال بررسی پورت ${port} روی \`${awaitingIp}\`...`, {
        parse_mode: 'Markdown',
      });
      const isOpen = await checkPort(awaitingIp, port);
      const status = isOpen ? '✅ باز است' : '❌ بسته است / پاسخ نداد';
      await ctx.telegram.editMessageText(
        chatId,
        msg.message_id,
        undefined,
        `🔢 پورت ${port} روی \`${awaitingIp}\`: ${status}`,
        { parse_mode: 'Markdown', ...buildActionKeyboard(awaitingIp) }
      );
    } else {
      await ctx.reply('❌ لطفاً یک عدد بین 1 تا 65535 به‌عنوان شماره پورت بفرست.');
    }
    return;
  }

  const { ip, original } = await resolveTarget(text);
  if (!ip) {
    await ctx.reply('❌ این یک IP یا دامنه معتبر نیست. دوباره امتحان کن.');
    return;
  }

  const msg = await ctx.reply('⏳ در حال بررسی...');
  const report = await buildReport(ip, original);
  saveHistory(chatId, ip, original);
  await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, report, {
    parse_mode: 'Markdown',
    ...buildActionKeyboard(ip),
  });
});

bot.action(/^recheck:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ip = ctx.match[1];
  const chatId = ctx.chat.id;
  const history = historyStore.get(chatId) || [];
  const found = history.find((h) => h.ip === ip);
  const original = found ? found.original : ip;

  await ctx.editMessageText('⏳ در حال بررسی...');
  const report = await buildReport(ip, original);
  saveHistory(chatId, ip, original);
  await ctx.editMessageText(report, { parse_mode: 'Markdown', ...buildActionKeyboard(ip) });
});

bot.action(/^scan:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ip = ctx.match[1];
  await ctx.editMessageText(`⏳ در حال اسکن پورت‌های رایج برای \`${ip}\` ...`, {
    parse_mode: 'Markdown',
  });
  const results = await scanCommonPorts(ip);
  const open = Object.entries(results)
    .filter(([, ok]) => ok)
    .map(([p]) => `${p} (${COMMON_PORTS[p]})`);
  const closed = Object.entries(results)
    .filter(([, ok]) => !ok)
    .map(([p]) => p);
  const text =
    `🔌 نتیجه اسکن پورت برای \`${ip}\`:\n\n` +
    `✅ باز: ${open.length ? open.join(', ') : 'هیچ‌کدام'}\n` +
    `❌ بسته/بدون پاسخ: ${closed.length ? closed.join(', ') : 'هیچ‌کدام'}`;
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buildActionKeyboard(ip) });
});

bot.action(/^port:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ip = ctx.match[1];
  awaitingPort.set(ctx.chat.id, ip);
  await ctx.editMessageText(`🔢 شماره پورتی که می‌خوای برای \`${ip}\` چک کنم رو بفرست (مثلاً 8080):`, {
    parse_mode: 'Markdown',
  });
});

bot.action(/^whois:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ip = ctx.match[1];
  await ctx.editMessageText(`⏳ در حال گرفتن اطلاعات Whois برای \`${ip}\` ...`, {
    parse_mode: 'Markdown',
  });
  const info = await getWhoisInfo(ip);
  let text;
  if (info.error) {
    text = `⚠️ اطلاعات Whois پیدا نشد: ${info.error}`;
  } else {
    text =
      `📋 Whois (شبکه) برای \`${ip}\`:\n\n` +
      `🏷 نام شبکه: ${info.name}\n` +
      `🔖 Handle: ${info.handle}\n` +
      `🌍 کشور: ${info.country}\n` +
      `📦 رنج آدرس: ${info.startAddress} - ${info.endAddress}\n\n` +
      `ℹ️ این اطلاعات شبکه (RDAP) است، نه اطلاعات ثبت دامنه (مالک/تاریخ ثبت).`;
  }
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...buildActionKeyboard(ip) });
});

bot
  .launch()
  .then(() => console.log('Bot started polling...'))
  .catch((err) => console.error('Failed to launch bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
