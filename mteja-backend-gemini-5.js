// ============================================================
//  MTEJA AI — WhatsApp Bot Backend v2.1
// ============================================================

import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN, VERIFY_TOKEN, GEMINI_API_KEY,
  SUPABASE_URL, SUPABASE_KEY, WHATSAPP_PHONE_ID,
  PORT = 3000,
} = process.env;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

const SYSTEM_INSTRUCTION = `You are MTEJA AI, a friendly WhatsApp business assistant for Kisumu SMEs.
Help with business advice and general questions. Keep messages SHORT (max 5 lines).
Use English/Swahili mix. Currency is Ksh. Sign off with "— MTEJA AI 🤖"
For registration or sales logging, tell users to type "register" or "log".`;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sessions = new Map();
const chatHistories = new Map();

// ── DASHBOARD (embedded) ─────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>MTEJA AI Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Georgia,serif;background:#F0FDF4;min-height:100vh}
    #login-screen{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:linear-gradient(135deg,#064E3B,#065F46)}
    .login-card{background:#fff;border-radius:24px;padding:40px 32px;width:100%;max-width:380px;box-shadow:0 32px 80px rgba(0,0,0,0.3)}
    .login-logo{font-size:48px;text-align:center;margin-bottom:8px}
    .login-title{text-align:center;font-size:26px;font-weight:900;color:#064E3B;margin-bottom:4px}
    .login-sub{text-align:center;font-size:14px;color:#94A3B8;font-family:system-ui;margin-bottom:28px}
    .form-group{margin-bottom:16px}
    label{display:block;font-size:12px;font-weight:700;color:#64748B;font-family:system-ui;letter-spacing:.5px;margin-bottom:6px}
    input{width:100%;padding:12px 14px;border:1px solid #E2E8F0;border-radius:10px;font-size:15px;font-family:system-ui;color:#0F172A}
    input:focus{outline:none;border-color:#065F46}
    .btn-login{width:100%;padding:14px;background:linear-gradient(135deg,#065F46,#064E3B);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:system-ui;cursor:pointer;margin-top:8px}
    #login-msg{font-size:13px;font-family:system-ui;text-align:center;margin-top:10px;min-height:20px}
    #dashboard{display:none}
    .header{background:linear-gradient(135deg,#064E3B,#065F46);padding:20px 16px;position:sticky;top:0;z-index:20}
    .header-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
    .biz-code{font-size:10px;color:#6EE7B7;font-family:system-ui;font-weight:700;letter-spacing:2px;margin-bottom:4px}
    .biz-name{font-size:18px;font-weight:900;color:#fff}
    .biz-type{font-size:12px;color:#A7F3D0;font-family:system-ui}
    .logout-btn{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer;font-family:system-ui}
    .quick-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
    .qs{background:rgba(255,255,255,.1);border-radius:10px;padding:10px;text-align:center}
    .qs-val{font-size:18px;font-weight:900;color:#fff}
    .qs-label{font-size:10px;color:#6EE7B7;font-family:system-ui;font-weight:600;margin-top:2px}
    .tabs{background:#fff;border-bottom:1px solid #E2E8F0;display:flex;overflow-x:auto;position:sticky;top:158px;z-index:10}
    .tab{flex:0 0 auto;background:none;border:none;padding:14px 16px;font-size:13px;font-family:system-ui;font-weight:600;color:#94A3B8;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
    .tab.active{color:#065F46;border-bottom-color:#065F46}
    .content{max-width:700px;margin:0 auto;padding:20px 16px 80px}
    .stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
    .stat-card{background:#fff;border-radius:16px;padding:18px;border:1px solid #E2E8F0;border-left:4px solid var(--c);position:relative;overflow:hidden}
    .stat-icon{position:absolute;right:14px;top:14px;font-size:24px;opacity:.15}
    .stat-label{font-size:10px;color:#94A3B8;font-family:system-ui;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}
    .stat-val{font-size:24px;font-weight:900;color:#0F172A}
    .stat-sub{font-size:12px;color:var(--c);margin-top:4px;font-family:system-ui;font-weight:600}
    .card{background:#fff;border-radius:16px;padding:20px;border:1px solid #E2E8F0;margin-bottom:16px}
    .card-title{font-size:15px;font-weight:800;color:#0F172A;margin-bottom:16px}
    .txn{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #F8FAFC}
    .txn:last-child{border-bottom:none}
    .txn-name{font-size:14px;font-weight:700;color:#0F172A;font-family:system-ui}
    .txn-item{font-size:12px;color:#94A3B8;font-family:system-ui}
    .txn-date{font-size:11px;color:#CBD5E1;font-family:system-ui}
    .txn-amount{font-size:16px;font-weight:900;color:#065F46}
    .txn-pts{font-size:11px;color:#F59E0B;font-weight:700;font-family:system-ui}
    .customer-card{background:#fff;border-radius:14px;padding:16px;border:1px solid #E2E8F0;margin-bottom:10px}
    .c-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
    .c-name{font-size:15px;font-weight:800;color:#0F172A;font-family:system-ui}
    .c-phone{font-size:12px;color:#64748B;font-family:system-ui;margin-top:2px}
    .badge{border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;font-family:system-ui}
    .c-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
    .c-stat{background:#F8FAFC;border-radius:8px;padding:8px;text-align:center}
    .c-stat-val{font-size:13px;font-weight:800;color:#0F172A;font-family:system-ui}
    .c-stat-label{font-size:10px;color:#94A3B8;font-family:system-ui}
    .search-input{width:100%;padding:12px 16px;border-radius:12px;border:1px solid #E2E8F0;font-size:14px;font-family:system-ui;margin-bottom:16px;color:#0F172A;background:#fff}
    .followup-card{background:#fff;border-radius:14px;padding:18px;border:1px solid #E2E8F0;border-left:4px solid #EF4444;margin-bottom:12px}
    .fu-msg{background:#F0FDF4;border-radius:10px;padding:10px 14px;font-size:13px;color:#065F46;font-family:system-ui;font-style:italic;margin:10px 0 12px;line-height:1.5}
    .wa-btn{display:block;text-align:center;background:#25D366;color:#fff;border-radius:10px;padding:10px;font-size:13px;font-weight:700;font-family:system-ui;text-decoration:none}
    .loading{text-align:center;padding:40px;color:#94A3B8;font-family:system-ui;font-size:14px}
    .footer{position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #E2E8F0;padding:10px;text-align:center;font-size:12px;color:#94A3B8;font-family:system-ui}
    .footer span{color:#065F46;font-weight:700}
  </style>
</head>
<body>

<div id="login-screen">
  <div class="login-card">
    <div class="login-logo">🤖</div>
    <div class="login-title">MTEJA AI</div>
    <div class="login-sub">Business Dashboard · Kisumu</div>
    <div class="form-group">
      <label>YOUR WHATSAPP NUMBER</label>
      <input id="inp-phone" type="tel" placeholder="e.g. 254712345678"/>
    </div>
    <div class="form-group">
      <label>YOUR BUSINESS CODE</label>
      <input id="inp-code" type="text" placeholder="e.g. MTEJA-001"/>
    </div>
    <button class="btn-login" onclick="doLogin()">🚀 Open My Dashboard</button>
    <div id="login-msg"></div>
  </div>
</div>

<div id="dashboard">
  <div class="header">
    <div class="header-top">
      <div>
        <div class="biz-code" id="h-code"></div>
        <div class="biz-name" id="h-name"></div>
        <div class="biz-type" id="h-type"></div>
      </div>
      <button class="logout-btn" onclick="doLogout()">← Logout</button>
    </div>
    <div class="quick-stats">
      <div class="qs"><div class="qs-val" id="qs-rev">—</div><div class="qs-label">This Week</div></div>
      <div class="qs"><div class="qs-val" id="qs-cust">—</div><div class="qs-label">Customers</div></div>
      <div class="qs"><div class="qs-val" id="qs-fu">—</div><div class="qs-label">Follow-ups</div></div>
    </div>
  </div>
  <div class="tabs">
    <button class="tab active" onclick="showTab('overview',this)">📊 Overview</button>
    <button class="tab" onclick="showTab('customers',this)">👥 Customers</button>
    <button class="tab" onclick="showTab('transactions',this)">💰 Sales</button>
    <button class="tab" onclick="showTab('followups',this)">🔔 Follow-ups</button>
  </div>
  <div class="content">
    <div id="tab-overview"><div class="loading">Loading...</div></div>
    <div id="tab-customers" style="display:none"><div class="loading">Loading...</div></div>
    <div id="tab-transactions" style="display:none"><div class="loading">Loading...</div></div>
    <div id="tab-followups" style="display:none"><div class="loading">Loading...</div></div>
  </div>
  <div class="footer">MTEJA AI · <span>Kisumu, Kenya</span> · Powered by Gemini 🤖</div>
</div>

<script>
// ── SINGLE SUPABASE CLIENT — no naming conflicts ──────────────
const _db = window.supabase.createClient(
  "https://ypwmlgvgssdkicrlkhii.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlwd21sZ3Znc3Nka2ljcmxraGlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzNjg0ODgsImV4cCI6MjA5MTk0NDQ4OH0.8U1rsJ4RsUUiMPLWC2cHx9pcZgmpQXDjqdPGppVudq8"
);

let BIZ = null;
let CUSTOMERS = [];
let TRANSACTIONS = [];

// ── LOGIN ─────────────────────────────────────────────────────
async function doLogin() {
  const phone = document.getElementById("inp-phone").value.trim();
  const code  = document.getElementById("inp-code").value.trim().toUpperCase();
  const msg   = document.getElementById("login-msg");

  if (!phone || !code) {
    msg.style.color = "#EF4444";
    msg.textContent = "Please fill in both fields.";
    return;
  }

  msg.style.color = "#F59E0B";
  msg.textContent = "Checking...";

  try {
    const { data, error } = await _db
      .from("businesses")
      .select("*")
      .eq("phone", phone)
      .eq("code", code)
      .single();

    if (error || !data) {
      msg.style.color = "#EF4444";
      msg.textContent = "❌ Not found. Check your number and code.";
      console.error("Login error:", error);
      return;
    }

    msg.style.color = "#10B981";
    msg.textContent = "✅ Found! Opening dashboard...";
    BIZ = data;
    localStorage.setItem("mteja_biz", JSON.stringify({ phone, code }));
    setTimeout(openDashboard, 500);

  } catch(e) {
    msg.style.color = "#EF4444";
    msg.textContent = "❌ Error: " + e.message;
    console.error(e);
  }
}

// ── OPEN DASHBOARD ────────────────────────────────────────────
function openDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("dashboard").style.display = "block";
  document.getElementById("h-code").textContent = BIZ.code;
  document.getElementById("h-name").textContent = BIZ.name || "My Business";
  document.getElementById("h-type").textContent = (BIZ.type || "") + " · Since " +
    new Date(BIZ.created_at).toLocaleDateString("en-KE",{month:"long",year:"numeric"});
  loadData();
}

// ── LOGOUT ────────────────────────────────────────────────────
function doLogout() {
  localStorage.removeItem("mteja_biz");
  location.reload();
}

// ── LOAD ALL DATA ─────────────────────────────────────────────
async function loadData() {
  const phone = BIZ.phone;
  const weekAgo = new Date(Date.now() - 7*86400000).toISOString();

  const [custRes, txnRes] = await Promise.all([
    _db.from("customers").select("*").eq("business_phone", phone).order("total_spent",{ascending:false}),
    _db.from("transactions").select("*").eq("business_phone", phone).order("created_at",{ascending:false}).limit(50)
  ]);

  CUSTOMERS    = custRes.data  || [];
  TRANSACTIONS = txnRes.data   || [];

  const weekRev = TRANSACTIONS
    .filter(t => t.created_at > weekAgo)
    .reduce((s,t) => s + t.amount, 0);

  const overdue = CUSTOMERS.filter(c =>
    Math.floor((Date.now() - new Date(c.last_visit)) / 86400000) >= 18
  );

  document.getElementById("qs-rev").textContent  = "Ksh " + weekRev.toLocaleString();
  document.getElementById("qs-cust").textContent = CUSTOMERS.length;
  document.getElementById("qs-fu").textContent   = overdue.length;

  renderOverview(weekRev, overdue);
  renderCustomers();
  renderTransactions();
  renderFollowups(overdue);
}

// ── OVERVIEW ──────────────────────────────────────────────────
function renderOverview(weekRev, overdue) {
  const total = TRANSACTIONS.reduce((s,t) => s + t.amount, 0);
  const avg   = TRANSACTIONS.length ? Math.round(total / TRANSACTIONS.length) : 0;
  const pts   = CUSTOMERS.reduce((s,c) => s + c.total_points, 0);
  const top3  = [...CUSTOMERS].slice(0,3);
  const rec   = TRANSACTIONS.slice(0,4);

  document.getElementById("tab-overview").innerHTML = \`
    <div class="stat-grid">
      <div class="stat-card" style="--c:#065F46"><span class="stat-icon">💰</span>
        <div class="stat-label">Total Revenue</div>
        <div class="stat-val">Ksh \${total.toLocaleString()}</div>
        <div class="stat-sub">↑ Ksh \${weekRev.toLocaleString()} this week</div>
      </div>
      <div class="stat-card" style="--c:#0EA5E9"><span class="stat-icon">🧾</span>
        <div class="stat-label">Total Sales</div>
        <div class="stat-val">\${TRANSACTIONS.length}</div>
        <div class="stat-sub">Avg Ksh \${avg.toLocaleString()}</div>
      </div>
      <div class="stat-card" style="--c:#F59E0B"><span class="stat-icon">👥</span>
        <div class="stat-label">Customers</div>
        <div class="stat-val">\${CUSTOMERS.length}</div>
        <div class="stat-sub">\${overdue.length} need follow-up</div>
      </div>
      <div class="stat-card" style="--c:#8B5CF6"><span class="stat-icon">⭐</span>
        <div class="stat-label">Points Given</div>
        <div class="stat-val">\${pts}</div>
        <div class="stat-sub">Loyalty rewards</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">🏆 Top Customers</div>
      \${top3.length ? top3.map((c,i)=>\`
        <div class="txn">
          <div>
            <div class="txn-name">\${['🥇','🥈','🥉'][i]} \${c.name}</div>
            <div class="txn-item">\${c.visit_count} visits · \${c.total_points} pts</div>
          </div>
          <div class="txn-amount">Ksh \${c.total_spent.toLocaleString()}</div>
        </div>\`).join("") : '<p style="color:#94A3B8;font-family:system-ui;font-size:14px">No customers yet. Log your first sale!</p>'}
    </div>
    <div class="card">
      <div class="card-title">⚡ Recent Sales</div>
      \${rec.length ? rec.map(t=>\`
        <div class="txn">
          <div>
            <div class="txn-name">\${t.customer_name}</div>
            <div class="txn-item">\${t.item||"—"}</div>
            <div class="txn-date">\${new Date(t.created_at).toLocaleDateString("en-KE")}</div>
          </div>
          <div style="text-align:right">
            <div class="txn-amount">Ksh \${t.amount.toLocaleString()}</div>
            <div class="txn-pts">+\${t.points_awarded} pts</div>
          </div>
        </div>\`).join("") : '<p style="color:#94A3B8;font-family:system-ui;font-size:14px">No sales yet. Type "log" on WhatsApp to log your first sale!</p>'}
    </div>\`;
}

// ── CUSTOMERS ─────────────────────────────────────────────────
function renderCustomers(q) {
  q = q || "";
  const list = CUSTOMERS.filter(c =>
    c.name.toLowerCase().includes(q.toLowerCase()) ||
    (c.phone||"").includes(q)
  );

  document.getElementById("tab-customers").innerHTML = \`
    <input class="search-input" placeholder="🔍  Search by name or phone..."
      oninput="renderCustomers(this.value)" value="\${q}"/>
    \${list.length ? list.map(c => {
      const days = Math.floor((Date.now()-new Date(c.last_visit))/86400000);
      const s = c.total_spent>5000?"vip":days>=21?"overdue":days>=30?"lost":"active";
      const badge = {vip:["#FEF3C7","#92400E","⭐ VIP"],active:["#D1FAE5","#065F46","● Active"],overdue:["#FEE2E2","#991B1B","⚠ Overdue"],lost:["#F1F5F9","#64748B","✕ Lost"]}[s];
      return \`<div class="customer-card" style="border-left:4px solid \${badge[1]}">
        <div class="c-top">
          <div><div class="c-name">\${c.name}</div><div class="c-phone">📞 \${c.phone||"—"}</div></div>
          <span class="badge" style="background:\${badge[0]};color:\${badge[1]}">\${badge[2]}</span>
        </div>
        <div class="c-stats">
          <div class="c-stat"><div class="c-stat-val">Ksh \${c.total_spent.toLocaleString()}</div><div class="c-stat-label">Spent</div></div>
          <div class="c-stat"><div class="c-stat-val">⭐ \${c.total_points}</div><div class="c-stat-label">Points</div></div>
          <div class="c-stat"><div class="c-stat-val">\${days}d ago</div><div class="c-stat-label">Last Visit</div></div>
        </div>
      </div>\`;}).join("") : '<p style="color:#94A3B8;font-family:system-ui;font-size:14px;padding:20px 0">No customers yet.</p>'}\`;
}

// ── TRANSACTIONS ──────────────────────────────────────────────
function renderTransactions() {
  document.getElementById("tab-transactions").innerHTML = \`
    <div class="card">
      <div class="card-title" style="display:flex;justify-content:space-between">
        <span>All Sales</span>
        <span style="color:#065F46;font-size:13px;font-family:system-ui">\${TRANSACTIONS.length} records</span>
      </div>
      \${TRANSACTIONS.length ? TRANSACTIONS.map(t=>\`
        <div class="txn">
          <div>
            <div class="txn-name">\${t.customer_name}</div>
            <div class="txn-item">\${t.item||"—"}</div>
            <div class="txn-date">\${new Date(t.created_at).toLocaleDateString("en-KE",{day:"numeric",month:"short",year:"numeric"})}</div>
          </div>
          <div style="text-align:right">
            <div class="txn-amount">Ksh \${t.amount.toLocaleString()}</div>
            <div class="txn-pts">+\${t.points_awarded} pts</div>
          </div>
        </div>\`).join("") : '<p style="color:#94A3B8;font-family:system-ui;font-size:14px">No sales yet.</p>'}
    </div>\`;
}

// ── FOLLOWUPS ─────────────────────────────────────────────────
function renderFollowups(overdue) {
  document.getElementById("tab-followups").innerHTML = overdue.length===0
    ? \`<div class="card" style="text-align:center;color:#065F46;padding:40px;font-family:system-ui">🎉<br><br>No overdue customers!<br>Everyone visited recently.</div>\`
    : \`<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#991B1B;font-family:system-ui">
        ⚠️ \${overdue.length} customer(s) haven't visited in 18+ days!
       </div>
       \${overdue.map(c=>{
         const days=Math.floor((Date.now()-new Date(c.last_visit))/86400000);
         const wa=(c.phone||"").replace(/^0/,"254");
         const fname=c.name.split(" ")[0];
         return \`<div class="followup-card">
           <div class="c-top">
             <div><div class="c-name">\${c.name}</div><div class="c-phone">📞 \${c.phone||"—"}</div></div>
             <div style="text-align:right"><div style="font-size:13px;font-weight:700;color:#EF4444;font-family:system-ui">\${days} days ago</div>
             <div style="font-size:11px;color:#94A3B8;font-family:system-ui">Ksh \${c.total_spent.toLocaleString()} total</div></div>
           </div>
           <div class="fu-msg">💬 "\${fname}! Tumekukosa sana. Kuja uone deals zetu mpya — tuna kitu maalum kwako! 😊"</div>
           <a href="https://wa.me/\${wa}?text=Habari%20\${fname}!%20Tumekukosa%20sana%20%F0%9F%98%8A" target="_blank" class="wa-btn">📱 Send WhatsApp Message</a>
         </div>\`;}).join("")}\`;
}

// ── TABS ──────────────────────────────────────────────────────
function showTab(name, btn) {
  ["overview","customers","transactions","followups"].forEach(t=>{
    document.getElementById("tab-"+t).style.display = t===name?"block":"none";
  });
  document.querySelectorAll(".tab").forEach(b=>b.classList.remove("active"));
  btn.classList.add("active");
}

// ── AUTO LOGIN ────────────────────────────────────────────────
window.addEventListener("load", async () => {
  const saved = localStorage.getItem("mteja_biz");
  if (!saved) return;
  try {
    const { phone, code } = JSON.parse(saved);
    const { data, error } = await _db
      .from("businesses").select("*")
      .eq("phone", phone).eq("code", code).single();
    if (data && !error) {
      BIZ = data;
      openDashboard();
    } else {
      localStorage.removeItem("mteja_biz");
    }
  } catch(e) {
    localStorage.removeItem("mteja_biz");
  }
});
</script>
</body>
</html>
`;

function getSession(p) { return sessions.get(p) || { step: null, data: {} }; }
function setSession(p, s) { sessions.set(p, s); }
function clearSession(p) { sessions.delete(p); }

function generateCode(name) {
  const prefix = name.toUpperCase().replace(/[^A-Z]/g,"").substring(0,3).padEnd(3,"X");
  return `MTEJA-${prefix}${Math.floor(100+Math.random()*900)}`;
}

async function send(to, text) {
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_ID}/messages`, {
      method:"POST",
      headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json" },
      body:JSON.stringify({ messaging_product:"whatsapp", to, type:"text", text:{ body:text } }),
    });
    const d = await res.json();
    if(d.error) console.error("WA error:",d.error);
    else console.log(`✅ Sent to ${to}`);
  } catch(e) { console.error("Send failed:",e.message); }
}

async function askGemini(phone, msg) {
  const history = chatHistories.get(phone) || [];
  for(const modelName of MODELS) {
    for(let attempt=1; attempt<=3; attempt++) {
      try {
        const model = genAI.getGenerativeModel({ model:modelName, systemInstruction:SYSTEM_INSTRUCTION });
        const chat = model.startChat({ history, generationConfig:{ maxOutputTokens:300, temperature:0.7 } });
        const result = await chat.sendMessage(msg);
        const reply = result.response.text();
        chatHistories.set(phone, [...history,
          { role:"user", parts:[{ text:msg }] },
          { role:"model", parts:[{ text:reply }] }
        ].slice(-20));
        return reply;
      } catch(err) {
        const is404 = err.message?.includes("404")||err.message?.includes("not found");
        const is503 = err.message?.includes("503")||err.message?.includes("unavailable");
        if(is404) break;
        if(is503 && attempt<3) { await new Promise(r=>setTimeout(r,attempt*2000)); continue; }
        break;
      }
    }
  }
  return "Samahani, kuna msongo saa hii 😅 Jaribu tena!\n\n— MTEJA AI 🤖";
}

async function handleReg(phone, text, session) {
  if(session.step==="reg_start") {
    setSession(phone, { step:"reg_name", data:{} });
    return send(phone,"🏪 *Business Registration*\n━━━━━━━━━━━━\n\nStep 1 of 3\nWhat is your *business name?*\n\n— MTEJA AI 🤖");
  }
  if(session.step==="reg_name") {
    setSession(phone, { step:"reg_type", data:{ name:text } });
    return send(phone,`✅ Name: *${text}*\n\nStep 2 of 3\nBusiness *type?*\n• salon • pharmacy • hardware\n• restaurant • boutique • other\n\n— MTEJA AI 🤖`);
  }
  if(session.step==="reg_type") {
    setSession(phone, { step:"reg_owner", data:{ ...session.data, type:text } });
    return send(phone,`✅ Type: *${text}*\n\nStep 3 of 3\nYour *name* (owner)?\n\n— MTEJA AI 🤖`);
  }
  if(session.step==="reg_owner") {
    const { name, type } = session.data;
    const { data:existing } = await supabase.from("businesses").select("code").eq("phone",phone).single();
    if(existing) {
      clearSession(phone);
      return send(phone,`⚠️ Already registered!\nCode: *${existing.code}*\n\nType *dashboard* for login link.\n\n— MTEJA AI 🤖`);
    }
    const code = generateCode(name);
    const { error } = await supabase.from("businesses").insert({
      phone, name, type:type.toLowerCase(), owner_name:text,
      code, plan:"basic", created_at:new Date().toISOString()
    });
    clearSession(phone);
    if(error) { console.error("Reg error:",error); return send(phone,"❌ Failed. Type *register* to retry.\n\n— MTEJA AI 🤖"); }
    console.log(`✅ Registered: ${name} → ${code}`);
    return send(phone,`🎉 *Registered!*\n━━━━━━━━━━━━\n🏪 *${name}*\n👤 ${text}\n🔑 Code: *${code}*\n\nSave this code!\nType *dashboard* for your login link.\n\n— MTEJA AI 🤖`);
  }
}

async function handleSale(phone, text, session) {
  const { data:biz } = await supabase.from("businesses").select("name").eq("phone",phone).single();
  if(!biz) { clearSession(phone); return send(phone,"⚠️ Register first! Type *register*\n\n— MTEJA AI 🤖"); }
  if(session.step==="sale_start") {
    setSession(phone, { step:"sale_name", data:{} });
    return send(phone,"💰 *Log a Sale*\n━━━━━━━━━━━━\n\nStep 1 of 4\nCustomer *name?*\n\n— MTEJA AI 🤖");
  }
  if(session.step==="sale_name") {
    setSession(phone, { step:"sale_phone", data:{ customer_name:text } });
    return send(phone,`✅ Customer: *${text}*\n\nStep 2 of 4\nCustomer *phone?*\n(e.g. 0712345678)\nType *skip* if unknown.\n\n— MTEJA AI 🤖`);
  }
  if(session.step==="sale_phone") {
    const cp = text.toLowerCase()==="skip"?null:text;
    setSession(phone, { step:"sale_item", data:{ ...session.data, customer_phone:cp } });
    return send(phone,`✅ Phone: *${cp||"not provided"}*\n\nStep 3 of 4\nWhat did they *buy?*\n\n— MTEJA AI 🤖`);
  }
  if(session.step==="sale_item") {
    setSession(phone, { step:"sale_amount", data:{ ...session.data, item:text } });
    return send(phone,`✅ Item: *${text}*\n\nStep 4 of 4\n*Amount?* (Ksh)\n\n— MTEJA AI 🤖`);
  }
  if(session.step==="sale_amount") {
    const amount = parseInt(text.replace(/[^0-9]/g,""));
    if(!amount||amount<1) return send(phone,"⚠️ Enter valid amount e.g. *1500*\n\n— MTEJA AI 🤖");
    const { customer_name, customer_phone, item } = session.data;
    const points = Math.floor(amount/100);
    await supabase.from("transactions").insert({
      business_phone:phone, customer_name, customer_phone:customer_phone||null,
      item, amount, points_awarded:points, created_at:new Date().toISOString()
    });
    const { data:ex } = await supabase.from("customers").select("*").eq("business_phone",phone).eq("name",customer_name).single();
    if(ex) {
      await supabase.from("customers").update({
        total_points:ex.total_points+points, total_spent:ex.total_spent+amount,
        last_visit:new Date().toISOString(), visit_count:ex.visit_count+1,
        phone:customer_phone||ex.phone
      }).eq("id",ex.id);
    } else {
      await supabase.from("customers").insert({
        business_phone:phone, name:customer_name, phone:customer_phone||null,
        total_points:points, total_spent:amount,
        last_visit:new Date().toISOString(), visit_count:1
      });
    }
    clearSession(phone);
    console.log(`✅ Sale: ${customer_name} Ksh ${amount}`);
    return send(phone,`✅ *Sale Logged!*\n━━━━━━━━━━━━\n👤 ${customer_name}\n🛍️ ${item}\n💰 Ksh ${amount.toLocaleString()}\n⭐ +${points} pts\n\nType *log* for another.\n\n— MTEJA AI 🤖`);
  }
}

async function handleStats(phone) {
  const { data:txns } = await supabase.from("transactions").select("amount").eq("business_phone",phone)
    .gte("created_at",new Date(Date.now()-7*86400000).toISOString());
  const total = txns?.reduce((s,t)=>s+t.amount,0)||0;
  const count = txns?.length||0;
  const avg = count?Math.round(total/count):0;
  return send(phone,`📊 *Your Week*\n━━━━━━━━━━━━\n💰 Revenue: *Ksh ${total.toLocaleString()}*\n🧾 Sales: *${count}*\n📈 Avg: *Ksh ${avg.toLocaleString()}*\n\n${count>5?"🔥 Great week!":"💪 Log more sales!"}\n\n— MTEJA AI 🤖`);
}

async function handleFollow(phone) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-21);
  const { data } = await supabase.from("customers").select("*").eq("business_phone",phone)
    .lt("last_visit",cutoff.toISOString()).order("total_spent",{ascending:false}).limit(5);
  if(!data?.length) return send(phone,"🎉 No overdue customers!\n\nEveryone visited recently.\n\n— MTEJA AI 🤖");
  const list = data.map((c,i)=>{
    const days=Math.floor((Date.now()-new Date(c.last_visit))/86400000);
    return `${i+1}. *${c.name}* — ${days} days\n    📞 ${c.phone||"no phone"}`;
  }).join("\n");
  return send(phone,`📋 *Follow Up Today:*\n━━━━━━━━━━━━\n${list}\n\nSend them "Habari, tunakukosa!" 😊\n\n— MTEJA AI 🤖`);
}

app.get("/dashboard", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(DASHBOARD_HTML);
});

app.get("/webhook", (req, res) => {
  if(req.query["hub.mode"]==="subscribe" && req.query["hub.verify_token"]===VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(req.query["hub.challenge"]);
  } else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if(!message) return;
    const from = message.from;
    const text = message.type==="text" ? message.text.body.trim() : "[Please type your message]";
    console.log(`📩 From ${from}: ${text}`);
    const lower = text.toLowerCase();
    const session = getSession(from);

    if(session.step?.startsWith("reg_")) return handleReg(from, text, session);
    if(session.step?.startsWith("sale_")) return handleSale(from, text, session);

    if(lower==="register"||lower==="jiunge") {
      setSession(from,{step:"reg_start",data:{}});
      return handleReg(from,text,{step:"reg_start",data:{}});
    }
    if(lower==="log"||lower==="sale"||lower==="log sale") {
      setSession(from,{step:"sale_start",data:{}});
      return handleSale(from,text,{step:"sale_start",data:{}});
    }
    if(lower.startsWith("stats")||lower.startsWith("report")) return handleStats(from);
    if(lower.startsWith("follow")||lower.startsWith("wapi")) return handleFollow(from);
    if(lower==="help"||lower==="menu") {
      return send(from,"🤖 *MTEJA AI Commands*\n━━━━━━━━━━━━\n📝 *register*\n💰 *log*\n📋 *follow*\n📊 *stats*\n🌐 *dashboard*\n❓ *help*\n\n— MTEJA AI 🤖");
    }
    if(lower==="dashboard") {
      const { data:biz } = await supabase.from("businesses").select("code").eq("phone",from).single();
      if(biz) return send(from,`🌐 *Dashboard*\nhttps://mteja-ai.onrender.com/dashboard\n\n🔑 Login:\n📱 ${from}\n🏷️ *${biz.code}*\n\n— MTEJA AI 🤖`);
      return send(from,"Register first! Type *register*\n\n— MTEJA AI 🤖");
    }
    if(lower==="hello"||lower==="hi"||lower==="habari") {
      const { data:biz } = await supabase.from("businesses").select("name,code").eq("phone",from).single();
      if(biz) return send(from,`👋 Karibu ${biz.name}!\nCode: *${biz.code}*\n\nType *help* for commands.\n\n— MTEJA AI 🤖`);
      return send(from,"👋 *Habari! Welcome to MTEJA AI* 🤖\n\nType *register* to start!\n\n— MTEJA AI 🤖");
    }
    const reply = await askGemini(from, text);
    await send(from, reply);
  } catch(e) { console.error("❌ Webhook error:",e.message); }
});

app.get("/health", (_,res) => res.json({
  status:"ok", service:"MTEJA AI v2.1", timestamp:new Date().toISOString()
}));

app.listen(PORT, () => console.log(`🚀 MTEJA AI v2.1 running on port ${PORT}`));
