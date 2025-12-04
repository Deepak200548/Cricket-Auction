// === Load all players into dropdown ===
function loadPlayerDropdown() {
  fetch("http://127.0.0.1:8000/players")
    .then(res => res.json())
    .then(players => {
      const select = document.getElementById("playerSelect");
      select.innerHTML = `<option value="">-- Select a Player --</option>`;

      players.forEach(p => {
        select.innerHTML += `
          <option value="${p._id}">${p.name}</option>
        `;
      });
    })
    .catch(err => console.log("Error loading player list:", err));
}



// === Load selected player's details ===
function loadSelectedPlayer(id) {
  if (!id) {
    document.getElementById("playerName").innerText = "---";
    document.getElementById("playerRole").innerText = "---";
    document.getElementById("playerBase").innerText = "0";
    document.getElementById("playerAge").innerText = "---";
    return;
  }

  fetch(`http://127.0.0.1:8000/players`)
    .then(res => res.json())
    .then(players => {
      const p = players.find(x => x._id === id);

      if (!p) return;

      document.getElementById("playerName").innerText = p.name || "---";
      document.getElementById("playerRole").innerText = p.category || "---";
      document.getElementById("playerBase").innerText = p.base_price || 0;
      document.getElementById("playerAge").innerText = p.age || "---";

    })
    .catch(err => console.log("Cannot load selected player:", err));
}



// === Load team details ===
function loadTeams() {
  fetch("http://127.0.0.1:8000/teams")
    .then(res => res.json())
    .then(teams => {
      let tbody = document.getElementById("teamTableBody");
      tbody.innerHTML = "";

      teams.forEach(t => {
        tbody.innerHTML += `
          <tr>
            <td>${t.name}</td>
            <td>₹${t.budget}</td>
            <td>${(t.players || []).length}</td>
          </tr>
        `;
      });
    })
    .catch(err => console.log("Cannot load teams:", err));
}



// === Event: When dropdown changes ===
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("playerSelect").addEventListener("change", function () {
    loadSelectedPlayer(this.value);
  });
});


// === Auto refresh teams every 3 seconds ===
setInterval(loadTeams, 3000);


// === Initial load ===
loadPlayerDropdown();
loadTeams();
