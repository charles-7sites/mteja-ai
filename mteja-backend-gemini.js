import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const { WHATSAPP_TOKEN, VERIFY_TOKEN, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_KEY, WHATSAPP_PHONE_ID, PORT = 3000 } = process.env;

// Test connections on startup
console.log("Starting MTEJA AI...");
console.log("GEMINI_API_KEY set:", !!GEMINI_API_KEY);
console.log("SUPABASE_URL set:", !!SUPABASE_URL);
console.log("WHATSAPP_TOKEN set:", !!WHATSAPP_TOKEN);

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sessions = new Map();

function genCode(n) {
  return "MTEJA-" + n.toUpperCase().replace(/[^A-Z]/g,"").substring(0,3).padEnd(3,"X") + Math.floor(100+Math.random()*900);
}

async function send(to, body) {
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } })
    });
    const d = await r.json();
    d.error ? console.error("WA error:", d.error) : console.log("Sent to", to);
  } catch(e) { console.error("Send failed:", e.message); }
}

async function askGemini(phone, msg) {
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];
  for (const m of models) {
    try {
      const model = genAI.getGenerativeModel({ model: m });
      const result = await model.generateContent("You are MTEJA AI for Kisumu SMEs. Be brief (max 4 lines). Mix English/Swahili. Sign off with — MTEJA AI 🤖\n\nUser: " + msg);
      return result.response.text();
    } catch(e) { console.log("Model", m, "failed:", e.message); }
  }
  return "Samahani, jaribu tena! 😅\n\n— MTEJA AI 🤖";
}

function getS(p) { return sessions.get(p) || { step: null, data: {} }; }
function setS(p, s) { sessions.set(p, s); }
function clearS(p) { sessions.delete(p); }

async function handleReg(phone, text, s) {
  if(s.step === "r1") { setS(phone,{step:"r2",data:{}}); return send(phone,"🏪 *Registration*\nStep 1/3: Business *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step === "r2") { setS(phone,{step:"r3",data:{name:text}}); return send(phone,`✅ Name: *${text}*\nStep 2/3: Business *type?*\n(salon/pharmacy/hardware/restaurant/other)\n\n— MTEJA AI 🤖`); }
  if(s.step === "r3") { setS(phone,{step:"r4",data:{...s.data,type:text}}); return send(phone,`✅ Type: *${text}*\nStep 3/3: Owner *name?*\n\n— MTEJA AI 🤖`); }
  if(s.step === "r4") {
    const {name,type} = s.data;
    const {data:ex} = await supabase.from("businesses").select("code").eq("phone",phone).single();
    if(ex) { clearS(phone); return send(phone,`⚠️ Already registered!\nCode: *${ex.code}*\nType *dashboard* for your link.\n\n— MTEJA AI 🤖`); }
    const code = genCode(name);
    await supabase.from("businesses").insert({phone,name,type:type.toLowerCase(),owner_name:text,code,plan:"basic",created_at:new Date().toISOString()});
    clearS(phone);
    return send(phone,`🎉 *Registered!*\n🏪 ${name}\n👤 ${text}\n🔑 Code: *${code}*\n\nType *dashboard* for your link.\n\n— MTEJA AI 🤖`);
  }
}

async function handleSale(phone, text, s) {
  const {data:biz} = await supabase.from("businesses").select("name").eq("phone",phone).single();
  if(!biz) { clearS(phone); return send(phone,"⚠️ Register first! Type *register*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s1") { setS(phone,{step:"s2",data:{}}); return send(phone,"💰 *Log Sale*\nStep 1/4: Customer *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s2") { setS(phone,{step:"s3",data:{cn:text}}); return send(phone,`✅ ${text}\nStep 2/4: Customer *phone?*\n(Type *skip* if unknown)\n\n— MTEJA AI 🤖`); }
  if(s.step==="s3") { const cp=text.toLowerCase()==="skip"?null:text; setS(phone,{step:"s4",data:{...s.data,cp}}); return send(phone,`✅ Phone saved\nStep 3/4: What did they *buy?*\n\n— MTEJA AI 🤖`); }
  if(s.step==="s4") { setS(phone,{step:"s5",data:{...s.data,item:text}}); return send(phone,`✅ Item: ${text}\nStep 4/4: *Amount?* (Ksh)\n\n— MTEJA AI 🤖`); }
  if(s.step==="s5") {
    const amount = parseInt(text.replace(/[^0-9]/g,""));
    if(!amount) return send(phone,"⚠️ Enter valid amount e.g. *1500*\n\n— MTEJA AI 🤖");
    const {cn,cp,item} = s.data;
    const pts = Math.floor(amount/100);
    await supabase.from("transactions").insert({business_phone:phone,customer_name:cn,customer_phone:cp||null,item,amount,points_awarded:pts,created_at:new Date().toISOString()});
    const {data:ex} = await supabase.from("customers").select("*").eq("business_phone",phone).eq("name",cn).single();
    if(ex) await supabase.from("customers").update({total_points:ex.total_points+pts,total_spent:ex.total_spent+amount,last_visit:new Date().toISOString(),visit_count:ex.visit_count+1,phone:cp||ex.phone}).eq("id",ex.id);
    else await supabase.from("customers").insert({business_phone:phone,name:cn,phone:cp||null,total_points:pts,total_spent:amount,last_visit:new Date().toISOString(),visit_count:1});
    clearS(phone);
    return send(phone,`✅ *Sale Logged!*\n👤 ${cn}\n🛍️ ${item}\n💰 Ksh ${amount.toLocaleString()}\n⭐ +${pts} pts\n\n— MTEJA AI 🤖`);
  }
}

app.get("/webhook", (req,res) => {
  req.query["hub.mode"]==="subscribe" && req.query["hub.verify_token"]===VERIFY_TOKEN
    ? res.send(req.query["hub.challenge"]) : res.sendStatus(403);
});

app.post("/webhook", async (req,res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg) return;
    const from = msg.from;
    const text = msg.type==="text" ? msg.text.body.trim() : "[type your message]";
    console.log(`MSG from ${from}: ${text}`);
    const lower = text.toLowerCase();
    const s = getS(from);

    if(s.step?.startsWith("r")) return handleReg(from,text,s);
    if(s.step?.startsWith("s")) return handleSale(from,text,s);

    if(lower==="register"||lower==="jiunge") { setS(from,{step:"r1",data:{}}); return handleReg(from,text,{step:"r1",data:{}}); }
    if(lower==="log"||lower==="sale") { setS(from,{step:"s1",data:{}}); return handleSale(from,text,{step:"s1",data:{}}); }

    if(lower.startsWith("stats")||lower.startsWith("report")) {
      const {data:t} = await supabase.from("transactions").select("amount").eq("business_phone",from).gte("created_at",new Date(Date.now()-7*86400000).toISOString());
      const tot=t?.reduce((s,x)=>s+x.amount,0)||0;
      return send(from,`📊 *This Week*\n💰 Ksh ${tot.toLocaleString()}\n🧾 ${t?.length||0} sales\n\n— MTEJA AI 🤖`);
    }
    if(lower.startsWith("follow")) {
      const cut=new Date(); cut.setDate(cut.getDate()-21);
      const {data:c} = await supabase.from("customers").select("name,phone,last_visit").eq("business_phone",from).lt("last_visit",cut.toISOString()).limit(5);
      if(!c?.length) return send(from,"🎉 No overdue customers!\n\n— MTEJA AI 🤖");
      return send(from,"📋 *Follow Up:*\n"+c.map((x,i)=>`${i+1}. *${x.name}* 📞 ${x.phone||"no phone"}`).join("\n")+"\n\n— MTEJA AI 🤖");
    }
    if(lower==="dashboard") {
      const {data:b} = await supabase.from("businesses").select("code").eq("phone",from).single();
      if(b) return send(from,`🌐 *Your Dashboard*\nhttps://charles-7sites.github.io/mteja-ai/dashboard.html\n\n🔑 Login:\n📱 ${from}\n🏷️ *${b.code}*\n\n— MTEJA AI 🤖`);
      return send(from,"Type *register* first!\n\n— MTEJA AI 🤖");
    }
    if(lower==="help"||lower==="menu") return send(from,"🤖 *Commands*\n📝 register\n💰 log\n📋 follow\n📊 stats\n🌐 dashboard\n❓ help\n\n— MTEJA AI 🤖");
    if(lower==="hello"||lower==="hi"||lower==="habari") {
      const {data:b} = await supabase.from("businesses").select("name,code").eq("phone",from).single();
      return send(from, b ? `👋 Karibu ${b.name}!\nCode: *${b.code}*\nType *help* for commands.\n\n— MTEJA AI 🤖` : "👋 Welcome to MTEJA AI!\nType *register* to start.\n\n— MTEJA AI 🤖");
    }
    await send(from, await askGemini(from,text));
  } catch(e) { console.error("Webhook error:",e.message); }
});

app.get("/health", (_,res) => res.json({status:"ok",node:process.version,time:new Date().toISOString()}));

app.listen(PORT, () => console.log(`🚀 MTEJA AI running on port ${PORT} (Node ${process.version})`));
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


// ── SAVE BUSINESS REGISTRATION TO SUPABASE ───────────────────
async function saveBusinessIfNew(phone, reply, history) {
  if (!reply.includes("MTEJA-")) return;
  const codeMatch = reply.match(/MTEJA-[A-Z0-9]+/);
  if (!codeMatch) return;
  const code = codeMatch[0];
  const { data: existing } = await supabase
    .from("businesses").select("id").eq("phone", phone).single();
  if (existing) return;
  const fullConvo = history.map(h => h.parts?.[0]?.text || "").join(" ");
  const nameMatch = fullConvo.match(/Business name[:\s]+([A-Za-z\s&]+)/i) ||
                    fullConvo.match(/jina.*?[:\s]+([A-Za-z\s&]+)/i);
  const typeMatch = fullConvo.match(/salon|pharmacy|hardware|restaurant|boutique|referral|agency|duka|shop/i);
  const ownerMatch = fullConvo.match(/owner[:\s]+([A-Za-z\s]+)/i);
  const name = nameMatch?.[1]?.trim() || "Business";
  const type = typeMatch?.[0]?.toLowerCase() || "other";
  const owner_name = ownerMatch?.[1]?.trim() || "";
  await supabase.from("businesses").insert({
    phone, name, type, owner_name, code, plan: "basic",
    created_at: new Date().toISOString(),
  });
  console.log(`✅ Business saved: ${name} → ${code}`);
}

// ── SAVE TRANSACTION WHEN BOT CONFIRMS SALE ──────────────────
async function saveTransactionIfLogged(phone, reply, history) {
  const isConfirmation =
    reply.toLowerCase().includes("asante") ||
    reply.toLowerCase().includes("logged") ||
    reply.toLowerCase().includes("imehifadhiwa") ||
    reply.toLowerCase().includes("recorded") ||
    reply.toLowerCase().includes("imeandikwa");
  if (!isConfirmation) return;
  const amountMatch = reply.match(/Ksh\s*([\d,]+)/i);
  if (!amountMatch) return;
  const amount = parseInt(amountMatch[1].replace(/,/g, ""));
  if (!amount || amount < 10) return;
  const recentConvo = history.slice(-8).map(h => h.parts?.[0]?.text || "").join(" ");
  const nameMatch = recentConvo.match(/(?:^|\s)([A-Z][a-z]+ [A-Z][a-z]+)/m);
  const customer_name = nameMatch?.[1]?.trim() || "Customer";
  const phoneMatch = recentConvo.match(/0[17]\d{8}/);
  const customer_phone = phoneMatch?.[0] || null;
  const itemMatch = recentConvo.match(/(?:bought|alinunua|item)[:\s]+([A-Za-z\s]+)/i);
  const item = itemMatch?.[1]?.trim() || "Sale";
  await logTransaction({ business_phone: phone, customer_name, customer_phone, item, amount });
  console.log(`✅ Transaction saved: ${customer_name} Ksh ${amount}`);
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

    // Auto-save to Supabase based on bot reply
    const currentHistory = conversations.get(from) || [];
    await saveBusinessIfNew(from, reply, currentHistory);
    await saveTransactionIfLogged(from, reply, currentHistory);

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
