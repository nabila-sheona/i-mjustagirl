"""
I'm Just a Girl — IUT Wheel of Names
=====================================
Flask JSON API backend.

- Auth is handled entirely by Firebase (client SDK does sign up / sign in).
  This server never sees a password — it only ever sees a Firebase ID token,
  which it verifies with the Firebase Admin SDK on every request.
- Only @iut-dhaka.edu emails are accepted, AND the email must be verified
  (Firebase's own "click the link we emailed you" flow) before the account
  can write anything. This is enforced server-side, not just in the UI.
- All wheels / entries / "submitted by" data live in MongoDB.
"""

import json
import os
from datetime import datetime, timezone
from functools import wraps

import firebase_admin
from bson import ObjectId
from bson.errors import InvalidId
from dotenv import load_dotenv
from firebase_admin import auth as fb_auth
from firebase_admin import credentials
from flask import Flask, g, jsonify, request, send_from_directory
from pymongo import MongoClient, ReturnDocument

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ALLOWED_EMAIL_DOMAIN = os.environ.get("ALLOWED_EMAIL_DOMAIN", "@iut-dhaka.edu").lower()
REQUIRE_VERIFIED_EMAIL = os.environ.get("REQUIRE_VERIFIED_EMAIL", "1") == "1"

MONGODB_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
MONGO_DB_NAME = os.environ.get("MONGO_DB_NAME", "iut_wheel_of_names")

THEMES = ["default", "black-purple", "white-pink", "blue-black", "lilac", "cream"]
DEFAULT_THEME = "default"
# ---------------------------------------------------------------------------
# Firebase Admin init
# ---------------------------------------------------------------------------
_cred_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
_cred_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_PATH")

if _cred_json:
    cred = credentials.Certificate(json.loads(_cred_json))
    firebase_admin.initialize_app(cred)
elif _cred_path:
    cred = credentials.Certificate(_cred_path)
    firebase_admin.initialize_app(cred)
elif os.environ.get("SKIP_FIREBASE_AUTH") == "1":
   # strictly for local development and MUST NOT be used in production.
    class _DummyAuth:
        @staticmethod
        def verify_id_token(token):
            return {
                "uid": os.environ.get("DEV_UID", "dev"),
                "email": os.environ.get("DEV_EMAIL", "dev@iut-dhaka.edu"),
                "email_verified": True,
            }

    fb_auth = _DummyAuth()
else:
    raise RuntimeError(
        "Missing Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON "
        "(the full JSON as a string) or FIREBASE_SERVICE_ACCOUNT_PATH "
        "(path to the service-account .json file) in your .env. "
        "Download this from Firebase Console > Project Settings > Service accounts. "
        "For local development without Firebase, set SKIP_FIREBASE_AUTH=1 (NOT for production)."
    )

# ---------------------------------------------------------------------------
# Mongo init
# ---------------------------------------------------------------------------
client = MongoClient(MONGODB_URI)
db = client[MONGO_DB_NAME]
users_col = db["users"]
wheels_col = db["wheels"]
nominations = db["nominations"]
users_col.create_index("uid", unique=True)
users_col.create_index("email", unique=True)

app = Flask(__name__, static_folder="static", static_url_path="")


def now():
    return datetime.now(timezone.utc)


def public_user(u):
    if not u:
        return None
    return {
        "uid": u["uid"],
        "email": u["email"],
        "display_name": u["display_name"],
        "theme": u.get("theme", DEFAULT_THEME),
    }


# ---------------------------------------------------------------------------
# Auth: verify Firebase ID token on every protected request
# ---------------------------------------------------------------------------
def require_auth(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify({"error": "Missing bearer token"}), 401
        token = header.split(" ", 1)[1]
        try:
            decoded = fb_auth.verify_id_token(token)
        except Exception:
            return jsonify({"error": "Invalid or expired token"}), 401

        email = (decoded.get("email") or "").lower()
        if not email.endswith(ALLOWED_EMAIL_DOMAIN):
            return jsonify({"error": f"Only {ALLOWED_EMAIL_DOMAIN} emails are allowed"}), 403
        if REQUIRE_VERIFIED_EMAIL and not decoded.get("email_verified"):
            return jsonify({"error": "Please verify your email first, then sign in again."}), 403

        g.uid = decoded["uid"]
        g.email = email
        return view(*args, **kwargs)

    return wrapped


def current_user_doc():
    return users_col.find_one({"uid": g.uid})


# ---------------------------------------------------------------------------
# Auth sync — called by the frontend right after signup / every login
# ---------------------------------------------------------------------------
@app.route("/api/auth/sync", methods=["POST"])
@require_auth
def auth_sync():
    body = request.get_json(force=True, silent=True) or {}
    display_name = (body.get("display_name") or "").strip()

    existing = users_col.find_one({"uid": g.uid})
    if existing:
        if display_name and display_name != existing.get("display_name"):
            users_col.update_one({"uid": g.uid}, {"$set": {"display_name": display_name}})
            existing["display_name"] = display_name
        return jsonify({"user": public_user(existing)})

    if not display_name or len(display_name) < 2:
        return jsonify({"error": "A display name (2+ characters) is required for new accounts"}), 400

    # One Firebase account per email is already enforced by Firebase itself;
    # this unique index is a second, server-side safety net.
    try:
        doc = {
            "uid": g.uid,
            "email": g.email,
            "display_name": display_name,
            "theme": DEFAULT_THEME,
            "created_at": now(),
        }
        users_col.insert_one(doc)
    except Exception:
        doc = users_col.find_one({"uid": g.uid}) or users_col.find_one({"email": g.email})
        if not doc:
            return jsonify({"error": "Could not create account"}), 409

    return jsonify({"user": public_user(doc)}), 201


@app.route("/api/me", methods=["GET"])
@require_auth
def me():
    u = current_user_doc()
    if not u:
        return jsonify({"error": "Account not set up yet — call /api/auth/sync first"}), 404
    return jsonify({"user": public_user(u)})


@app.route("/api/me/theme", methods=["POST"])
@require_auth
def set_theme():
    body = request.get_json(force=True, silent=True) or {}
    theme = body.get("theme")
    if theme not in THEMES:
        return jsonify({"error": f"theme must be one of {THEMES}"}), 400
    u = users_col.find_one_and_update(
        {"uid": g.uid}, {"$set": {"theme": theme}}, return_document=ReturnDocument.AFTER
    )
    if not u:
        return jsonify({"error": "Account not found"}), 404
    return jsonify({"user": public_user(u)})


@app.route("/api/users", methods=["GET"])
@require_auth
def list_users():
    """Everyone except the caller — used to populate the 'nominate a name' picker."""
    others = list(
        users_col.find({"uid": {"$ne": g.uid}}, {"_id": 0, "uid": 1, "display_name": 1}).sort(
            "display_name", 1
        )
    )
    return jsonify({"users": others})


# ---------------------------------------------------------------------------
# Wheels
# ---------------------------------------------------------------------------
def serialize_wheel(w, include_entries=True):
    out = {
        "id": str(w["_id"]),
        "title": w["title"],
        "created_by_name": w["created_by_name"],
        "created_by_uid": w["created_by"],
        "created_at": w["created_at"].isoformat(),
        "entry_count": len(w.get("entries", [])),
    }
    if include_entries:
        out["entries"] = [
            {
                "target_uid": e["target_uid"],
                "display_name": e["display_name"],
                "weight": e.get("weight", 1),
                "added_by_uid": e["added_by_uid"],
                "added_by_name": e["added_by_name"],
                "added_at": e["added_at"].isoformat(),
            }
            for e in w.get("entries", [])
        ]
    return out


@app.route("/api/wheels", methods=["GET"])
@require_auth
def list_wheels():
    wheels = list(wheels_col.find().sort("created_at", -1))
    return jsonify({"wheels": [serialize_wheel(w, include_entries=False) for w in wheels]})


@app.route("/api/wheels", methods=["POST"])
@require_auth
def create_wheel():
    u = current_user_doc()
    if not u:
        return jsonify({"error": "Account not set up yet"}), 404
    body = request.get_json(force=True, silent=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title is required"}), 400
    doc = {
        "title": title,
        "created_by": g.uid,
        "created_by_name": u["display_name"],
        "created_at": now(),
        "entries": [],
    }
    result = wheels_col.insert_one(doc)
    doc["_id"] = result.inserted_id
    return jsonify({"wheel": serialize_wheel(doc)}), 201


def get_wheel_or_none(wheel_id):
    try:
        return wheels_col.find_one({"_id": ObjectId(wheel_id)})
    except InvalidId:
        return None


@app.route("/api/wheels/<wheel_id>", methods=["GET"])
@require_auth
def get_wheel(wheel_id):
    w = get_wheel_or_none(wheel_id)
    if not w:
        return jsonify({"error": "Wheel not found"}), 404
    return jsonify({"wheel": serialize_wheel(w)})


@app.route("/api/wheels/<wheel_id>", methods=["DELETE"])
@require_auth
def delete_wheel(wheel_id):
    w = get_wheel_or_none(wheel_id)
    if not w:
        return jsonify({"error": "Wheel not found"}), 404
    if w["created_by"] != g.uid:
        return jsonify({"error": "Only the creator can delete this wheel"}), 403
    wheels_col.delete_one({"_id": w["_id"]})
    return jsonify({"ok": True})


@app.route("/api/nominations", methods=["POST"])
@require_auth
def nominate():
    body = request.get_json(force=True, silent=True) or {}

    target_uid = body.get("target_uid")
    nickname = (body.get("nickname") or "").strip()

    if not target_uid:
        return jsonify({"error": "target_uid is required"}), 400

    if target_uid == g.uid:
        return jsonify({"error": "You cannot nominate yourself"}), 403

    if not nickname:
        return jsonify({"error": "nickname is required"}), 400

    target = users_col.find_one({"uid": target_uid})
    if not target:
        return jsonify({"error": "User not found"}), 404

    me = current_user_doc()

    doc = {
        "target_uid": target_uid,
        "nickname": nickname,
        "weight": 1,
        "added_by_uid": g.uid,
        "added_by_name": me["display_name"],
        "added_at": now(),
    }

    nominations.insert_one(doc)
    return jsonify({"ok": True}), 201
@app.route("/api/my-wheel", methods=["GET"])
@require_auth
def my_wheel():
    docs = list(nominations.find({"target_uid": g.uid}).sort("added_at", -1))

    entries = []
    for d in docs:
        entries.append({
            "id": str(d["_id"]),
            "nickname": d["nickname"],
            "weight": d.get("weight", 1),
            "added_by_name": d["added_by_name"],
        })

    return jsonify({
        "owner_uid": g.uid,
        "entries": entries,
        "count": len(entries),
    })
    

# ---------------------------------------------------------------------------
# NEW: Spin cap + spin history + "lock in" a final nickname
# ---------------------------------------------------------------------------
MAX_SPINS = int(os.environ.get("MAX_SPINS", 5))

spins_col = db["spins"]
locks_col = db["locks"]
spins_col.create_index([("uid", 1), ("spun_at", -1)])
locks_col.create_index("uid", unique=True)


def serialize_spin(s):
    return {
        "id": str(s["_id"]),
        "nickname": s["nickname"],
        "spun_at": s["spun_at"].isoformat(),
    }


@app.route("/api/spins", methods=["GET"])
@require_auth
def list_spins():
    """Current user's own spin history + how many spins they have left."""
    u = current_user_doc()
    if not u:
        return jsonify({"error": "Account not set up yet"}), 404
    spins = list(spins_col.find({"uid": g.uid}).sort("spun_at", -1))
    used = u.get("spins_used", 0)
    lock = locks_col.find_one({"uid": g.uid})
    return jsonify({
        "spins": [serialize_spin(s) for s in spins],
        "spins_used": used,
        "spins_remaining": max(0, MAX_SPINS - used),
        "max_spins": MAX_SPINS,
        "locked_spin_id": str(lock["spin_id"]) if lock else None,
    })


@app.route("/api/spins", methods=["POST"])
@require_auth
def record_spin():
    """
    Record the outcome of a spin the client already ran (the wheel's own
    spin physics/randomness in app.js are untouched — this just persists
    the result). The per-user cap of MAX_SPINS is enforced atomically here
    server-side, via a conditional $inc, so it can't be bypassed by racing
    requests or by calling the API directly.
    """
    body = request.get_json(force=True, silent=True) or {}
    nickname = (body.get("nickname") or "").strip()
    if not nickname:
        return jsonify({"error": "nickname is required"}), 400

    u = users_col.find_one_and_update(
        {
            "uid": g.uid,
            "$or": [
                {"spins_used": {"$lt": MAX_SPINS}},
                {"spins_used": {"$exists": False}},
            ],
        },
        {"$inc": {"spins_used": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if not u:
        return jsonify({"error": f"You've already used all {MAX_SPINS} spins"}), 403

    doc = {"uid": g.uid, "nickname": nickname, "spun_at": now()}
    result = spins_col.insert_one(doc)
    doc["_id"] = result.inserted_id

    used = u.get("spins_used", 0)
    return jsonify({
        "spin": serialize_spin(doc),
        "spins_used": used,
        "spins_remaining": max(0, MAX_SPINS - used),
    }), 201


@app.route("/api/spins/<spin_id>/lock", methods=["POST"])
@require_auth
def lock_spin(spin_id):
    """Mark one of the caller's own past spins as their final chosen nickname."""
    try:
        spin = spins_col.find_one({"_id": ObjectId(spin_id), "uid": g.uid})
    except InvalidId:
        spin = None
    if not spin:
        return jsonify({"error": "Spin not found"}), 404

    u = current_user_doc()
    locks_col.update_one(
        {"uid": g.uid},
        {"$set": {
            "uid": g.uid,
            "display_name": u["display_name"] if u else g.email,
            "spin_id": spin["_id"],
            "nickname": spin["nickname"],
            "locked_at": now(),
        }},
        upsert=True,
    )
    return jsonify({"ok": True, "locked_nickname": spin["nickname"]})


@app.route("/api/final-nicknames", methods=["GET"])
@require_auth
def final_nicknames():
    """Public board: every user's locked-in final nickname (Final Nicknames tab)."""
    locks = list(locks_col.find().sort("locked_at", 1))
    return jsonify({"final_nicknames": [
        {
            "uid": l["uid"],
            "display_name": l.get("display_name", "Unknown"),
            "nickname": l["nickname"],
            "locked_at": l["locked_at"].isoformat(),
        }
        for l in locks
    ]})


# ---------------------------------------------------------------------------
# Static frontend
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)