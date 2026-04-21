// ============================================================
//  MTEJA AI — WhatsApp Bot Backend (Gemini Version - FREE)
//  Stack: Node.js + Express + Meta WhatsApp API + Google Gemini
//  Deploy to: Render.com (free)
// ============================================================

import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ── ENV VARIABLES ─────────────────────────────────────────────
const {
  WHATSAPP_TOKEN,
  VERIFY_TOKEN,
  GEMINI_API_KEY,
  SUPABASE_URL,
  SUPABASE_KEY,
  WHATSAPP_PHONE_ID,
  PORT = 3000,
} = process.env;

// ── GEMINI SETUP ──────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Fallback chain — tries each model in order if previous is overloaded
const MODELS = [
  "gemini-2.5-flash",       // Best free model — fast + smart
  "gemini-2.5-flash-lite",  // Cheapest + fastest fallback
  "gemini-2.0-flash",       // Older but reliable free fallback
  "gemini-2.0-flash-lite",  // Last resort — always available
];

const SYSTEM_INSTRUCTION = `You are MTEJA AI, a WhatsApp business assistant for small businesses in Kisumu, Kenya.
Help owners log customer sales, track follow-ups, and grow their business.

RULES:
- Keep messages SHORT (WhatsApp style, max 5 lines)
- Use English/Swahili mix naturally
- Use emojis sparingly but warmly
- Customer names should be Kisumu names: Achieng, Otieno, Akinyi, Odhiambo, Adhiambo, Nafula, etc.
- Currency is always Ksh
- Sign off with "— MTEJA AI 🤖"
- One business owner can only register ONE business per WhatsApp number
- If someone tries to register again, remind them of their existing business code and offer to update details instead

COMMANDS YOU HANDLE:
- "register" / "start" / "hello" → Business registration flow
- "log" / "sale" → Log a customer transaction
- "follow" / "follow up" → List customers to contact today
- "stats" / "report" → Weekly business summary
- "help" / "menu" → Show all commands

REGISTRATION FLOW (collect in this order):
1. Business name?
2. Business type? (salon/pharmacy/hardware/restaurant/boutique/other)
3. Owner name?
4. Assign code MTEJA-XXX → confirm registration

LOG SALE FLOW (collect ALL 4 steps in order — do not skip any):
1. Customer name?
2. Customer phone number? (e.g. 0712345678) — THIS IS MANDATORY, do not skip
3. What did they buy?
4. How much? (Ksh amount)
→ Confirm sale, award points (1 point per Ksh 100), show total points

FOLLOW-UP FLOW:
- List customers overdue (18-25 days) with their phone number and suggested message

HELP MENU:
- Show all commands clearly with examples`;

// ── SUPABASE SETUP ────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── CONVERSATION HISTORY STORE ────────────────────────────────
// Stores chat history per phone number for context
const conversations = new Map();

function getHistory(phone) {
  return conversations.get(phone) || [];
}

function saveHistory(phone, history) {
  conversations.set(phone, history.slice(-20)); // keep last 20 messages
}

// ── SEND WHATSAPP MESSAGE ─────────────────────────────────────
async function sendWhatsApp(to, text) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`,
      {
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
      }
    );
    const data = await res.json();
    if (data.error) console.error("WhatsApp send error:", data.error);
    else console.log(`✅ Sent to ${to}`);
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err);
  }
}

// ── CALL GEMINI WITH RETRY + FALLBACK ────────────────────────
async function askGemini(phone, userMessage) {
  const history = getHistory(phone);
  let lastError = null;

  // Try each model in order until one works
  for (const modelName of MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`🤖 Trying model: ${modelName} (attempt ${attempt})`);

        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_INSTRUCTION,
        });

        const chat = model.startChat({
          history,
          generationConfig: {
            maxOutputTokens: 300,
            temperature: 0.7,
          },
        });

        const result = await chat.sendMessage(userMessage);
        const reply = result.response.text();

        // Save updated history on success
        saveHistory(phone, [
          ...history,
          { role: "user", parts: [{ text: userMessage }] },
          { role: "model", parts: [{ text: reply }] },
        ]);

        console.log(`✅ Success with model: ${modelName}`);
        return reply;

      } catch (err) {
        lastError = err;
        const is503 = err.message?.includes("503") || err.message?.includes("unavailable") || err.message?.includes("high demand");
        const is404 = err.message?.includes("404") || err.message?.includes("not found");

        if (is404) {
          // Model doesn't exist — skip to next model immediately
          console.log(`⏭️ Model ${modelName} not found, trying next...`);
          break;
        }

        if (is503 && attempt < 3) {
          // Server overloaded — wait and retry same model
          const wait = attempt * 2000; // 2s, 4s
          console.log(`⏳ Model ${modelName} overloaded, retrying in ${wait/1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        // Other error — try next model
        console.log(`❌ Model ${modelName} failed: ${err.message}`);
        break;
      }
    }
  }

  // All models failed — send friendly error to user
  console.error("❌ All Gemini models failed:", lastError?.message);
  return "Samahani, kuna msongo mkubwa saa hii 😅 Tafadhali jaribu tena baada ya dakika moja!\n\n— MTEJA AI 🤖";
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

  // Update or create customer
  const { data: existing } = await supabase
    .from("customers")
    .select("*")
    .eq("business_phone", business_phone)
    .eq("name", customer_name)
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

// ── GET OVERDUE CUSTOMERS ─────────────────────────────────────
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

// ── GET WEEKLY STATS ──────────────────────────────────────────
async function getWeeklyStats(business_phone) {
  const { data: txns } = await supabase
    .from("transactions")
    .select("amount, created_at")
    .eq("business_phone", business_phone)
    .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString());

  const total = txns?.reduce((s, t) => s + t.amount, 0) || 0;
  const count = txns?.length || 0;
  const avg = count > 0 ? Math.round(total / count) : 0;

  return { total, count, avg };
}

// ── WEBHOOK VERIFICATION ──────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta");
    res.status(200).send(challenge);
  } else {
    console.log("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ── MAIN WEBHOOK — RECEIVES ALL MESSAGES ─────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Always respond immediately to Meta

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const text =
      message.type === "text"
        ? message.text.body.trim()
        : "[Please type your message in text]";

    console.log(`📩 From ${from}: ${text}`);

    const lower = text.toLowerCase();

    // ── STATS SHORTCUT ────────────────────────────────────────
    if (lower.startsWith("stats") || lower.startsWith("report") || lower.startsWith("mapato")) {
      const { total, count, avg } = await getWeeklyStats(from);
      return sendWhatsApp(
        from,
        `📊 *Your Week in Numbers*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💰 Revenue: *Ksh ${total.toLocaleString()}*\n` +
        `👥 Sales logged: *${count}*\n` +
        `📈 Avg per sale: *Ksh ${avg.toLocaleString()}*\n\n` +
        `${count > 5 ? "🔥 Great week! Keep pushing!" : "💪 Log more sales to track better!"}\n\n— MTEJA AI 🤖`
      );
    }

    // ── FOLLOW-UP SHORTCUT ────────────────────────────────────
    if (lower.startsWith("follow") || lower.startsWith("wapi") || lower.startsWith("remind")) {
      const overdue = await getOverdueCustomers(from);
      if (overdue.length === 0) {
        return sendWhatsApp(
          from,
          `🎉 No overdue customers right now!\n\nEveryone visited recently. Keep logging sales to stay on top.\n\n— MTEJA AI 🤖`
        );
      }
      const list = overdue
        .map((c, i) => {
          const days = Math.floor((Date.now() - new Date(c.last_visit)) / 86400000);
          return `${i + 1}. *${c.name}* — ${days} days ago (Ksh ${c.total_spent.toLocaleString()} spent)`;
        })
        .join("\n");

      return sendWhatsApp(
        from,
        `📋 *Follow Up Today:*\n━━━━━━━━━━━━━━━\n${list}\n\nSend them a message — a simple "Habari, tunakukosa!" goes a long way! 😊\n\n— MTEJA AI 🤖`
      );
    }

    // ── ALL OTHER MESSAGES → GEMINI AI ───────────────────────
    const reply = await askGemini(from, text);
    await sendWhatsApp(from, reply);

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({
    status: "ok",
    service: "MTEJA AI WhatsApp Bot",
    ai: "Google Gemini 1.5 Flash (Free)",
    timestamp: new Date().toISOString(),
  })
);

app.listen(PORT, () =>
  console.log(`🚀 MTEJA AI running on port ${PORT} — powered by Gemini`)
);
