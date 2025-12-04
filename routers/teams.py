from fastapi import APIRouter, HTTPException
from models import Team
from database import db
from bson import ObjectId

router = APIRouter()

def serialize_doc(doc):
    doc["_id"] = str(doc["_id"])
    return doc

@router.post("/add")
def add_team(team: Team):
    result = db.teams.insert_one(team.dict())
    return {"id": str(result.inserted_id)}

@router.get("/")
def list_teams():
    teams = [serialize_doc(t) for t in db.teams.find()]
    return teams

@router.get("/{team_id}")
def get_team(team_id: str):
    team = db.teams.find_one({"_id": ObjectId(team_id)})
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return serialize_doc(team)

@router.put("/update/{team_id}")
def update_team(team_id: str, team: Team):
    result = db.teams.update_one({"_id": ObjectId(team_id)}, {"$set": team.dict()})
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Team not found or not updated")
    return {"msg": "Team updated"}

@router.delete("/delete/{team_id}")
def delete_team(team_id: str):
    result = db.teams.delete_one({"_id": ObjectId(team_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Team not found")
    return {"msg": "Team deleted"}
