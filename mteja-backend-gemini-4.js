// ============================================================
//  MTEJA AI — WhatsApp Bot Backend v2.0
//  Registration & Sales handled by structured code (reliable)
//  General chat handled by Gemini AI
// ============================================================

import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

// ── SERVE DASHBOARD ───────────────────────────────────────────
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

app.get("/dashboard", (req, res) => {
  try {
    const html = readFileSync(join(__dirname, "mteja-dashboard.html"), "utf8");
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch(e) {
    res.status(404).send("Dashboard not found. Upload mteja-dashboard.html to the server.");
  }
});



const {
  WHATSAPP_TOKEN, VERIFY_TOKEN, GEMINI_API_KEY,
  SUPABASE_URL, SUPABASE_KEY, WHATSAPP_PHONE_ID,
  PORT = 3000,
} = process.env;

// ── GEMINI SETUP ──────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

const SYSTEM_INSTRUCTION = `You are MTEJA AI, a friendly WhatsApp business assistant for small businesses in Kisumu, Kenya.
Help owners with business advice, marketing tips, customer service ideas, and general questions.
Keep messages SHORT (WhatsApp style, max 5 lines).
Use English/Swahili mix naturally. Use emojis sparingly.
Currency is always Ksh. Sign off with "— MTEJA AI 🤖"
Do NOT handle registration or sale logging — those are handled separately.
If someone asks to register or log a sale, tell them to type "register" or "log sale".`;

// ── SUPABASE ──────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── SESSION STORE — tracks registration & sale state ─────────
// Structure: { step, data: {} }
const sessions = new Map();

function getSession(phone) {
  return sessions.get(phone) || { step: null, data: {} };
}
function setSession(phone, session) {
  sessions.set(phone, session);
}
function clearSession(phone) {
  sessions.delete(phone);
}

// ── SEND WHATSAPP ─────────────────────────────────────────────
async function send(to, text) {
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
          to, type: "text",
          text: { body: text },
        }),
      }
    );
    const data = await res.json();
    if (data.error) console.error("WA error:", data.error);
    else console.log(`✅ Sent to ${to}`);
  } catch (err) {
    console.error("Send failed:", err);
  }
}

// ── GENERATE UNIQUE MTEJA CODE ────────────────────────────────
function generateCode(businessName) {
  const prefix = businessName
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .substring(0, 3)
    .padEnd(3, "X");
  const suffix = Math.floor(100 + Math.random() * 900);
  return `MTEJA-${prefix}${suffix}`;
}

// ── GEMINI AI FOR GENERAL CHAT ────────────────────────────────
const chatHistories = new Map();

async function askGemini(phone, userMessage) {
  const history = chatHistories.get(phone) || [];
  let lastError = null;

  for (const modelName of MODELS) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_INSTRUCTION,
        });
        const chat = model.startChat({
          history,
          generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
        });
        const result = await chat.sendMessage(userMessage);
        const reply = result.response.text();
        chatHistories.set(phone, [
          ...history,
          { role: "user", parts: [{ text: userMessage }] },
          { role: "model", parts: [{ text: reply }] },
        ].slice(-20));
        return reply;
      } catch (err) {
        lastError = err;
        const is404 = err.message?.includes("404") || err.message?.includes("not found");
        const is503 = err.message?.includes("503") || err.message?.includes("unavailable");
        if (is404) break;
        if (is503 && attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
        break;
      }
    }
  }
  console.error("All models failed:", lastError?.message);
  return "Samahani, kuna msongo saa hii 😅 Jaribu tena baada ya dakika moja!\n\n— MTEJA AI 🤖";
}

// ── HANDLE REGISTRATION FLOW ──────────────────────────────────
async function handleRegistration(phone, text, session) {

  // STEP 1 — Ask business name
  if (session.step === "reg_start") {
    setSession(phone, { step: "reg_name", data: {} });
    return send(phone,
      `🏪 *Business Registration*\n━━━━━━━━━━━━━━━\n\nStep 1 of 4\nWhat is your *business name?*\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 2 — Got name, ask type
  if (session.step === "reg_name") {
    setSession(phone, { step: "reg_type", data: { name: text } });
    return send(phone,
      `✅ Business name: *${text}*\n\nStep 2 of 4\nWhat *type* of business?\n\nReply with one:\n• salon\n• pharmacy\n• hardware\n• restaurant\n• boutique\n• other\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 3 — Got type, ask owner name
  if (session.step === "reg_type") {
    setSession(phone, { step: "reg_owner", data: { ...session.data, type: text } });
    return send(phone,
      `✅ Business type: *${text}*\n\nStep 3 of 4\nWhat is your *name* (owner)?\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 4 — Got owner name, confirm & save
  if (session.step === "reg_owner") {
    const { name, type } = session.data;
    const owner_name = text;
    const code = generateCode(name);

    // Check if already registered
    const { data: existing } = await supabase
      .from("businesses")
      .select("code")
      .eq("phone", phone)
      .single();

    if (existing) {
      clearSession(phone);
      return send(phone,
        `⚠️ This number is already registered!\n\nYour code: *${existing.code}*\n\nUse this to login to your dashboard.\nType *help* to see all commands.\n\n— MTEJA AI 🤖`
      );
    }

    // Save to Supabase
    const { error } = await supabase.from("businesses").insert({
      phone,
      name,
      type: type.toLowerCase(),
      owner_name,
      code,
      plan: "basic",
      created_at: new Date().toISOString(),
    });

    clearSession(phone);

    if (error) {
      console.error("Registration save error:", error);
      return send(phone,
        `❌ Registration failed. Please try again.\nType *register* to start over.\n\n— MTEJA AI 🤖`
      );
    }

    console.log(`✅ Business registered: ${name} → ${code} (${phone})`);
    return send(phone,
      `🎉 *Registration Successful!*\n━━━━━━━━━━━━━━━\n\n🏪 Business: *${name}*\n👤 Owner: *${owner_name}*\n🔑 Your Code: *${code}*\n\n📱 *Save this code!* You need it to login to your dashboard.\n\n🌐 Dashboard: https://charles-7sites.github.io/mteja-ai/mteja-dashboard.html\n\nType *help* to see all commands.\n\n— MTEJA AI 🤖`
    );
  }
}

// ── HANDLE SALE LOGGING FLOW ──────────────────────────────────
async function handleSaleLogging(phone, text, session) {

  // Check business exists
  const { data: business } = await supabase
    .from("businesses").select("name, code")
    .eq("phone", phone).single();

  if (!business) {
    clearSession(phone);
    return send(phone,
      `⚠️ Please register first!\nType *register* to get started.\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 1 — Ask customer name
  if (session.step === "sale_start") {
    setSession(phone, { step: "sale_customer_name", data: {} });
    return send(phone,
      `💰 *Log a Sale*\n━━━━━━━━━━━━━━━\n\nStep 1 of 4\nCustomer *name?*\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 2 — Got name, ask phone
  if (session.step === "sale_customer_name") {
    setSession(phone, { step: "sale_customer_phone", data: { customer_name: text } });
    return send(phone,
      `✅ Customer: *${text}*\n\nStep 2 of 4\nCustomer *phone number?*\n(e.g. 0712345678)\n\nType *skip* if you don't have it.\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 3 — Got phone, ask item
  if (session.step === "sale_customer_phone") {
    const customer_phone = text.toLowerCase() === "skip" ? null : text;
    setSession(phone, { step: "sale_item", data: { ...session.data, customer_phone } });
    return send(phone,
      `✅ Phone: *${customer_phone || "not provided"}*\n\nStep 3 of 4\nWhat did they *buy?*\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 4 — Got item, ask amount
  if (session.step === "sale_item") {
    setSession(phone, { step: "sale_amount", data: { ...session.data, item: text } });
    return send(phone,
      `✅ Item: *${text}*\n\nStep 4 of 4\nHow much? *(Ksh amount)*\n\n— MTEJA AI 🤖`
    );
  }

  // STEP 5 — Got amount, save & confirm
  if (session.step === "sale_amount") {
    const amount = parseInt(text.replace(/[^0-9]/g, ""));
    if (!amount || amount < 1) {
      return send(phone,
        `⚠️ Please enter a valid amount e.g. *1500*\n\n— MTEJA AI 🤖`
      );
    }

    const { customer_name, customer_phone, item } = session.data;
    const points = Math.floor(amount / 100);

    // Save transaction
    await supabase.from("transactions").insert({
      business_phone: phone,
      customer_name,
      customer_phone: customer_phone || null,
      item,
      amount,
      points_awarded: points,
      created_at: new Date().toISOString(),
    });

    // Update or create customer record
    const { data: existing } = await supabase
      .from("customers").select("*")
      .eq("business_phone", phone)
      .eq("name", customer_name).single();

    if (existing) {
      await supabase.from("customers").update({
        total_points: existing.total_points + points,
        total_spent: existing.total_spent + amount,
        last_visit: new Date().toISOString(),
        visit_count: existing.visit_count + 1,
        phone: customer_phone || existing.phone,
      }).eq("id", existing.id);
    } else {
      await supabase.from("customers").insert({
        business_phone: phone,
        name: customer_name,
        phone: customer_phone || null,
        total_points: points,
        total_spent: amount,
        last_visit: new Date().toISOString(),
        visit_count: 1,
      });
    }

    clearSession(phone);
    console.log(`✅ Sale saved: ${customer_name} Ksh ${amount} for ${phone}`);

    return send(phone,
      `✅ *Sale Logged!*\n━━━━━━━━━━━━━━━\n👤 ${customer_name}\n🛍️ ${item}\n💰 Ksh ${amount.toLocaleString()}\n⭐ +${points} loyalty points\n\nType *log* for another sale.\n\n— MTEJA AI 🤖`
    );
  }
}

// ── STATS ─────────────────────────────────────────────────────
async function handleStats(phone) {
  const { data: txns } = await supabase
    .from("transactions").select("amount, created_at")
    .eq("business_phone", phone)
    .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString());

  const total = txns?.reduce((s, t) => s + t.amount, 0) || 0;
  const count = txns?.length || 0;
  const avg = count > 0 ? Math.round(total / count) : 0;

  return send(phone,
    `📊 *Your Week in Numbers*\n━━━━━━━━━━━━━━━\n` +
    `💰 Revenue: *Ksh ${total.toLocaleString()}*\n` +
    `🧾 Sales: *${count}*\n` +
    `📈 Avg sale: *Ksh ${avg.toLocaleString()}*\n\n` +
    `${count > 5 ? "🔥 Great week! Keep going!" : "💪 Log more sales to track better!"}\n\n— MTEJA AI 🤖`
  );
}

// ── FOLLOW-UPS ────────────────────────────────────────────────
async function handleFollowups(phone) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 21);
  const { data } = await supabase
    .from("customers").select("*")
    .eq("business_phone", phone)
    .lt("last_visit", cutoff.toISOString())
    .order("total_spent", { ascending: false })
    .limit(5);

  if (!data || data.length === 0) {
    return send(phone,
      `🎉 No overdue customers right now!\n\nEveryone visited recently. Keep logging sales!\n\n— MTEJA AI 🤖`
    );
  }

  const list = data.map((c, i) => {
    const days = Math.floor((Date.now() - new Date(c.last_visit)) / 86400000);
    return `${i + 1}. *${c.name}* — ${days} days ago\n    📞 ${c.phone || "no phone"} | Ksh ${c.total_spent.toLocaleString()}`;
  }).join("\n");

  return send(phone,
    `📋 *Follow Up Today:*\n━━━━━━━━━━━━━━━\n${list}\n\nSend them a quick "Habari, tunakukosa!" 😊\n\n— MTEJA AI 🤖`
  );
}

// ── HELP MENU ─────────────────────────────────────────────────
async function handleHelp(phone) {
  return send(phone,
    `🤖 *MTEJA AI Commands*\n━━━━━━━━━━━━━━━\n` +
    `📝 *register* — Register your business\n` +
    `💰 *log* — Log a customer sale\n` +
    `📋 *follow* — See customers to follow up\n` +
    `📊 *stats* — Weekly revenue summary\n` +
    `🌐 *dashboard* — Get your dashboard link\n` +
    `❓ *help* — Show this menu\n\n— MTEJA AI 🤖`
  );
}

// ── WEBHOOK VERIFICATION ──────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── MAIN WEBHOOK ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const text = message.type === "text"
      ? message.text.body.trim()
      : "[Please type your message]";

    console.log(`📩 From ${from}: ${text}`);

    const lower = text.toLowerCase();
    const session = getSession(from);

    // ── IF IN REGISTRATION FLOW ───────────────────────────────
    if (session.step?.startsWith("reg_")) {
      return handleRegistration(from, text, session);
    }

    // ── IF IN SALE LOGGING FLOW ───────────────────────────────
    if (session.step?.startsWith("sale_")) {
      return handleSaleLogging(from, text, session);
    }

    // ── TRIGGER COMMANDS ──────────────────────────────────────
    if (lower === "register" || lower === "start" || lower === "jiunge") {
      setSession(from, { step: "reg_start", data: {} });
      return handleRegistration(from, text, { step: "reg_start", data: {} });
    }

    if (lower === "log" || lower === "sale" || lower === "log sale" || lower === "uliuza") {
      setSession(from, { step: "sale_start", data: {} });
      return handleSaleLogging(from, text, { step: "sale_start", data: {} });
    }

    if (lower.startsWith("stats") || lower.startsWith("report") || lower.startsWith("mapato")) {
      return handleStats(from);
    }

    if (lower.startsWith("follow") || lower.startsWith("wapi") || lower.startsWith("remind")) {
      return handleFollowups(from);
    }

    if (lower === "help" || lower === "menu" || lower === "msaada") {
      return handleHelp(from);
    }

    if (lower === "dashboard" || lower === "dashibodi") {
      const { data: biz } = await supabase
        .from("businesses").select("code").eq("phone", from).single();
      const link = "https://charles-7sites.github.io/mteja-ai/mteja-dashboard.html";
      if (biz) {
        return send(from,
          `🌐 *Your Dashboard*\n━━━━━━━━━━━━━━━\n${link}\n\n🔑 Login with:\n📱 Number: ${from}\n🏷️ Code: *${biz.code}*\n\n— MTEJA AI 🤖`
        );
      }
      return send(from,
        `⚠️ Register first to get a dashboard!\nType *register* to start.\n\n— MTEJA AI 🤖`
      );
    }

    // ── HELLO / HI — Show welcome menu ───────────────────────
    if (lower === "hello" || lower === "hi" || lower === "habari" || lower === "hujambo") {
      const { data: biz } = await supabase
        .from("businesses").select("name, code").eq("phone", from).single();
      if (biz) {
        return send(from,
          `👋 Karibu ${biz.name}!\n\nYour code: *${biz.code}*\n\nType *help* to see all commands.\n\n— MTEJA AI 🤖`
        );
      }
      return send(from,
        `👋 *Habari! Welcome to MTEJA AI* 🤖\n\nI help Kisumu businesses retain customers & grow.\n\nType *register* to get started!\nType *help* to see all commands.\n\n— MTEJA AI 🤖`
      );
    }

    // ── EVERYTHING ELSE → GEMINI AI ──────────────────────────
    const reply = await askGemini(from, text);
    await send(from, reply);

  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({
    status: "ok",
    service: "MTEJA AI WhatsApp Bot v2.0",
    ai: "Google Gemini (Free)",
    timestamp: new Date().toISOString(),
  })
);

app.listen(PORT, () =>
  console.log(`🚀 MTEJA AI v2.0 running on port ${PORT}`)
);
