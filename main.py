from fastapi import FastAPI, APIRouter, HTTPException, Query, Depends, Header, Request, Form
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, JSONResponse
from typing import List, Optional, Dict, Any
from bson import ObjectId
from datetime import datetime, timezone, timedelta
from jose import jwt, JWTError
from passlib.context import CryptContext
from dotenv import load_dotenv
from models.models import BidRequest
import os, asyncio
from database import db


load_dotenv()

# Admin emails: comma-separated in env ADMIN_EMAILS, or default to this one
ADMIN_EMAILS_RAW = os.getenv("ADMIN_EMAILS", "deepaks.cse@skit.org.in")
ADMIN_EMAILS = {e.strip().lower() for e in ADMIN_EMAILS_RAW.split(",") if e.strip()}

app = FastAPI()
router = APIRouter(prefix="/auction", tags=["Auction"])

# -------------------------
# STATIC + TEMPLATES SETUP
# -------------------------

# Serve ONLY JS/CSS/images from /static
app.mount("/static", StaticFiles(directory="static"), name="static")

# Serve HTML dynamically from templates/
templates = Jinja2Templates(directory="templates")


@app.get("/", response_class=HTMLResponse)
async def serve_index(request: Request):
    """Dynamic Landing Page"""
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/viewer", response_class=HTMLResponse)
async def viewer_page(request: Request):
    """Dynamic Auction Viewer"""
    return templates.TemplateResponse("viewer.html", {"request": request})


# ⭐⭐⭐ ADMIN PAGE ROUTE ⭐⭐⭐
@app.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request):
    return templates.TemplateResponse("admin.html", {"request": request})


# -------------------------
# CORS CONFIG
# -------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# AUTH / JWT SETUP
# -------------------------

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALG = os.getenv("JWT_ALG", "HS256")
ACCESS_TOKEN_MIN = int(os.getenv("ACCESS_TOKEN_MIN", "30"))
REFRESH_TOKEN_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "7"))
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


def hash_password(p: str) -> str:
    return pwd_context.hash(p)


def verify_password(p: str, h: str) -> bool:
    return pwd_context.verify(p, h)


def create_token(
    sub: str,
    kind: str,
    minutes: int | None = None,
    days: int | None = None,
    extra: Dict[str, Any] | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    if minutes is not None:
        exp = now + timedelta(minutes=minutes)
    else:
        exp = now + timedelta(days=days)
    payload = {
        "sub": sub,
        "typ": kind,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    if extra:
        payload.update(extra)
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

    # expose team_id (if assigned) so that team members can bid only for their team
    return {
        "user_id": str(user["_id"]),
        "email": user["email"],
        "name": user.get("name", ""),
        "is_admin": bool(user.get("is_admin", False)),
        "team_id": str(user["team_id"]) if user.get("team_id") else None,
    }


@app.get("/me")
def me(user=Depends(get_current_user)):
    return {"ok": True, "user": user}


# -------------------------
# AUTH ROUTES
# -------------------------

@app.post("/auth/register")
def register(email: str = Form(...), password: str = Form(...), name: str = Form(None)):
    email = email.lower().strip()
    if len(password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    if db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    db.users.create_index("email", unique=True)
    db.users.insert_one(
        {
            "email": email,
            "password_hash": hash_password(password),
            "name": name or "",
            "is_active": True,
            "is_admin": (email in ADMIN_EMAILS),
            # team_id can be set later for team members (manually or via an admin route)
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }
    )
    return {"ok": True, "message": "Registered. Please log in."}


@app.post("/auth/login")
def login(email: str = Form(...), password: str = Form(...)):
    u = db.users.find_one({"email": email.lower().strip()})
    if not u or not verify_password(password, u["password_hash"]):
        raise HTTPException(401, "Invalid credentials")
    user_id = str(u["_id"])
    access = create_token(
        user_id,
        "access",
        minutes=ACCESS_TOKEN_MIN,
        extra={
            "email": u["email"],
            "is_admin": bool(u.get("is_admin", False)),
            # Optional: also embed team_id in token if present (not strictly required for logic here)
            "team_id": str(u["team_id"]) if u.get("team_id") else None,
        },
    )
    refresh = create_token(user_id, "refresh", days=REFRESH_TOKEN_DAYS)
    return {"ok": True, "access_token": access, "refresh_token": refresh, "token_type": "bearer"}


@app.post("/auth/refresh")
def refresh_token(refresh_token: str = Form(...)):
    try:
        payload = decode_token(refresh_token)
        if payload.get("typ") != "refresh":
            raise HTTPException(401, "Invalid token type")
        user_id = payload["sub"]
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    u = db.users.find_one({"_id": ObjectId(user_id), "is_active": True})
    if not u:
        raise HTTPException(401, "User not found or disabled")
    access = create_token(
        user_id,
        "access",
        minutes=ACCESS_TOKEN_MIN,
        extra={
            "email": u["email"],
            "is_admin": bool(u.get("is_admin", False)),
            "team_id": str(u["team_id"]) if u.get("team_id") else None,
        },
    )
    return {"ok": True, "access_token": access, "token_type": "bearer"}


# -------------------------
# PUBLIC PLAYER REGISTRATION
# -------------------------

@app.post("/players/public_register")
def public_player_register(
    full_name: str = Form(...),
    role: str = Form(...),
    category: Optional[str] = Form(None),
    age: Optional[int] = Form(None),
    batting_style: Optional[str] = Form(None),
    bowling_style: Optional[str] = Form(None),
    bio: Optional[str] = Form(None),
):
    name = (full_name or "").strip()
    if not name:
        raise HTTPException(400, "Full name is required")
    allowed_roles = {"Faculty", "Student", "Alumni"}
    if role not in allowed_roles:
        raise HTTPException(400, "Invalid role")
    player_doc = {
        "name": name,
        "affiliation_role": role,
        "category": category or None,
        "age": age,
        "batting_style": (batting_style or "").strip(),
        "bowling_style": (bowling_style or "").strip(),
        "bio": (bio or "").strip(),
        "base_price": None,
        "base_price_status": "pending",
        "status": "available",
        "current_team": None,
        "final_team": None,
        "final_bid": None,
        "created_by": None,
        "created_at": datetime.utcnow(),
    }
    res = db.players.insert_one(player_doc)
    return {"ok": True, "player_id": str(res.inserted_id)}


# -------------------------
# ROUTER IMPORTS (OPTIONAL)
# -------------------------

try:
    from routers import players, teams
    app.include_router(players.router, prefix="/players", tags=["Players"])
    app.include_router(teams.router, prefix="/teams", tags=["Teams"])
except Exception:
    # If these routers don't exist, we fall back to the inline /players and /teams
    # endpoints defined below.
    pass


# -------------------------
# ADMIN / PLAYER ROUTES
# -------------------------

def require_admin(user=Depends(get_current_user)):
    if not user.get("is_admin"):
        raise HTTPException(403, "Admin privileges required")
    return user


# -------------------------
# CORE /players and /teams ENDPOINTS
# -------------------------

@app.get("/players")
def list_players():
    """
    List all players for the admin dashboard.

    Returns a plain list of players with fields:
    _id, name, category, status, base_price, final_bid, team_id, team_name
    """
    players_out: List[Dict[str, Any]] = []

    for p in db.players.find({}):
        team_id_str = p.get("final_team") or p.get("current_team")
        team_name = None
        if team_id_str:
            try:
                team_doc = db.teams.find_one({"_id": ObjectId(team_id_str)})
                if team_doc:
                    team_name = team_doc.get("name")
            except Exception:
                # if team_id_str is not a valid ObjectId or team not found, just skip
                pass

        players_out.append(
            {
                "_id": str(p["_id"]),
                "name": p.get("name", ""),
                "category": p.get("category"),
                "status": p.get("status", "available"),
                "base_price": p.get("base_price"),
                "final_bid": p.get("final_bid"),
                "team_id": team_id_str,
                "team_name": team_name,
            }
        )

    return players_out


@app.get("/teams")
def list_teams():
    """
    List all teams for the admin dashboard.

    Returns a plain list of teams with fields:
    _id, name, budget
    """
    teams_out: List[Dict[str, Any]] = []
    for t in db.teams.find({}):
        teams_out.append(
            {
                "_id": str(t["_id"]),
                "name": t.get("name", ""),
                "budget": t.get("budget", 0),
            }
        )
    return teams_out


# -------------------------
# ADMIN PLAYER MANAGEMENT
# -------------------------

@app.get("/admin/players/pending")
def admin_get_pending_players(user=Depends(require_admin)):
    players = list(db.players.find({"base_price_status": "pending"}))
    for p in players:
        p["_id"] = str(p["_id"])
    return {"ok": True, "players": players}


@app.patch("/admin/player/{player_id}/base-price")
def admin_set_base_price(
    player_id: str,
    body: Dict[str, Any],
    user=Depends(require_admin),
):
    price = body.get("price")
    try:
        price = float(price)
    except Exception:
        raise HTTPException(400, "Invalid price")
    if price <= 0:
        raise HTTPException(400, "Price must be positive")
    pid = ensure_object_id(player_id)
    res = db.players.update_one(
        {"_id": pid},
        {
            "$set": {
                "base_price": price,
                "base_price_status": "set",
                "updated_at": datetime.utcnow(),
            }
        },
    )
    if res.matched_count == 0:
        raise HTTPException(404, "Player not found")
    return {"ok": True, "player_id": player_id, "base_price": price}


# -------------------------
# EVENT HUB
# -------------------------

class EventHub:
    def __init__(self, max_events: int = 2000):
        self._events = []
        self._cond = asyncio.Condition()
        self._max_events = max_events
        self._last_id = 0

    def _trim(self):
        if len(self._events) > self._max_events:
            self._events = self._events[-self._max_events:]

    def _now_iso(self):
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

    async def wait_for_events(self, since_id: int, timeout: int):
        deadline = asyncio.get_event_loop().time() + timeout
        async with self._cond:
            while True:
                ready = [e for e in self._events if e["id"] > since_id]
                if ready:
                    return ready
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    return []
                await self._cond.wait()

    def get_events(self, since_id: int, limit: int = 200):
        ready = [e for e in self._events if e["id"] > since_id]
        return ready[:limit]


event_hub = EventHub()


# -------------------------
# AUCTION
# -------------------------

def ensure_object_id(id_str):
    try:
        return ObjectId(id_str)
    except Exception:
        raise HTTPException(400, "Invalid ObjectId")


def _get_auction_config():
    cfg = db.config.find_one({"key": "auction"}) or {}
    if "active" not in cfg:
        cfg["active"] = False
    return cfg


@router.get("/status")
def auction_status():
    cfg = _get_auction_config()
    return {
        "active": bool(cfg.get("active", False)),
        "current_player_id": cfg.get("current_player_id"),
    }


@router.post("/start")
def auction_start(user=Depends(require_admin)):
    cfg = _get_auction_config()
    cfg["active"] = True
    cfg["started_at"] = datetime.utcnow()
    db.config.update_one(
        {"key": "auction"},
        {"$set": {**cfg, "key": "auction"}},
        upsert=True,
    )
    try:
        asyncio.create_task(event_hub.publish("auction_status", {"active": True}))
    except Exception:
        pass
    return {"ok": True, "message": "Auction started"}


@router.post("/stop")
def auction_stop(user=Depends(require_admin)):
    cfg = _get_auction_config()
    cfg["active"] = False
    cfg["stopped_at"] = datetime.utcnow()
    db.config.update_one(
        {"key": "auction"},
        {"$set": {**cfg, "key": "auction"}},
        upsert=True,
    )
    try:
        asyncio.create_task(event_hub.publish("auction_status", {"active": False}))
    except Exception:
        pass
    return {"ok": True, "message": "Auction stopped"}


@router.post("/sold/{player_id}")
def mark_player_sold(player_id: str, user=Depends(require_admin)):
    """
    Mark player as SOLD.
    Requires final_bid and final_team to already exist.
    """
    pid = ensure_object_id(player_id)

    player = db.players.find_one({"_id": pid})
    if not player:
        raise HTTPException(404, "Player not found")

    final_bid = player.get("final_bid")
    final_team = player.get("final_team")

    if final_bid is None or final_team is None:
        raise HTTPException(400, "Player must have a bid before marking SOLD")

    db.players.update_one(
        {"_id": pid},
        {
            "$set": {
                "status": "sold",
                "final_bid": float(final_bid),
                "final_team": str(final_team),
                "updated_at": datetime.utcnow(),
            }
        },
    )

    return {
        "ok": True,
        "player_id": player_id,
        "final_bid": final_bid,
        "final_team": final_team,
        "status": "sold",
    }
@router.get("/current_player")
def get_current_player():
    """
    Return the currently active auction player.
    Reads player ID from config.key='auction'.
    """
    cfg = db.config.find_one({"key": "auction"}) or {}
    player_id = cfg.get("current_player_id")

    if not player_id:
        return {"message": "No current player"}

    try:
        pid = ObjectId(player_id)
    except Exception:
        raise HTTPException(400, "Invalid current_player_id stored in config")

    player = db.players.find_one({"_id": pid})
    if not player:
        raise HTTPException(404, "Current player not found in DB")

    # Convert ObjectId to string
    player["_id"] = str(player["_id"])

    return player
@router.post("/set_current_player/{player_id}")
def set_current_player(player_id: str, user=Depends(require_admin)):
    """
    Manually set the current auction player.
    """
    try:
        pid = ObjectId(player_id)
    except Exception:
        raise HTTPException(400, "Invalid player_id")

    player = db.players.find_one({"_id": pid})
    if not player:
        raise HTTPException(404, "Player not found")

    # Update config
    db.config.update_one(
        {"key": "auction"},
        {"$set": {"current_player_id": player_id}},
        upsert=True
    )

    # Publish event for viewers
    try:
        asyncio.create_task(event_hub.publish("current_player_changed", {
            "player_id": player_id
        }))
    except Exception:
        pass

    return {"ok": True, "message": "Current player updated", "player": {"_id": player_id, "name": player["name"]}}
@router.post("/next_player")
def next_player(user=Depends(require_admin)):
    """
    Move auction to the next available player.
    """
    # Find next available player
    next_p = db.players.find_one({"status": "available"}, sort=[("_id", 1)])

    if not next_p:
        return {"message": "No more available players"}

    player_id = str(next_p["_id"])

    # Update config
    db.config.update_one(
        {"key": "auction"},
        {"$set": {"current_player_id": player_id}},
        upsert=True
    )

    # Publish event for viewers
    try:
        asyncio.create_task(event_hub.publish("current_player_changed", {
            "player_id": player_id
        }))
    except Exception:
        pass

    return {
        "ok": True,
        "player": {
            "_id": player_id,
            "name": next_p["name"],
            "category": next_p.get("category"),
            "base_price": next_p.get("base_price")
        }
    }


@router.post("/bid")
def place_bid(bid: BidRequest, user=Depends(get_current_user)):
    try:
        player_id = ensure_object_id(bid.player_id)
        team_id = ensure_object_id(bid.team_id)
    except Exception:
        raise

    if not user.get("is_admin", False):
        if not user.get("team_id"):
            raise HTTPException(403, "You are not assigned to any team")
        if user["team_id"] != str(team_id):
            raise HTTPException(403, "You can only bid for your own team")

    player = db.players.find_one({"_id": player_id})
    team = db.teams.find_one({"_id": team_id})

    if not player:
        raise HTTPException(404, "Player not found")
    if not team:
        raise HTTPException(404, "Team not found")

    cfg = _get_auction_config()
    if not cfg.get("active", False):
        raise HTTPException(400, "Auction is not active")

    amount = float(bid.bid_amount)
    if amount <= 0:
        raise HTTPException(400, "Bid amount must be positive")

    team_budget = float(team.get("budget", 0))
    if amount > team_budget:
        raise HTTPException(400, "Team does not have enough budget")

    current_highest = float(player.get("final_bid") or 0)
    if amount <= current_highest:
        raise HTTPException(400, "Bid must be higher than current highest bid")

    db.players.update_one(
        {"_id": player_id},
        {
            "$set": {
                "final_bid": amount,
                "final_team": str(team_id),
                "status": "in_auction",
            }
        },
    )

    db.teams.update_one(
        {"_id": team_id},
        {"$set": {"budget": team_budget - amount}},
    )

    payload = {
        "player_id": str(player_id),
        "team_id": str(team_id),
        "amount": amount,
    }

    try:
        asyncio.create_task(event_hub.publish("bid_placed", payload))
    except Exception:
        pass

    return {"ok": True, **payload}


app.include_router(router)
