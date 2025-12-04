// === Token helpers ===
function getAccess() { return localStorage.getItem("access"); }
function getRefresh() { return localStorage.getItem("refresh"); }
function setTokens(a, r) { if (a) localStorage.setItem("access", a); if (r) localStorage.setItem("refresh", r); }
function clearTokens() { localStorage.removeItem("access"); localStorage.removeItem("refresh"); }

async function api(url, options={}) {
  const access = getAccess();
  options.headers = Object.assign({}, options.headers, access ? { Authorization: `Bearer ${access}` } : {});
  let res = await fetch(url, options);
  if (res.status === 401 && getRefresh()) {
    const fd = new FormData();
    fd.append("refresh_token", getRefresh());
    const rr = await fetch("/auth/refresh", { method: "POST", body: fd });
    if (rr.ok) {
      const d = await rr.json();
      setTokens(d.access_token, null);
      options.headers.Authorization = `Bearer ${d.access_token}`;
      res = await fetch(url, options);
    } else {
      clearTokens();
    }
  }
  return res;
}

let CURRENT_USER = null;
let WATCH_MODE = false;

// NEW: track currently selected player row for highlight
let SELECTED_PLAYER_ROW = null;

// === Fetch user ===
async function fetchMe() {
  try {
    const res = await api("/me");
    if (!res.ok) return null;
    const data = await res.json();
    CURRENT_USER = data.user;
    return CURRENT_USER;
  } catch { return null; }
}

// === UI refs ===
const authCard   = document.getElementById("auth-card");
const modeCard   = document.getElementById("mode-card");
const playerCard = document.getElementById("player-card");
const adminCard  = document.getElementById("admin-card");  // may be null
const appCard    = document.getElementById("app-card");    // may be null
const logoutBtn  = document.getElementById("btn-logout");

// NEW: admin start controls on mode page
const adminStartWrapper = document.getElementById("admin-start-wrapper");
const adminStartBtn     = document.getElementById("btn-start-auction");
const adminStartStatus  = document.getElementById("admin-start-status");

// === UI ===
function showLogin() {
  if (authCard)   authCard.style.display = "";
  if (modeCard)   modeCard.style.display = "none";
  if (playerCard) playerCard.style.display = "none";
  if (appCard)    appCard.style.display = "none";
  if (adminCard)  adminCard.style.display = "none";
  if (logoutBtn)  logoutBtn.style.display = "none";
}

function showMode() {
  WATCH_MODE = false;
  if (authCard)   authCard.style.display = "none";
  if (modeCard)   modeCard.style.display = "";
  if (playerCard) playerCard.style.display = "none";
  if (appCard)    appCard.style.display = "none";
  if (logoutBtn)  logoutBtn.style.display = "";
}

function showPlayer() {
  if (modeCard)   modeCard.style.display = "none";
  if (playerCard) playerCard.style.display = "";
}

function showApp() {
  if (modeCard)   modeCard.style.display = "none";
  if (playerCard) playerCard.style.display = "none";
  if (appCard)    appCard.style.display = "";
  if (logoutBtn)  logoutBtn.style.display = "";
  applyBidPermissions();
}

// Lock team select for team members (non-admin)
function applyTeamLock() {
  const teamSelect = document.getElementById("team-picker");
  if (!teamSelect) return;
  if (CURRENT_USER && !CURRENT_USER.is_admin && CURRENT_USER.team_id) {
    const tid = CURRENT_USER.team_id;
    teamSelect.value = tid;
    teamSelect.disabled = true;
  } else {
    teamSelect.disabled = false;
  }
}

function showAdminIfNeeded() {
  const startBtn = document.getElementById("btn-start");
  const stopBtn  = document.getElementById("btn-stop");

  if (!(CURRENT_USER?.is_admin)) {
    if (startBtn) startBtn.style.display = "none";
    if (stopBtn)  stopBtn.style.display  = "none";
    if (adminCard) adminCard.style.display = "none";
    if (adminStartWrapper) adminStartWrapper.classList.add("d-none");
  } else {
    if (startBtn) startBtn.style.display = "";
    if (stopBtn)  stopBtn.style.display  = "";
    if (adminCard) adminCard.style.display = "";
    if (adminStartWrapper) adminStartWrapper.classList.remove("d-none");
  }
}

// === Bid permissions ===
function applyBidPermissions(container=document) {
  const canBid = !!(CURRENT_USER) && !WATCH_MODE;
  container.querySelectorAll('button[data-action="bid"]').forEach(b => b.disabled = !canBid);
  container.querySelectorAll('.bid-input').forEach(i => i.disabled = !canBid);
}

// === Logout ===
if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    clearTokens();
    CURRENT_USER = null;
    showLogin();
  });
}

/* ===============================
   FIXED: USER LOGIN HANDLER
   =============================== */
document.getElementById("login-form").addEventListener("submit", async(e)=>{
  e.preventDefault();
  e.stopPropagation();   // prevent double submit

  const fd   = new FormData(e.target);
  const res  = await fetch("/auth/login", { method:"POST", body:fd });
  const data = await res.json();

  if (!res.ok || !data.ok) return alert(data.detail || "Login failed");

  setTokens(data.access_token, data.refresh_token);
  const me = await fetchMe();
  if (!me) { clearTokens(); return showLogin(); }

  showAdminIfNeeded();
  showMode();
  loadStatus();
  loadTeams().then(applyTeamLock);
  loadPlayers();
});

/* ===============================
   FIXED: ADMIN LOGIN HANDLER
   =============================== */
document.getElementById("admin-login-form").addEventListener("submit", async(e)=>{
  e.preventDefault();
  e.stopPropagation();   // prevent bubbling into other handlers

  const fd   = new FormData(e.target);
  const res  = await fetch("/auth/login", { method:"POST", body:fd });
  const data = await res.json();

  if (!res.ok || !data.ok) return alert(data.detail || "Login failed");

  setTokens(data.access_token, data.refresh_token);

  const me = await fetchMe();
  if (!me || !CURRENT_USER?.is_admin) {
    clearTokens();
    return alert("This account is not an admin.");
  }

  // Redirect admin to admin dashboard
  window.location.href = "/admin";
});

// === Account Register ===
document.getElementById("register-form").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch("/auth/register", { method:"POST", body:fd });
  const data = await res.json();
  if (!res.ok || !data.ok) return alert(data.detail || "Registration failed");
  alert("Account created. Login now.");
});

// === Mode buttons ===
document.getElementById("btn-register-player").addEventListener("click", () => showPlayer());

// WATCH MODE -> viewer
document.getElementById("btn-watch").addEventListener("click", (e) => {
  e.preventDefault();
  window.location.href = "/viewer";
});

// === Player Registration ===
document.getElementById("player-form").addEventListener("submit", async(e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await api("/players/public_register", { method:"POST", body:fd });
  const data = await res.json();
  if (!res.ok || !data.ok) return alert(data.detail || "Registration failed");
  alert("Registered successfully!");
  showMode();
});

// === Admin Panel: Load Pending Players ===
const adminList = document.getElementById("admin-pending-list");
async function adminLoadPending() {
  if (!adminList) return;
  const res  = await api("/admin/players/pending");
  const data = await res.json();
  adminList.innerHTML = "";
  (data.players || []).forEach(p => {
    const li = document.createElement("li");
    li.className = "list-group-item d-flex justify-content-between align-items-center gap-2 flex-wrap";
    li.innerHTML = `
      <div><strong>${p.name}</strong> <span class="badge text-bg-secondary">${p.affiliation_role||"-"}</span></div>
      <div class="input-group" style="max-width:220px">
        <span class="input-group-text">₹</span>
        <input type="number" min="1" class="hidden" placeholder="Base Price" />
        <button class="btn btn-primary">Set</button>
      </div>`;
    const input = li.querySelector("input");
    const btn   = li.querySelector("button");
    btn.addEventListener("click", async()=>{
      const price = Number(input.value || 0);
      if (!price) return alert("Enter a valid price");
      const r = await api(`/admin/player/${p._id}/base-price`, {
        method:"PATCH",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ price })
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.detail || "Failed");
      li.remove();
    });
    adminList.appendChild(li);
  });
}

// === Auction status ===
async function loadStatus() {
  try {
    const r = await fetch("/auction/status");
    const s = await r.json();
    const el = document.getElementById("auction-status");
    if (!el) return;
    el.textContent = s.active ? "Auction is LIVE" : "Auction is NOT active";
    el.classList.toggle("alert-success", !!s.active);
    el.classList.toggle("alert-secondary", !s.active);
  } catch {}
}

// === Teams ===
async function loadTeams() {
  try {
    const r = await api("/teams");
    const teams = await r.json();
    const sel = document.getElementById("team-picker");
    if (!sel) return;
    sel.innerHTML = `<option value="">Select Team</option>`;
    teams.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t._id;
      opt.textContent = `${t.name} (₹${t.budget})`;
      sel.appendChild(opt);
    });
  } catch {}
}

// === Players ===
async function loadPlayers() {
  try {
    const r = await fetch("/players/");
    const players = await r.json();
    const wrap = document.getElementById("players-list");
    if (!wrap) return;
    wrap.innerHTML = "";
    players.forEach(p => {
      const div = document.createElement("div");
      div.className = "list-group-item d-flex align-items-center gap-3";

      // EXISTING dataset
      div.dataset.playerId = p._id;

      // NEW: extra dataset fields required for Selected Player Info
      div.dataset.name      = p.name || "";
      div.dataset.category  = p.category || "";
      div.dataset.basePrice = (p.base_price ?? "").toString();
      div.dataset.finalBid  = (p.final_bid ?? "").toString();
      div.dataset.status    = p.status || "available";
      // team name may come with different property names; fall back safely
      div.dataset.team      = (p.team_name || p.team || "").toString();

      const suggested = (typeof p.final_bid === "number" ? p.final_bid + 50 : (p.base_price || 100));
      div.innerHTML = `
        <div class="flex-grow-1">
          <div><strong>${p.name}</strong> <small class="text-muted">(${p.category || "-"})</small></div>
          <div>Status: ${p.status || "available"}${p.final_bid ? " · Final Bid: " + p.final_bid : ""}</div>
        </div>
        <div class="ms-auto d-flex gap-2" style="min-width:260px">
          <div class="input-group" style="max-width:200px">
            <span class="input-group-text">₹</span>
            <input type="number" class="hidden" value="${suggested}" />
          </div>
          
        </div>`;
      wrap.appendChild(div);
    });
    applyBidPermissions(wrap);
  } catch {}
}

/* ===============================
   NEW: Selected-player-row CSS helper
   =============================== */
function ensureSelectedRowHighlightStyle() {
  if (document.getElementById("selected-player-row-style")) return;
  const style = document.createElement("style");
  style.id = "selected-player-row-style";
  style.textContent = `
    .selected-player-row {
      background-color: #fff3cd;
      transition: background-color 0.2s ease-in-out;
    }
  `;
  document.head.appendChild(style);
}

/* ===============================
   NEW: Selected Player Info renderer
   =============================== */
function showSelectedPlayerInfo(row, teamId) {
  if (!row) return;

  const {
    name,
    category,
    basePrice,
    finalBid,
    status,
    team
  } = row.dataset;

  const container = document.getElementById("selected-player-info");
  if (!container) return; // silently exit if container not present in HTML

  // Make sure container is visible when we have a selection
  container.classList.remove("d-none");
  container.style.display = "";

  // Try to fill structured fields if they exist
  const nameEl       = container.querySelector(".selected-player-name");
  const categoryEl   = container.querySelector(".selected-player-category");
  const basePriceEl  = container.querySelector(".selected-player-base-price");
  const finalBidEl   = container.querySelector(".selected-player-final-bid");
  const statusEl     = container.querySelector(".selected-player-status");
  const teamEl       = container.querySelector(".selected-player-team");
  const chosenTeamEl = container.querySelector(".selected-player-chosen-team");

  if (nameEl)      nameEl.textContent      = name || "";
  if (categoryEl)  categoryEl.textContent  = category || "";
  if (basePriceEl) basePriceEl.textContent = basePrice || "-";
  if (finalBidEl)  finalBidEl.textContent  = finalBid || "-";
  if (statusEl)    statusEl.textContent    = status || "-";
  if (teamEl)      teamEl.textContent      = team || "-";
  if (chosenTeamEl) chosenTeamEl.textContent = teamId || "";

  // Fallback: if there are no specific fields, render a simple details block
  if (
    !nameEl && !categoryEl && !basePriceEl &&
    !finalBidEl && !statusEl && !teamEl && !chosenTeamEl
  ) {
    container.innerHTML = `
      <div><strong>${name || "Unnamed player"}</strong>${category ? ` <span class="text-muted">(${category})</span>` : ""}</div>
      <div>Base Price: ${basePrice || "-"}</div>
      <div>Status: ${status || "-"}</div>
      <div>Final Bid: ${finalBid || "-"}</div>
      <div>Team: ${team || "-"}</div>
      ${teamId ? `<div>Selected by team ID: ${teamId}</div>` : ""}
    `;
  }
}

// === Bid handler ===
const playersListEl = document.getElementById("players-list");
if (playersListEl) {
  playersListEl.addEventListener("click", async (e) => {
    const btn = e.target.closest('button[data-action="bid"]');
    if (!btn) return;

    if (!CURRENT_USER) {
      return alert("Please login first.");
    }

    const row = btn.closest(".list-group-item");
    const playerId = row?.dataset.playerId;
    if (!playerId) return alert("Player ID missing.");

    const input = row.querySelector(".bid-input");
    const amount = Number(input?.value || 0);
    if (!amount || amount <= 0) return alert("Enter a valid bid amount.");

    const teamSelect = document.getElementById("team-picker");
    let teamId = teamSelect ? teamSelect.value : "";

    if (!teamId && CURRENT_USER.team_id) {
      teamId = CURRENT_USER.team_id;
    }

    if (!teamId) {
      return alert("Select a team first.");
    }

    try {
      const res = await api("/auction/bid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          player_id: playerId,
          team_id: teamId,
          bid_amount: amount
        })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        return alert(data.detail || data.message || "Bid failed");
      }
      alert("Bid placed successfully!");
      loadStatus();
      loadTeams().then(applyTeamLock);
      loadPlayers();
    } catch (err) {
      console.error(err);
      alert("Error placing bid.");
    }
  });

  /* ==========================================
     NEW: Row click → Selected Player Info
     ========================================== */
  playersListEl.addEventListener("click", (e) => {
    const row = e.target.closest(".list-group-item");
    if (!row) return;

    // Ignore clicks on the bid button so original bid handler works
    if (e.target.closest('button[data-action="bid"]')) return;

    // Make sure highlight style is available
    ensureSelectedRowHighlightStyle();

    // Remove highlight from previous row
    if (SELECTED_PLAYER_ROW && SELECTED_PLAYER_ROW !== row) {
      SELECTED_PLAYER_ROW.classList.remove("selected-player-row");
    }

    // Highlight current row
    row.classList.add("selected-player-row");
    SELECTED_PLAYER_ROW = row;

    // Resolve selected team ID (similar logic as bidding)
    const teamSelect = document.getElementById("team-picker");
    let teamId = teamSelect ? teamSelect.value : "";
    if (!teamId && CURRENT_USER?.team_id) {
      teamId = CURRENT_USER.team_id;
    }

    // Show details in the Selected Player Info container
    showSelectedPlayerInfo(row, teamId);
  });
}

// === Admin Start Auction (Mode page button) ===
if (adminStartBtn) {
  adminStartBtn.addEventListener("click", async () => {
    if (!CURRENT_USER?.is_admin) {
      return alert("Only admins can start the auction.");
    }
    adminStartStatus.textContent = "";
    try {
      const res = await api("/auction/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        adminStartStatus.textContent = data.detail || data.message || "Failed to start auction.";
        adminStartStatus.classList.remove("text-success");
        adminStartStatus.classList.add("text-danger");
        return;
      }
      adminStartStatus.textContent = data.message || "Auction started.";
      adminStartStatus.classList.remove("text-danger");
      adminStartStatus.classList.add("text-success");
      loadStatus();
    } catch (err) {
      console.error(err);
      adminStartStatus.textContent = "Error starting auction.";
      adminStartStatus.classList.remove("text-success");
      adminStartStatus.classList.add("text-danger");
    }
  });
}

// Existing app-card buttons
const btnStart = document.getElementById("btn-start");
const btnStop  = document.getElementById("btn-stop");

if (btnStart) {
  btnStart.addEventListener("click", async () => {
    if (!CURRENT_USER?.is_admin) return alert("Only admins can start the auction.");
    try {
      const res = await api("/auction/start", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) return alert(data.detail || data.message || "Failed to start auction.");
      alert(data.message || "Auction started.");
      loadStatus();
    } catch {
      alert("Error starting auction.");
    }
  });
}

if (btnStop) {
  btnStop.addEventListener("click", async () => {
    if (!CURRENT_USER?.is_admin) return alert("Only admins can stop the auction.");
    try {
      const res = await api("/auction/stop", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) return alert(data.detail || data.message || "Failed to stop auction.");
      alert(data.message || "Auction stopped.");
      loadStatus();
    } catch {
      alert("Error stopping auction.");
    }
  });
}

// Boot
(async function boot(){
  if (!getAccess() && !getRefresh()) return showLogin();

  const me = await fetchMe();
  if (!me) { clearTokens(); return showLogin(); }

  showAdminIfNeeded();

  if (CURRENT_USER?.is_admin) adminLoadPending();

  showMode();
  loadStatus();
  await loadTeams();
  applyTeamLock();
  loadPlayers();
})();
