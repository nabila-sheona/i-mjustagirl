# 🎡 I'm Just a Girl — the IUT Wheel of Names

**👉 Play it live: https://imjustagirl.onrender.com/**

Okay so. Everyone at IUT has a secret nickname waiting for them and they
just don't know it yet. This app fixes that.

Here's the whole vibe:

1. You sign in with your `@iut-dhaka.edu` email. No randoms allowed. 🚫
2. You go nominate a nickname for someone else (never yourself, we checked,
   nice try).
3. Everyone who nominated you goes onto **your own personal wheel**.
4. You get **5 spins**, no more, no less — drama requires a limit.
5. Whichever nickname you like best out of your 5 spins, you **lock it in**.
6. Head over to the **Final Nicknames** tab and see what everybody else
   locked in too. 🍿

That's it. That's the app. Spin fair, spin square, no crying if you get
"Chaotic Library Gremlin."

Pick a theme while you're at it — six flavors, all vibes: default,
black-purple, white-pink, blue-black, lilac, cream. It even skins the wheel
itself now, no more mismatched neon-pink slices on your moody black-purple
theme.

---

## Section B — the boring-but-important technical stuff

### What this actually is

- **Backend:** Flask JSON API (`app.py`)
- **Frontend:** plain HTML/CSS/JS (no framework), served as static files by
  Flask
- **Auth:** Firebase (Google sign-in only). This server never sees a
  password — it only ever sees a Firebase ID token, verified server-side via
  the Firebase Admin SDK on every single request.
- **Domain gate:** only `@iut-dhaka.edu` emails, checked in the browser
  _and_ independently re-checked on the server from the decoded token — not
  just whatever the client claims.
- **Database:** MongoDB (Atlas) — users, wheels/nominations, spin history,
  and locked-in final picks.
- **Deployed on:** Render → https://imjustagirl.onrender.com/

### Live deployment note

The site is hosted on Render's free tier, which spins the instance down
after inactivity — the very first request after a quiet period can take
10–30s to wake back up. That's Render, not a bug.

### Project structure

```
iut_wheel_of_names/
├── app.py                     # Flask JSON API (Firebase auth verify, Mongo storage)
├── requirements.txt
├── .env.example                # copy to .env and fill in real values
├── .gitignore
├── README.md
└── static/
    ├── index.html               # single-page app shell
    ├── css/style.css            # 6 themes
    └── js/
        ├── firebase-config.js   # PUBLIC firebase web config
        └── app.js                # auth + API + wheel canvas/spin
```

### Firebase setup

1. [Firebase Console](https://console.firebase.google.com/) → your project
   (`imjustagirl`) → **Authentication → Sign-in method** → enable **Google**.
2. **Project settings → General → Your apps → Web app** → copy the config
   object into `static/js/firebase-config.js`. These values are public by
   design; it's fine that they ship to the browser.
3. **Project settings → Service accounts → Generate new private key**. This
   file _is_ secret. Either:
   - save it as `firebase-service-account.json` next to `app.py` and set
     `FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json`, or
   - paste its full contents as one line into `FIREBASE_SERVICE_ACCOUNT_JSON`.
4. Auth persistence is explicitly pinned to `browserLocalPersistence` in
   `app.js`, so a page refresh keeps you signed in instead of bouncing you
   back to the login screen.

### MongoDB setup

```
MONGODB_URI=mongodb+srv://<db_user>:<db_password>@imjustagirl.tvwexnq.mongodb.net
MONGO_DB_NAME=iut_wheel_of_names
```

> **Security note:** rotate your Atlas database password (Atlas → Database
> Access → edit user) before going live if it was ever shared in plain text
> anywhere. New password goes only in your local `.env` — never in a file
> you upload or commit.

### Run it locally

```bash
cd iut_wheel_of_names
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# edit .env: MONGODB_URI, FIREBASE_SERVICE_ACCOUNT_PATH (or _JSON)

python app.py
```

Open **http://localhost:5000**.

### How the flow works, technically

1. **Sign in** via Google (`@iut-dhaka.edu` domain hinted in the picker, but
   enforced for real on the server from the decoded token + `email_verified`).
2. On first sign-in, the frontend calls `POST /api/auth/sync`, which creates
   the Mongo `users` doc (`uid`, `email`, `display_name`, `theme`).
3. Any signed-in user can nominate any _other_ registered user a nickname —
   never themselves — rejected both client- and server-side.
4. Each user has one personal wheel made of the nicknames others nominated
   for them (`GET /api/my-wheel`).
5. **Spinning:** the winner is picked client-side with
   `crypto.getRandomValues()` (not `Math.random()`), landing the fixed
   top-center pointer exactly on the winning slice's center every time —
   the rotation math solves for that directly, not an approximation.
6. Each spin result is persisted via `POST /api/spins`. The 5-spin cap is
   enforced **atomically server-side** (a conditional `$inc` in Mongo), so
   it can't be bypassed by calling the API directly or racing requests.
7. `POST /api/spins/<id>/lock` marks one of your own past spins as your
   final nickname. `GET /api/final-nicknames` is the public board everyone
   sees on the **Final Nicknames** tab.

### Data model (MongoDB)

**users**

```
{ uid, email, display_name, theme, spins_used, created_at }
```

**wheels / nominations**

```
{
  _id, title, created_by, created_by_name, created_at,
  entries: [
    { target_uid, display_name, weight, added_by_uid, added_by_name, added_at }
  ]
}
```

**spins**

```
{ _id, uid, nickname, spun_at }
```

**locks**

```
{ uid, display_name, spin_id, nickname, locked_at }
```

### Permissions recap

- A wheel entry can be removed by whoever added it, or by the wheel's
  creator.
- A wheel itself can only be deleted by its creator.
- Weight (1–20) controls slice size.
- You can only lock in one of _your own_ past spin results.
- Everyone can see everyone's locked-in final nickname; only you can see
  your own full spin history.

### Deploying

Run behind gunicorn/uwsgi, set `FLASK_DEBUG=0`, and make sure `.env` /
`firebase-service-account.json` are never baked into a public image or
committed to the repo. Currently deployed on Render at
https://imjustagirl.onrender.com/.
