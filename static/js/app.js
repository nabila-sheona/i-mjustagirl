import { firebaseConfig, ALLOWED_EMAIL_DOMAIN } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

// NEW: explicitly pin persistence to localStorage/IndexedDB so a page
// refresh keeps the user signed in. Firebase *should* default to this, but
// some browsers (Safari ITP, certain privacy modes) silently fall back to
// in-memory/session-only persistence unless it's set explicitly.
setPersistence(auth, browserLocalPersistence).catch((err) =>
  console.error("Failed to set auth persistence:", err),
);

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const views = {
  loading: $("loading-view"), // NEW
  auth: $("auth-view"),
  verify: $("verify-view"),
  detail: $("detail-view"),
  final: $("final-view"), // NEW: was missing, so the Final Nicknames tab never actually toggled
};

function showView(name) {
  Object.values(views).forEach((v) => {
    if (v) v.classList.add("hidden");
  });
  if (views[name]) views[name].classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Theme handling (applies instantly, persists locally + to account)
// ---------------------------------------------------------------------
const THEMES = [
  "default",
  "black-purple",
  "white-pink",
  "blue-black",
  "lilac",
  "cream",
];
const themeSelect = $("theme-select");

function applyTheme(theme, { persistRemote = false } = {}) {
  if (!THEMES.includes(theme)) theme = "default";
  document.documentElement.setAttribute("data-theme", theme);
  themeSelect.value = theme;
  localStorage.setItem("theme", theme);
  if (persistRemote && auth.currentUser) {
    apiFetch("/api/me/theme", { method: "POST", body: { theme } }).catch(
      () => {},
    );
  }
}

applyTheme(localStorage.getItem("theme") || "default");
themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value, { persistRemote: true });
  if (typeof activeWheel !== "undefined" && activeWheel) drawWheel(); // NEW: repaint wheel with the new theme's colors right away
});

// ---------------------------------------------------------------------
// API helper — always attaches the current Firebase ID token
// ---------------------------------------------------------------------
async function apiFetch(path, { method = "GET", body } = {}) {
  const user = auth.currentUser;
  const headers = { "Content-Type": "application/json" };
  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function authMsg(text, kind = "error") {
  const el = $("auth-msg");
  el.innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : "";
}

// Google sign-in (keeps authentication simple — only Google provider)
const googleProvider = new GoogleAuthProvider();
// Hint to Google to prefer accounts in the university domain in the chooser.
// This is a UI hint only — the server should still validate the token's email domain.
googleProvider.setCustomParameters({
  hd: ALLOWED_EMAIL_DOMAIN.replace(/^@/, ""),
});
if ($("google-signin-btn")) {
  $("google-signin-btn").addEventListener("click", async () => {
    authMsg("");
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      authMsg(friendlyAuthError(err));
    }
  });
}

function validDomain(email) {
  return email
    .trim()
    .toLowerCase()
    .endsWith(ALLOWED_EMAIL_DOMAIN.toLowerCase());
}

// Email/password signup & login removed — only Google sign-in is used.
// Keep friendlyAuthError for Google sign-in errors.

function friendlyAuthError(err) {
  const code = err.code || "";
  if (code.includes("email-already-in-use"))
    return "An account with this email already exists — sign in instead.";
  if (code.includes("invalid-credential") || code.includes("wrong-password"))
    return "Incorrect email or password.";
  if (code.includes("user-not-found"))
    return "No account found with that email.";
  if (code.includes("weak-password"))
    return "Password must be at least 6 characters.";
  if (code.includes("too-many-requests"))
    return "Too many attempts — please wait a moment and try again.";
  return err.message || "Something went wrong.";
}
$("logout-btn").addEventListener("click", async () => {
  await signOut(auth);

  currentProfile = null;
  activeWheel = null;
  spinsRemaining = MAX_SPINS; // NEW
  lockedSpinId = null; // NEW

  $("user-chip").classList.add("hidden");
  $("logout-btn").classList.add("hidden");
  $("tab-nav")?.classList.add("hidden"); // NEW

  showView("auth");
});
// (Email verification / resend UI removed — Google accounts are used.)

// ---------------------------------------------------------------------
// Auth state -> routing (Google sign-in only)
// ---------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  try {
    if (!user) {
      $("user-chip").classList.add("hidden");
      $("logout-btn").classList.add("hidden");
      showView("auth");
      return;
    }

    if (!validDomain(user.email || "")) {
      authMsg(
        `Only ${ALLOWED_EMAIL_DOMAIN} accounts are allowed on this site.`,
      );
      await signOut(auth);
      showView("auth");
      return;
    }

    await syncAndEnterApp();
  } catch (err) {
    console.error("Auth bootstrap failed:", err);

    // Force login screen instead of leaving the app blank
    authMsg("Session could not be loaded. Please sign in again.");
    await signOut(auth).catch(() => {});
    showView("auth");
  }
});
async function syncAndEnterApp() {
  const user = auth.currentUser;

  const data = await apiFetch("/api/auth/sync", {
    method: "POST",
    body: {
      display_name:
        user?.displayName || user?.email?.split("@")[0] || "IUT User",
    },
  });

  currentProfile = data.user;

  applyTheme(currentProfile.theme || "default");

  $("user-chip").textContent =
    `${currentProfile.display_name} (${currentProfile.email})`;

  $("user-chip").classList.remove("hidden");
  $("logout-btn").classList.remove("hidden");
  $("tab-nav")?.classList.remove("hidden"); // NEW

  // This hides the login popup and shows the app
  await Promise.all([loadUsers(), loadMyWheel(), loadSpins() /* NEW */]);
}

let currentProfile = null;
function escapeHtml(s) {
  return String(s).replace(
    /[<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
// ---------------------------------------------------------------------
// My wheel
// ---------------------------------------------------------------------
async function loadMyWheel() {
  showView("detail");

  let data;

  try {
    data = await apiFetch("/api/my-wheel");
  } catch (err) {
    console.error(err);
    alert(err.message);
    return;
  }
  // Temporary placeholder so the app does not crash
  activeWheel = {
    id: "mine",
    title: "My Nickname Wheel",
    created_by_uid: currentProfile.uid,
    entries: (data.entries || []).map((e) => ({
      display_name: e.nickname,
      weight: e.weight || 1,
      added_by_name: e.added_by_name || "Unknown",
      added_by_uid: "",
      target_uid: "",
    })),
  };

  $("wheel-title").textContent = "My Nickname Wheel";
  $("entry-count").textContent = activeWheel.entries.length;
  $("winner-banner").classList.add("hidden");

  const list = $("entries-list");
  list.innerHTML = "";

  activeWheel.entries.forEach((e) => {
    const row = document.createElement("div");
    row.className = "entry-row";
    row.innerHTML = `
      <div class="who">
        <div>${escapeHtml(e.display_name)}</div>
        <small>added by ${escapeHtml(e.added_by_name)}</small>
      </div>`;
    list.appendChild(row);
  });

  drawWheel();
}

// ---------------------------------------------------------------------
// NEW: spin cap, spin history, lock-in ("Final Nicknames")
// ---------------------------------------------------------------------
const MAX_SPINS = 5;
let spinsRemaining = MAX_SPINS;
let lockedSpinId = null;

async function loadSpins() {
  try {
    const data = await apiFetch("/api/spins");
    spinsRemaining = data.spins_remaining;
    lockedSpinId = data.locked_spin_id;
    renderSpinsPanel(data);
  } catch (err) {
    console.error("Failed to load spins:", err);
  }
}

function renderSpinsPanel(data) {
  const remainingEl = $("spins-remaining");
  if (remainingEl) {
    remainingEl.textContent =
      spinsRemaining > 0
        ? `${spinsRemaining} of ${data.max_spins} spins left`
        : "No spins left — pick your favorite below to lock it in";
  }
  const usedCountEl = $("spins-used-count");
  if (usedCountEl) usedCountEl.textContent = data.spins_used;

  const spinBtn = $("spin-btn");
  if (spinBtn) spinBtn.disabled = spinsRemaining <= 0;

  const list = $("spins-list");
  if (!list) return;
  list.innerHTML = "";
  if (!data.spins.length) {
    list.innerHTML = `<p style="color:var(--text-muted);font-size:.85rem">Spin the wheel to start collecting results.</p>`;
    return;
  }
  data.spins.forEach((s) => {
    const row = document.createElement("div");
    row.className = "spin-row" + (s.id === lockedSpinId ? " locked" : "");
    row.innerHTML = `
      <div>${escapeHtml(s.nickname)}</div>
      <button class="btn btn-sm lock-btn" data-spin-id="${s.id}">
        ${s.id === lockedSpinId ? "✓ Locked in" : "Lock in"}
      </button>`;
    list.appendChild(row);
  });
  list.querySelectorAll(".lock-btn").forEach((btn) => {
    btn.addEventListener("click", () => lockSpin(btn.dataset.spinId));
  });
}

async function recordSpin(nickname) {
  try {
    const data = await apiFetch("/api/spins", {
      method: "POST",
      body: { nickname },
    });
    spinsRemaining = data.spins_remaining;
    await loadSpins();
  } catch (err) {
    console.error("Failed to record spin:", err);
  }
}

async function lockSpin(spinId) {
  try {
    await apiFetch(`/api/spins/${spinId}/lock`, { method: "POST" });
    await loadSpins();
  } catch (err) {
    alert(err.message);
  }
}

async function loadFinalNicknames() {
  const list = $("final-list");
  if (!list) return;
  list.innerHTML = `<p style="color:var(--text-muted);font-size:.85rem">Loading…</p>`;
  try {
    const data = await apiFetch("/api/final-nicknames");
    list.innerHTML = "";
    if (!data.final_nicknames.length) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:.85rem">No one has locked in a nickname yet.</p>`;
      return;
    }
    data.final_nicknames.forEach((f) => {
      const row = document.createElement("div");
      row.className = "final-row";
      row.innerHTML = `
        <div>${escapeHtml(f.display_name)}</div>
        <div class="final-nick">${escapeHtml(f.nickname)}</div>`;
      list.appendChild(row);
    });
  } catch (err) {
    list.innerHTML = `<p style="color:var(--danger)">${escapeHtml(err.message)}</p>`;
  }
}

// NEW: tab nav — My Wheel <-> Final Nicknames
const tabNav = $("tab-nav");
if (tabNav) {
  tabNav.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      tabNav
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      showView(tab === "final" ? "final" : "detail");
      if (tab === "final") loadFinalNicknames();
    });
  });
}

async function loadUsers() {
  const data = await apiFetch("/api/users");

  const select = $("nominee-select");
  select.innerHTML = "";

  data.users.forEach((u) => {
    const option = document.createElement("option");
    option.value = u.uid;
    option.textContent = u.display_name;
    select.appendChild(option);
  });
}

// ---------------------------------------------------------------------
// Wheel detail: nominee list, add/remove, canvas render + spin
// ---------------------------------------------------------------------
let activeWheel = null;
$("add-entry-btn").addEventListener("click", async () => {
  const target_uid = $("nominee-select").value;
  const nickname = $("nominee-nickname").value.trim();

  if (!target_uid) {
    alert("Please choose a user.");
    return;
  }

  if (!nickname) {
    alert("Please enter a nickname.");
    return;
  }

  try {
    await apiFetch("/api/nominations", {
      method: "POST",
      body: {
        target_uid,
        nickname,
      },
    });

    $("nominee-nickname").value = "";

    await loadMyWheel();

    alert("Nickname sent successfully!");
  } catch (err) {
    alert(err.message);
  }
});

// ---- Canvas rendering ----
const canvas = $("wheel-canvas");
const ctx = canvas.getContext("2d");
const PALETTE = [
  "#4361ee",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#a855f7",
  "#3b82f6",
  "#ef4444",
  "#14b8a6",
];

let rotation = 0; // radians

// NEW: one color set per theme, so the wheel slices match the page theme.
// "default" mirrors the original PALETTE exactly.
const THEME_PALETTES = {
  default: [
    "#4361ee",
    "#ec4899",
    "#f59e0b",
    "#10b981",
    "#a855f7",
    "#3b82f6",
    "#ef4444",
    "#14b8a6",
  ],
  "black-purple": [
    "#a855f7",
    "#f472b6",
    "#facc15",
    "#34d399",
    "#818cf8",
    "#60a5fa",
    "#f87171",
    "#2dd4bf",
  ],
  "white-pink": [
    "#ec4899",
    "#f472b6",
    "#fb7185",
    "#f59e0b",
    "#a78bfa",
    "#38bdf8",
    "#fca5a5",
    "#f9a8d4",
  ],
  "blue-black": [
    "#3b82f6",
    "#60a5fa",
    "#818cf8",
    "#38bdf8",
    "#f472b6",
    "#34d399",
    "#f87171",
    "#facc15",
  ],
  lilac: [
    "#9370db",
    "#c9a8f5",
    "#f472b6",
    "#7dd3fc",
    "#facc15",
    "#34d399",
    "#fb7185",
    "#a78bfa",
  ],
  cream: [
    "#c98a4b",
    "#e4b87c",
    "#c1443c",
    "#4c8c5e",
    "#8a7a63",
    "#d97706",
    "#b45309",
    "#7c9885",
  ],
};
function getPalette() {
  const theme =
    document.documentElement.getAttribute("data-theme") || "default";
  return THEME_PALETTES[theme] || PALETTE;
}

function expandedSlices(entries) {
  // one visual slice per weight unit keeps physics fair & simple
  const slices = [];
  const palette = getPalette(); // NEW: theme-matched colors instead of fixed PALETTE
  entries.forEach((e, i) => {
    for (let w = 0; w < e.weight; w++)
      slices.push({ ...e, color: palette[i % palette.length] });
  });
  return slices;
}

function drawWheel() {
  const entries = activeWheel ? activeWheel.entries : [];
  const slices = expandedSlices(entries);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = Math.min(cx, cy) - 8;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!slices.length) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ccc";
    ctx.fill();
    ctx.fillStyle = "#666";
    ctx.font = "16px Quicksand, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Add names to spin", cx, cy);
    return;
  }

  const sliceAngle = (Math.PI * 2) / slices.length;
  slices.forEach((s, i) => {
    const start = rotation + i * sliceAngle;
    const end = start + sliceAngle;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, end);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + sliceAngle / 2);
    ctx.textAlign = "right";
    ctx.fillStyle = "#fff";
    ctx.font = "bold 14px Quicksand, sans-serif";
    ctx.fillText(s.display_name, r - 12, 5);
    ctx.restore();
  });
}

function cryptoRandom() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] / 4294967296; // -> [0, 1)
}

let spinning = false;

$("spin-btn").addEventListener("click", () => spin());
canvas.addEventListener("click", () => spin());

function spin() {
  if (spinning || !activeWheel || !activeWheel.entries.length) return;
  if (spinsRemaining <= 0) {
    // NEW: enforce the 5-spin cap client-side (server enforces it too)
    alert(
      `You've used all ${MAX_SPINS} spins — pick your favorite below to lock it in.`,
    );
    return;
  }
  spinning = true;
  $("winner-banner").classList.add("hidden");

  const slices = expandedSlices(activeWheel.entries);
  const sliceAngle = (Math.PI * 2) / slices.length;

  // Pick the winning slice with crypto-secure randomness (each weight unit = 1 slice = equal chance)
  const winningIndex = Math.floor(cryptoRandom() * slices.length);
  const winner = slices[winningIndex];

  // Land the pointer (fixed at top, angle = -PI/2) on the middle of the winning slice.
  const targetSliceCenter = winningIndex * sliceAngle + sliceAngle / 2;
  // FIX: this must be a *whole* number of full turns. Only whole multiples of
  // 2π cancel out of the final rotation — a fractional value here (e.g. 7.43)
  // leaves a leftover fraction-of-a-turn offset, which is why the pointer
  // could previously land near the winning slice but not exactly on it.
  const extraSpins = 6 + Math.floor(cryptoRandom() * 4); // whole number, 6-9 full turns
  const finalRotation =
    -Math.PI / 2 - targetSliceCenter - extraSpins * Math.PI * 2;

  const duration = 4200 + cryptoRandom() * 1200;
  const startRotation = rotation;
  const delta = finalRotation - startRotation;
  const startTime = performance.now();

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function frame(now) {
    const t = Math.min(1, (now - startTime) / duration);
    rotation = startRotation + delta * easeOutCubic(t);
    drawWheel();
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      rotation = ((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      spinning = false;
      const banner = $("winner-banner");
      banner.textContent = `🎉 ${winner.display_name} wins!`;
      banner.classList.remove("hidden");
      recordSpin(winner.display_name); // NEW: persist this result & refresh spins-left count
    }
  }
  requestAnimationFrame(frame);
}
