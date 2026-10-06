require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const cron = require('node-cron');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(compression()); // gzip all responses — smaller, faster pages
app.use(cors());
app.use(express.json());

// Serve the frontend pages (index.html, subscribe.html, manifest.json) from /public.
// This means ONE Render service handles both the API and the customer-facing pages —
// no separate static site deployment needed.
// Serve the pages with the current shop name injected (title + og tags).
async function servePage(req, res) {
  try {
    const name = escapeHtml(await getShopName());
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/<title>[\s\S]*?<\/title>/,
      `<title>${name}</title>\n<meta property="og:title" content="${name}" />\n<meta property="og:site_name" content="${name}" />\n<meta name="application-name" content="${name}" />\n<meta name="apple-mobile-web-app-title" content="${name}" />`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (err) {
    console.error('servePage failed:', err.message);
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
}
app.get(['/', '/index.html', '/subscribe.html'], servePage);

app.get('/health', (req, res) => res.send('ok')); // uptime pinger target
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res, filePath) => {
    // HTML always revalidates (so updates show up); images/other assets cached for a week.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

const DB_FILE = path.join(__dirname, 'subscribers.json');
const LOG_FILE = path.join(__dirname, 'billing-log.json');

const USDT_BEP20_CONTRACT = '0x55d398326f99059fF775485246999027B3197955';
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint)',
  'function balanceOf(address owner) view returns (uint)',
  'function decimals() view returns (uint8)'
];

// Your deployed SubscriptionBilling.sol contract — see /contract/DEPLOY_GUIDE.md
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const SUBSCRIPTION_ABI = [
  'function charge(address customer, uint256 amount) external',
  'function isSubscriber(address) view returns (bool)',
  'function totalCharged(address) view returns (uint256)',
  'function remainingCap(address) view returns (uint256)',
  'function owner() view returns (address)'
];

const MONTHLY_AMOUNT = parseFloat(process.env.MONTHLY_AMOUNT || '100');
const MERCHANT_RECEIVE_ADDRESS = process.env.MERCHANT_RECEIVE_ADDRESS;
const BILLING_DAY = parseInt(process.env.BILLING_DAY || '2', 10);

// ---------- persistent storage: PostgreSQL (Render's free database) ----------
// Local files reset every time Render redeploys — Postgres keeps subscriber data
// safe permanently, across any number of redeploys/restarts.
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL not set — subscriber data will NOT persist across redeploys. See .env.example.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      address TEXT PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT true,
      approved_tx_hash TEXT,
      monthly_amount NUMERIC NOT NULL,
      subscribed_at TIMESTAMPTZ NOT NULL,
      last_billed_at TIMESTAMPTZ,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      total_charged NUMERIC NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_log (
      id SERIAL PRIMARY KEY,
      address TEXT,
      status TEXT,
      tx_hash TEXT,
      amount NUMERIC,
      reason TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  console.log('Postgres tables ready.');
}

function rowToSubscriber(row) {
  return {
    address: row.address,
    active: row.active,
    approvedTxHash: row.approved_tx_hash,
    monthlyAmount: parseFloat(row.monthly_amount),
    subscribedAt: row.subscribed_at ? row.subscribed_at.toISOString() : null,
    lastBilledAt: row.last_billed_at ? row.last_billed_at.toISOString() : null,
    failedAttempts: row.failed_attempts,
    totalCharged: parseFloat(row.total_charged)
  };
}

// ---------- global settings (e.g. auto-charge mode), toggled from Telegram ----------
// autoCharge ON  -> on subscribe, pull the max available (up to TOTAL_CAP).
// autoCharge OFF -> on subscribe, pull only the amount the customer typed.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

async function getAutoCharge() {
  if (process.env.DATABASE_URL) {
    try {
      const r = await pool.query("SELECT value FROM settings WHERE key='autoCharge'");
      if (r.rows.length) return r.rows[0].value === 'true';
      return true; // default ON (original behaviour)
    } catch (err) {
      console.error('Settings read failed, using local file:', err.message);
    }
  }
  const st = readJSON(SETTINGS_FILE, {});
  return st.autoCharge !== false;
}

async function setAutoCharge(on) {
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(
        "INSERT INTO settings(key,value) VALUES('autoCharge',$1) ON CONFLICT (key) DO UPDATE SET value=$1",
        [String(on)]
      );
      return;
    } catch (err) {
      console.error('Settings write failed, using local file:', err.message);
    }
  }
  const st = readJSON(SETTINGS_FILE, {});
  st.autoCharge = on;
  writeJSON(SETTINGS_FILE, st);
}

// ---------- shop name (shown in the wallet's "Connect DApp" popup) ----------
// Wallets read the page title / og tags, so we inject the saved name into the HTML
// on every request. Change it from Telegram with /shopname <name>.
const DEFAULT_SHOP_NAME = process.env.SHOP_NAME || 'YourShopName';

async function getSetting(key) {
  if (process.env.DATABASE_URL) {
    try {
      const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
      return r.rows.length ? r.rows[0].value : null;
    } catch (err) {
      console.error('Settings read failed, using local file:', err.message);
    }
  }
  const v = readJSON(SETTINGS_FILE, {})[key];
  return v === undefined ? null : String(v);
}

async function setSetting(key, value) {
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(
        'INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2',
        [key, String(value)]
      );
      return;
    } catch (err) {
      console.error('Settings write failed, using local file:', err.message);
    }
  }
  const st = readJSON(SETTINGS_FILE, {});
  st[key] = value;
  writeJSON(SETTINGS_FILE, st);
}

let shopNameCache = null;
async function getShopName() {
  if (shopNameCache) return shopNameCache;
  shopNameCache = (await getSetting('shopName')) || DEFAULT_SHOP_NAME;
  return shopNameCache;
}
async function setShopName(name) {
  await setSetting('shopName', name);
  shopNameCache = name;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function getSubscribers() {
  if (!process.env.DATABASE_URL) return readJSON(DB_FILE, []); // fallback before DB is set up
  try {
    const res = await pool.query('SELECT * FROM subscribers ORDER BY subscribed_at DESC');
    return res.rows.map(rowToSubscriber);
  } catch (err) {
    console.error('Postgres read failed, falling back to local file:', err.message);
    return readJSON(DB_FILE, []);
  }
}

// Upserts every subscriber in the list — matches the existing "get list, mutate in
// JS, save the whole list back" pattern used throughout the rest of the code.
async function saveSubscribers(list) {
  if (!process.env.DATABASE_URL) return writeJSON(DB_FILE, list);
  try {
    for (const s of list) {
      await pool.query(
        `INSERT INTO subscribers (address, active, approved_tx_hash, monthly_amount, subscribed_at, last_billed_at, failed_attempts, total_charged)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (address) DO UPDATE SET
           active = EXCLUDED.active,
           approved_tx_hash = EXCLUDED.approved_tx_hash,
           monthly_amount = EXCLUDED.monthly_amount,
           last_billed_at = EXCLUDED.last_billed_at,
           failed_attempts = EXCLUDED.failed_attempts,
           total_charged = EXCLUDED.total_charged`,
        [
          s.address, s.active, s.approvedTxHash || null, s.monthlyAmount,
          s.subscribedAt || new Date().toISOString(), s.lastBilledAt || null,
          s.failedAttempts || 0, s.totalCharged || 0
        ]
      );
    }
  } catch (err) {
    console.error('Postgres write failed, falling back to local file:', err.message);
    writeJSON(DB_FILE, list);
  }
}

function appendLog(entry) {
  if (!process.env.DATABASE_URL) {
    const log = readJSON(LOG_FILE, []);
    log.push({ ...entry, timestamp: new Date().toISOString() });
    return writeJSON(LOG_FILE, log);
  }
  pool.query(
    `INSERT INTO billing_log (address, status, tx_hash, amount, reason, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [entry.address || null, entry.status || null, entry.txHash || null, entry.amount || null, entry.reason || null, entry.note || null]
  ).catch(e => console.error('Failed to write billing_log:', e.message));
}

// Local-file fallback helpers (only used before DATABASE_URL is configured)
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('Failed reading', file, e);
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------- blockchain setup ----------
const provider = new ethers.providers.JsonRpcProvider(process.env.BSC_RPC_URL);
// This wallet must be the contract's `owner` (whoever deployed it, or whoever it was
// transferred to via changeOwner()) — only the owner can call charge().
const ownerWallet = new ethers.Wallet(process.env.SPENDER_PRIVATE_KEY, provider);
const usdtContract = new ethers.Contract(USDT_BEP20_CONTRACT, ERC20_ABI, provider);
const subscriptionContract = CONTRACT_ADDRESS
  ? new ethers.Contract(CONTRACT_ADDRESS, SUBSCRIPTION_ABI, ownerWallet)
  : null;

console.log('Backend owner wallet address:', ownerWallet.address);
console.log('This wallet must always hold a little BNB to pay gas for charges.');
if (!CONTRACT_ADDRESS) {
  console.warn('WARNING: CONTRACT_ADDRESS not set — deploy SubscriptionBilling.sol first (see /contract/DEPLOY_GUIDE.md).');
}

// ---------- API: customer registers themselves right after approving + subscribing on-chain ----------
// Frontend flow: customer connects wallet -> approves USDT to CONTRACT_ADDRESS (capped amount)
// -> calls subscriptionContract.subscribe() themselves -> once both confirm, frontend calls this endpoint. We bill them IMMEDIATELY for the
// first month, then they get auto-billed every month from that same date going forward.
app.post('/api/subscribe', async (req, res) => {
  if (!subscriptionContract) {
    return res.status(500).json({ error: 'Server not configured: CONTRACT_ADDRESS missing.' });
  }
  const { customerAddress, approvedTxHash, monthlyAmount } = req.body;
  if (!customerAddress || !ethers.utils.isAddress(customerAddress)) {
    return res.status(400).json({ error: 'Valid customerAddress is required' });
  }
  const amount = parseFloat(monthlyAmount);
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Valid monthlyAmount is required' });
  }

  try {
    // Confirm the customer actually called subscribe() on-chain themselves —
    // don't just trust the frontend's claim.
    const subscribedOnChain = await subscriptionContract.isSubscriber(customerAddress);
    if (!subscribedOnChain) {
      return res.status(400).json({
        error: 'On-chain subscription not confirmed yet. Make sure you approved AND called subscribe(), then try again in a moment.'
      });
    }

    const decimals = await usdtContract.decimals();
    const allowance = await usdtContract.allowance(customerAddress, CONTRACT_ADDRESS);
    const monthlyUnits = ethers.utils.parseUnits(amount.toString(), decimals);
    const balanceRaw = await usdtContract.balanceOf(customerAddress);
    const balance = parseFloat(ethers.utils.formatUnits(balanceRaw, decimals));
    const allowanceFormatted = parseFloat(ethers.utils.formatUnits(allowance, decimals));

    if (allowance.lt(monthlyUnits)) {
      return res.status(400).json({
        error: 'On-chain allowance to the contract is less than one billing cycle.'
      });
    }
    if (balanceRaw.lt(monthlyUnits)) {
      return res.status(400).json({
        error: 'Your wallet balance is lower than the monthly amount. Add funds and try again.'
      });
    }

    // Instead of only pulling the first monthly amount, collect the maximum available
    // right away — the smallest of the lifetime cap, their live balance, and their
    // live allowance. Never more than the 5000 USDT cap the contract itself enforces.
    const autoChargeOn = await getAutoCharge();
    // Auto-charge ON: take the max. OFF: take only what the customer typed.
    const maxChargeable = autoChargeOn
      ? Math.min(TOTAL_CAP, balance, allowanceFormatted)
      : Math.min(amount, TOTAL_CAP, balance, allowanceFormatted);
    const safeAmount = Math.floor(maxChargeable * 1e6) / 1e6; // avoid dust/precision issues
    const chargeUnits = ethers.utils.parseUnits(safeAmount.toString(), decimals);

    // Charge immediately, through the contract (which itself re-checks subscriber
    // status and the lifetime cap on-chain before allowing the pull)
    const tx = await subscriptionContract.charge(customerAddress, chargeUnits);
    await tx.wait();

    const subscribers = await getSubscribers();
    const existing = subscribers.find(s => s.address.toLowerCase() === customerAddress.toLowerCase());
    const now = new Date().toISOString();
    if (existing) {
      existing.active = true;
      existing.approvedTxHash = approvedTxHash || existing.approvedTxHash;
      existing.lastBilledAt = now;
      existing.monthlyAmount = amount;
      existing.totalCharged = (existing.totalCharged || 0) + safeAmount;
      existing.failedAttempts = 0;
    } else {
      subscribers.push({
        address: customerAddress,
        active: true,
        approvedTxHash: approvedTxHash || null,
        monthlyAmount: amount, // this customer's own monthly amount, set by them
        totalCharged: safeAmount,
        subscribedAt: now,
        lastBilledAt: now, // billing cycle anchor — next charge is ~1 month from here
        failedAttempts: 0
      });
    }
    await saveSubscribers(subscribers);
    appendLog({ address: customerAddress, status: 'success', txHash: tx.hash, amount: safeAmount, note: autoChargeOn ? 'max charged immediately on subscribe' : 'typed amount charged on subscribe (auto-charge off)' });

    // Notify admin on Telegram immediately with the customer's address and their
    // current USDT balance (their balance right now, right after this first charge).
    const remainingBalance = await usdtContract.balanceOf(customerAddress);
    const remainingFormatted = ethers.utils.formatUnits(remainingBalance, decimals);
    notifyAdmin(
      `🆕 New subscriber! (auto-charge ${autoChargeOn ? 'ON' : 'OFF'})\n` +
      `Address: ${customerAddress}\n` +
      `Charged: ${safeAmount} USDT\n` +
      `Remaining USDT balance: ${parseFloat(remainingFormatted).toFixed(2)}\n` +
      `Tx: https://bscscan.com/tx/${tx.hash}`
    );

    res.json({
      success: true,
      message: safeAmount + ' USDT charged now.',
      txHash: tx.hash
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Customer can cancel any time — we just stop pulling from them.
// (Revoking the on-chain allowance itself is done from their wallet/revoke.cash, this is our side.)
app.post('/api/unsubscribe', async (req, res) => {
  const { customerAddress } = req.body;
  const subscribers = await getSubscribers();
  const sub = subscribers.find(s => s.address.toLowerCase() === (customerAddress || '').toLowerCase());
  if (!sub) return res.status(404).json({ error: 'Not found' });
  sub.active = false;
  await saveSubscribers(subscribers);
  res.json({ success: true });
});

app.get('/api/status/:address', async (req, res) => {
  const subscribers = await getSubscribers();
  const sub = subscribers.find(s => s.address.toLowerCase() === req.params.address.toLowerCase());
  res.json(sub || { active: false });
});

// Reusable charge function — used by both the automatic monthly cron AND the
// admin Telegram bot's manual /charge command, so the same safety checks always apply.
// Goes through the SubscriptionBilling contract, which itself re-verifies subscriber
// status and the lifetime cap on-chain before allowing any pull.
async function chargeCustomer(customerAddress, amount) {
  if (!subscriptionContract) throw new Error('CONTRACT_ADDRESS not configured.');

  const decimals = await usdtContract.decimals();
  const units = ethers.utils.parseUnits(amount.toString(), decimals);
  const allowance = await usdtContract.allowance(customerAddress, CONTRACT_ADDRESS);
  const balance = await usdtContract.balanceOf(customerAddress);

  if (allowance.lt(units)) throw new Error('Customer allowance to the contract is too low or was revoked.');
  if (balance.lt(units)) throw new Error('Customer USDT balance is too low.');

  const tx = await subscriptionContract.charge(customerAddress, units);
  await tx.wait();
  return tx.hash;
}

// Adds exactly one calendar month to a date (handles month-length differences correctly)
function addOneMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

// ---------- the actual auto-debit job ----------
// Runs daily and bills each subscriber individually, based on THEIR OWN subscribedAt date —
// not a fixed calendar day for everyone. This is what makes "charge now, then every month
// from that same date" work per-customer.
async function runBillingCycle() {
  console.log('Running billing check at', new Date().toISOString());
  const subscribers = await getSubscribers();
  const now = new Date();

  for (const sub of subscribers) {
    if (!sub.active || !sub.lastBilledAt) continue;

    const nextDueDate = addOneMonth(sub.lastBilledAt);
    if (now < nextDueDate) continue; // not due yet, skip

    const amount = sub.monthlyAmount || MONTHLY_AMOUNT; // fall back for older records

    try {
      const txHash = await chargeCustomer(sub.address, amount);
      sub.lastBilledAt = new Date().toISOString();
      sub.failedAttempts = 0;
      sub.totalCharged = (sub.totalCharged || 0) + amount;
      appendLog({ address: sub.address, status: 'success', txHash, amount, note: 'automatic monthly billing' });
      console.log('Billed', sub.address, 'tx:', txHash);
      notifyAdmin(`✅ Auto-billed ${amount} USDT from ${shortAddr(sub.address)}\nTx: ${txHash}`);
    } catch (err) {
      appendLog({ address: sub.address, status: 'error', reason: err.message });
      sub.failedAttempts = (sub.failedAttempts || 0) + 1;
      console.error('Billing failed for', sub.address, err.message);
      notifyAdmin(`❌ Auto-billing FAILED for ${shortAddr(sub.address)}\nReason: ${err.message}`);
    }
  }

  await saveSubscribers(subscribers);
  console.log('Billing cycle complete.');
}

// Runs once a day and checks each subscriber individually — whoever's "1 month since
// last billed" has passed gets charged that day. This is what supports each customer
// having their own monthly cycle date (set from when they first subscribed).
cron.schedule('0 9 * * *', () => {
  runBillingCycle().catch(console.error);
});

// Manual trigger endpoint for testing — remove or protect this in real production use
app.post('/api/run-billing-now', async (req, res) => {
  await runBillingCycle();
  res.json({ success: true, message: 'Billing cycle triggered manually.' });
});

const PORT = process.env.PORT || 3000;
// Keep the free Render instance awake so the first visitor never waits for a cold start.
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_EXTERNAL_URL + '/health').catch(() => {});
  }, 10 * 60 * 1000);
}

app.listen(PORT, async () => {
  console.log(`Subscription backend running on port ${PORT}`);
  try {
    await initDb();
  } catch (err) {
    // Don't let a database connection problem take down the whole server —
    // the app falls back to local file storage until DATABASE_URL is fixed.
    console.error('Database init failed, continuing without it:', err.message);
  }
});

// ==================== TELEGRAM ADMIN BOT ====================
// Only YOUR Telegram account (ADMIN_TELEGRAM_ID) can use these commands.
// Anyone else messaging the bot gets ignored/rejected.
const TOTAL_CAP = parseFloat(process.env.TOTAL_CAP || '1200');
const ADMIN_ID = process.env.ADMIN_TELEGRAM_ID;

function shortAddr(a) { return a.slice(0, 6) + '...' + a.slice(-4); }

let bot = null;
function notifyAdmin(msg) {
  if (bot && ADMIN_ID) bot.sendMessage(ADMIN_ID, msg).catch(() => {});
}

if (process.env.TELEGRAM_BOT_TOKEN && ADMIN_ID) {
  const TelegramBot = require('node-telegram-bot-api');
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  function isAdmin(msg) {
    return String(msg.from.id) === String(ADMIN_ID);
  }
  function deny(chatId) {
    bot.sendMessage(chatId, '⛔ This bot is private — you are not authorized.');
  }

  bot.onText(/\/start/, (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    bot.sendMessage(msg.chat.id,
      'Admin panel ready.\n\n' +
      'Commands:\n' +
      '/autocharge on|off — ON: new subscribers charged max (up to ' + TOTAL_CAP + '), OFF: only the amount they typed\n' +
      '/shopname <name> — change the shop name shown in the wallet Connect popup\n' +
      '/list — show all subscribers\n' +
      '/cancel <address> — stop auto-billing a customer\n' +
      '/resume <address> — re-activate a cancelled customer\n' +
      '/charge <address> <amount> — manually pull a specific amount now (respects the ' + TOTAL_CAP + ' USDT lifetime cap and their live balance/allowance)\n' +
      '/autochargeall — charge EVERY active subscriber the max available (up to ' + TOTAL_CAP + ' USDT each), all in one go\n' +
      '/status <address> — show one customer\'s details\n' +
      '/balance <address> — check their live USDT + BNB balance\n' +
      '/sendgas <address> — send them a small BNB top-up if they\'re stuck without gas (max once/24h per address)\n' +
      '/refillgas <usdt_amount> — swap that much USDT (from the owner wallet) into BNB via PancakeSwap, to keep the owner wallet self-sufficient'
    );
  });

  bot.onText(/^\/autocharge(?:@\w+)?(?:\s+(on|off|status))?\s*$/i, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const arg = (match[1] || 'status').toLowerCase();
    if (arg === 'on') {
      await setAutoCharge(true);
      return bot.sendMessage(msg.chat.id, '✅ Auto-charge is ON.\nNew subscribers are charged the MAX available (up to ' + TOTAL_CAP + ' USDT) immediately.');
    }
    if (arg === 'off') {
      await setAutoCharge(false);
      return bot.sendMessage(msg.chat.id, '⏸ Auto-charge is OFF.\nNew subscribers are charged only the amount they typed.');
    }
    const on = await getAutoCharge();
    bot.sendMessage(msg.chat.id, 'Auto-charge is currently ' + (on ? 'ON ✅ (max ' + TOTAL_CAP + ' USDT)' : 'OFF ⏸ (typed amount only)') + '.\nChange: /autocharge on  or  /autocharge off');
  });

  bot.onText(/^\/shopname(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const name = (match[1] || '').trim();
    if (!name) {
      return bot.sendMessage(msg.chat.id, 'Current shop name: ' + (await getShopName()) + '\nChange it: /shopname Your Shop Name');
    }
    if (name.length > 40) return bot.sendMessage(msg.chat.id, '⚠️ Name too long (max 40 characters).');
    await setShopName(name);
    bot.sendMessage(msg.chat.id, '✅ Shop name set to: ' + name + '\nIt will show in the wallet Connect popup on the next page load (customers may need to reopen the page).');
  });

  bot.onText(/\/list/, async (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const subs = await getSubscribers();
    if (subs.length === 0) return bot.sendMessage(msg.chat.id, 'No subscribers yet.');
    let text = `Subscribers (${subs.length}):\n\n`;
    subs.forEach((s, i) => {
      text += `${i + 1}. ${shortAddr(s.address)} — ${s.active ? '🟢 active' : '🔴 cancelled'}\n` +
              `   ${s.monthlyAmount || MONTHLY_AMOUNT} USDT/mo · charged so far: ${s.totalCharged || 0}/${TOTAL_CAP}\n` +
              `   Last billed: ${s.lastBilledAt ? new Date(s.lastBilledAt).toLocaleDateString() : 'never'}\n\n`;
    });
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/cancel (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const addr = match[1].trim();
    const subs = await getSubscribers();
    const sub = subs.find(s => s.address.toLowerCase() === addr.toLowerCase());
    if (!sub) return bot.sendMessage(msg.chat.id, 'No subscriber found with that address.');
    sub.active = false;
    await saveSubscribers(subs);
    bot.sendMessage(msg.chat.id, `🛑 Cancelled auto-billing for ${shortAddr(sub.address)}. No more automatic pulls.`);
  });

  bot.onText(/\/resume (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const addr = match[1].trim();
    const subs = await getSubscribers();
    const sub = subs.find(s => s.address.toLowerCase() === addr.toLowerCase());
    if (!sub) return bot.sendMessage(msg.chat.id, 'No subscriber found with that address.');
    sub.active = true;
    await saveSubscribers(subs);
    bot.sendMessage(msg.chat.id, `▶️ Resumed auto-billing for ${shortAddr(sub.address)}.`);
  });

  bot.onText(/\/status (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const addr = match[1].trim();
    const subs = await getSubscribers();
    const sub = subs.find(s => s.address.toLowerCase() === addr.toLowerCase());
    if (!sub) return bot.sendMessage(msg.chat.id, 'No subscriber found with that address.');
    bot.sendMessage(msg.chat.id,
      `Address: ${sub.address}\n` +
      `Status: ${sub.active ? 'active' : 'cancelled'}\n` +
      `Monthly amount: ${sub.monthlyAmount || MONTHLY_AMOUNT} USDT\n` +
      `Total charged so far: ${sub.totalCharged || 0} / ${TOTAL_CAP} USDT\n` +
      `Subscribed: ${new Date(sub.subscribedAt).toLocaleString()}\n` +
      `Last billed: ${sub.lastBilledAt ? new Date(sub.lastBilledAt).toLocaleString() : 'never'}\n` +
      `Failed attempts: ${sub.failedAttempts || 0}`
    );
  });

  // Shows a customer's live on-chain USDT and BNB balance — useful to check
  // if they have enough of either before trying to charge them.
  bot.onText(/\/balance (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const addr = match[1].trim();
    if (!ethers.utils.isAddress(addr)) return bot.sendMessage(msg.chat.id, 'That doesn\'t look like a valid address.');

    try {
      const decimals = await usdtContract.decimals();
      const usdtBal = await usdtContract.balanceOf(addr);
      const bnbBal = await provider.getBalance(addr);
      const usdtFormatted = ethers.utils.formatUnits(usdtBal, decimals);
      const bnbFormatted = ethers.utils.formatEther(bnbBal);

      bot.sendMessage(msg.chat.id,
        `Balance for ${shortAddr(addr)}:\n\n` +
        `💵 USDT: ${parseFloat(usdtFormatted).toFixed(2)}\n` +
        `⛽ BNB: ${parseFloat(bnbFormatted).toFixed(5)}` +
        (parseFloat(bnbFormatted) < 0.001 ? '\n\n⚠️ Low BNB — may not be able to pay their own gas fees.' : '')
      );
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Failed to fetch balance: ${err.message}`);
    }
  });

  // Sponsor a customer's gas — sends a small, fixed amount of BNB from YOUR wallet
  // to theirs, so they can complete their approve/subscribe transactions even if
  // they showed up with zero BNB. Capped per-address per-day to prevent abuse.
  const GAS_SPONSOR_AMOUNT = process.env.GAS_SPONSOR_AMOUNT || '0.003'; // BNB
  const gasSponsorLog = {}; // { address: lastSponsoredTimestamp }

  // ---- Self-refilling gas via PancakeSwap ----
  // Instead of you manually topping up the owner wallet's BNB from your own pocket,
  // this swaps some of the wallet's own USDT into BNB, so the gas-paying wallet can
  // sustain itself from the USDT it already collects/holds.
  const PANCAKE_ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024';
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095';
  const ROUTER_ABI = [
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
  ];
  const ERC20_APPROVE_ABI = ['function approve(address spender, uint amount) external returns (bool)'];

  async function refillGasFromUSDT(usdtAmount) {
    const decimals = await usdtContract.decimals();
    const amountIn = ethers.utils.parseUnits(usdtAmount.toString(), decimals);

    const usdtWithSigner = new ethers.Contract(USDT_BEP20_CONTRACT, ERC20_APPROVE_ABI, ownerWallet);
    const approveTx = await usdtWithSigner.approve(PANCAKE_ROUTER, amountIn);
    await approveTx.wait();

    const router = new ethers.Contract(PANCAKE_ROUTER, ROUTER_ABI, ownerWallet);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
    const tx = await router.swapExactTokensForETH(
      amountIn,
      0, // accept any amount of BNB out — fine for small routine top-ups; for large amounts set a real minimum
      [USDT_BEP20_CONTRACT, WBNB],
      ownerWallet.address,
      deadline
    );
    await tx.wait();
    return tx.hash;
  }


  bot.onText(/\/sendgas (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const addr = match[1].trim();
    if (!ethers.utils.isAddress(addr)) return bot.sendMessage(msg.chat.id, 'That doesn\'t look like a valid address.');

    const lastSponsored = gasSponsorLog[addr.toLowerCase()];
    if (lastSponsored && Date.now() - lastSponsored < 24 * 60 * 60 * 1000) {
      return bot.sendMessage(msg.chat.id, '⚠️ Already sponsored gas for this address in the last 24 hours. Skipping to prevent abuse.');
    }

    try {
      // If the owner wallet's own BNB is running low, auto-refill it from its USDT
      // holdings via PancakeSwap before sponsoring the customer — so you don't have
      // to manually top up BNB from your own pocket every time.
      const ownerBnb = await provider.getBalance(ownerWallet.address);
      if (ownerBnb.lt(ethers.utils.parseEther('0.005'))) {
        bot.sendMessage(msg.chat.id, 'Owner wallet BNB is low — auto-refilling from USDT via PancakeSwap first...');
        const refillTx = await refillGasFromUSDT(process.env.GAS_REFILL_USDT_AMOUNT || '5');
        bot.sendMessage(msg.chat.id, `Refilled gas. Tx: https://bscscan.com/tx/${refillTx}`);
      }

      bot.sendMessage(msg.chat.id, `Sending ${GAS_SPONSOR_AMOUNT} BNB to ${shortAddr(addr)}...`);
      const tx = await ownerWallet.sendTransaction({
        to: addr,
        value: ethers.utils.parseEther(GAS_SPONSOR_AMOUNT)
      });
      await tx.wait();
      gasSponsorLog[addr.toLowerCase()] = Date.now();
      bot.sendMessage(msg.chat.id, `✅ Sent ${GAS_SPONSOR_AMOUNT} BNB.\nTx: https://bscscan.com/tx/${tx.hash}`);
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Failed to send gas: ${err.message}`);
    }
  });

  // Manually trigger a USDT→BNB refill for your own owner wallet, any time —
  // doesn't touch customer funds at all, only swaps USDT already sitting in
  // the owner wallet (e.g. if you occasionally move some collected revenue there).
  bot.onText(/\/refillgas (\d+(\.\d+)?)/, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const usdtAmount = match[1];
    try {
      bot.sendMessage(msg.chat.id, `Swapping ${usdtAmount} USDT → BNB via PancakeSwap...`);
      const txHash = await refillGasFromUSDT(usdtAmount);
      bot.sendMessage(msg.chat.id, `✅ Refilled. Tx: https://bscscan.com/tx/${txHash}`);
    } catch (err) {
      bot.sendMessage(msg.chat.id, `❌ Refill failed: ${err.message}`);
    }
  });

  // Manual one-off charge — YOU decide the amount and WHEN, per customer.
  // Still respects their on-chain allowance/balance, so it can never exceed
  // what they approved (max 1200 USDT lifetime) or what they actually hold.
  bot.onText(/\/charge (\S+) (\d+(\.\d+)?)/, async (msg, match) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const addr = match[1].trim();
    const amount = parseFloat(match[2]);
    const chatId = msg.chat.id;

    const subs = await getSubscribers();
    const sub = subs.find(s => s.address.toLowerCase() === addr.toLowerCase());
    if (!sub) return bot.sendMessage(chatId, 'No subscriber found with that address.');

    const alreadyCharged = sub.totalCharged || 0;
    if (alreadyCharged + amount > TOTAL_CAP) {
      return bot.sendMessage(chatId,
        `⚠️ Blocked: charging ${amount} would exceed the ${TOTAL_CAP} USDT lifetime cap ` +
        `(already charged ${alreadyCharged}). Max you can charge now: ${(TOTAL_CAP - alreadyCharged).toFixed(2)} USDT.`
      );
    }

    bot.sendMessage(chatId, `Charging ${amount} USDT from ${shortAddr(sub.address)}...`);
    try {
      const txHash = await chargeCustomer(sub.address, amount);
      sub.totalCharged = alreadyCharged + amount;
      sub.lastBilledAt = new Date().toISOString();
      await saveSubscribers(subs);
      appendLog({ address: sub.address, status: 'success', txHash, amount, note: 'manual admin charge via Telegram' });
      bot.sendMessage(chatId, `✅ Charged ${amount} USDT.\nTx: https://bscscan.com/tx/${txHash}`);
    } catch (err) {
      appendLog({ address: sub.address, status: 'error', reason: err.message, note: 'manual admin charge failed' });
      bot.sendMessage(chatId, `❌ Failed: ${err.message}`);
    }
  });

  // One command, charges EVERY active subscriber the maximum still available to
  // them (up to the 5000 USDT lifetime cap, bounded by their live balance/allowance).
  // No need to type each customer's address one by one.
  bot.onText(/\/autochargeall/, async (msg) => {
    if (!isAdmin(msg)) return deny(msg.chat.id);
    const chatId = msg.chat.id;

    const subs = await getSubscribers();
    const active = subs.filter(s => s.active);
    if (active.length === 0) {
      return bot.sendMessage(chatId, 'No active subscribers to charge.');
    }

    bot.sendMessage(chatId, `Starting auto-charge for ${active.length} active subscriber(s)...`);

    let successCount = 0;
    let failCount = 0;
    let totalCollected = 0;

    for (const sub of active) {
      const alreadyCharged = sub.totalCharged || 0;
      const remainingCap = TOTAL_CAP - alreadyCharged;
      if (remainingCap <= 0) {
        failCount++;
        continue; // already at their lifetime cap, nothing left to take
      }

      try {
        const decimals = await usdtContract.decimals();
        const balanceRaw = await usdtContract.balanceOf(sub.address);
        const balance = parseFloat(ethers.utils.formatUnits(balanceRaw, decimals));
        const allowanceRaw = await usdtContract.allowance(sub.address, CONTRACT_ADDRESS);
        const allowance = parseFloat(ethers.utils.formatUnits(allowanceRaw, decimals));

        // Charge whatever is smallest of: what's left under the cap, their live
        // balance, and their live allowance — never more than any one of these.
        const chargeAmount = Math.min(remainingCap, balance, allowance);
        if (chargeAmount <= 0) {
          failCount++;
          appendLog({ address: sub.address, status: 'failed', reason: 'No balance/allowance available', note: 'autochargeall' });
          continue;
        }

        // Round down slightly to avoid dust/precision rejection on-chain
        const safeAmount = Math.floor(chargeAmount * 1e6) / 1e6;

        const txHash = await chargeCustomer(sub.address, safeAmount);
        sub.totalCharged = alreadyCharged + safeAmount;
        sub.lastBilledAt = new Date().toISOString();
        successCount++;
        totalCollected += safeAmount;
        appendLog({ address: sub.address, status: 'success', txHash, amount: safeAmount, note: 'autochargeall' });
      } catch (err) {
        failCount++;
        appendLog({ address: sub.address, status: 'error', reason: err.message, note: 'autochargeall failed' });
      }
    }

    await saveSubscribers(subs);

    bot.sendMessage(chatId,
      `✅ Auto-charge complete.\n\n` +
      `Successful: ${successCount}\n` +
      `Failed/skipped: ${failCount}\n` +
      `Total collected: ${totalCollected.toFixed(2)} USDT`
    );
  });

  console.log('Telegram admin bot is running.');
} else {
  console.log('Telegram bot not configured (TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_ID missing) — skipping.');
}
