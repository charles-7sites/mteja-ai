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
