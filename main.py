
from fastapi import FastAPI, APIRouter, HTTPException, Query, Depends, Header, Request, Form
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional, Dict, Any
from bson import ObjectId
from datetime import datetime, timezone, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext
from dotenv import load_dotenv
import os, asyncio

# --- Local imports ---
from database import db
from models import BidRequest

load_dotenv()
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv('ADMIN_EMAILS','').split(',') if e.strip()}

app = FastAPI()
router = APIRouter(prefix="/auction", tags=["Auction"])

# Optional external routers
try:
    from routers import players, teams
    app.include_router(players.router, prefix="/players", tags=["Players"])
    app.include_router(teams.router, prefix="/teams", tags=["Teams"])
except Exception:
    pass

app.mount("/static", StaticFiles(directory="frontend"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "Welcome to the Cricket Auction API"}

# --- JWT utils (PBKDF2-SHA256) ---
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALG = os.getenv("JWT_ALG", "HS256")
ACCESS_TOKEN_MIN = int(os.getenv("ACCESS_TOKEN_MIN", "30"))
REFRESH_TOKEN_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "7"))
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

def hash_password(p: str) -> str:
    return pwd_context.hash(p)

def verify_password(p: str, h: str) -> bool:
    return pwd_context.verify(p, h)

def create_token(sub: str, kind: str, minutes: int=None, days: int=None, extra: Dict[str,Any]|None=None) -> str:
    now = datetime.now(timezone.utc)
    exp = now + (timedelta(minutes=minutes) if minutes is not None else timedelta(days=days))
    payload = {"sub": sub, "typ": kind, "iat": int(now.timestamp()), "exp": int(exp.timestamp())}
    if extra: payload.update(extra)
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

def decode_token(token: str) -> dict:
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])

def get_current_user(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    token = authorization.split(" ", 1)[1]
    try:
        payload = decode_token(token)
        if payload.get("typ") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user_id = payload["sub"]
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.users.find_one({"_id": ObjectId(user_id), "is_active": True})
    if not user:
        raise HTTPException(status_code=401, detail="User not found or disabled")
    return {
        "user_id": str(user["_id"]),
        "email": user["email"],
        "name": user.get("name",""),
        "is_admin": bool(user.get("is_admin", False)),
    }

@app.get("/me")
def me(user=Depends(get_current_user)):
    return {"ok": True, "user": user}

# --- Auth ---
@app.post("/auth/register")
def register(email: str = Form(...), password: str = Form(...), name: str = Form(None)):
    email = email.lower().strip()
    if len(password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    if db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    db.users.create_index("email", unique=True)
    db.users.insert_one({
        "email": email,
        "password_hash": hash_password(password),
        "name": name or "",
        "is_active": True,
        "is_admin": (email in ADMIN_EMAILS),
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    })
    return {"ok": True, "message": "Registered. Please log in."}

@app.post("/auth/login")
def login(email: str = Form(...), password: str = Form(...)):
    u = db.users.find_one({"email": email.lower().strip()})
    if not u or not verify_password(password, u["password_hash"]):
        raise HTTPException(401, "Invalid credentials")
    user_id = str(u["_id"])
    access = create_token(user_id, "access", minutes=ACCESS_TOKEN_MIN, extra={"email": u["email"], "is_admin": bool(u.get("is_admin", False))})
    refresh = create_token(user_id, "refresh", days=REFRESH_TOKEN_DAYS)
    return {"ok": True, "access_token": access, "refresh_token": refresh, "token_type": "bearer"}

@app.post("/auth/refresh")
def refresh(refresh_token: str = Form(...)):
    try:
        payload = decode_token(refresh_token)
        if payload.get("typ") != "refresh":
            raise HTTPException(401, "Invalid token type")
        user_id = payload["sub"]
    except JWTError:
        raise HTTPException(401, "Invalid or expired refresh token")
    if not db.users.find_one({"_id": ObjectId(user_id), "is_active": True}):
        raise HTTPException(401, "User disabled")
    new_access = create_token(user_id, "access", minutes=ACCESS_TOKEN_MIN)
    return {"ok": True, "access_token": new_access, "token_type": "bearer"}

# --- Admin helpers ---
def require_admin(user=Depends(get_current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, "Admin privileges required")
    return user

# --- Player self-registration (role mandatory; base price set by admin) ---
@app.get("/player/me")
def get_my_player(user=Depends(get_current_user)):
    doc = db.players.find_one({"created_by": user["user_id"]})
    if not doc:
        return {"ok": True, "registered": False}
    doc["_id"] = str(doc["_id"])
    return {"ok": True, "registered": True, "player": doc}

@app.post("/player/register")
def register_player(
    user=Depends(get_current_user),
    full_name: str = Form(...),
    role: str = Form(...),           # Faculty | Student | Alumni
    category: str = Form(None),
    age: int = Form(None),
    batting_style: str = Form(None),
    bowling_style: str = Form(None),
    bio: str = Form(None)
):
    if db.players.find_one({"created_by": user["user_id"]}):
        raise HTTPException(400, "You are already registered as a player")
    if role not in {"Faculty","Student","Alumni"}:
        raise HTTPException(400, "Select role as Faculty, Student, or Alumni")
    valid_categories = {"Batter","Bowler","All-rounder","Wicket-keeper"}
    if category and category not in valid_categories:
        raise HTTPException(400, "Select a valid category")
    player_doc = {
        "name": full_name.strip(),
        "category": category or None,
        "base_price": None,
        "base_price_status": "pending",
        "age": age,
        "batting_style": (batting_style or "").strip(),
        "bowling_style": (bowling_style or "").strip(),
        "bio": (bio or "").strip(),
        "affiliation_role": role,
        "status": "available",
        "current_team": None,
        "performance": None,
        "final_team": None,
        "final_bid": None,
        "created_by": user["user_id"],
        "created_at": datetime.utcnow(),
        "source": "self-registration",
    }
    res = db.players.insert_one(player_doc)
    return {"ok": True, "player_id": str(res.inserted_id)}

# --- Admin endpoints ---
@app.get("/admin/players/pending")
def admin_list_pending(user=Depends(require_admin)):
    items = []
    for p in db.players.find({"base_price_status": {"$ne": "set"}}).limit(500):
        p["_id"] = str(p["_id"])
        items.append(p)
    return {"ok": True, "players": items}

@app.patch("/admin/player/{player_id}/base-price")
def admin_set_base_price(player_id: str, user=Depends(require_admin), price: float = Form(...)):
    try:
        price = float(price)
        if price <= 0: raise ValueError
    except Exception:
        raise HTTPException(400, "Enter a valid base price")
    oid = ObjectId(player_id)
    res = db.players.find_one_and_update(
        {"_id": oid},
        {"$set": {"base_price": price, "base_price_status": "set", "updated_at": datetime.utcnow()}}
    )
    if not res: raise HTTPException(404, "Player not found")
    return {"ok": True, "player_id": player_id, "base_price": price}

# --- Event Hub & Auction routes ---
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
            evt = {"id": self._last_id, "ts": self._now_iso(), "type": kind, "data": payload}
            self._events.append(evt)
            self._trim()
            self._cond.notify_all()
    async def wait_for_events(self, since_id: int, timeout: int) -> List[Dict[str, Any]]:
        deadline = asyncio.get_event_loop().time() + timeout
        async with self._cond:
            while True:
                ready = [e for e in self._events if e["id"] > since_id]
                if ready: return ready
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0: return []
                try:
                    await asyncio.wait_for(self._cond.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    return []
    def get_events(self, since_id: int, limit: int = 200) -> List[Dict[str, Any]]:
        ready = [e for e in self._events if e["id"] > since_id]
        return ready[:limit] if limit else ready

event_hub = EventHub()

def ensure_object_id(id_str: str) -> ObjectId:
    try: return ObjectId(id_str)
    except Exception: raise HTTPException(400, "Invalid ObjectId")

@router.post("/bid")
async def place_bid(req: BidRequest, user=Depends(get_current_user)):
    player_id = req.player_id
    team_id = req.team_id
    bid_amount = req.bid_amount
    player = db.players.find_one({"_id": ensure_object_id(player_id)})
    team = db.teams.find_one({"_id": ensure_object_id(team_id)})
    if not player or not team: raise HTTPException(404, "Player or Team not found")
    highest_bid = db.bids.find_one({"player_id": player_id}, sort=[("amount", -1)])
    if highest_bid and highest_bid["amount"] >= bid_amount:
        raise HTTPException(400, "Bid must be higher than current highest bid")
    team_bids = list(db.bids.find({"team_id": team_id}))
    total_bid_amount = sum(b["amount"] for b in team_bids) + bid_amount
    if total_bid_amount > team["budget"]: raise HTTPException(400, "Budget exceeded")
    db.bids.insert_one({
        "player_id": player_id, "team_id": team_id, "amount": bid_amount,
        "time": datetime.utcnow(), "placed_by": user["user_id"]
    })
    await event_hub.publish("bid_placed", {"player_id": player_id, "team_id": team_id, "amount": bid_amount, "by": user["email"]})
    remaining_budget = team["budget"] - total_bid_amount
    await event_hub.publish("team_budget", {"team_id": team_id, "budget": remaining_budget})
    return {"message": "Bid placed successfully"}

@router.get("/bids/highest")
def get_highest_bid(player_id: str):
    highest_bid = db.bids.find_one({"player_id": player_id}, sort=[("amount", -1)])
    if not highest_bid: return {"player_id": player_id, "highest_bid": None}
    return {"player_id": player_id, "highest_bid": {"team_id": highest_bid["team_id"], "amount": highest_bid["amount"], "time": highest_bid["time"]}}

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
    return {"active": status.get("active", False)} if status else {"active": False}

@router.get("/updates")
async def poll_updates(since: Optional[int] = Query(None), timeout: int = Query(25, ge=0, le=60), limit: int = Query(200, ge=1, le=500)):
    since_id = since or 0
    events = await event_hub.wait_for_events(since_id=since_id, timeout=timeout)
    return {"events": events[:limit], "last_id": events[-1]["id"] if events else since_id}

@router.get("/updates/short")
def poll_updates_short(since: Optional[int] = Query(None), limit: int = Query(200, ge=1, le=500)):
    since_id = since or 0
    events = event_hub.get_events(since_id=since_id, limit=limit)
    return {"events": events, "last_id": events[-1]["id"] if events else since_id}

app.include_router(router)

