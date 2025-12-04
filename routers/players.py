from fastapi import APIRouter, HTTPException
from models import Player
from database import db
from bson import ObjectId

router = APIRouter()

def serialize_doc(doc):
    doc["_id"] = str(doc["_id"])
    return doc

@router.post("/add")
def add_player(player: Player):
    result = db.players.insert_one(player.dict())
    return {"id": str(result.inserted_id)}

@router.get("/")
def list_players():
    players = [serialize_doc(p) for p in db.players.find()]
    return players

@router.get("/{player_id}")
def get_player(player_id: str):
    player = db.players.find_one({"_id": ObjectId(player_id)})
    if not player:
        raise HTTPException(status_code=404, detail="Player not found")
    return serialize_doc(player)

@router.put("/update/{player_id}")
def update_player(player_id: str, player: Player):
    result = db.players.update_one({"_id": ObjectId(player_id)}, {"$set": player.dict()})
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Player not found or not updated")
    return {"msg": "Player updated"}

@router.delete("/delete/{player_id}")
def delete_player(player_id: str):
    result = db.players.delete_one({"_id": ObjectId(player_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Player not found")
    return {"msg": "Player deleted"}
