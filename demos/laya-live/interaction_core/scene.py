"""Small server-authored playable scene, never inferred from player claims."""
from .rules import WORLD


def make_scene(B):
    def actor(name, en, skill, trust=50):
        state = B._blank_actor_state(B.CFG.get("actor"))
        state.update(name=name, name_en=en)
        state["relationship"].update(trust=trust, doubt=30)
        state["interaction"] = {
            "location": "tavern", "stats": {"strength": skill, "combat": skill,
                "perception": skill, "craft": skill, "persuasion": skill, "defense": 2, "resolve": 2},
            "energy": 10, "health": 10, "incapacitated": False, "restrained": False,
            "support": 0, "openness": "neutral",
            "relationship_to": "player" if en != "Player" else None,
        }
        return state
    return {
        "player": actor("玩家", "Player", 5),
        "lia": actor("莉亚", "Lia", 6, 60),
        "oren": actor("奥伦", "Oren", 4, 40),
        WORLD: {"name": "酒馆运行场景", "interaction": {
            "turn_tick": 0, "scene_tick": 0, "world_tick": 0, "default_addressee": "lia",
            "environment": {"inspect": -1, "force": 0}, "noise": 0,
            "facts": [], "conversation": [], "objects": {
                "cellar_door": {"name": "地窖门", "kind": "door", "location": "tavern",
                    "open": False, "locked": True, "difficulty": {"force": 6}},
                "cellar_key": {"name": "地窖钥匙", "kind": "item", "location": "old_well",
                    "owner": None, "portable": True, "opens": "cellar_door", "bonuses": {}},
                "badge": {"name": "徽章", "kind": "item", "location": "tavern", "owner": "player",
                    "portable": True, "bonuses": {}, "verified_clue": "徽章上刻有北境商会的登记编号。"},
                "knife": {"name": "小刀", "kind": "item", "location": "tavern", "owner": "player",
                    "portable": True, "bonuses": {"combat": 1}},
                "apple": {"name": "苹果", "kind": "item", "location": "tavern", "owner": "player",
                    "portable": True, "bonuses": {}, "health": 2},
            },
        }},
    }
