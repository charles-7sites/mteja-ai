const express = require("express");
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
    await supabase.from("businesses").insert({ phone, name, type: type.toLowerCase(), owner_name: text, code, plan: "basic", created_at: new Date().toISOString() });
    clearS(phone);
    console.log("Registered:", name, "→", code);
    return send(phone,"🎉 *Registered!*\n🏪 "+name+"\n👤 "+text+"\n🔑 Code: *"+code+"*\n\nType *dashboard* for your link.\n\n— MTEJA AI 🤖");
  }
}

async function handleSale(phone, text, s) {
  const { data: biz } = await supabase.from("businesses").select("name").eq("phone",phone).single();
  if(!biz) { clearS(phone); return send(phone,"⚠️ Register first! Reply *1* to register.\n\n— MTEJA AI 🤖"); }

  // Normalize phone: strip spaces, convert 07xx → 2547xx, keep 2547xx as-is
  function normalizePhone(p) {
    p = p.replace(/\s+/g,"").replace(/[^0-9]/g,"");
    if(p.startsWith("0")) return "254" + p.slice(1);
    if(p.startsWith("7") || p.startsWith("1")) return "254" + p;
    return p;
  }

  // s1 — ask for customer phone number
  if(s.step==="s1") {
    setS(phone,{step:"s2",data:{}});
    return send(phone,"💰 *Log Sale*\nStep 1: Customer *phone number?*\n(e.g. 0712345678)\n\n— MTEJA AI 🤖");
  }

  // s2 — received customer phone, look them up
  if(s.step==="s2") {
    const raw = text.replace(/\s+/g,"").replace(/[^0-9]/g,"");
    const cp  = normalizePhone(text); // always 254XXXXXXXXX

    // Build all possible formats this number could be stored as
    const local = raw.startsWith("254") ? "0" + raw.slice(3) : (raw.startsWith("0") ? raw : "0" + raw);
    const intl  = raw.startsWith("254") ? raw : "254" + (raw.startsWith("0") ? raw.slice(1) : raw);

    // Use limit(1) — handles duplicates safely, matches any stored format
    const { data: rows } = await supabase
      .from("customers")
      .select("*")
      .eq("business_phone", phone)
      .or(`phone.eq.${intl},phone.eq.${local},phone.eq.${raw}`)
      .limit(1);

    const existing = rows && rows.length > 0 ? rows[0] : null;

    if(existing) {
      setS(phone,{step:"s4",data:{cn:existing.name, cp:intl, customerId:existing.id}});
      return send(phone,"👤 *"+existing.name+"*\n⭐ Points: "+existing.total_points+" | Visits: "+existing.visit_count+"\n\nStep 2: What did they *buy?*\n\n— MTEJA AI 🤖");
    } else {
      setS(phone,{step:"s3",data:{cp:intl}});
      return send(phone,"📱 New customer!\nStep 2: Their *name?*\n\n— MTEJA AI 🤖");
    }
  }

  // s3 — new customer name collected, ask for item
  if(s.step==="s3") {
    setS(phone,{step:"s4",data:{...s.data, cn:text, customerId:null}});
    return send(phone,"✅ Name: *"+text+"*\nStep 3: What did they *buy?*\n\n— MTEJA AI 🤖");
  }

  // s4 — item collected, ask for amount
  if(s.step==="s4") {
    setS(phone,{step:"s5",data:{...s.data, item:text}});
    return send(phone,"✅ Item: *"+text+"*\nStep 4: *Amount paid?* (Ksh)\n\n— MTEJA AI 🤖");
  }

  // s5 — amount received, save everything
  if(s.step==="s5") {
    const amount = parseInt(text.replace(/[^0-9]/g,""));
    if(!amount) return send(phone,"⚠️ Enter valid amount e.g. *1500*\n\n— MTEJA AI 🤖");
    const { cn, cp, item, customerId } = s.data;
    const pts = Math.floor(amount/100);

    // Save transaction
    await supabase.from("transactions").insert({ business_phone:phone, customer_name:cn, customer_phone:cp||null, item, amount, points_awarded:pts, created_at:new Date().toISOString() });

    // Update or create customer record
    if(customerId) {
      const { data: ex } = await supabase.from("customers").select("*").eq("id",customerId).single();
      await supabase.from("customers").update({ total_points:ex.total_points+pts, total_spent:ex.total_spent+amount, last_visit:new Date().toISOString(), visit_count:ex.visit_count+1 }).eq("id",customerId);
    } else {
      await supabase.from("customers").insert({ business_phone:phone, name:cn, phone:cp||null, total_points:pts, total_spent:amount, last_visit:new Date().toISOString(), visit_count:1 });
    }

    clearS(phone);
    return send(phone,"✅ *Sale Logged!*\n👤 "+cn+"\n🛍️ "+item+"\n💰 Ksh "+amount.toLocaleString()+"\n⭐ +"+pts+" pts\n\nReply *0* for menu\n\n— MTEJA AI 🤖");
  }
}

// ══════════════════════════════════════════════
//  CORS — allow dashboard (GitHub Pages) to call API
// ══════════════════════════════════════════════
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ══════════════════════════════════════════════
//  MTEJA AI — Dashboard API Routes
// ══════════════════════════════════════════════

// GET /api/stats
app.get("/api/stats", async (req, res) => {
  try {
    const [bizRes, custRes, txRes] = await Promise.all([
      supabase.from("businesses").select("*"),
      supabase.from("customers").select("*"),
      supabase.from("transactions").select("amount")
    ]);
    const businesses   = (bizRes.data  || []).length;
    const customers    = (custRes.data || []).length;
    const transactions = (txRes.data   || []).length;
    const revenue      = (txRes.data   || []).reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    res.json({ businesses, customers, transactions, revenue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/businesses
app.get("/api/businesses", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("businesses")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/businesses — register from dashboard
app.post("/api/businesses", async (req, res) => {
  try {
    const { business_name, owner_name, phone, business_type, location } = req.body;
    if (!business_name || !owner_name || !phone) {
      return res.status(400).json({ message: "business_name, owner_name and phone are required" });
    }
    const { data: existing } = await supabase.from("businesses").select("phone").eq("phone", phone).maybeSingle();
    if (existing) return res.status(400).json({ message: "A business with this phone already exists" });
    const code = genCode(business_name);
    const { error } = await supabase
      .from("businesses")
      .insert({ phone, name: business_name, type: business_type, owner_name, code, plan: "basic", created_at: new Date().toISOString() });
    if (error) throw error;
    res.status(201).json({ business: { phone, name: business_name, type: business_type, owner_name, code, plan: "basic" } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/businesses/:id
app.delete("/api/businesses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from("businesses").delete().eq("phone", id);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
 app.get("/webhook", (req, res) => {
  req.query["hub.mode"]==="subscribe" && req.query["hub.verify_token"]===VERIFY_TOKEN
    ? res.send(req.query["hub.challenge"]) : res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg) return;
    const from = msg.from;
    const text = msg.type==="text" ? msg.text.body.trim() : "[type your message]";
    console.log("MSG:", from, text);
    const lower = text.toLowerCase();
    const s = getS(from);

    if(s.step && s.step[0]==="r") return handleReg(from,text,s);
    if(s.step && s.step[0]==="s") return handleSale(from,text,s);

    const MENU = `🤖 *MTEJA AI Menu*\n━━━━━━━━━━━━━━━\n1️⃣ Register Business\n2️⃣ Log a Sale\n3️⃣ My Stats (This Week)\n4️⃣ Follow Up Customers\n5️⃣ My Dashboard\n6️⃣ Help / About\n━━━━━━━━━━━━━━━\nReply with a number 1-6\n\n— MTEJA AI 🤖`;

    // Map numbers to commands
    if(lower==="1"||lower==="register") { setS(from,{step:"r1",data:{}}); return handleReg(from,text,{step:"r1",data:{}}); }
    if(lower==="2"||lower==="log"||lower==="sale") { setS(from,{step:"s1",data:{}}); return handleSale(from,text,{step:"s1",data:{}}); }
    if(lower==="3"||lower==="stats"||lower==="report") {
      const { data: t } = await supabase.from("transactions").select("amount").eq("business_phone",from).gte("created_at",new Date(Date.now()-7*86400000).toISOString());
      const tot = t ? t.reduce((s,x)=>s+x.amount,0) : 0;
      return send(from,"📊 *This Week's Stats*\n💰 Revenue: Ksh "+tot.toLocaleString()+"\n🧾 Sales: "+(t?t.length:0)+"\n\nReply *0* for menu\n\n— MTEJA AI 🤖");
    }
    if(lower==="4"||lower==="follow") {
      const cut = new Date(); cut.setDate(cut.getDate()-21);
      const { data: c } = await supabase.from("customers").select("name,phone").eq("business_phone",from).lt("last_visit",cut.toISOString()).limit(5);
      if(!c||!c.length) return send(from,"🎉 No overdue customers!\nAll customers visited recently.\n\nReply *0* for menu\n\n— MTEJA AI 🤖");
      return send(from,"📋 *Follow Up List:*\n"+c.map((x,i)=>(i+1)+". *"+x.name+"* 📞 "+(x.phone||"no phone")).join("\n")+"\n\nReply *0* for menu\n\n— MTEJA AI 🤖");
    }
    if(lower==="5"||lower==="dashboard") {
      const { data: b } = await supabase.from("businesses").select("code").eq("phone",from).single();
      if(b) return send(from,"🌐 *Your Dashboard*\nhttps://charles-7sites.github.io/mteja-ai/dashboard.html\n\n🔑 Login with:\n📱 "+from+"\n🏷️ Code: *"+b.code+"*\n\n— MTEJA AI 🤖");
      return send(from,"⚠️ Not registered yet!\nReply *1* to register your business.\n\n— MTEJA AI 🤖");
    }
    if(lower==="6"||lower==="help"||lower==="about") return send(from,"ℹ️ *About MTEJA AI*\nYour AI-powered customer retention tool for Kisumu businesses.\n\n✅ Log sales\n✅ Track customers\n✅ Send follow-ups\n✅ View dashboard\n\nReply *0* for menu\n\n— MTEJA AI 🤖");
    if(lower==="0"||lower==="menu"||lower==="help"||lower==="hi"||lower==="hello"||lower==="habari") {
      const { data: b } = await supabase.from("businesses").select("name,code").eq("phone",from).single();
      if(b) return send(from,"👋 Karibu *"+b.name+"*!\nCode: *"+b.code+"*\n\n"+MENU);
      return send(from,"👋 Welcome to *MTEJA AI*!\nYour business growth partner.\n\n"+MENU);
    }
    await send(from, await askGemini(text));
  } catch(e) { console.error("Webhook error:", e.message); }
});

app.get("/health", (_, res) => res.json({ status: "ok", node: process.version, time: new Date().toISOString() }));

app.listen(PORT, () => console.log("🚀 MTEJA AI running on port " + PORT));
