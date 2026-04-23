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
  if(!biz) { clearS(phone); return send(phone,"⚠️ Register first! Type *register*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s1") { setS(phone,{step:"s2",data:{}}); return send(phone,"💰 *Log Sale*\nStep 1/4: Customer *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s2") { setS(phone,{step:"s3",data:{cn:text}}); return send(phone,"✅ "+text+"\nStep 2/4: Customer *phone?*\n(Type *skip* if unknown)\n\n— MTEJA AI 🤖"); }
  if(s.step==="s3") { const cp=text.toLowerCase()==="skip"?null:text; setS(phone,{step:"s4",data:{...s.data,cp}}); return send(phone,"✅ Phone saved\nStep 3/4: What did they *buy?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s4") { setS(phone,{step:"s5",data:{...s.data,item:text}}); return send(phone,"✅ Item: "+text+"\nStep 4/4: *Amount?* (Ksh)\n\n— MTEJA AI 🤖"); }
  if(s.step==="s5") {
    const amount = parseInt(text.replace(/[^0-9]/g,""));
    if(!amount) return send(phone,"⚠️ Enter valid amount e.g. *1500*\n\n— MTEJA AI 🤖");
    const { cn, cp, item } = s.data;
    const pts = Math.floor(amount/100);
    await supabase.from("transactions").insert({ business_phone:phone, customer_name:cn, customer_phone:cp||null, item, amount, points_awarded:pts, created_at:new Date().toISOString() });
    const { data: ex } = await supabase.from("customers").select("*").eq("business_phone",phone).eq("name",cn).single();
    if(ex) await supabase.from("customers").update({ total_points:ex.total_points+pts, total_spent:ex.total_spent+amount, last_visit:new Date().toISOString(), visit_count:ex.visit_count+1, phone:cp||ex.phone }).eq("id",ex.id);
    else await supabase.from("customers").insert({ business_phone:phone, name:cn, phone:cp||null, total_points:pts, total_spent:amount, last_visit:new Date().toISOString(), visit_count:1 });
    clearS(phone);
    return send(phone,"✅ *Sale Logged!*\n👤 "+cn+"\n🛍️ "+item+"\n💰 Ksh "+amount.toLocaleString()+"\n⭐ +"+pts+" pts\n\n— MTEJA AI 🤖");
  }
}

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
    const { data: existing } = await supabase.from("businesses").select("phone").eq("phone", phone).single();
    if (existing) return res.status(400).json({ message: "A business with this phone already exists" });
    const code = genCode(business_name);
    const { data, error } = await supabase
      .from("businesses")
      .insert({ name: business_name, owner_name, phone, type: business_type, location, code, plan: "basic", created_at: new Date().toISOString() })
      .select()
      .single();
    if (error) throw error;
    res.status(201).json({ business: data });
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

app.listen(PORT, () => console.log("🚀 MTEJA AI running on port " + PORT));
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
  if(!biz) { clearS(phone); return send(phone,"⚠️ Register first! Type *register*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s1") { setS(phone,{step:"s2",data:{}}); return send(phone,"💰 *Log Sale*\nStep 1/4: Customer *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s2") { setS(phone,{step:"s3",data:{cn:text}}); return send(phone,"✅ "+text+"\nStep 2/4: Customer *phone?*\n(Type *skip* if unknown)\n\n— MTEJA AI 🤖"); }
  if(s.step==="s3") { const cp=text.toLowerCase()==="skip"?null:text; setS(phone,{step:"s4",data:{...s.data,cp}}); return send(phone,"✅ Phone saved\nStep 3/4: What did they *buy?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="s4") { setS(phone,{step:"s5",data:{...s.data,item:text}}); return send(phone,"✅ Item: "+text+"\nStep 4/4: *Amount?* (Ksh)\n\n— MTEJA AI 🤖"); }
  if(s.step==="s5") {
    const amount = parseInt(text.replace(/[^0-9]/g,""));
    if(!amount) return send(phone,"⚠️ Enter valid amount e.g. *1500*\n\n— MTEJA AI 🤖");
    const { cn, cp, item } = s.data;
    const pts = Math.floor(amount/100);
    await supabase.from("transactions").insert({ business_phone:phone, customer_name:cn, customer_phone:cp||null, item, amount, points_awarded:pts, created_at:new Date().toISOString() });
    const { data: ex } = await supabase.from("customers").select("*").eq("business_phone",phone).eq("name",cn).single();
    if(ex) await supabase.from("customers").update({ total_points:ex.total_points+pts, total_spent:ex.total_spent+amount, last_visit:new Date().toISOString(), visit_count:ex.visit_count+1, phone:cp||ex.phone }).eq("id",ex.id);
    else await supabase.from("customers").insert({ business_phone:phone, name:cn, phone:cp||null, total_points:pts, total_spent:amount, last_visit:new Date().toISOString(), visit_count:1 });
    clearS(phone);
    return send(phone,"✅ *Sale Logged!*\n👤 "+cn+"\n🛍️ "+item+"\n💰 Ksh "+amount.toLocaleString()+"\n⭐ +"+pts+" pts\n\n— MTEJA AI 🤖");
  }
}

// ══════════════════════════════════════════════
//  MTEJA AI — Dashboard API Routes
//  Paste these into your server.js BEFORE the
//  /webhook routes
// ══════════════════════════════════════════════

// GET /api/stats  — dashboard overview numbers
app.get("/api/stats", async (req, res) => {
  try {
    const [{ count: businesses }, { count: customers }, { count: transactions }, txData] =
      await Promise.all([
        supabase.from("businesses").select("*", { count: "exact", head: true }),
        supabase.from("customers").select("*",  { count: "exact", head: true }),
        supabase.from("transactions").select("*",{ count: "exact", head: true }),
        supabase.from("transactions").select("amount")
      ]);

    const revenue = (txData.data || []).reduce((sum, t) => sum + (t.amount || 0), 0);

    res.json({ businesses, customers, transactions, revenue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// GET /api/businesses  — list all registered businesses
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


// POST /api/businesses  — register a new business (from dashboard)
app.post("/api/businesses", async (req, res) => {
  try {
    const { business_name, owner_name, phone, business_type, location } = req.body;
    if (!business_name || !owner_name || !phone) {
      return res.status(400).json({ message: "business_name, owner_name and phone are required" });
    }

    // Generate a unique code e.g. MTEJA-007
    const { count } = await supabase
      .from("businesses")
      .select("*", { count: "exact", head: true });

    const code = "MTEJA-" + String((count || 0) + 1).padStart(3, "0");

    const { data, error } = await supabase
      .from("businesses")
      .insert({
        name: business_name,
        owner_name,
        phone,
        business_type,
        location,
        business_code: code
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ business: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// DELETE /api/businesses/:id  — remove a business
app.delete("/api/businesses/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Try matching by phone (your primary key) or id
    const { error } = await supabase
      .from("businesses")
      .delete()
      .or(`phone.eq.${id},id.eq.${id},business_code.eq.${id}`);

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

app.listen(PORT, () => console.log("🚀 MTEJA AI running on port " + PORT));
