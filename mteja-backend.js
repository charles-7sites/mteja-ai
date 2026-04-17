// ============================================================
//  MTEJA AI — WhatsApp Bot Backend
//  Stack: Node.js + Express + Meta WhatsApp API + Claude API
//  Deploy to: Railway.app or Render.com
// ============================================================

import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ── ENV VARIABLES (set in Railway dashboard) ─────────────────
const {
  WHATSAPP_TOKEN,        // Meta WhatsApp API token
  VERIFY_TOKEN,          // Your custom webhook verify token
  ANTHROPIC_API_KEY,     // Claude API key
  SUPABASE_URL,
  SUPABASE_KEY,
  PORT = 3000,
} = process.env;

const claude  = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── MTEJA AI SYSTEM PROMPT ────────────────────────────────────
const SYSTEM_PROMPT = `You are MTEJA AI, a WhatsApp business assistant for small businesses in Kisumu, Kenya.
Help owners log customer sales, track follow-ups, and grow their business.

RULES:
- Keep messages SHORT (WhatsApp style, max 5 lines)
- Use English/Swahili mix naturally
- Use emojis sparingly but warmly
- Customer names should be Kisumu names: Achieng, Otieno, Akinyi, Odhiambo, Adhiambo, Nafula, etc.
- Currency is always Ksh
- Sign off with "— MTEJA AI 🤖"

COMMANDS YOU HANDLE:
- "register" / "start" → Business registration flow
- "log" / "sale" → Log a customer transaction
- "follow" / "follow up" → List customers to contact today
- "stats" / "report" → Weekly business summary
- "help" / "menu" → Show all commands
- "loyalty [phone]" → Check a customer's loyalty points

For registration, collect: business name, type, owner name → assign code MTEJA-XXX
For logging sale, collect: customer name/phone, item bought, amount in Ksh → award 1 point per Ksh 100
For follow-ups, list 3 customers overdue (18-25 days) with suggested message`;

// ── IN-MEMORY CONVERSATION STORE (replace with Supabase in prod) ──
const conversations = new Map();

function getHistory(phone) {
  return conversations.get(phone) || [];
}

function saveHistory(phone, history) {
  // Keep last 20 messages to stay within token limits
  conversations.set(phone, history.slice(-20));
}

// ── SEND WHATSAPP MESSAGE ─────────────────────────────────────
async function sendWhatsApp(to, text) {
  const phone_id = process.env.WHATSAPP_PHONE_ID;
  await fetch(`https://graph.facebook.com/v18.0/${phone_id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

// ── LOG TRANSACTION TO SUPABASE ───────────────────────────────
async function logTransaction({ business_phone, customer_name, customer_phone, item, amount }) {
  const points = Math.floor(amount / 100);
  await supabase.from("transactions").insert({
    business_phone,
    customer_name,
    customer_phone: customer_phone || null,
    item,
    amount,
    points_awarded: points,
    created_at: new Date().toISOString(),
  });

  // Update or create customer record
  const { data: existing } = await supabase
    .from("customers")
    .select("*")
    .eq("business_phone", business_phone)
    .eq("phone", customer_phone)
    .single();

  if (existing) {
    await supabase
      .from("customers")
      .update({
        total_points: existing.total_points + points,
        total_spent: existing.total_spent + amount,
        last_visit: new Date().toISOString(),
        visit_count: existing.visit_count + 1,
      })
      .eq("id", existing.id);
  } else {
    await supabase.from("customers").insert({
      business_phone,
      name: customer_name,
      phone: customer_phone || null,
      total_points: points,
      total_spent: amount,
      last_visit: new Date().toISOString(),
      visit_count: 1,
    });
  }
  return points;
}

// ── GET OVERDUE CUSTOMERS (for follow-up list) ────────────────
async function getOverdueCustomers(business_phone, days = 21) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data } = await supabase
    .from("customers")
    .select("*")
    .eq("business_phone", business_phone)
    .lt("last_visit", cutoff.toISOString())
    .order("total_spent", { ascending: false })
    .limit(5);

  return data || [];
}

// ── CALL CLAUDE API ───────────────────────────────────────────
async function askClaude(phone, userMessage) {
  const history = getHistory(phone);
  const newHistory = [...history, { role: "user", content: userMessage }];

  const response = await claude.messages.create({
    model: "claude-haiku-4-5-20251001", // Fast + cheap for WhatsApp
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: newHistory,
  });

  const reply = response.content[0]?.text || "Samahani, kuna hitilafu. Jaribu tena! 🙏";
  saveHistory(phone, [...newHistory, { role: "assistant", content: reply }]);
  return reply;
}

// ── WEBHOOK VERIFICATION ──────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── MAIN WEBHOOK — RECEIVES MESSAGES ─────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    if (!message) return;

    const from = message.from; // sender's phone number
    const text = message.type === "text"
      ? message.text.body.trim()
      : message.type === "audio"
        ? "[Voice message — please type your message]"
        : "[Unsupported message type]";

    console.log(`📩 From ${from}: ${text}`);

    // ── SHORTCUT COMMANDS (no AI needed) ─────────────────────
    const lower = text.toLowerCase();

    // Quick stats from DB
    if (lower.startsWith("stats") || lower.startsWith("report")) {
      const { data: txns } = await supabase
        .from("transactions")
        .select("amount, created_at")
        .eq("business_phone", from)
        .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString());

      const total  = txns?.reduce((s, t) => s + t.amount, 0) || 0;
      const count  = txns?.length || 0;
      const avg    = count > 0 ? Math.round(total / count) : 0;

      const statsMsg =
        `📊 *Your Week in Numbers*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💰 Revenue: *Ksh ${total.toLocaleString()}*\n` +
        `👥 Transactions: *${count}*\n` +
        `📈 Avg sale: *Ksh ${avg.toLocaleString()}*\n\n` +
        `${count > 5 ? "🔥 Great week! Keep going!" : "💪 Room to grow — log more sales!"}\n\n— MTEJA AI 🤖`;

      return sendWhatsApp(from, statsMsg);
    }

    // Follow-up list from DB
    if (lower.startsWith("follow") || lower.startsWith("wapi")) {
      const overdue = await getOverdueCustomers(from);
      if (overdue.length === 0) {
        return sendWhatsApp(from,
          "🎉 No overdue customers right now — everyone has visited recently!\n\nKeep logging sales to track visits.\n\n— MTEJA AI 🤖"
        );
      }
      const list = overdue.map((c, i) => {
        const days = Math.floor((Date.now() - new Date(c.last_visit)) / 86400000);
        return `${i + 1}. *${c.name}* — ${days} days ago (Ksh ${c.total_spent.toLocaleString()} total)`;
      }).join("\n");

      return sendWhatsApp(from,
        `📋 *Customers to Follow Up:*\n━━━━━━━━━━━━━━━\n${list}\n\nReply with a customer's number to send them a message! E.g. "message 1"\n\n— MTEJA AI 🤖`
      );
    }

    // ── ALL OTHER MESSAGES → CLAUDE AI ───────────────────────
    const reply = await askClaude(from, text);
    await sendWhatsApp(from, reply);

  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  service: "MTEJA AI WhatsApp Bot",
  timestamp: new Date().toISOString(),
}));

app.listen(PORT, () => console.log(`🚀 MTEJA AI running on port ${PORT}`));


/* ============================================================
   SUPABASE SCHEMA — run these in Supabase SQL editor
   ============================================================

CREATE TABLE businesses (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  type          TEXT,
  owner_name    TEXT,
  code          TEXT UNIQUE,
  plan          TEXT DEFAULT 'basic',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE customers (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_phone  TEXT NOT NULL,
  name            TEXT,
  phone           TEXT,
  total_points    INT DEFAULT 0,
  total_spent     INT DEFAULT 0,
  visit_count     INT DEFAULT 0,
  last_visit      TIMESTAMPTZ DEFAULT now(),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE transactions (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_phone  TEXT NOT NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  item            TEXT,
  amount          INT NOT NULL,
  points_awarded  INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Index for fast follow-up queries
CREATE INDEX idx_customers_business_visit
  ON customers(business_phone, last_visit);

============================================================
   DEPLOYMENT STEPS
   ============================================================

1. Push this code to GitHub

2. Go to railway.app → New Project → Deploy from GitHub

3. Add environment variables in Railway dashboard:
   WHATSAPP_TOKEN      = your Meta token
   WHATSAPP_PHONE_ID   = your WhatsApp number ID
   VERIFY_TOKEN        = any secret string you choose (e.g. "mteja2025")
   ANTHROPIC_API_KEY   = sk-ant-...
   SUPABASE_URL        = https://xxx.supabase.co
   SUPABASE_KEY        = your supabase anon key

4. Railway gives you a URL like: https://mteja-ai.up.railway.app

5. In Meta Developer Console:
   Webhook URL   → https://mteja-ai.up.railway.app/webhook
   Verify Token  → the same string you set in env

6. Subscribe to "messages" webhook field

7. Test by sending a WhatsApp message to your bot number!

============================================================ */
