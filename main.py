
from fastapi import FastAPI, APIRouter, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional, Dict, Any
from bson import ObjectId
from datetime import datetime, timezone
from database import db
from models import BidRequest
from fastapi import BackgroundTasks
import asyncio

app = FastAPI()
router = APIRouter(prefix="/auction", tags=["Auction"])

# Include other routers
from routers import players, teams
app.include_router(players.router, prefix="/players", tags=["Players"])
app.include_router(teams.router, prefix="/teams", tags=["Teams"])


app.mount("/static", StaticFiles(directory="frontend"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "Welcome to the Cricket Auction API"}

# -----------------------
# In-memory Event Hub for polling
# -----------------------
class EventHub:
    def __init__(self, max_events: int = 2000):
        self._events: List[Dict[str, Any]] = []
        self._cond = asyncio.Condition()
        self._max_events = max_events
        self._last_id = 0

    def _trim(self):
        if len(self._events) > self._max_events:
            self._events = self._events[-self._max_events:]

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    async def publish(self, kind: str, payload: Dict[str, Any]):
        async with self._cond:
            self._last_id += 1
            evt = {
                "id": self._last_id,
                "ts": self._now_iso(),
                "type": kind,
                "data": payload,
            }
            self._events.append(evt)
            self._trim()
            self._cond.notify_all()

    async def wait_for_events(self, since_id: int, timeout: int) -> List[Dict[str, Any]]:
        deadline = asyncio.get_event_loop().time() + timeout
        async with self._cond:
            while True:
                ready = [e for e in self._events if e["id"] > since_id]
                if ready:
                    return ready
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    return []
                try:
                    await asyncio.wait_for(self._cond.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    return []

    def get_events(self, since_id: int, limit: int = 200) -> List[Dict[str, Any]]:
        ready = [e for e in self._events if e["id"] > since_id]
        return ready[:limit] if limit else ready

event_hub = EventHub()

def ensure_object_id(id_str: str) -> ObjectId:
    try:
        return ObjectId(id_str)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid ObjectId")

# -----------------------
# Auction endpoints
# -----------------------
@router.post("/bid")
async def place_bid(req: BidRequest):  # <-- async
    player_id = req.player_id
    team_id = req.team_id
    bid_amount = req.bid_amount

    player_oid = ensure_object_id(player_id)
    team_oid = ensure_object_id(team_id)

    player = db.players.find_one({"_id": player_oid})
    team = db.teams.find_one({"_id": team_oid})

    if not player or not team:
        raise HTTPException(status_code=404, detail="Player or Team not found")

    highest_bid = db.bids.find_one({"player_id": player_id}, sort=[("amount", -1)])
    if highest_bid and highest_bid["amount"] >= bid_amount:
        raise HTTPException(status_code=400, detail="Bid must be higher than current highest bid")

    team_bids = list(db.bids.find({"team_id": team_id}))
    total_bid_amount = sum(b["amount"] for b in team_bids) + bid_amount
    if total_bid_amount > team["budget"]:
        raise HTTPException(status_code=400, detail="Budget exceeded")

    db.bids.insert_one({
        "player_id": player_id,
        "team_id": team_id,
        "amount": bid_amount,
        "time": datetime.utcnow()
    })

    # Publish bid + budget events (await instead of create_task)
    await event_hub.publish("bid_placed", {
        "player_id": player_id,
        "team_id": team_id,
        "amount": bid_amount
    })

    remaining_budget = team["budget"] - total_bid_amount
    await event_hub.publish("team_budget", {
        "team_id": team_id,
        "budget": remaining_budget
    })

    return {"message": "Bid placed successfully"}


@router.get("/bids/highest")
def get_highest_bid(player_id: str):
    highest_bid = db.bids.find_one({"player_id": player_id}, sort=[("amount", -1)])
    if not highest_bid:
        return {"player_id": player_id, "highest_bid": None}
    return {
        "player_id": player_id,
        "highest_bid": {
            "team_id": highest_bid["team_id"],
            "amount": highest_bid["amount"],
            "time": highest_bid["time"],
        }
    }

@router.post("/start")
async def start_auction():
    db.auction_status.update_one({}, {"$set": {"active": True}}, upsert=True)
    await event_hub.publish("auction_status", {"active": True})
    return {"msg": "Auction started"}

@router.post("/stop")
async def stop_auction():
    db.auction_status.update_one({}, {"$set": {"active": False}}, upsert=True)
    await event_hub.publish("auction_status", {"active": False})
    return {"msg": "Auction stopped"}

@router.get("/status")
def get_status():
    status = db.auction_status.find_one({})
    if not status:
        return {"active": False}
    return {"active": status.get("active", False)}

@router.post("/player/sell/{player_id}")
async def mark_player_as_sold(player_id: str, team_id: str, final_bid: float):
    player_oid = ensure_object_id(player_id)
    team_oid = ensure_object_id(team_id)

    player = db.players.find_one({"_id": player_oid})
    team = db.teams.find_one({"_id": team_oid})

    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    if player.get("status") == "sold":
        raise HTTPException(status_code=400, detail="Player already sold")

    db.players.update_one({"_id": player_oid}, {"$set": {
        "status": "sold",
        "final_team": team_id,
        "final_bid": final_bid
    }})

    db.teams.update_one({"_id": team_oid}, {"$push": {"players": player_id}})

    await event_hub.publish("player_sold", {
        "player_id": player_id,
        "team_id": team_id,
        "final_bid": final_bid
    })

    return {"msg": f"Player {player['name']} sold to team {team['name']} for {final_bid}"}

# -----------------------
# Polling endpoints
# -----------------------
@router.get("/updates")
async def poll_updates(
    since: Optional[int] = Query(None, description="Last seen event id; get newer events"),
    timeout: int = Query(25, ge=0, le=60, description="Seconds to wait (long-poll)"),
    limit: int = Query(200, ge=1, le=500, description="Max events to return")
):
    since_id = since or 0
    events = await event_hub.wait_for_events(since_id=since_id, timeout=timeout)
    events = events[:limit]
    return {"events": events, "last_id": events[-1]["id"] if events else since_id}

@router.get("/updates/short")
def poll_updates_short(
    since: Optional[int] = Query(None),
    limit: int = Query(200, ge=1, le=500)
):
    since_id = since or 0
    events = event_hub.get_events(since_id=since_id, limit=limit)
    return {"events": events, "last_id": events[-1]["id"] if events else since_id}

app.include_router(router)

# Ensure router is included after route definitions
app.include_router(router)
