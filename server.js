const express = require("express");
const crypto = require("crypto");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN, VERIFY_TOKEN, GEMINI_API_KEY,
  SUPABASE_URL, SUPABASE_KEY, WHATSAPP_PHONE_ID,
  PORT = 3000
} = process.env;

console.log("MTEJA AI starting...");
console.log("Keys loaded:", { gemini: !!GEMINI_API_KEY, supabase: !!SUPABASE_URL, wa: !!WHATSAPP_TOKEN });

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sessions = new Map();

function genCode(name) {
  const p = name.toUpperCase().replace(/[^A-Z]/g,"").substring(0,3).padEnd(3,"X");
  return "MTEJA-" + p + Math.floor(100 + Math.random() * 900);
}


// ── PHONE NORMALIZER ─────────────────────────────────────────
// Converts ANY format to uniform 254XXXXXXXXX (12 digits)
// Handles: 0712345678 → 254712345678
//          +254712345678 → 254712345678
//          254712345678 → 254712345678 (unchanged)
//          07123 4567 8 → 254712345678 (strips spaces)
function normalizePhone(raw) {
  if (!raw) return null;
  // Strip all non-digits
  let p = String(raw).replace(/[^0-9]/g, "");
  // 0XXXXXXXXX (10 digits starting with 0) → 254XXXXXXXXX
  if (p.length === 10 && p.startsWith("0")) {
    p = "254" + p.slice(1);
  }
  // 7XXXXXXXXX or 1XXXXXXXXX (9 digits, missing country code)
  if (p.length === 9 && (p.startsWith("7") || p.startsWith("1"))) {
    p = "254" + p;
  }
  // Already 254XXXXXXXXX (12 digits)
  if (p.length === 12 && p.startsWith("254")) {
    return p;
  }
  // Return null if unrecognized format
  console.warn("⚠️ Unrecognized phone format:", raw, "→ cleaned:", p);
  return p.length >= 9 ? p : null;
}

function getS(p) { return sessions.get(p) || { step: null, data: {} }; }
function setS(p, s) { sessions.set(p, s); }
function clearS(p) { sessions.delete(p); }

async function send(to, body) {
  try {
    const r = await fetch("https://graph.facebook.com/v18.0/" + WHATSAPP_PHONE_ID + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + WHATSAPP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } })
    });
    const d = await r.json();
    d.error ? console.error("WA:", d.error) : console.log("Sent to", to);
  } catch(e) { console.error("Send error:", e.message); }
}

async function askGemini(msg) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = "You are MTEJA AI for Kisumu SMEs. Be brief (max 4 lines). Mix English/Swahili. Sign off with — MTEJA AI 🤖\n\nUser says: " + msg;
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch(e) {
    console.error("Gemini error:", e.message);
    return "Samahani, jaribu tena! 😅\n\n— MTEJA AI 🤖";
  }
}

async function handleReg(phone, text, s) {
  if(s.step === "r1") { setS(phone,{step:"r2",data:{}}); return send(phone,"🏪 *Registration*\nStep 1/3: Business *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step === "r2") { setS(phone,{step:"r3",data:{name:text}}); return send(phone,"✅ Name: *"+text+"*\nStep 2/3: Business *type?*\n(salon/pharmacy/hardware/restaurant/other)\n\n— MTEJA AI 🤖"); }
  if(s.step === "r3") { setS(phone,{step:"r4",data:{...s.data,type:text}}); return send(phone,"✅ Type: *"+text+"*\nStep 3/3: Owner *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step === "r4") {
    const { name, type } = s.data;
    const { data: ex } = await supabase.from("businesses").select("code").eq("phone",phone).single();
    if(ex) { clearS(phone); return send(phone,"⚠️ Already registered!\nCode: *"+ex.code+"*\nType *dashboard* for link.\n\n— MTEJA AI 🤖"); }
    const code = genCode(name);
    const normPhone = normalizePhone(phone) || phone;
    await supabase.from("businesses").insert({ phone:normPhone, name, type: type.toLowerCase(), owner_name: text, code, plan: "basic", created_at: new Date().toISOString() });
    clearS(phone);
    console.log("Registered:", name, "→", code);
    return send(phone,"🎉 *Registered!*\n🏪 "+name+"\n👤 "+text+"\n🔑 Code: *"+code+"*\n\nType *dashboard* for your link.\n\n— MTEJA AI 🤖");
  }
}

async function handleSale(phone, text, s) {
  const { data: biz } = await supabase.from("businesses").select("name").eq("phone",phone).single();
  if(!biz) { clearS(phone); return send(phone,"⚠️ Register first! Type *register*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s1") { setS(phone,{step:"s2",data:{}}); return send(phone,"💰 *Log Sale*\nStep 1/4: Customer *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s2") { setS(phone,{step:"s3",data:{cn:text}}); return send(phone,"✅ "+text+"\nStep 2/4: Customer *phone?*\n(Type *skip* if unknown)\n\n— MTEJA AI 🤖"); }
  if(s.step==="s3") { const rawCp=text.toLowerCase()==="skip"?null:text; const cp=rawCp?normalizePhone(rawCp):null; setS(phone,{step:"s4",data:{...s.data,cp}}); return send(phone,"✅ Phone: *"+(cp||"skipped")+"*\nStep 3/4: What did they *buy?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s4") { setS(phone,{step:"s5",data:{...s.data,item:text}}); return send(phone,"✅ Item: "+text+"\nStep 4/4: *Amount?* (Ksh)\n\n— MTEJA AI 🤖"); }
  if(s.step==="s5") {
    const amount = parseInt(text.replace(/[^0-9]/g,""));
    if(!amount) return send(phone,"⚠️ Enter valid amount e.g. *1500*\n\n— MTEJA AI 🤖");
    const { cn, cp: rawCp2, item } = s.data;
    const cp2 = rawCp2 ? normalizePhone(rawCp2) : null; // Always normalize before saving
    const pts = Math.floor(amount/100);
    const normBizPhone = normalizePhone(phone) || phone;
    await supabase.from("transactions").insert({ business_phone:normBizPhone, customer_name:cn, customer_phone:cp2, item, amount, points_awarded:pts, created_at:new Date().toISOString() });
    const { data: ex } = await supabase.from("customers").select("*").eq("business_phone",normBizPhone).eq("name",cn).single();
    if(ex) await supabase.from("customers").update({ total_points:ex.total_points+pts, total_spent:ex.total_spent+amount, last_visit:new Date().toISOString(), visit_count:ex.visit_count+1, phone:cp2||ex.phone }).eq("id",ex.id);
    else await supabase.from("customers").insert({ business_phone:normBizPhone, name:cn, phone:cp2, total_points:pts, total_spent:amount, last_visit:new Date().toISOString(), visit_count:1 });
    clearS(phone);
    return send(phone,"✅ *Sale Logged!*\n👤 "+cn+"\n🛍️ "+item+"\n💰 Ksh "+amount.toLocaleString()+"\n⭐ +"+pts+" pts\n\n— MTEJA AI 🤖");
  }
}

app.get("/webhook", (req, res) => {
  req.query["hub.mode"]==="subscribe" && req.query["hub.verify_token"]===VERIFY_TOKEN
    ? res.send(req.query["hub.challenge"]) : res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg) return;
    const from = normalizePhone(msg.from) || msg.from;
    const text = msg.type==="text" ? msg.text.body.trim() : "[type your message]";
    console.log("MSG:", from, text);
    const lower = text.toLowerCase();
    const s = getS(from);

    if(s.step && s.step[0]==="r") return handleReg(from,text,s);
    if(s.step && s.step[0]==="s") return handleSale(from,text,s);

    if(lower==="register") { setS(from,{step:"r1",data:{}}); return handleReg(from,text,{step:"r1",data:{}}); }
    if(lower==="log"||lower==="sale") { setS(from,{step:"s1",data:{}}); return handleSale(from,text,{step:"s1",data:{}}); }
    if(lower==="stats"||lower==="report") {
      const { data: t } = await supabase.from("transactions").select("amount").eq("business_phone",from).gte("created_at",new Date(Date.now()-7*86400000).toISOString());
      const tot = t ? t.reduce((s,x)=>s+x.amount,0) : 0;
      return send(from,"📊 *This Week*\n💰 Ksh "+tot.toLocaleString()+"\n🧾 "+(t?t.length:0)+" sales\n\n— MTEJA AI 🤖");
    }
    if(lower==="follow") {
      const cut = new Date(); cut.setDate(cut.getDate()-21);
      const { data: c } = await supabase.from("customers").select("name,phone").eq("business_phone",from).lt("last_visit",cut.toISOString()).limit(5);
      if(!c||!c.length) return send(from,"🎉 No overdue customers!\n\n— MTEJA AI 🤖");
      return send(from,"📋 *Follow Up:*\n"+c.map((x,i)=>(i+1)+". *"+x.name+"* 📞 "+(x.phone||"no phone")).join("\n")+"\n\n— MTEJA AI 🤖");
    }
    if(lower==="dashboard") {
      const { data: b } = await supabase.from("businesses").select("code").eq("phone",from).single();
      if(b) return send(from,"🌐 *Dashboard*\nhttps://charles-7sites.github.io/mteja-ai/dashboard.html\n\n🔑 Login:\n📱 "+from+"\n🏷️ *"+b.code+"*\n\n— MTEJA AI 🤖");
      return send(from,"Type *register* first!\n\n— MTEJA AI 🤖");
    }
    if(lower==="help"||lower==="menu") return send(from,"🤖 *Commands*\nregister | log | follow | stats | dashboard | help\n\n— MTEJA AI 🤖");
    if(lower==="hello"||lower==="hi"||lower==="habari") {
      const { data: b } = await supabase.from("businesses").select("name,code").eq("phone",from).single();
      return send(from, b ? "👋 Karibu "+b.name+"!\nCode: *"+b.code+"*\nType *help* for commands.\n\n— MTEJA AI 🤖" : "👋 Welcome to MTEJA AI!\nType *register* to start.\n\n— MTEJA AI 🤖");
    }
    await send(from, await askGemini(text));
  } catch(e) { console.error("Webhook error:", e.message); }
});

app.get("/health", (_, res) => res.json({ status: "ok", node: process.version, time: new Date().toISOString() }));


// ── NOTIFY CLIENT AFTER ADMIN REGISTERS THEM ─────────────────
// Called by admin.html after successful registration
app.post("/api/notify-client", async (req, res) => {
  const { phone, name, code, owner_name, plan } = req.body;
  if (!phone || !name || !code) {
    return res.status(400).json({ error: "phone, name and code required" });
  }

  const dashUrl = "https://charles-7sites.github.io/mteja-ai/dashboard.html";
  const planAmounts = { basic: "500", pro: "1,500", business: "4,000", enterprise: "10,000+" };
  const planKsh = planAmounts[plan] || "500";
  const firstName = (owner_name || name).split(" ")[0];

  const waMsg =
    `Habari ${firstName}! 👋\n\n` +
    `Umesajiliwa kwenye *MTEJA AI* — msaidizi wako wa biashara! 🤖\n\n` +
    `🏪 Biashara: *${name}*\n` +
    `🔑 Code yako: *${code}*\n` +
    `📦 Plan: ${(plan||"basic").toUpperCase()} — Ksh ${planKsh}/mwezi\n\n` +
    `📱 *Dashboard yako:*\n${dashUrl}\n\n` +
    `Login na:\n` +
    `• Namba: ${phone}\n` +
    `• Code: ${code}\n\n` +
    `Au tuma *hello* kwa bot:\n+1 (555) 192-6031\n\n` +
    `🌊 Karibu MTEJA AI! — Kisumu, Kenya`;

  try {
    // Send WhatsApp message
    const waPhone = normalizePhone(phone) || phone.replace(/^\+/, "");
    await send(waPhone, waMsg);
    console.log("✅ Welcome WhatsApp sent to", phone);
    res.json({ success: true, message: "WhatsApp sent to " + phone });
  } catch(e) {
    console.error("Notify client error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── ADMIN AUTH — Server-side PIN ─────────────────────────────
// Password lives ONLY on the server — never in HTML source code
const ADMIN_PIN = process.env.ADMIN_PIN || "mteja@admin2026";
const adminSessions = new Map(); // token → expiry

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function isValidToken(token) {
  if (!token || !adminSessions.has(token)) return false;
  if (Date.now() > adminSessions.get(token)) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// Login — returns session token
app.post("/api/admin/login", (req, res) => {
  const { pin } = req.body;
  if (!pin || pin !== ADMIN_PIN) {
    return res.status(401).json({ error: "Wrong password" });
  }
  const token = generateToken();
  const expiry = Date.now() + 8 * 60 * 60 * 1000; // 8 hours
  adminSessions.set(token, expiry);
  console.log("✅ Admin logged in");
  res.json({ token, expiresIn: "8 hours" });
});

// Verify token
app.post("/api/admin/verify", (req, res) => {
  const { token } = req.body;
  if (isValidToken(token)) {
    res.json({ valid: true });
  } else {
    res.status(401).json({ valid: false, error: "Session expired" });
  }
});

// Logout
app.post("/api/admin/logout", (req, res) => {
  const { token } = req.body;
  if (token) adminSessions.delete(token);
  res.json({ success: true });
});

// Middleware to protect admin API routes
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.body?.adminToken;
  if (!isValidToken(token)) {
    return res.status(401).json({ error: "Unauthorized — invalid or expired session" });
  }
  next();
}

// Protected notify-client — only admin can trigger it
app.post("/api/admin/notify-client", requireAdmin, async (req, res) => {
  const { phone, name, code, owner_name, plan } = req.body;
  if (!phone || !name || !code) {
    return res.status(400).json({ error: "phone, name and code required" });
  }
  const planAmounts = { basic: "500", pro: "1,500", business: "4,000", enterprise: "10,000+" };
  const planKsh = planAmounts[plan] || "500";
  const firstName = (owner_name || name).split(" ")[0];
  const dashUrl = "https://charles-7sites.github.io/mteja-ai/dashboard.html";

  const waMsg =
    `Habari ${firstName}! 👋

` +
    `Umesajiliwa kwenye *MTEJA AI* — msaidizi wako wa biashara! 🤖

` +
    `🏪 Biashara: *${name}*
` +
    `🔑 Code yako: *${code}*
` +
    `📦 Plan: ${(plan||"basic").toUpperCase()} — Ksh ${planKsh}/mwezi

` +
    `📱 *Dashboard yako:*
${dashUrl}

` +
    `Login na:
• Namba: ${phone}
• Code: ${code}

` +
    `Au tuma *hello* kwa bot:
+1 (555) 192-6031

` +
    `🌊 Karibu MTEJA AI! — Kisumu, Kenya`;

  try {
    const normWaPhone = normalizePhone(phone) || phone;
    await send(normWaPhone, waMsg);
    console.log("✅ Welcome WhatsApp sent to", normWaPhone);
    res.json({ success: true });
  } catch(e) {
    console.error("Notify error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Clean expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of adminSessions.entries()) {
    if (now > expiry) adminSessions.delete(token);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log("🚀 MTEJA AI running on port " + PORT));

// ============================================================
//  MTEJA AI — M-PESA C2B INTEGRATION
//  When a customer pays a business via M-Pesa, MTEJA AI
//  automatically logs the transaction and notifies the owner
// ============================================================

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_ENV = "sandbox" // "sandbox" for testing, "production" for live
} = process.env;

const MPESA_BASE = MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

// ── GET M-PESA ACCESS TOKEN ───────────────────────────────────
async function getMpesaToken() {
  const auth = Buffer.from(MPESA_CONSUMER_KEY + ":" + MPESA_CONSUMER_SECRET).toString("base64");
  const res = await fetch(MPESA_BASE + "/oauth/v1/generate?grant_type=client_credentials", {
    headers: { Authorization: "Basic " + auth }
  });
  const data = await res.json();
  return data.access_token;
}

// ── REGISTER C2B CALLBACK URLS ────────────────────────────────
// Call this once to tell Safaricom where to send payment notifications
async function registerC2BUrls() {
  try {
    const token = await getMpesaToken();
    const baseUrl = process.env.SERVER_URL || "https://mteja-ai.onrender.com";
    const res = await fetch(MPESA_BASE + "/mpesa/c2b/v1/registerurl", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        ShortCode: MPESA_SHORTCODE,
        ResponseType: "Completed",
        ConfirmationURL: baseUrl + "/mpesa/confirm",
        ValidationURL: baseUrl + "/mpesa/validate"
      })
    });
    const data = await res.json();
    console.log("✅ M-Pesa C2B URLs registered:", data);
  } catch(e) {
    console.error("❌ M-Pesa C2B registration failed:", e.message);
  }
}

// ── STK PUSH — Prompt customer to pay ────────────────────────
// Business owner can trigger this to request payment from customer
async function stkPush({ phone, amount, businessPhone, accountRef, description }) {
  try {
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + timestamp).toString("base64");
    const callbackUrl = (process.env.SERVER_URL || "https://mteja-ai.onrender.com") + "/mpesa/stk-callback";

    const res = await fetch(MPESA_BASE + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: Math.round(amount),
        PartyA: phone,           // Customer phone
        PartyB: MPESA_SHORTCODE, // Business till/paybill
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: accountRef || "MTEJA",
        TransactionDesc: description || "Payment via MTEJA AI"
      })
    });
    const data = await res.json();
    console.log("STK Push response:", data);
    return data;
  } catch(e) {
    console.error("STK Push failed:", e.message);
    return null;
  }
}

// ── PROCESS CONFIRMED M-PESA PAYMENT ─────────────────────────
async function processMpesaPayment(paymentData) {
  const {
    TransID,        // M-Pesa transaction ID e.g. "QA12B3CD4E"
    TransAmount,    // Amount paid e.g. "500"
    MSISDN,         // Customer phone e.g. "254712345678"
    FirstName,      // Customer first name from M-Pesa
    LastName,       // Customer last name
    MiddleName,     // Customer middle name
    BillRefNumber,  // Account reference (business enters this)
    BusinessShortCode, // The till/paybill number
    TransTime,      // Transaction time
  } = paymentData;

  const customerPhone = "+" + MSISDN;
  const customerName  = [FirstName, MiddleName, LastName].filter(Boolean).join(" ").trim() || "M-Pesa Customer";
  const amount        = parseFloat(TransAmount);
  const points        = Math.floor(amount / 100);

  console.log(`💰 M-Pesa payment: ${customerName} (${customerPhone}) → Ksh ${amount} | Ref: ${BillRefNumber}`);

  // Find which MTEJA business owns this shortcode OR match by BillRefNumber (MTEJA code)
  let businessPhone = null;

  // Try matching by MTEJA code in the bill reference (e.g. customer enters "MTEJA-FAA123")
  if (BillRefNumber && BillRefNumber.startsWith("MTEJA-")) {
    const { data: biz } = await supabase
      .from("businesses")
      .select("phone, name")
      .eq("code", BillRefNumber.toUpperCase())
      .single();
    if (biz) businessPhone = biz.phone;
  }

  // Fallback: match by shortcode stored in business record
  if (!businessPhone) {
    const { data: biz } = await supabase
      .from("businesses")
      .select("phone, name")
      .eq("mpesa_shortcode", BusinessShortCode)
      .single();
    if (biz) businessPhone = biz.phone;
  }

  if (!businessPhone) {
    console.log("⚠️ Could not match M-Pesa payment to a MTEJA business. Ref:", BillRefNumber);
    return;
  }

  // Save transaction to Supabase
  await supabase.from("transactions").insert({
    business_phone:  businessPhone,
    customer_name:   customerName,
    customer_phone:  customerPhone,
    item:            BillRefNumber || "M-Pesa Payment",
    amount:          amount,
    points_awarded:  points,
    mpesa_ref:       TransID,
    source:          "mpesa_auto",
    created_at:      new Date().toISOString()
  });

  // Update or create customer record
  const { data: existing } = await supabase
    .from("customers")
    .select("*")
    .eq("business_phone", businessPhone)
    .eq("phone", customerPhone)
    .single();

  if (existing) {
    await supabase.from("customers").update({
      total_points:  existing.total_points + points,
      total_spent:   existing.total_spent + amount,
      last_visit:    new Date().toISOString(),
      visit_count:   existing.visit_count + 1,
    }).eq("id", existing.id);
  } else {
    await supabase.from("customers").insert({
      business_phone: businessPhone,
      name:           customerName,
      phone:          customerPhone,
      total_points:   points,
      total_spent:    amount,
      last_visit:     new Date().toISOString(),
      visit_count:    1,
    });
  }

  // Get business name for notification
  const { data: biz } = await supabase
    .from("businesses")
    .select("name")
    .eq("phone", businessPhone)
    .single();

  // ── Notify business owner via WhatsApp ───────────────────
  const notification =
    `💰 *M-Pesa Payment Received!*\n` +
    `━━━━━━━━━━━━━━━\n` +
    `👤 ${customerName}\n` +
    `📞 ${customerPhone}\n` +
    `💵 Ksh ${amount.toLocaleString()}\n` +
    `🔖 Ref: ${TransID}\n` +
    `⭐ +${points} loyalty points\n\n` +
    `✅ Automatically logged!\n\n` +
    `— MTEJA AI 🤖`;

  // Send WhatsApp to business owner (using their registered phone)
  const ownerWaPhone = businessPhone.replace("+", "");
  await send(ownerWaPhone, notification);

  // ── Send receipt to customer via WhatsApp (if they have WA) ─
  if (customerPhone) {
    const customerWa = MSISDN; // Already in 254 format
    const receipt =
      `✅ *Malipo Yamepokelewa!*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🏪 ${biz?.name || "Biashara"}\n` +
      `💵 Ksh ${amount.toLocaleString()}\n` +
      `🔖 ${TransID}\n` +
      `⭐ Umepata ${points} loyalty points!\n\n` +
      `Asante kwa biashara yako! 🙏\n` +
      `— MTEJA AI 🤖`;
    await send(customerWa, receipt);
  }

  console.log(`✅ M-Pesa payment processed: ${customerName} → ${biz?.name} Ksh ${amount}`);
}

// ── M-PESA ROUTES ─────────────────────────────────────────────

// Validation URL — Safaricom checks before processing payment
app.post("/mpesa/validate", (req, res) => {
  console.log("M-Pesa validation request:", req.body);
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// Confirmation URL — called after payment is confirmed
app.post("/mpesa/confirm", async (req, res) => {
  console.log("💰 M-Pesa payment confirmed:", JSON.stringify(req.body));
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  // Process asynchronously so M-Pesa doesn't timeout waiting
  processMpesaPayment(req.body).catch(e => console.error("Payment processing error:", e));
});

// STK Push callback — result of STK push request
app.post("/mpesa/stk-callback", async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  const body = req.body?.Body?.stkCallback;
  if (!body) return;

  if (body.ResultCode === 0) {
    // Payment successful — extract details
    const items = body.CallbackMetadata?.Item || [];
    const get = (name) => items.find(i => i.Name === name)?.Value;
    await processMpesaPayment({
      TransID:           get("MpesaReceiptNumber"),
      TransAmount:       get("Amount"),
      MSISDN:            get("PhoneNumber"),
      FirstName:         "Customer",
      BillRefNumber:     get("AccountReference"),
      BusinessShortCode: MPESA_SHORTCODE,
      TransTime:         get("TransactionDate"),
    });
  } else {
    console.log("STK Push failed/cancelled. Code:", body.ResultCode, body.ResultDesc);
  }
});

// ── STK PUSH TRIGGER FROM WHATSAPP ───────────────────────────
// Business owner types: "pay 0712345678 1500"
// Bot sends STK push to customer's phone
// ── Add this to the main webhook handler ─────────────────────
// (Insert in the app.post("/webhook") handler alongside other commands)

// ── ADMIN: Register C2B URLs on startup ──────────────────────
if (MPESA_CONSUMER_KEY && MPESA_SHORTCODE) {
  setTimeout(registerC2BUrls, 5000); // Wait 5s after server starts
  console.log("📱 M-Pesa C2B integration enabled");
} else {
  console.log("ℹ️  M-Pesa keys not set — C2B integration inactive");
}

// ── EXPOSE STK PUSH ENDPOINT FOR DASHBOARD ───────────────────
app.post("/api/stk-push", async (req, res) => {
  const { phone, amount, businessPhone, accountRef } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: "phone and amount required" });
  const result = await stkPush({ phone, amount, businessPhone, accountRef });
  res.json(result || { error: "STK Push failed" });
});

