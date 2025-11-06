from pydantic import BaseModel
from typing import List, Optional

class Player(BaseModel):
    name: str
    category: str
    base_price: float
    performance: Optional[str] = None
    current_team: Optional[str] = None

class Team(BaseModel):
    name: str
    budget: float
    owner: str
    players: List[str] = []

class BidRequest(BaseModel):
    player_id: str
    team_id: str
    bid_amount: float