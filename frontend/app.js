// === Helper functions ===
function getAccess() { return localStorage.getItem("access"); }
function getRefresh() { return localStorage.getItem("refresh"); }
function clearTokens() { localStorage.removeItem("access"); localStorage.removeItem("refresh"); }

async function api(url, options={}) {
  const access = getAccess();
  options.headers = Object.assign({}, options.headers, access ? { Authorization: `Bearer ${access}` } : {});
  let res = await fetch(url, options);
  if (res.status === 401 && getRefresh()) {
    // try refresh
    const fd = new FormData();
    fd.append("refresh_token", getRefresh());
    const rr = await fetch("/auth/refresh", { method: "POST", body: fd });
    if (rr.ok) {
      const d = await rr.json();
      localStorage.setItem("access", d.access_token);
      options.headers.Authorization = `Bearer ${d.access_token}`;
      res = await fetch(url, options);
    } else {
      clearTokens();
    }
  }
  return res;
}

let CURRENT_USER = null;
async function fetchMe() {
  try {
    const res = await api("/me");
    if (!res.ok) return null;
    const data = await res.json();
    CURRENT_USER = data.user;
    return CURRENT_USER;
  } catch { return null; }
}

// === UI References ===
const authCard = document.getElementById("auth-card");
const modeCard = document.getElementById("mode-card");
const playerCard = document.getElementById("player-card");
const adminCard = document.getElementById("admin-card");
const appCard = document.getElementById("app-card");
const logoutBtn = document.getElementById("btn-logout");

// === UI state ===
function showLogin() {
  authCard.style.display = "";
  modeCard.style.display = "none";
  playerCard.style.display = "none";
  appCard.style.display = "none";
  adminCard.style.display = "none";
  logoutBtn.style.display = "none";
}

function showMode() {
  authCard.style.display = "none";
  modeCard.style.display = "";
  playerCard.style.display = "none";
  appCard.style.display = "none";
  logoutBtn.style.display = "";
}

function showPlayer() {
  modeCard.style.display = "none";
  playerCard.style.display = "";
}

function showApp() {
  modeCard.style.display = "none";
  playerCard.style.display = "none";
  appCard.style.display = "";
  logoutBtn.style.display = "";
}

function showAdminIfNeeded() {
  if (CURRENT_USER?.is_admin) adminCard.style.display = "";
  else adminCard.style.display = "none";
}

// === Logout ===
logoutBtn.addEventListener("click", () => {
  clearTokens();
  showLogin();
});

// === Login ===
document.getElementById("login-form").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch("/auth/login", { method:"POST", body:fd });
  const data = await res.json();
  if (!res.ok || !data.ok) return alert(data.detail || "Login failed");
  localStorage.setItem("access", data.access_token);
  localStorage.setItem("refresh", data.refresh_token);
  await afterLogin();
});

// === Register ===
document.getElementById("register-form").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch("/auth/register", { method:"POST", body:fd });
  const data = await res.json();
  if (!res.ok || !data.ok) return alert(data.detail || "Registration failed");
  alert("Account created. Please login.");
});

// === After Login ===
async function afterLogin() {
  const me = await fetchMe();
  if (!me) { clearTokens(); return showLogin(); }
  showAdminIfNeeded();
  if (CURRENT_USER?.is_admin) adminLoadPending();
  showMode();
}

// === Player Register Button ===
document.getElementById("btn-register-player").addEventListener("click", () => showPlayer());

// === Watch Button ===
document.getElementById("btn-watch").addEventListener("click", () => showApp());

// === Player Registration Submit ===
document.getElementById("player-form").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await api("/player/register", { method:"POST", body:fd });
  const data = await res.json();
  if (!res.ok || !data.ok) return alert(data.detail || "Registration failed");
  alert("Registered! Base Price will be set by admin.");
  showMode();
});

// === Admin Panel ===
const adminList = document.getElementById("admin-pending-list");
async function adminLoadPending() {
  const res = await api("/admin/players/pending");
  const data = await res.json();
  adminList.innerHTML = "";
  (data.players||[]).forEach(p => {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center";
    li.innerHTML = `
      <span><strong>${p.name}</strong> (${p.affiliation_role})</span>
      <div class="input-group" style="max-width:200px;">
        <span class="input-group-text">₹</span>
        <input type="number" class="form-control" min="1" />
        <button class="btn btn-primary">Set</button>
      </div>`;
    const input = li.querySelector("input");
    const btn = li.querySelector("button");
    btn.addEventListener("click", async()=> {
      const price = Number(input.value);
      const r = await api(`/admin/player/${p._id}/base-price`, {
        method:"PATCH",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ price })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.detail || "Failed");
      li.remove();
    });
    adminList.appendChild(li);
  });
}

// === Boot ===
(async function boot(){
  if (!getAccess() && !getRefresh()) return showLogin();
  const me = await fetchMe();
  if (!me) { clearTokens(); return showLogin(); }
  showAdminIfNeeded();
  if (CURRENT_USER?.is_admin) adminLoadPending();
  showMode();
})();
