// ==========================
// Config
// ==========================
const API_BASE = "http://localhost:8000";

// ==========================
// State
// ==========================
let lastId = 0;
let stopPolling = false;
let teamId = localStorage.getItem("teamId") || "";
let auctionActive = false;
let bpPlayer = null; // bidding panel current player

// ==========================
// Elements
// ==========================
const auctionStatusDiv = document.getElementById("auction-status");
const playersListDiv   = document.getElementById("players-list");
const teamBudgetDiv    = document.getElementById("team-budget");
const teamPicker       = document.getElementById("team-picker");
const btnStart         = document.getElementById("btn-start");
const btnStop          = document.getElementById("btn-stop");

// Bidding panel (optional, can be omitted from HTML if not used)
const bpBackdrop = document.getElementById("bid-panel-backdrop");
const bpClose    = document.getElementById("bp-close");
const bpCancel   = document.getElementById("bp-cancel");
const bpSubmit   = document.getElementById("bp-submit");
const bpAmount   = document.getElementById("bp-amount");
const bpHighest  = document.getElementById("bp-highest");
const bpPName    = document.getElementById("bp-player-name");
const bpPMeta    = document.getElementById("bp-player-meta");

// ==========================
// UI helpers
// ==========================
function setAuctionActiveUI(active) {
  auctionActive = !!active;
  const msg = active ? "Auction is LIVE" : "Auction is NOT active";
  auctionStatusDiv.textContent = msg;
  auctionStatusDiv.classList.toggle("alert-success", active);
  auctionStatusDiv.classList.toggle("alert-secondary", !active);

  // buttons + inputs on each row
  document.querySelectorAll("#players-list button[data-action='bid']").forEach(b => {
    b.disabled = !auctionActive || !teamId;
  });
  document.querySelectorAll("#players-list .bid-input").forEach(inp => {
    inp.disabled = !auctionActive || !teamId;
  });

  // panel submit
  if (bpSubmit) bpSubmit.disabled = !auctionActive || !teamId;
}

function ensureTeamChosen() {
  if (!teamId) {
    alert("Please select your team first.");
    teamPicker?.focus();
    return false;
  }
  return true;
}

// ==========================
// Row rendering (amount input + button on right)
// ==========================
function renderPlayerRow(player) {
  const item = document.createElement("div");
  item.className = "list-group-item d-flex align-items-center gap-3";

  const suggested =
    (typeof player.final_bid === "number" && !isNaN(player.final_bid))
      ? player.final_bid + 50
      : (player.base_price || 100);

  item.innerHTML = `
    <div class="flex-grow-1" data-player-id="${player._id}">
      <div><strong>${player.name}</strong> <small class="text-muted">(${player.category})</small></div>
      <div class="status">Status: ${player.status || "available"}${player.final_bid ? " · Final Bid: " + player.final_bid : ""}</div>
    </div>

    <div class="ms-auto d-flex align-items-center gap-2" style="min-width:260px">
      <div class="input-group" style="max-width:200px">
        <span class="input-group-text">₹</span>
        <input type="number" class="form-control bid-input" step="1" min="1" value="${suggested}" placeholder="Amount" />
      </div>
      <button class="btn btn-sm btn-primary" data-action="bid">Place Bid</button>
    </div>
  `;

  const btn   = item.querySelector('[data-action="bid"]');
  const input = item.querySelector('.bid-input');

  btn.onclick = () => placeBid(player._id, input.value);

  // current state
  btn.disabled   = !auctionActive || !teamId;
  input.disabled = !auctionActive || !teamId;

  return item;
}

// ==========================
// Event handling (from /auction/updates)
// ==========================
function applyEvent(evt) {
  if (evt.type === "auction_status") {
    setAuctionActiveUI(!!evt.data.active);
    return;
  }

  if (evt.type === "team_budget") {
    if (evt.data.team_id === teamId) {
      const txt = `Your Remaining Budget: ${evt.data.budget}`;
      const total = teamBudgetDiv.getAttribute("data-total");
      teamBudgetDiv.textContent = total ? `${txt} (Total: ₹${total})` : txt;
    }
    return;
  }

  if (evt.type === "bid_placed") {
    const { player_id, amount } = evt.data;

    const rowWrap = document.querySelector(`[data-player-id="${player_id}"]`);
    if (rowWrap) {
      const statusEl = rowWrap.querySelector(".status");
      if (statusEl) {
        const base = (statusEl.textContent || "").replace(/\s*·\s*Final Bid:\s*[\d.]+/, "");
        statusEl.textContent = `${base} · Final Bid: ${amount}`;
      }
      // bump the row's input to next step
      const input = rowWrap.parentElement.querySelector(".bid-input");
      if (input) {
        const current = Number(input.value || 0);
        if (amount >= current) input.value = amount + 50;
      }
    } else {
      loadPlayers();
    }

    // if panel open for same player
    if (bpPlayer && bpPlayer._id === player_id) {
      const current = Number(bpAmount?.value || 0);
      if (amount >= current) {
        if (bpAmount) bpAmount.value = amount + 50;
        if (bpHighest) bpHighest.textContent = `₹ ${amount} (latest)`;
      }
    }
    return;
  }

  if (evt.type === "player_sold") {
    const { player_id } = evt.data;
    const rowWrap = document.querySelector(`[data-player-id="${player_id}"]`);
    if (rowWrap) {
      const statusEl = rowWrap.querySelector(".status");
      if (statusEl) statusEl.textContent = "Status: sold";
      const btn = rowWrap.parentElement.querySelector('[data-action="bid"]');
      const inp = rowWrap.parentElement.querySelector('.bid-input');
      if (btn) btn.disabled = true;
      if (inp) inp.disabled = true;
    } else {
      loadPlayers();
    }
    return;
  }
}

// ==========================
// Networking
// ==========================
async function longPoll() {
  while (!stopPolling) {
    const params = new URLSearchParams();
    if (lastId) params.set("since", String(lastId));
    params.set("timeout", "25");

    try {
      const res = await fetch(`${API_BASE}/auction/updates?${params.toString()}`);
      const body = await res.json();
      const events = body.events || [];
      if (events.length) {
        events.forEach(applyEvent);
        lastId = body.last_id || lastId;
      }
    } catch (e) {
      console.error("Polling error:", e);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function loadPlayers() {
  try {
    const res = await fetch(`${API_BASE}/players/`);
    const players = await res.json();
    playersListDiv.innerHTML = "";
    players.forEach(p => playersListDiv.appendChild(renderPlayerRow(p)));
    setAuctionActiveUI(auctionActive);
  } catch (e) {
    console.error("Error fetching players:", e);
  }
}

async function loadStatus() {
  try {
    const r = await fetch(`${API_BASE}/auction/status`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    setAuctionActiveUI(!!s.active);
  } catch (e) {
    console.error("Failed to load /auction/status:", e);
    auctionStatusDiv.textContent = "Could not load auction status";
    auctionStatusDiv.classList.remove("alert-success");
    auctionStatusDiv.classList.add("alert-warning");
  }
}

async function loadTeams() {
  try {
    const res = await fetch(`${API_BASE}/teams/`);
    const teams = await res.json();
    if (!teamPicker) return;

    teamPicker.innerHTML = `<option value="">— Select team —</option>`;
    teams.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t._id;
      opt.textContent = `${t.name} (₹${t.budget})`;
      teamPicker.appendChild(opt);
    });

    if (teamId) {
      const found = [...teamPicker.options].some(o => o.value === teamId);
      if (found) {
        teamPicker.value = teamId;
        await showTeamBudgetTotal(teamId);
      } else {
        teamId = "";
        localStorage.removeItem("teamId");
      }
    }

    teamPicker.onchange = async () => {
      teamId = teamPicker.value;
      if (teamId) {
        localStorage.setItem("teamId", teamId);
        await showTeamBudgetTotal(teamId);
      } else {
        localStorage.removeItem("teamId");
        teamBudgetDiv.textContent = "Budget: —";
        teamBudgetDiv.removeAttribute("data-total");
      }
      setAuctionActiveUI(auctionActive);
    };
  } catch (e) {
    console.error("Error loading teams:", e);
  }
}

async function showTeamBudgetTotal(id) {
  try {
    const res = await fetch(`${API_BASE}/teams/${id}`);
    const team = await res.json();
    teamBudgetDiv.setAttribute("data-total", team.budget);
    teamBudgetDiv.textContent = `Your Remaining Budget: — (Total: ₹${team.budget})`;
  } catch (e) {
    console.error("Error loading team:", e);
  }
}

// ==========================
// Bidding panel (optional)
// ==========================
async function fetchHighest(playerId) {
  try {
    const r = await fetch(`${API_BASE}/auction/bids/highest?player_id=${playerId}`);
    const body = await r.json();
    const highest = body?.highest_bid;
    if (!highest) { bpHighest && (bpHighest.textContent = "No bids yet"); return 0; }
    bpHighest && (bpHighest.textContent = `₹ ${highest.amount} (by team ${highest.team_id})`);
    return Number(highest.amount) || 0;
  } catch {
    bpHighest && (bpHighest.textContent = "Unable to load");
    return 0;
  }
}

async function openBidPanel(player) {
  if (!ensureTeamChosen()) return;
  bpPlayer = player;
  bpPName && (bpPName.textContent = player.name || "—");
  bpPMeta && (bpPMeta.textContent = `${player.category || "—"} · Base ₹${player.base_price ?? "—"}`);

  const highest = await fetchHighest(player._id);
  const suggested = highest ? highest + 50 : (player.base_price || 100);
  bpAmount && (bpAmount.value = suggested);
  bpSubmit && (bpSubmit.disabled = !auctionActive || !teamId);

  if (bpBackdrop) {
    bpBackdrop.style.display = "flex";
    bpAmount?.focus();
  }
}

function closeBidPanel() {
  if (bpBackdrop) bpBackdrop.style.display = "none";
  bpPlayer = null;
}
bpClose  && (bpClose.onclick  = closeBidPanel);
bpCancel && (bpCancel.onclick = closeBidPanel);

if (bpSubmit) {
  bpSubmit.onclick = async () => {
    if (!bpPlayer || !ensureTeamChosen()) return;
    const amount = Number(bpAmount?.value || 0);
    if (!amount || isNaN(amount) || amount <= 0) return alert("Enter a valid amount");
    if (!auctionActive) return alert("Auction is not active");

    try {
      const res = await fetch(`${API_BASE}/auction/bid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: bpPlayer._id, team_id: teamId, bid_amount: amount })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Bid failed");
      alert(data.message || "Bid placed successfully");
      closeBidPanel();
    } catch (e) {
      alert("Error: " + e.message);
    }
  };
}

// quick + buttons in panel
document.querySelectorAll("[data-bp-inc]").forEach(btn => {
  btn.addEventListener("click", () => {
    const inc = Number(btn.getAttribute("data-bp-inc"));
    const now = Number(bpAmount?.value || 0);
    bpAmount && (bpAmount.value = now + inc);
  });
});

// ==========================
// Row bid action (uses the per-row input value)
// ==========================
async function placeBid(playerId, rawAmount) {
  if (!ensureTeamChosen()) return;
  const amount = Number(rawAmount);
  if (!amount || isNaN(amount) || amount <= 0) return alert("Enter a valid amount");
  if (!auctionActive) return alert("Auction is not active");

  try {
    const res = await fetch(`${API_BASE}/auction/bid`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player_id: playerId, team_id: teamId, bid_amount: amount })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Bid failed");
    alert(data.message || "Bid placed successfully");
  } catch (e) {
    alert("Error: " + e.message);
  }
}

// ==========================
// Start/Stop buttons
// ==========================
if (btnStart) btnStart.onclick = async () => {
  const r = await fetch(`${API_BASE}/auction/start`, { method: "POST" });
  await r.json().catch(() => ({}));
  await loadStatus();
};
if (btnStop) btnStop.onclick = async () => {
  const r = await fetch(`${API_BASE}/auction/stop`, { method: "POST" });
  await r.json().catch(() => ({}));
  await loadStatus();
};

// ==========================
// Boot
// ==========================
async function longPoll() {
  while (!stopPolling) {
    const params = new URLSearchParams();
    if (lastId) params.set("since", String(lastId));
    params.set("timeout", "25");
    try {
      const res = await fetch(`${API_BASE}/auction/updates?${params.toString()}`);
      const body = await res.json();
      (body.events || []).forEach(applyEvent);
      lastId = body.last_id || lastId;
    } catch (e) {
      console.error("Polling error:", e);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function loadPlayers() {
  try {
    const res = await fetch(`${API_BASE}/players/`);
    const players = await res.json();
    playersListDiv.innerHTML = "";
    players.forEach(p => playersListDiv.appendChild(renderPlayerRow(p)));
    setAuctionActiveUI(auctionActive);
  } catch (e) { console.error("Error fetching players:", e); }
}

async function loadStatus() {
  try {
    const r = await fetch(`${API_BASE}/auction/status`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const s = await r.json();
    setAuctionActiveUI(!!s.active);
  } catch (e) {
    console.error("Failed to load /auction/status:", e);
    auctionStatusDiv.textContent = "Could not load auction status";
    auctionStatusDiv.classList.remove("alert-success");
    auctionStatusDiv.classList.add("alert-warning");
  }
}

async function loadTeams() {
  try {
    const res = await fetch(`${API_BASE}/teams/`);
    const teams = await res.json();
    if (!teamPicker) return;
    teamPicker.innerHTML = `<option value="">— Select team —</option>`;
    teams.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t._id;
      opt.textContent = `${t.name} (₹${t.budget})`;
      teamPicker.appendChild(opt);
    });
    if (teamId) {
      const found = [...teamPicker.options].some(o => o.value === teamId);
      if (found) { teamPicker.value = teamId; await showTeamBudgetTotal(teamId); }
      else { teamId = ""; localStorage.removeItem("teamId"); }
    }
    teamPicker.onchange = async () => {
      teamId = teamPicker.value;
      if (teamId) { localStorage.setItem("teamId", teamId); await showTeamBudgetTotal(teamId); }
      else { localStorage.removeItem("teamId"); teamBudgetDiv.textContent = "Budget: —"; teamBudgetDiv.removeAttribute("data-total"); }
      setAuctionActiveUI(auctionActive);
    };
  } catch (e) { console.error("Error loading teams:", e); }
}

async function showTeamBudgetTotal(id) {
  try {
    const res = await fetch(`${API_BASE}/teams/${id}`);
    const team = await res.json();
    teamBudgetDiv.setAttribute("data-total", team.budget);
    teamBudgetDiv.textContent = `Your Remaining Budget: — (Total: ₹${team.budget})`;
  } catch (e) { console.error("Error loading team:", e); }
}

loadTeams();
loadPlayers();
loadStatus();
longPoll();
