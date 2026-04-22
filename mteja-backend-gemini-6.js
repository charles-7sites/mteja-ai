// MTEJA AI — Backend v3.0
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const { WHATSAPP_TOKEN, VERIFY_TOKEN, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_KEY, WHATSAPP_PHONE_ID, PORT = 3000 } = process.env;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MODELS = ["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.0-flash","gemini-2.0-flash-lite"];
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sessions = new Map();
const chatHistories = new Map();

function getSession(p) { return sessions.get(p) || { step: null, data: {} }; }
function setSession(p, s) { sessions.set(p, s); }
function clearSession(p) { sessions.delete(p); }
function genCode(n) { return "MTEJA-" + n.toUpperCase().replace(/[^A-Z]/g,"").substring(0,3).padEnd(3,"X") + Math.floor(100+Math.random()*900); }

async function send(to, body) {
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      method:"POST", headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json" },
      body: JSON.stringify({ messaging_product:"whatsapp", to, type:"text", text:{ body } })
    });
    const d = await r.json();
    d.error ? console.error("WA:",d.error) : console.log("✅ Sent to",to);
  } catch(e) { console.error("Send error:",e.message); }
}

async function askGemini(phone, msg) {
  const history = chatHistories.get(phone) || [];
  const sys = "You are MTEJA AI, WhatsApp assistant for Kisumu SMEs. Be brief (max 5 lines). Mix English/Swahili. Sign off with — MTEJA AI 🤖";
  for (const m of MODELS) {
    try {
      const model = genAI.getGenerativeModel({ model:m, systemInstruction:sys });
      const chat = model.startChat({ history, generationConfig:{ maxOutputTokens:300 } });
      const reply = (await chat.sendMessage(msg)).response.text();
      chatHistories.set(phone, [...history, {role:"user",parts:[{text:msg}]}, {role:"model",parts:[{text:reply}]}].slice(-20));
      return reply;
    } catch(e) {
      if (e.message?.includes("404")) continue;
      if (e.message?.includes("503")) { await new Promise(r=>setTimeout(r,2000)); continue; }
      continue;
    }
  }
  return "Samahani, jaribu tena! 😅\n\n— MTEJA AI 🤖";
}

async function handleReg(phone, text, s) {
  if(s.step==="reg_start") { setSession(phone,{step:"reg_name",data:{}}); return send(phone,"🏪 *Registration*\n\nStep 1 of 3\nBusiness *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="reg_name") { setSession(phone,{step:"reg_type",data:{name:text}}); return send(phone,`✅ Name: *${text}*\n\nStep 2 of 3\nBusiness *type?*\nsalon/pharmacy/hardware/restaurant/other\n\n— MTEJA AI 🤖`); }
  if(s.step==="reg_type") { setSession(phone,{step:"reg_owner",data:{...s.data,type:text}}); return send(phone,`✅ Type: *${text}*\n\nStep 3 of 3\nOwner *name?*\n\n— MTEJA AI 🤖`); }
  if(s.step==="reg_owner") {
    const {name,type} = s.data;
    const {data:ex} = await supabase.from("businesses").select("code").eq("phone",phone).single();
    if(ex) { clearSession(phone); return send(phone,`⚠️ Already registered!\nCode: *${ex.code}*\n\nType *dashboard* for your link.\n\n— MTEJA AI 🤖`); }
    const code = genCode(name);
    const {error} = await supabase.from("businesses").insert({phone,name,type:type.toLowerCase(),owner_name:text,code,plan:"basic",created_at:new Date().toISOString()});
    clearSession(phone);
    if(error) { console.error(error); return send(phone,"❌ Failed. Type *register* to retry.\n\n— MTEJA AI 🤖"); }
    console.log(`✅ Registered: ${name} → ${code}`);
    return send(phone,`🎉 *Registered!*\n🏪 ${name}\n👤 ${text}\n🔑 Code: *${code}*\n\nSave this code!\nType *dashboard* for your link.\n\n— MTEJA AI 🤖`);
  }
}

async function handleSale(phone, text, s) {
  const {data:biz} = await supabase.from("businesses").select("name").eq("phone",phone).single();
  if(!biz) { clearSession(phone); return send(phone,"⚠️ Register first! Type *register*\n\n— MTEJA AI 🤖"); }
  if(s.step==="sale_start") { setSession(phone,{step:"sale_name",data:{}}); return send(phone,"💰 *Log Sale*\n\nStep 1/4: Customer *name?*\n\n— MTEJA AI 🤖"); }
  if(s.step==="sale_name") { setSession(phone,{step:"sale_phone",data:{customer_name:text}}); return send(phone,`✅ ${text}\n\nStep 2/4: Customer *phone?*\n(Type *skip* if unknown)\n\n— MTEJA AI 🤖`); }
  if(s.step==="sale_phone") { const cp=text.toLowerCase()==="skip"?null:text; setSession(phone,{step:"sale_item",data:{...s.data,customer_phone:cp}}); return send(phone,`✅ Phone: ${cp||"skipped"}\n\nStep 3/4: What did they *buy?*\n\n— MTEJA AI 🤖`); }
  if(s.step==="sale_item") { setSession(phone,{step:"sale_amount",data:{...s.data,item:text}}); return send(phone,`✅ Item: ${text}\n\nStep 4/4: *Amount?* (Ksh)\n\n— MTEJA AI 🤖`); }
  if(s.step==="sale_amount") {
    const amount = parseInt(text.replace(/[^0-9]/g,""));
    if(!amount) return send(phone,"⚠️ Enter valid amount e.g. *1500*\n\n— MTEJA AI 🤖");
    const {customer_name,customer_phone,item} = s.data;
    const points = Math.floor(amount/100);
    await supabase.from("transactions").insert({business_phone:phone,customer_name,customer_phone:customer_phone||null,item,amount,points_awarded:points,created_at:new Date().toISOString()});
    const {data:ex} = await supabase.from("customers").select("*").eq("business_phone",phone).eq("name",customer_name).single();
    if(ex) { await supabase.from("customers").update({total_points:ex.total_points+points,total_spent:ex.total_spent+amount,last_visit:new Date().toISOString(),visit_count:ex.visit_count+1,phone:customer_phone||ex.phone}).eq("id",ex.id); }
    else { await supabase.from("customers").insert({business_phone:phone,name:customer_name,phone:customer_phone||null,total_points:points,total_spent:amount,last_visit:new Date().toISOString(),visit_count:1}); }
    clearSession(phone);
    return send(phone,`✅ *Sale Logged!*\n👤 ${customer_name}\n🛍️ ${item}\n💰 Ksh ${amount.toLocaleString()}\n⭐ +${points} pts\n\n— MTEJA AI 🤖`);
  }
}

app.get("/webhook", (req,res) => {
  if(req.query["hub.mode"]==="subscribe" && req.query["hub.verify_token"]===VERIFY_TOKEN) res.send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});

app.post("/webhook", async (req,res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!msg) return;
    const from = msg.from;
    const text = msg.type==="text" ? msg.text.body.trim() : "[type your message]";
    console.log(`📩 ${from}: ${text}`);
    const lower = text.toLowerCase();
    const s = getSession(from);

    if(s.step?.startsWith("reg_")) return handleReg(from,text,s);
    if(s.step?.startsWith("sale_")) return handleSale(from,text,s);
    if(lower==="register"||lower==="jiunge") { setSession(from,{step:"reg_start",data:{}}); return handleReg(from,text,{step:"reg_start",data:{}}); }
    if(lower==="log"||lower==="sale"||lower==="log sale") { setSession(from,{step:"sale_start",data:{}}); return handleSale(from,text,{step:"sale_start",data:{}}); }
    if(lower.startsWith("stats")||lower.startsWith("report")) {
      const {data:t} = await supabase.from("transactions").select("amount").eq("business_phone",from).gte("created_at",new Date(Date.now()-7*86400000).toISOString());
      const total=t?.reduce((s,x)=>s+x.amount,0)||0, count=t?.length||0;
      return send(from,`📊 *This Week*\n💰 Ksh ${total.toLocaleString()}\n🧾 ${count} sales\n\n— MTEJA AI 🤖`);
    }
    if(lower.startsWith("follow")) {
      const cut=new Date(); cut.setDate(cut.getDate()-21);
      const {data:c} = await supabase.from("customers").select("name,phone,last_visit,total_spent").eq("business_phone",from).lt("last_visit",cut.toISOString()).limit(5);
      if(!c?.length) return send(from,"🎉 No overdue customers!\n\n— MTEJA AI 🤖");
      return send(from,"📋 *Follow Up:*\n"+c.map((x,i)=>`${i+1}. *${x.name}* — 📞 ${x.phone||"no phone"}`).join("\n")+"\n\n— MTEJA AI 🤖");
    }
    if(lower==="dashboard") {
      const {data:b} = await supabase.from("businesses").select("code").eq("phone",from).single();
      if(b) return send(from,`🌐 *Dashboard*\nhttps://mteja-ai.onrender.com/dashboard\n\nLogin:\n📱 ${from}\n🔑 *${b.code}*\n\n— MTEJA AI 🤖`);
      return send(from,"Type *register* first!\n\n— MTEJA AI 🤖");
    }
    if(lower==="help"||lower==="menu") return send(from,"🤖 *Commands*\n📝 register\n💰 log\n📋 follow\n📊 stats\n🌐 dashboard\n❓ help\n\n— MTEJA AI 🤖");
    if(lower==="hello"||lower==="hi"||lower==="habari") {
      const {data:b} = await supabase.from("businesses").select("name,code").eq("phone",from).single();
      return send(from, b ? `👋 Karibu ${b.name}!\nCode: *${b.code}*\nType *help* for commands.\n\n— MTEJA AI 🤖` : "👋 Welcome to MTEJA AI!\nType *register* to start.\n\n— MTEJA AI 🤖");
    }
    await send(from, await askGemini(from,text));
  } catch(e) { console.error("❌",e.message); }
});

app.get("/health", (_,res) => res.json({status:"ok",version:"3.0",time:new Date().toISOString()}));
app.get("/dashboard", (_,res) => res.send("<h2>Dashboard coming soon. Your bot is working! ✅</h2>"));

app.listen(PORT, () => console.log(`🚀 MTEJA AI v3.0 on port ${PORT}`));
