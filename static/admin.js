/* ============================================================
    AUTH HELPERS
============================================================ */
function getAccess() { return localStorage.getItem("access"); }
function logout() {
    localStorage.removeItem("access");
    localStorage.removeItem("refresh");
    window.location.href = "/";
}

async function api(url, options = {}) {
    const token = getAccess();
    options.headers = Object.assign(
        {},
        options.headers || {},
        token ? { Authorization: `Bearer ${token}` } : {}
    );
    return await fetch(url, options);
}

/* ============================================================
    LOAD AUCTION STATUS
============================================================ */
async function loadAuctionStatus() {
    const r = await api("/auction/status");
    const s = await r.json();
    const el = document.getElementById("auction-status");

    el.textContent = s.active ? "Auction is LIVE" : "Auction is NOT active";
    el.classList.toggle("alert-success", s.active);
    el.classList.toggle("alert-secondary", !s.active);
}

/* ============================================================
    START / STOP AUCTION
============================================================ */
document.getElementById("btn-start").addEventListener("click", async () => {
    const res = await api("/auction/start", { method: "POST" });
    const data = await res.json();
    alert(data.message || "Auction started");
    loadAuctionStatus();
});

document.getElementById("btn-stop").addEventListener("click", async () => {
    const res = await api("/auction/stop", { method: "POST" });
    const data = await res.json();
    alert(data.message || "Auction stopped");
    loadAuctionStatus();
});

/* ============================================================
    LOAD PENDING PLAYERS (SET BASE PRICE)
============================================================ */
async function loadPendingPlayers() {
    const res = await api("/admin/players/pending");
    const data = await res.json();

    const list = document.getElementById("admin-pending-list");
    list.innerHTML = "";

    (data.players || []).forEach(p => {
        const li = document.createElement("li");
        li.className = "list-group-item d-flex justify-content-between flex-wrap";

        li.innerHTML = `
            <div><strong>${p.name}</strong> (${p.affiliation_role || "-"})</div>
            <div class="input-group" style="max-width:240px;">
                <span class="input-group-text">₹</span>
                <input type="number" min="1" class="form-control" id="bp-${p._id}" placeholder="Base Price">
                <button class="btn btn-primary">Set</button>
            </div>
        `;

        li.querySelector("button").onclick = async () => {
            const price = Number(document.getElementById(`bp-${p._id}`).value);
            if (!price) return alert("Enter valid price");

            const r = await api(`/admin/player/${p._id}/base-price`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ price })
            });

            const d = await r.json();
            if (!r.ok) return alert(d.detail || "Failed");

            alert("Base price set!");
            loadPendingPlayers();
        };

        list.appendChild(li);
    });
}

/* ============================================================
    LOAD TEAMS
============================================================ */
async function loadTeamsForAdmin() {
    const r = await api("/teams");
    const teams = await r.json();

    const list = document.getElementById("teams-list");
    list.innerHTML = "";

    teams.forEach(t => {
        const li = document.createElement("li");
        li.className = "list-group-item d-flex justify-content-between";
        li.innerHTML = `<strong>${t.name}</strong> <span>₹${t.budget}</span>`;
        list.appendChild(li);
    });
}

/* ============================================================
    LOAD PLAYERS FOR ADMIN (BID + SOLD)
============================================================ */
async function loadPlayersAdmin() {
    const r = await api("/players");
    const players = await r.json();

    const wrap = document.getElementById("players-list-admin");
    wrap.innerHTML = "";

    players.forEach(p => {
        const div = document.createElement("div");
        div.className = "list-group-item d-flex justify-content-between flex-wrap align-items-center";

        /* Store dataset for selected-player-info panel */
        div.dataset.name = p.name || "";
        div.dataset.category = p.category || "-";
        div.dataset.basePrice = p.base_price || "-";
        div.dataset.finalBid = p.final_bid || "-";
        div.dataset.status = p.status || "-";
        div.dataset.team = p.final_team || p.current_team || "-";
        div.dataset.age = p.age || "-";
        div.dataset.batting = p.batting_style || "-";
        div.dataset.bowling = p.bowling_style || "-";
        div.dataset.affiliation = p.affiliation_role || "-";
        div.dataset.bio = p.bio || "-";

        const suggested = p.final_bid ? p.final_bid + 50 : (p.base_price || 100);

        div.innerHTML = `
            <div class="me-auto">
                <strong>${p.name}</strong> (${p.category || "-"})<br>
                Status: <b>${p.status}</b><br>
                Final Bid: <b>${p.final_bid || "-"}</b>
            </div>

            <div class="d-flex gap-2 mt-2">
                <input type="number" class="form-control" style="width:120px" id="bid-${p._id}" value="${suggested}">
                <select id="team-${p._id}" class="form-select" style="width:150px"></select>
                <button class="btn btn-sm btn-primary" onclick="placeBid('${p._id}')">Bid</button>
                <button class="btn btn-sm btn-success" onclick="markSold('${p._id}')">SOLD</button>
            </div>
        `;

        /* When clicking row → show player details */
        div.addEventListener("click", (e) => {
            if (e.target.tagName === "BUTTON") return;

            document.querySelectorAll(".selected-player-row")
                    .forEach(r => r.classList.remove("selected-player-row"));

            div.classList.add("selected-player-row");
            showSelectedPlayerInfo(div);
        });

        wrap.appendChild(div);
    });

    loadTeamsIntoDropdowns();
}

/* Populate each player's dropdown */
async function loadTeamsIntoDropdowns() {
    const r = await api("/teams");
    const teams = await r.json();

    document.querySelectorAll("[id^='team-']").forEach(sel => {
        sel.innerHTML = teams
            .map(t => `<option value="${t._id}">${t.name}</option>`)
            .join("");
    });
}

/* ============================================================
    SELECTED PLAYER INFO PANEL
============================================================ */
function showSelectedPlayerInfo(row) {
    const box = document.getElementById("selected-player-info-admin");
    box.classList.remove("d-none");

    box.querySelector(".selected-player-name").textContent = row.dataset.name;
    box.querySelector(".selected-player-category").textContent = row.dataset.category;
    box.querySelector(".selected-player-base-price").textContent = row.dataset.basePrice;
    box.querySelector(".selected-player-status").textContent = row.dataset.status;
    box.querySelector(".selected-player-final-bid").textContent = row.dataset.finalBid;
    box.querySelector(".selected-player-team").textContent = row.dataset.team;

    box.querySelector(".selected-player-age").textContent = row.dataset.age;
    box.querySelector(".selected-player-batting").textContent = row.dataset.batting;
    box.querySelector(".selected-player-bowling").textContent = row.dataset.bowling;
    box.querySelector(".selected-player-affiliation").textContent = row.dataset.affiliation;
    box.querySelector(".selected-player-bio").textContent = row.dataset.bio;
}

/* ============================================================
    BID
============================================================ */
async function placeBid(pid) {
    const teamId = document.getElementById(`team-${pid}`).value;
    const amount = Number(document.getElementById(`bid-${pid}`).value);

    if (!amount) return alert("Enter amount");

    const r = await api("/auction/bid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            player_id: pid,
            team_id: teamId,
            bid_amount: amount
        })
    });

    const d = await r.json();
    alert(d.message || d.detail || "Bid complete");
    loadPlayersAdmin();
    loadTeamsForAdmin();
}

/* ============================================================
    SOLD
============================================================ */
async function markSold(pid) {
    if (!confirm("Mark this player as SOLD?")) return;

    const r = await api(`/auction/sold/${pid}`, { method: "POST" });
    const d = await r.json();

    if (!r.ok || !d.ok) return alert(d.detail || "Failed");

    alert("Player marked SOLD");
    loadPlayersAdmin();
}

/* ============================================================
    INITIAL LOAD
============================================================ */
loadAuctionStatus();
loadPendingPlayers();
loadTeamsForAdmin();
loadPlayersAdmin();
