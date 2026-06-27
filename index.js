// ═══════════════════════════════════════════════
// BoomStroy index.js — v7.0 (BUGFIX)
// TUZATILGANLAR:
// 1) GPS — maximumAge:0 olib tashlandi, progressive accuracy,
//    high-accuracy only, fallback IP bilan
// 2) 50km LIMIT YO'Q — hech qanday cheklov yo'q
// 3) OMBOR belgisi yo'q — faqat foydalanuvchi markeri
// 4) Telegram — chat_id sifatida faqat telegramId ishlatiladi
//    @username orqali yuborish ISHLAMAYDI (Telegram API cheklovi)
//    Foydalanuvchi botni start qilganida telegramId saqlanadi
// 5) Barcha buglar tuzatildi
// ═══════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore, collection, getDocs, doc, getDoc,
  addDoc, updateDoc, query, orderBy, where,
  serverTimestamp, limit, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ─── Firebase Config ────────────────────────────
const FB_CONFIG = {
  apiKey: "AIzaSyACliLcu37e-qLtG4rGZXRQsRQhHlZf6ZY",
  authDomain: "boomstroy-7bfdc.firebaseapp.com",
  projectId: "boomstroy-7bfdc",
  storageBucket: "boomstroy-7bfdc.firebasestorage.app",
  messagingSenderId: "615764370606",
  appId: "1:615764370606:web:3d28123cb3e21c10d8393f"
};
const fbApp = initializeApp(FB_CONFIG);
const db = getFirestore(fbApp);

// ─── Telegram Bot ────────────────────────────────
const TG_TOKEN = "8738939484:AAH0RJYIiGgSRK1FvfBFks_u5q3smd274l4";

// MUHIM: Telegram API faqat chat_id (raqam yoki @username EMAS) qabul qiladi.
// @username orqali faqat foydalanuvchi avval botni /start qilgan bo'lsa ishlaydi.
// Ishonchli usul: telegramId (raqam) ni Firestore ga saqlash.
async function tgSend(chatId, text) {
  if (!chatId) return false;
  // Agar @ bilan boshlansa va raqam emas bo'lsa — yuborma (ishlamaydi)
  if (typeof chatId === "string" && chatId.startsWith("@")) {
    console.warn("TG: @username orqali yuborish ishlamaydi. Foydalanuvchi botni /start qilishi kerak.");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
    });
    const data = await res.json();
    if (!data.ok) {
      console.warn("TG xato:", data.description);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("TG yuborishda xato:", e.message);
    return false;
  }
}

// ─── Parolni hash qilish (SHA-256) ───────────────
async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Constants ──────────────────────────────────
// OMBOR o'chirildi — endi faqat GPS markeri ko'rinadi
const BASE_FEE = 10000;
const PER_KM = 2000;
// 50KM LIMIT YO'Q — MAX_KM cheksiz
const CARD_NUM = "8600 0000 0000 0000";
const CARD_OWNER = "BoomStroy LLC";
const PAGE_SIZE = 12;

const RESTRICTED_WORDS = [
  "bo'ka", "boka", "bo`ka", "sirdaryo", "jizzax", "samarqand",
  "navoiy", "buxoro", "qashqadaryo", "surxondaryo", "xorazm",
  "qoraqalpog", "fergana", "farg'ona", "namangan", "andijon"
];

const STATUS_MAP = {
  pending: { cls: "status-pending", icon: "fa-hourglass-half", lbl: "Kutilmoqda" },
  paid_pending: { cls: "status-paid_pending", icon: "fa-credit-card", lbl: "To'lov tekshirilmoqda" },
  confirmed: { cls: "status-confirmed", icon: "fa-check-circle", lbl: "Tasdiqlangan" },
  processing: { cls: "status-processing", icon: "fa-cog", lbl: "Tayyorlanmoqda" },
  shipped: { cls: "status-shipped", icon: "fa-truck", lbl: "Yo'lda" },
  delivered: { cls: "status-delivered", icon: "fa-check-double", lbl: "Yetkazildi" },
  completed: { cls: "status-completed", icon: "fa-check-double", lbl: "Bajarildi" },
  cancelled: { cls: "status-cancelled", icon: "fa-times-circle", lbl: "Bekor qilingan" }
};

const STATUS_TG_MSG = {
  confirmed: "✅ Buyurtmangiz <b>tasdiqlandi!</b> Tez orada tayyorlanadi.",
  processing: "🔧 Buyurtmangiz <b>tayyorlanmoqda.</b> Biroz kuting.",
  shipped: "🚚 Buyurtmangiz <b>yo'lga chiqdi!</b> Tez yetib boradi.",
  delivered: "🎉 Buyurtmangiz <b>yetkazildi!</b> Rahmat!",
  completed: "✅ Buyurtmangiz <b>bajarildi!</b> Xaridingiz uchun rahmat! 🙏",
  cancelled: "❌ Buyurtmangiz <b>bekor qilindi.</b> Savollar uchun: +998 71 000 00 00"
};

// ─── App State ──────────────────────────────────
let products = [];
let categories = [];
let currentUser = null;
let cart = [];
let allOrders = [];
let currentCat = "";
let currentPage = 1;
let filteredProds = [];
let orderStep = 1;
let orderData = {};
let currentOrderTab = "all";

// Leaflet
let _pickerMap = null;
let _pickerMarker = null;
let _pickerResult = null;
let _pickerMode = "order";

// Firestore real-time listener
let _ordersUnsubscribe = null;

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
const fmt = n => Math.round(n || 0).toLocaleString("uz-UZ");

function fmtDate(ts) {
  if (!ts) return "—";
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString("uz-UZ") + " " +
      d.toLocaleTimeString("uz-UZ", { hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

function getStock(p) {
  const q = p.quantity || 0, m = p.minQuantity || 5;
  if (q <= 0) return { val: "out", lbl: "Tugagan", cls: "stock-out", emoji: "🔴" };
  if (q <= m) return { val: "low", lbl: "Tugayapti", cls: "stock-low", emoji: "🟡" };
  return { val: "in", lbl: "Mavjud", cls: "stock-in", emoji: "🟢" };
}

const cartTotal = () => cart.reduce((s, i) => s + i.price * i.qty, 0);
const cartCount = () => cart.reduce((s, i) => s + i.qty, 0);

function saveCart() { localStorage.setItem("bs_cart5", JSON.stringify(cart)); }
function loadCart() {
  try { cart = JSON.parse(localStorage.getItem("bs_cart5") || "[]"); } catch { cart = []; }
}

// ─── Session ─────────────────────────────────────
function saveSession(user) {
  currentUser = user;
  localStorage.setItem("bs_session5", JSON.stringify({ uid: user.id, ts: Date.now() }));
}
function clearSession() {
  currentUser = null;
  localStorage.removeItem("bs_session5");
}
async function restoreSession() {
  try {
    const raw = localStorage.getItem("bs_session5");
    if (!raw) return;
    const { uid, ts } = JSON.parse(raw);
    if (Date.now() - ts > 30 * 86400000) { clearSession(); return; }
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) currentUser = { id: snap.id, ...snap.data() };
    else clearSession();
  } catch { clearSession(); }
}

// ─── Haversine (km) ──────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371,
    dLat = (lat2 - lat1) * Math.PI / 180,
    dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Delivery fee — 50KM CHEKLOVI YO'Q ──────────
function calcDeliveryFee(km) {
  const cnt = cartCount();
  // Hech qanday km limit yo'q
  let discRate = 0, discLabel = "";
  if (cnt >= 10) { discRate = 0.15; discLabel = "15% chegirma (10+ ta)"; }
  else if (cnt >= 5) { discRate = 0.10; discLabel = "10% chegirma (5+ ta)"; }
  else if (cnt >= 3) { discRate = 0.05; discLabel = "5% chegirma (3+ ta)"; }
  const rawFee = BASE_FEE + Math.round(km * PER_KM);
  const fee = Math.round(rawFee * (1 - discRate));
  return {
    ok: true, fee, km: +km.toFixed(2),
    breakdown: `${fmt(BASE_FEE)} + ${fmt(Math.round(km * PER_KM))} (${km.toFixed(2)} km × ${fmt(PER_KM)})`,
    discount: discLabel || null
  };
}

// ─── Toast ───────────────────────────────────────
function showToast(msg, type = "", dur = 3500) {
  const c = document.getElementById("toast-container");
  if (!c) return;
  const t = document.createElement("div");
  t.className = `toast${type ? " " + type : ""}`;
  const icons = { success: "fa-check-circle", error: "fa-exclamation-circle", warning: "fa-exclamation-triangle" };
  t.innerHTML = `<i class="fas ${icons[type] || "fa-info-circle"}"></i> ${msg}`;
  c.appendChild(t);
  setTimeout(() => t.remove(), dur);
}

// ─── Modal ───────────────────────────────────────
function openModal(id) { document.getElementById(id)?.classList.add("open"); }
function closeModal(id) { document.getElementById(id)?.classList.remove("open"); }
window.openModal = openModal;
window.closeModal = closeModal;

// ═══════════════════════════════════════════════
// REVERSE GEOCODING — Nominatim
// ═══════════════════════════════════════════════
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=uz,ru&zoom=18`;
    const r = await fetch(url, {
      headers: { "Accept-Language": "uz,ru,en", "User-Agent": "BoomStroy/7.0" }
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.error) return null;

    const a = d.address || {};
    const parts = [];
    if (a.road || a.pedestrian || a.footway) parts.push(a.road || a.pedestrian || a.footway);
    if (a.house_number) parts.push(a.house_number);
    if (a.suburb || a.neighbourhood || a.quarter) parts.push(a.suburb || a.neighbourhood || a.quarter);
    if (a.city_district || a.county) parts.push(a.city_district || a.county);
    if (a.city || a.town || a.village) parts.push(a.city || a.town || a.village);

    return parts.length > 0 ? parts.join(", ") : (d.display_name || null);
  } catch (e) {
    console.warn("reverseGeocode xato:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════
// GPS — TO'LIQ ANIQ, HECH QANDAY KESH YO'Q
// ═══════════════════════════════════════════════

/**
 * GPS lokatsiya — eng aniq natija uchun:
 * 1. enableHighAccuracy: true — GPS sensorni majburan yoqadi
 * 2. maximumAge: 0 — keshdan HECH narsa olma
 * 3. watchPosition — doimiy yangilanib turadi, eng yaxshisini tanlaydi
 * 4. 10 soniya davomida eng yaxshi natija, keyin tugatadi
 * 5. accuracy <= 30m bo'lsa — darhol qaytaradi
 */
function getGPSLocationAccurate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      return reject(new Error("Brauzer GPS-ni qo'llab-quvvatlamaydi"));
    }

    let bestResult = null;
    let watchId = null;
    let mainTimeout = null;
    let resolved = false;

    function done(result) {
      if (resolved) return;
      resolved = true;
      if (watchId !== null) {
        try { navigator.geolocation.clearWatch(watchId); } catch { }
      }
      if (mainTimeout) clearTimeout(mainTimeout);
      if (result) {
        resolve(result);
      } else {
        reject(new Error("GPS signali topilmadi. Brauzer sozlamalarida joylashuvga ruxsat bering."));
      }
    }

    function onPos(pos) {
      const c = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy != null ? pos.coords.accuracy : 9999,
        altitude: pos.coords.altitude,
        speed: pos.coords.speed
      };

      // Eng aniq natijani saqlash
      if (!bestResult || c.accuracy < bestResult.accuracy) {
        bestResult = c;
        console.log("GPS natija:", c.lat.toFixed(6), c.lng.toFixed(6), "aniqlik:", c.accuracy.toFixed(0), "m");
      }

      // 30 metrdan yaxshi — darhol tugatamiz
      if (c.accuracy <= 30) {
        done(bestResult);
      }
    }

    function onErr(err) {
      const msgs = {
        1: "GPS ruxsati rad etildi. Brauzer sozlamalaridan joylashuvga ruxsat bering.",
        2: "GPS signali topilmadi. Ochiq joyga chiqing yoki WiFi yoqing.",
        3: "GPS vaqt tugadi."
      };
      if (!resolved) {
        if (bestResult) {
          done(bestResult); // Agar biror natija bor bo'lsa — uni qaytaramiz
        } else {
          done(null);
          reject(new Error(msgs[err.code] || "GPS xatosi: " + err.message));
        }
      }
    }

    const geoOpts = {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0
    };

    // watchPosition — doimiy yangilanib turadi
    try {
      watchId = navigator.geolocation.watchPosition(onPos, onErr, geoOpts);
    } catch (e) {
      reject(new Error("GPS ishlatib bo'lmadi: " + e.message));
      return;
    }

    // 12 soniyadan keyin eng yaxshi natija bilan tugatamiz
    mainTimeout = setTimeout(() => {
      if (!resolved) {
        if (bestResult) {
          done(bestResult);
        } else {
          done(null);
          reject(new Error("GPS vaqt tugadi. Iltimos, ochiq joyda qayta urinib ko'ring."));
        }
      }
    }, 12000);
  });
}

// ─── IP Fallback ────────────────────────────────
async function getIPLocation() {
  const apis = [
    "https://ipapi.co/json/",
    "https://ip-api.com/json/?fields=status,lat,lon,city,regionName,country"
  ];
  for (const url of apis) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      const d = await r.json();
      const lat = d.latitude || (d.status === "success" ? d.lat : null);
      const lng = d.longitude || (d.status === "success" ? d.lon : null);
      if (lat && lng) {
        return { lat: parseFloat(lat), lng: parseFloat(lng), city: d.city || d.regionName || "", source: "ip" };
      }
    } catch { /* keyingisini sinab ko'ramiz */ }
  }
  return null;
}

// ─── Lokatsiya yozish ────────────────────────────
function setOrderLocation(lat, lng, distKm, fee, discount, addressText) {
  orderData.lat = lat;
  orderData.lng = lng;
  orderData.distance = distKm;
  orderData.deliveryFee = fee;
  orderData.discount = discount;

  const latEl = document.getElementById("ord-lat");
  const lngEl = document.getElementById("ord-lng");
  if (latEl) latEl.value = lat.toFixed(6);
  if (lngEl) lngEl.value = lng.toFixed(6);

  if (addressText) {
    orderData.address = addressText;
    const addrEl = document.getElementById("ord-address");
    if (addrEl) addrEl.value = addressText;
  }
}

// ═══════════════════════════════════════════════
// MAP PICKER — OMBORSIZ, FAQAT FOYDALANUVCHI
// ═══════════════════════════════════════════════
function initMapPicker(defLat, defLng, zoom = 13) {
  const el = document.getElementById("map-picker-leaflet");
  if (!el) return;
  if (_pickerMap) { _pickerMap.remove(); _pickerMap = null; _pickerMarker = null; }
  _pickerResult = null;

  _pickerMap = L.map("map-picker-leaflet", {
    zoomControl: true,
    attributionControl: true
  }).setView([defLat, defLng], zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap",
    maxZoom: 19
  }).addTo(_pickerMap);

  // OMBOR BELGISI YO'Q — o'chirildi

  _pickerMap.on("click", e => placePickerMarker(e.latlng.lat, e.latlng.lng));

  if (_pickerMode === "order" && orderData.lat && orderData.lng) {
    placePickerMarker(orderData.lat, orderData.lng);
    _pickerMap.setView([orderData.lat, orderData.lng], 16);
  }
}

function placePickerMarker(lat, lng) {
  if (_pickerMarker) {
    _pickerMarker.setLatLng([lat, lng]);
  } else {
    const icon = L.divIcon({
      className: "",
      html: `<div style="width:28px;height:28px;border-radius:50%;background:var(--brand-primary);border:3px solid #fff;box-shadow:0 0 0 6px rgba(232,93,4,.3),0 2px 12px rgba(0,0,0,.4);cursor:grab;display:flex;align-items:center;justify-content:center;">
        <span style="font-size:12px">📍</span>
      </div>`,
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
    _pickerMarker = L.marker([lat, lng], { icon, draggable: true }).addTo(_pickerMap);
    _pickerMarker.on("dragend", e => {
      const p = e.target.getLatLng();
      updatePickerResult(p.lat, p.lng);
    });
  }
  updatePickerResult(lat, lng);
}

async function updatePickerResult(lat, lng) {
  _pickerResult = { lat, lng };
  const dist = haversine(41.299496, 69.240073, lat, lng); // Reference point (center)
  const res = calcDeliveryFee(dist);
  const box = document.getElementById("map-picker-result");
  const btn = document.getElementById("map-picker-confirm-btn");

  if (!box) return;
  box.style.display = "block";
  box.className = "confirmed-address-box show";

  // Hech qanday km cheklovi yo'q — har doim ok
  if (btn) btn.disabled = false;

  box.innerHTML = `<div class="cab-row"><div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;margin-right:8px"></div><span>Manzil aniqlanmoqda...</span></div>`;

  const address = await reverseGeocode(lat, lng);
  const addrText = address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  _pickerResult.address = addrText;

  box.innerHTML = `<div class="cab-row"><i class="fas fa-map-marker-alt" style="color:var(--green);font-size:18px;margin-top:2px"></i><div>
    <div class="cab-title">✅ Manzil aniqlandi!</div>
    <div class="cab-detail">
      📍 <strong>${addrText}</strong><br>
      🧭 ${lat.toFixed(5)}, ${lng.toFixed(5)}<br>
      📏 Masofa: <strong>${res.km} km</strong><br>
      🚚 Yetkazib berish: <strong>${fmt(res.fee)} so'm</strong><br>
      <small style="color:var(--text-muted)">${res.breakdown}</small>
      ${res.discount ? `<br>🎁 <strong>${res.discount}</strong>` : ""}
    </div></div></div>`;
}

window.searchMapPickerAddress = async function () {
  const q = document.getElementById("map-picker-search")?.value.trim();
  if (!q) return;
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1`,
      { headers: { "Accept-Language": "uz,ru,en", "User-Agent": "BoomStroy/7.0" } }
    );
    const data = await r.json();
    if (data[0]) {
      const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
      _pickerMap?.setView([lat, lng], 16);
      placePickerMarker(lat, lng);
    } else {
      showToast("Manzil topilmadi", "error");
    }
  } catch { showToast("Qidiruvda xatolik", "error"); }
};

window.gpsLocateInPicker = async function () {
  const box = document.getElementById("map-picker-result");
  if (box) {
    box.style.display = "block";
    box.className = "confirmed-address-box show";
    box.innerHTML = `<div class="cab-row"><div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;margin-right:8px"></div><span>GPS aniqlanmoqda... (10-15 soniya)</span></div>`;
  }
  try {
    const loc = await getGPSLocationAccurate();
    _pickerMap?.setView([loc.lat, loc.lng], 17);
    placePickerMarker(loc.lat, loc.lng);
    showToast(`GPS muvaffaqiyatli! ±${Math.round(loc.accuracy || 0)}m`, "success");
  } catch (e) {
    showToast("GPS ishlamadi. IP orqali aniqlanmoqda...", "warning");
    const ip = await getIPLocation();
    if (ip) {
      _pickerMap?.setView([ip.lat, ip.lng], 13);
      placePickerMarker(ip.lat, ip.lng);
      showToast(`Taxminiy joylashuv: ${ip.city} (IP orqali)`, "warning");
    } else {
      if (box) box.innerHTML = `<div style="color:var(--red)">❌ Joylashuv aniqlanmadi. Xaritadan qo'lda tanlang.</div>`;
    }
  }
};

window.confirmMapPicker = async function () {
  if (!_pickerResult?.lat) return showToast("Avval xaritadan manzil tanlang", "error");
  const dist = haversine(41.299496, 69.240073, _pickerResult.lat, _pickerResult.lng);
  const res = calcDeliveryFee(dist);

  if (_pickerMode === "delivery-check") {
    const el = document.getElementById("del-calc-result");
    if (el) {
      const addr = _pickerResult.address || `${_pickerResult.lat.toFixed(5)}, ${_pickerResult.lng.toFixed(5)}`;
      el.innerHTML = `<div class="delivery-result-ok">
        ✅ <strong>Yetkazib beriladi!</strong><br>
        📍 ${addr}<br>
        📏 <strong>${res.km} km</strong><br>
        🚚 <strong>${fmt(res.fee)} so'm</strong><br>
        <small>${res.breakdown}</small>
        ${res.discount ? `<br>🎁 ${res.discount}` : ""}
      </div>`;
    }
    closeModal("modal-map-picker");
    return;
  }

  const addressText = _pickerResult.address
    || (orderData.address?.trim() || `${_pickerResult.lat.toFixed(5)}, ${_pickerResult.lng.toFixed(5)}`);

  setOrderLocation(_pickerResult.lat, _pickerResult.lng, res.km, res.fee, res.discount, addressText);

  const calcBox = document.getElementById("delivery-calc-box");
  if (calcBox) calcBox.innerHTML = `<div class="delivery-result-ok">
    ✅ <strong>Manzil tasdiqlandi!</strong><br>
    📍 ${addressText}<br>
    📏 Masofa: <strong>${res.km} km</strong><br>
    🚚 Yetkazib berish: <strong>${fmt(res.fee)} so'm</strong>
  </div>`;

  closeModal("modal-map-picker");
  showToast("Manzil tasdiqlandi! ✓", "success");
};

window.openDeliveryCheckMap = function () {
  _pickerMode = "delivery-check";
  openModal("modal-map-picker");
  // Toshkent markazi
  setTimeout(() => initMapPicker(41.2995, 69.2401, 12), 200);
};

window.openOrderMapPicker = function () {
  _pickerMode = "order";
  openModal("modal-map-picker");
  const lat = orderData.lat || 41.2995;
  const lng = orderData.lng || 69.2401;
  setTimeout(() => initMapPicker(lat, lng, orderData.lat ? 16 : 12), 200);
};

// ─── GPS tugmasi (order step 2) ──────────────────
window.getMyLocation = async function () {
  const calcBox = document.getElementById("delivery-calc-box");
  if (!calcBox) return;

  calcBox.innerHTML = `<div class="gps-status-box loading">
    <div class="spinner"></div>
    <div>
      <div style="font-weight:700">GPS aniqlanmoqda...</div>
      <div style="font-size:12px;margin-top:3px">10-15 soniya sabr qiling. Ruxsat so'rasa — "Allow" bosing</div>
    </div>
  </div>`;

  try {
    const loc = await getGPSLocationAccurate();
    const dist = haversine(41.299496, 69.240073, loc.lat, loc.lng);
    const res = calcDeliveryFee(dist);

    // Reverse geocoding
    calcBox.innerHTML = `<div class="gps-status-box loading">
      <div class="spinner"></div>
      <div>Aniq manzil aniqlanmoqda...</div>
    </div>`;

    const address = await reverseGeocode(loc.lat, loc.lng);
    const addrText = address || `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;

    setOrderLocation(loc.lat, loc.lng, res.km, res.fee, res.discount, addrText);

    calcBox.innerHTML = `<div class="delivery-result-ok">
      ✅ <strong>GPS muvaffaqiyatli!</strong> (±${Math.round(loc.accuracy || 0)}m aniqlik)<br>
      📍 <strong>${addrText}</strong><br>
      🧭 <small>${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}</small><br>
      📏 Masofa: <strong>${res.km} km</strong><br>
      🚚 Yetkazib berish: <strong>${fmt(res.fee)} so'm</strong><br>
      <small>${res.breakdown}</small>
      ${res.discount ? `<br>🎁 ${res.discount}` : ""}
    </div>`;
    showToast(`GPS ✓ ±${Math.round(loc.accuracy || 0)}m`, "success");

  } catch (gpsErr) {
    console.warn("GPS xato:", gpsErr.message);
    calcBox.innerHTML = `<div class="gps-status-box warn">
      <i class="fas fa-exclamation-triangle"></i>
      <div>${gpsErr.message} — IP orqali aniqlanmoqda...</div>
    </div>`;

    const ip = await getIPLocation();
    if (ip) {
      const dist = haversine(41.299496, 69.240073, ip.lat, ip.lng);
      const res = calcDeliveryFee(dist);
      setOrderLocation(ip.lat, ip.lng, res.km, res.fee, res.discount, null);
      calcBox.innerHTML = `<div class="delivery-result-ok" style="border-left-color:var(--yellow)">
        ⚠️ Taxminiy joylashuv (${ip.city || "IP"})<br>
        📏 ~${res.km} km · 🚚 ~${fmt(res.fee)} so'm<br>
        <small style="color:var(--text-muted)">Aniqlik uchun xaritadan tanlang!</small>
      </div>`;
      showToast("Taxminiy joylashuv (IP orqali)", "warning");
    } else {
      orderData.lat = null; orderData.lng = null;
      calcBox.innerHTML = `<div class="delivery-result-err">❌ Joylashuv aniqlanmadi. <strong>Xaritadan tanlang.</strong></div>`;
    }
  }
};

// ═══════════════════════════════════════════════
// AUTH MODAL
// ═══════════════════════════════════════════════
function buildAuthModal() {
  const el = document.getElementById("modal-auth");
  if (!el) return;
  el.innerHTML = `
  <div class="modal-box narrow" onclick="event.stopPropagation()">
    <div class="modal-header">
      <div class="modal-header-icon"><i class="fas fa-user-shield"></i></div>
      <div class="modal-title" id="auth-modal-title">Kirish</div>
      <button class="modal-close" onclick="closeModal('modal-auth')"><i class="fas fa-times"></i></button>
    </div>
    <div class="modal-body">
      <div class="auth-tabs">
        <button class="auth-tab active" id="auth-tab-login" onclick="switchAuthTab('login')">
          <i class="fas fa-sign-in-alt"></i> Kirish
        </button>
        <button class="auth-tab" id="auth-tab-register" onclick="switchAuthTab('register')">
          <i class="fas fa-user-plus"></i> Ro'yxat
        </button>
      </div>

      <div id="auth-login-form">
        <div class="form-group">
          <label class="form-label">Telefon raqam <span>*</span></label>
          <input class="form-control" id="login-phone" type="tel" placeholder="+998901234567" autocomplete="username">
        </div>
        <div class="form-group">
          <label class="form-label">Parol <span>*</span></label>
          <div style="position:relative">
            <input class="form-control" id="login-pwd" type="password" placeholder="Parolingiz" autocomplete="current-password">
            <span onclick="togglePwd('login-pwd',this)" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text-muted)">
              <i class="fas fa-eye"></i>
            </span>
          </div>
        </div>
        <div id="login-err" class="alert-banner red" style="display:none;margin-bottom:12px"></div>
        <button class="btn btn-primary btn-wide" id="login-btn" onclick="doLogin()">
          <i class="fas fa-sign-in-alt"></i> Kirish
        </button>
      </div>

      <div id="auth-register-form" style="display:none">
        <div class="form-group">
          <label class="form-label">Ism Familiya <span>*</span></label>
          <input class="form-control" id="reg-name" placeholder="Toliq ismingiz" autocomplete="name">
        </div>
        <div class="form-group">
          <label class="form-label">Telefon raqam <span>*</span></label>
          <input class="form-control" id="reg-phone" type="tel" placeholder="+998901234567" autocomplete="username">
          <div class="form-hint"><i class="fas fa-info-circle"></i> Kirish uchun ishlatiladi</div>
        </div>
        <div class="form-group">
          <label class="form-label">Telegram @username (ixtiyoriy)</label>
          <div style="position:relative">
            <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted)">@</span>
            <input class="form-control" id="reg-tg" placeholder="username" style="padding-left:28px">
          </div>
          <div class="form-hint"><i class="fab fa-telegram" style="color:#2ca5e0"></i>
            Telegram botimizni avval start qiling: <a href="https://t.me/@BoomStroyBuyurtmaStat_bot" target="_blank" style="color:#2ca5e0">@BoomStroyBuyurtmaStat_bot</a>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Parol <span>*</span></label>
          <div style="position:relative">
            <input class="form-control" id="reg-pwd" type="password" placeholder="Kamida 6 ta belgi" autocomplete="new-password">
            <span onclick="togglePwd('reg-pwd',this)" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text-muted)">
              <i class="fas fa-eye"></i>
            </span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Parolni takrorlang <span>*</span></label>
          <input class="form-control" id="reg-pwd2" type="password" placeholder="Parolni qaytaring">
        </div>
        <div id="register-err" class="alert-banner red" style="display:none;margin-bottom:12px"></div>
        <button class="btn btn-primary btn-wide" id="register-btn" onclick="doRegister()">
          <i class="fas fa-user-plus"></i> Ro'yxatdan o'tish
        </button>
      </div>

      <div class="alert-banner blue" style="margin-top:14px">
        <i class="fas fa-info-circle alert-icon"></i>
        <div style="font-size:12px">
         
        </div>
      </div>
    </div>
  </div>`;
}

window.switchAuthTab = function (tab) {
  document.getElementById("auth-tab-login")?.classList.toggle("active", tab === "login");
  document.getElementById("auth-tab-register")?.classList.toggle("active", tab === "register");
  document.getElementById("auth-login-form").style.display = tab === "login" ? "block" : "none";
  document.getElementById("auth-register-form").style.display = tab === "register" ? "block" : "none";
  document.getElementById("auth-modal-title").textContent =
    tab === "login" ? "Kirish" : "Ro'yxatdan o'tish";
  ["login-err", "register-err"].forEach(id => {
    const e = document.getElementById(id); if (e) e.style.display = "none";
  });
};

window.setAuthTab = function (tab) { window.switchAuthTab(tab); };
window.submitAuth = function () { showToast("Iltimos, Kirish yoki Ro'yxat formasidan foydalaning", "warning"); };

window.togglePwd = function (inputId, btn) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  btn.innerHTML = `<i class="fas fa-eye${show ? "-slash" : ""}"></i>`;
};

function authErr(form, msg) {
  const el = document.getElementById(`${form}-err`);
  if (!el) return;
  el.style.display = "flex";
  el.innerHTML = `<i class="fas fa-exclamation-circle alert-icon"></i><div>${msg}</div>`;
}

function normalizePhone(raw) {
  let p = raw.replace(/\s+/g, "").replace(/-/g, "");
  if (!p.startsWith("+")) p = "+998" + p.replace(/^998/, "").replace(/^0/, "");
  return p;
}

window.doLogin = async function () {
  const rawPhone = document.getElementById("login-phone")?.value.trim();
  const pwd = document.getElementById("login-pwd")?.value;
  const btn = document.getElementById("login-btn");

  if (!rawPhone) return authErr("login", "Telefon raqam kiriting");
  if (!pwd) return authErr("login", "Parol kiriting");

  const phone = normalizePhone(rawPhone);
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block"></div> Tekshirilmoqda...`;

  try {
    const snap = await getDocs(
      query(collection(db, "users"), where("phone", "==", phone), limit(1))
    );
    if (snap.empty) {
      authErr("login", "Bu telefon raqam ro'yxatda yo'q");
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> Kirish`;
      return;
    }

    const userDoc = snap.docs[0];
    const userData = { id: userDoc.id, ...userDoc.data() };
    const inputHash = await hashPassword(pwd);

    if (inputHash !== userData.passwordHash) {
      authErr("login", "Parol noto'g'ri");
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> Kirish`;
      return;
    }

    await updateDoc(doc(db, "users", userDoc.id), { lastLoginAt: serverTimestamp() });

    saveSession(userData);
    updateHeaderUser();
    closeModal("modal-auth");
    showToast(`Xush kelibsiz, ${userData.fullName}! 👋`, "success");
    allOrders = [];
    startOrdersListener();
    renderHomeStats();
    renderProfilePage();

  } catch (e) {
    authErr("login", "Xatolik: " + e.message);
    btn.disabled = false; btn.innerHTML = `<i class="fas fa-sign-in-alt"></i> Kirish`;
  }
};

window.doRegister = async function () {
  const fullName = document.getElementById("reg-name")?.value.trim();
  const rawPhone = document.getElementById("reg-phone")?.value.trim();
  const tg = document.getElementById("reg-tg")?.value.trim().replace(/^@/, "");
  const pwd = document.getElementById("reg-pwd")?.value;
  const pwd2 = document.getElementById("reg-pwd2")?.value;
  const btn = document.getElementById("register-btn");

  if (!fullName) return authErr("register", "Ism Familiyani kiriting");
  if (!rawPhone) return authErr("register", "Telefon raqam kiriting");
  if (!pwd || pwd.length < 6) return authErr("register", "Parol kamida 6 ta belgi bo'lishi kerak");
  if (pwd !== pwd2) return authErr("register", "Parollar mos kelmaydi");

  const phone = normalizePhone(rawPhone);
  btn.disabled = true;
  btn.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2px;display:inline-block"></div> Saqlanmoqda...`;

  try {
    const check = await getDocs(
      query(collection(db, "users"), where("phone", "==", phone), limit(1))
    );
    if (!check.empty) {
      authErr("register", "Bu telefon raqam allaqachon ro'yxatda bor");
      btn.disabled = false; btn.innerHTML = `<i class="fas fa-user-plus"></i> Ro'yxatdan o'tish`;
      return;
    }

    const passwordHash = await hashPassword(pwd);
    const newUser = {
      fullName, phone,
      telegramUsername: tg || "",
      telegramId: "",       // Bot /start qilganda to'ldiriladi
      passwordHash,
      orderCount: 0,
      totalSpent: 0,
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
      source: "web"
    };

    const ref = await addDoc(collection(db, "users"), newUser);
    const userData = { id: ref.id, ...newUser };

    saveSession(userData);
    updateHeaderUser();
    closeModal("modal-auth");
    showToast(`Xush kelibsiz, ${fullName}! 🎉`, "success");

    // Telegram orqali xabar — faqat telegramId bo'lsa
    // (ro'yxat vaqtida telegramId bo'lmaydi, keyinroq bot orqali to'ldiriladi)

    startOrdersListener();
    renderHomeStats();
    renderProfilePage();

  } catch (e) {
    authErr("register", "Xatolik: " + e.message);
    btn.disabled = false; btn.innerHTML = `<i class="fas fa-user-plus"></i> Ro'yxatdan o'tish`;
  }
};

window.onUserBtnClick = function () {
  if (currentUser) goPage("profile");
  else openModal("modal-auth");
};

window.doLogout = function () {
  stopOrdersListener();
  clearSession();
  allOrders = []; cart = [];
  saveCart(); updateCartBadge(); renderCartPanel();
  updateHeaderUser();
  renderProfilePage();
  renderOrdersList("all");
  showToast("Chiqildi");
  goPage("home");
};

function updateHeaderUser() {
  const av = document.getElementById("hdr-user-av");
  const name = document.getElementById("hdr-user-name");
  if (currentUser) {
    const n = currentUser.fullName || "Foydalanuvchi";
    if (av) av.textContent = n[0].toUpperCase();
    if (name) name.textContent = n.split(" ")[0];
  } else {
    if (av) av.innerHTML = `<i class="fas fa-user"></i>`;
    if (name) name.textContent = "Kirish";
  }
}

// ═══════════════════════════════════════════════
// REAL-TIME ORDERS LISTENER + TELEGRAM
// MUHIM: Telegram faqat telegramId (raqam) bilan ishlaydi
// telegramId — bot /start qilganda Firestore ga yoziladi
// ═══════════════════════════════════════════════
function startOrdersListener() {
  stopOrdersListener();
  if (!currentUser) return;

  const q = query(
    collection(db, "orders"),
    where("customerId", "==", currentUser.id)
  );

  _ordersUnsubscribe = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      const newData = { id: change.doc.id, ...change.doc.data() };

      if (change.type === "modified") {
        const oldData = allOrders.find(o => o.id === newData.id);
        if (oldData && oldData.status !== newData.status) {
          // Status o'zgardi — Telegram xabar
          const tgMsg = STATUS_TG_MSG[newData.status];
          if (tgMsg) {
            // FAQAT telegramId (raqam) bilan yuboramiz
            const tgId = newData.telegramId || currentUser.telegramId || "";

            if (tgId) {
              const fullMsg =
                `🛒 <b>Buyurtma №${newData.orderNumber || newData.id.slice(-6)}</b>\n\n` +
                tgMsg + `\n\n` +
                `📋 Mahsulotlar: ${(newData.items || []).length} ta\n` +
                `💵 Jami: <b>${fmt(newData.grandTotal || newData.total)} so'm</b>\n` +
                `📍 ${newData.deliveryAddress || "—"}\n\n` +
                `📞 Savol bo'lsa: +998 71 000 00 00`;

              const sent = await tgSend(tgId, fullMsg);
              if (sent) {
                console.log("TG xabar yuborildi:", tgId);
              } else {
                console.warn("TG xabar yuborilmadi. telegramId to'g'rimi?", tgId);
              }
            } else {
              console.warn("TG yuborilmadi: telegramId bo'sh. Foydalanuvchi botni /start qilmagan.");
            }

            const st = STATUS_MAP[newData.status];
            if (st) showToast(`Buyurtma ${newData.orderNumber}: ${st.lbl}`, "success", 5000);
          }
        }
        const idx = allOrders.findIndex(o => o.id === newData.id);
        if (idx >= 0) allOrders[idx] = newData;
        else allOrders.push(newData);
      } else if (change.type === "added") {
        const exists = allOrders.find(o => o.id === newData.id);
        if (!exists) allOrders.push(newData);
      } else if (change.type === "removed") {
        allOrders = allOrders.filter(o => o.id !== newData.id);
      }
    });

    allOrders.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    renderOrdersList(currentOrderTab);
    renderHomeStats();
    renderProfilePage();
  }, (err) => {
    console.warn("onSnapshot xato:", err.message);
    loadMyOrders();
  });
}

function stopOrdersListener() {
  if (_ordersUnsubscribe) {
    _ordersUnsubscribe();
    _ordersUnsubscribe = null;
  }
}

async function loadMyOrders() {
  if (!currentUser) return;
  try {
    const snap = await getDocs(
      query(collection(db, "orders"), where("customerId", "==", currentUser.id), orderBy("createdAt", "desc"))
    );
    allOrders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    try {
      const snap2 = await getDocs(
        query(collection(db, "orders"), where("customerId", "==", currentUser.id))
      );
      allOrders = snap2.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    } catch (e2) {
      console.warn("loadMyOrders xato:", e2.message);
    }
  }
}

// ═══════════════════════════════════════════════
// PAGE NAVIGATION
// ═══════════════════════════════════════════════
function goPage(page) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll("[id^='sbn-']").forEach(el => el.classList.remove("active"));
  document.querySelectorAll("[id^='bn-']").forEach(el => el.classList.remove("active"));

  const show = id => document.getElementById("page-" + id)?.classList.add("active");
  const nav = (pageId, sbnId, bnId) => {
    show(pageId);
    document.getElementById(sbnId)?.classList.add("active");
    if (bnId) document.getElementById(bnId)?.classList.add("active");
  };

  if (!page || page === "home") { nav("home", "sbn-home", "bn-home"); }
  else if (page === "catalog") { nav("catalog", "sbn-catalog", "bn-catalog"); filterCatalog(); }
  else if (page === "search") { show("search"); setTimeout(() => document.getElementById("search-page-inp")?.focus(), 100); }
  else if (page === "orders") { nav("orders", "sbn-orders", "bn-orders"); renderOrdersList(currentOrderTab); }
  else if (page === "profile") { nav("profile", "sbn-profile", "bn-profile"); renderProfilePage(); }
  else if (page === "delivery-info") { nav("delivery-info", "sbn-delivery-info", null); }
  else if (page === "about") { nav("about", "sbn-about", null); }
}
window.goPage = goPage;

// ═══════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════
async function loadAll() {
  try {
    const [pSnap, cSnap] = await Promise.all([
      getDocs(query(collection(db, "products"), orderBy("name"))),
      getDocs(query(collection(db, "categories"), orderBy("name")))
    ]);
    products = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    categories = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSidebarCats();
    renderHomeStats();
    renderHomeCats();
    renderHomeProducts();
    renderHomeNewProducts();
    updateCartBadge();
    updateHeaderUser();
  } catch (e) {
    showToast("Ma'lumot yuklashda xatolik: " + e.message, "error");
  }
}

// ═══════════════════════════════════════════════
// SIDEBAR CATEGORIES
// ═══════════════════════════════════════════════
function renderSidebarCats() {
  const el = document.getElementById("sidebar-cats");
  const allCnt = products.filter(p => p.status !== "inactive").length;
  const countEl = document.getElementById("sbc-all-count");
  if (countEl) countEl.textContent = allCnt;
  if (!el) return;
  el.innerHTML = categories.map(c => {
    const cnt = products.filter(p => p.category === c.id && p.status !== "inactive").length;
    return `<div class="sb-cat-item" id="sbc-${c.id}" onclick="filterByCat('${c.id}')">
      <span class="sb-cat-icon">${c.icon || "📦"}</span>
      <span class="sb-cat-name">${c.name}</span>
      <span class="sb-cat-count">${cnt}</span>
    </div>`;
  }).join("");
  renderMobileCats();
}

// MOBILE MENU CATEGORIES
// ═══════════════════════════════════════════════
function renderMobileCats() {
  const el = document.getElementById("mobile-cats");
  if (!el) return;
  el.innerHTML = categories.map(c => {
    const cnt = products.filter(p => p.category === c.id && p.status !== "inactive").length;
    return `<div class="mm-cat-item" id="mmc-${c.id}" onclick="filterByCatMobile('${c.id}')">
      <span class="mm-cat-icon">${c.icon || "📦"}</span>
      <span class="mm-cat-name">${c.name}</span>
    </div>`;
  }).join("");
}

// ═══════════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════════
function renderHomeStats() {
  const grid = document.getElementById("home-stats-grid");
  if (!grid) return;
  const avail = products.filter(p => p.status !== "inactive");
  const inStock = avail.filter(p => (p.quantity || 0) > 0).length;
  const hsP = document.getElementById("hs-products");
  const hsC = document.getElementById("hs-cats");
  if (hsP) hsP.textContent = avail.length + "+";
  if (hsC) hsC.textContent = categories.length;
  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon" style="background:#fff3ed;color:var(--brand-primary)"><i class="fas fa-boxes"></i></div>
      <div><div class="stat-value">${avail.length}</div><div class="stat-label">Jami mahsulot</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:#f0fdf4;color:#16a34a"><i class="fas fa-check-circle"></i></div>
      <div><div class="stat-value">${inStock}</div><div class="stat-label">Mavjud</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:#eff6ff;color:#2563eb"><i class="fas fa-tags"></i></div>
      <div><div class="stat-value">${categories.length}</div><div class="stat-label">Kategoriya</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon" style="background:#f5f3ff;color:#7c3aed"><i class="fas fa-clipboard-list"></i></div>
      <div><div class="stat-value">${allOrders.length}</div><div class="stat-label">Buyurtmalarim</div></div>
    </div>`;
}

function renderHomeCats() {
  const grid = document.getElementById("home-cats-grid");
  if (!grid) return;
  grid.innerHTML = categories.map(c => {
    const cnt = products.filter(p => p.category === c.id && p.status !== "inactive").length;
    const col = c.color || "var(--brand-primary)";
    return `<div class="cat-card" onclick="filterByCat('${c.id}')" style="border-color:${col}30">
      <div class="cat-card-icon">${c.icon || "📦"}</div>
      <div class="cat-card-name" style="color:${col}">${c.name}</div>
      <div class="cat-card-count">${cnt} mahsulot</div>
    </div>`;
  }).join("");
}

function renderHomeProducts() {
  const el = document.getElementById("home-products");
  const badge = document.getElementById("home-popular-count");
  if (!el) return;
  const avail = products.filter(p => p.status !== "inactive" && (p.quantity || 0) > 0).slice(0, 8);
  if (badge) badge.textContent = avail.length + " ta";
  el.innerHTML = avail.map(p => productCardHTML(p)).join("");
}

function renderHomeNewProducts() {
  const el = document.getElementById("home-new-products");
  if (!el) return;
  const sorted = [...products]
    .filter(p => p.status !== "inactive")
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
    .slice(0, 6);
  el.innerHTML = sorted.map(p => productCardHTML(p)).join("");
}

window.filterAndGoSortNew = function () {
  goPage("catalog");
  setTimeout(() => { const s = document.getElementById("cat-sort-sel"); if (s) { s.value = "new"; filterCatalog(); } }, 100);
};

// ═══════════════════════════════════════════════
// PRODUCT CARD
// ═══════════════════════════════════════════════
function productCardHTML(p) {
  const cat = categories.find(c => c.id === p.category);
  const st = getStock(p);
  const inCart = cart.find(i => i.productId === p.id);
  const isNew = p.createdAt && (Date.now() - (p.createdAt.seconds || 0) * 1000 < 7 * 86400000);

  let badges = "";
  if (isNew) badges += `<span class="badge badge-new">Yangi</span>`;
  if (st.val === "low") badges += `<span class="badge badge-low">Tugayapti</span>`;
  if (st.val === "out") badges += `<span class="badge badge-out">Tugagan</span>`;

  let cartHTML = "";
  if (st.val === "out") {
    cartHTML = `<button class="btn-add-cart disabled"><i class="fas fa-times"></i> Tugagan</button>`;
  } else if (inCart) {
    cartHTML = `<div class="qty-control" onclick="event.stopPropagation()">
      <button class="qty-btn" onclick="changeCartQty('${p.id}',-1,event)">−</button>
      <span class="qty-num">${inCart.qty}</span>
      <button class="qty-btn" onclick="changeCartQty('${p.id}',1,event)">+</button>
    </div>`;
  } else {
    cartHTML = `<button class="btn-add-cart" onclick="addToCart('${p.id}',event)">
      <i class="fas fa-cart-plus"></i> Savatga
    </button>`;
  }

  const img = p.imageUrl
    ? `<img src="${p.imageUrl}" alt="${p.name}" onerror="this.parentElement.innerHTML='<span style=font-size:48px>${cat?.icon || "📦"}</span>'">`
    : `<span style="font-size:48px">${cat?.icon || "📦"}</span>`;

  return `<div class="pcard" onclick="showProduct('${p.id}')">
    <div class="pcard-img">
      ${img}
      <div class="badge-wrap"><div>${badges}</div><div></div></div>
    </div>
    <div class="pcard-body">
      <div class="pcard-cat">${cat?.icon || ""} ${cat?.name || ""}</div>
      <div class="pcard-name">${p.name}</div>
      ${p.brand ? `<div class="pcard-brand">${p.brand}</div>` : ""}
      <div class="pcard-price-row">
        <span class="pcard-price">${fmt(p.price)}</span>
        <span class="pcard-unit">so'm/${p.unit || "dona"}</span>
      </div>
      <div><span class="stock-pill ${st.cls}">${st.emoji} ${st.lbl}</span></div>
    </div>
    <div class="pcard-footer">${cartHTML}</div>
  </div>`;
}

// ═══════════════════════════════════════════════
// CATALOG
// ═══════════════════════════════════════════════
window.filterByCat = function (catId) {
  currentCat = catId; currentPage = 1;
  goPage("catalog");
  document.querySelectorAll("[id^='sbc-']").forEach(el => el.classList.remove("active"));
  if (catId) {
    document.getElementById("sbc-" + catId)?.classList.add("active");
    const cat = categories.find(c => c.id === catId);
    const tagEl = document.getElementById("active-cat-tag");
    if (tagEl) {
      tagEl.style.display = "block";
      tagEl.innerHTML = `<span class="active-cat-tag">${cat?.icon || ""} ${cat?.name || ""}
        <i class="fas fa-times" onclick="filterByCat('')"></i></span>`;
    }
  } else {
    document.getElementById("sbc-all")?.classList.add("active");
    const tagEl = document.getElementById("active-cat-tag");
    if (tagEl) tagEl.style.display = "none";
  }
  filterCatalog();
};

window.filterCatalog = function () {
  const search = (document.getElementById("cat-search-inp")?.value || "").toLowerCase();
  const sort = document.getElementById("cat-sort-sel")?.value || "name";
  const stockF = document.getElementById("cat-stock-sel")?.value || "";
  let arr = products.filter(p => p.status !== "inactive");
  if (currentCat) arr = arr.filter(p => p.category === currentCat);
  if (search) arr = arr.filter(p =>
    p.name?.toLowerCase().includes(search) ||
    p.sku?.toLowerCase().includes(search) ||
    p.brand?.toLowerCase().includes(search));
  if (stockF === "in") arr = arr.filter(p => (p.quantity || 0) > 0);
  if (stockF === "low") arr = arr.filter(p => (p.quantity || 0) > 0 && (p.quantity || 0) <= (p.minQuantity || 5));
  if (stockF === "out") arr = arr.filter(p => (p.quantity || 0) <= 0);
  if (sort === "price_asc") arr.sort((a, b) => (a.price || 0) - (b.price || 0));
  else if (sort === "price_desc") arr.sort((a, b) => (b.price || 0) - (a.price || 0));
  else if (sort === "new") arr.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  else if (sort === "qty_desc") arr.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
  else arr.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  filteredProds = arr;
  const info = document.getElementById("catalog-results-info");
  if (info) info.textContent = `${arr.length} ta mahsulot topildi`;
  renderCatalogPage();
};

window.resetCatalog = function () {
  currentCat = ""; currentPage = 1;
  const inp = document.getElementById("cat-search-inp"); if (inp) inp.value = "";
  const s1 = document.getElementById("cat-sort-sel"); if (s1) s1.value = "name";
  const s2 = document.getElementById("cat-stock-sel"); if (s2) s2.value = "";
  const tag = document.getElementById("active-cat-tag"); if (tag) tag.style.display = "none";
  document.querySelectorAll("[id^='sbc-']").forEach(el => el.classList.remove("active"));
  document.getElementById("sbc-all")?.classList.add("active");
  filterCatalog();
};

function renderCatalogPage() {
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageData = filteredProds.slice(start, start + PAGE_SIZE);
  const el = document.getElementById("catalog-grid");
  if (!el) return;
  if (!pageData.length) {
    el.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <span class="empty-state-icon">📦</span><h3>Mahsulot topilmadi</h3>
      <p>Boshqa kalit so'z sinab ko'ring</p></div>`;
    document.getElementById("catalog-pagination").innerHTML = "";
    return;
  }
  el.innerHTML = pageData.map(p => productCardHTML(p)).join("");
  renderPagination();
}

function renderPagination() {
  const total = Math.ceil(filteredProds.length / PAGE_SIZE);
  const el = document.getElementById("catalog-pagination");
  if (!el || total <= 1) { if (el) el.innerHTML = ""; return; }
  let html = "";
  if (currentPage > 1) html += `<button class="page-btn" onclick="goCatalogPage(${currentPage - 1})"><i class="fas fa-chevron-left"></i></button>`;
  const from = Math.max(1, currentPage - 2), to = Math.min(total, currentPage + 2);
  for (let i = from; i <= to; i++) html += `<button class="page-btn${i === currentPage ? " active" : ""}" onclick="goCatalogPage(${i})">${i}</button>`;
  if (currentPage < total) html += `<button class="page-btn" onclick="goCatalogPage(${currentPage + 1})"><i class="fas fa-chevron-right"></i></button>`;
  el.innerHTML = html;
}

window.goCatalogPage = function (p) { currentPage = p; renderCatalogPage(); window.scrollTo(0, 0); };

// ═══════════════════════════════════════════════
// LIVE SEARCH
// ═══════════════════════════════════════════════
window.liveSearch = function (val) {
  const drop = document.getElementById("gs-dropdown");
  if (!drop) return;
  if (!val || val.length < 2) { drop.classList.remove("open"); drop.innerHTML = ""; return; }
  const q = val.toLowerCase();
  const found = products.filter(p => p.status !== "inactive" && (
    p.name?.toLowerCase().includes(q) || p.brand?.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q)
  )).slice(0, 7);
  const cat = id => categories.find(c => c.id === id);
  if (!found.length) {
    drop.innerHTML = `<div class="sd-header">Qidiruv natijalari</div><div class="sd-no">Mahsulot topilmadi</div>`;
    drop.classList.add("open"); return;
  }
  drop.innerHTML = `<div class="sd-header">Qidiruv natijalari — ${found.length} ta</div>` +
    found.map(p => `<div class="sd-item" onclick="showProduct('${p.id}');closeSearchDrop()">
      <div class="sd-thumb">${p.imageUrl ? `<img src="${p.imageUrl}" onerror="this.parentElement.innerHTML='📦'">` : `<span style="font-size:20px">${cat(p.category)?.icon || "📦"}</span>`}</div>
      <div class="sd-info">
        <div class="sd-name">${p.name}</div>
        <div class="sd-meta"><span>${cat(p.category)?.name || ""}</span><span class="sd-price">${fmt(p.price)} so'm</span></div>
      </div></div>`).join("");
  drop.classList.add("open");
};
window.closeSearchDrop = function () { document.getElementById("gs-dropdown")?.classList.remove("open"); };

window.doPageSearch = function () {
  const val = (document.getElementById("search-page-inp")?.value || "").toLowerCase();
  const el = document.getElementById("search-page-out");
  if (!el) return;
  if (!val || val.length < 2) {
    el.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><h3>Qidirish uchun yozing</h3><p>Mahsulot nomi, brend yoki kod</p></div>`;
    return;
  }
  const found = products.filter(p => p.status !== "inactive" && (
    p.name?.toLowerCase().includes(val) || p.brand?.toLowerCase().includes(val) ||
    p.sku?.toLowerCase().includes(val) || p.description?.toLowerCase().includes(val)));
  if (!found.length) {
    el.innerHTML = `<div class="empty-state"><span class="empty-state-icon">📦</span><h3>Hech narsa topilmadi</h3><p>Boshqa so'z sinab ko'ring</p></div>`;
    return;
  }
  el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${found.length} ta natija</div>
    <div class="products-grid">${found.slice(0, 24).map(p => productCardHTML(p)).join("")}</div>`;
};

// ═══════════════════════════════════════════════
// PRODUCT DETAIL MODAL
// ═══════════════════════════════════════════════
window.showProduct = function (id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const cat = categories.find(c => c.id === p.category);
  const st = getStock(p);
  const inCart = cart.find(i => i.productId === id);
  document.getElementById("mproduct-title").textContent = p.name;

  let cartCtrl = "";
  if (st.val === "out") {
    cartCtrl = `<button class="btn btn-secondary btn-wide" disabled>❌ Sotib bo'lingan</button>`;
  } else if (inCart) {
    cartCtrl = `
      <div class="qty-control" style="width:180px;margin:0 auto 10px">
        <button class="qty-btn" onclick="changeCartQtyModal('${id}',-1)">−</button>
        <span class="qty-num" id="mdl-qty-${id}">${inCart.qty}</span>
        <button class="qty-btn" onclick="changeCartQtyModal('${id}',1)">+</button>
      </div>
      <button class="btn btn-primary btn-wide" onclick="startOrderFlow();closeModal('modal-product')">
        <i class="fas fa-bolt"></i> Buyurtma berish (${inCart.qty} ta)
      </button>`;
  } else {
    cartCtrl = `<button class="btn btn-primary btn-wide" id="mdl-add-${id}" onclick="addToCartModal('${id}')">
      <i class="fas fa-cart-plus"></i> Savatga qo'shish
    </button>`;
  }

  const img = p.imageUrl
    ? `<img src="${p.imageUrl}" alt="${p.name}" onerror="this.parentElement.innerHTML='<span style=font-size:72px>${cat?.icon || "📦"}</span>'">`
    : `<span style="font-size:72px">${cat?.icon || "📦"}</span>`;

  document.getElementById("mproduct-body").innerHTML = `
    <div class="pd-image">${img}</div>
    <div class="pd-price-row">
      <span class="pd-price">${fmt(p.price)}</span>
      <span class="pd-unit">so'm / ${p.unit || "dona"}</span>
    </div>
    <div style="margin-bottom:12px">
      <span class="stock-pill ${st.cls}">${st.emoji} ${st.lbl}</span>
      ${p.quantity > 0 ? `&nbsp;<span style="font-size:12px;color:var(--text-muted)">${p.quantity} ${p.unit || "dona"} mavjud</span>` : ""}
    </div>
    <div class="pd-meta-grid">
      <div class="pd-meta-item"><div class="pd-meta-label">Kategoriya</div><div class="pd-meta-value">${cat?.icon || ""} ${cat?.name || "—"}</div></div>
      ${p.brand ? `<div class="pd-meta-item"><div class="pd-meta-label">Brend</div><div class="pd-meta-value">${p.brand}</div></div>` : ""}
      ${p.sku ? `<div class="pd-meta-item"><div class="pd-meta-label">SKU</div><div class="pd-meta-value">${p.sku}</div></div>` : ""}
      <div class="pd-meta-item"><div class="pd-meta-label">O'lchov</div><div class="pd-meta-value">${p.unit || "dona"}</div></div>
    </div>
    ${p.description ? `<div class="pd-description"><strong>Tavsif:</strong><br>${p.description}</div>` : ""}
    <div class="pd-actions">${cartCtrl}</div>`;
  openModal("modal-product");
};

window.addToCartModal = function (id) {
  addToCart(id, null);
  const inCart = cart.find(i => i.productId === id);
  const btn = document.getElementById("mdl-add-" + id);
  if (btn && inCart) {
    btn.outerHTML = `<div class="qty-control" style="width:180px;margin:0 auto 10px">
      <button class="qty-btn" onclick="changeCartQtyModal('${id}',-1)">−</button>
      <span class="qty-num" id="mdl-qty-${id}">${inCart.qty}</span>
      <button class="qty-btn" onclick="changeCartQtyModal('${id}',1)">+</button>
    </div>`;
  }
};

window.changeCartQtyModal = function (id, delta) {
  const p = products.find(x => x.id === id);
  const exist = cart.find(i => i.productId === id);
  if (!exist) return;
  if (delta > 0 && exist.qty >= (p?.quantity || 999)) return showToast("Yetarli miqdor yo'q!", "error");
  exist.qty += delta;
  if (exist.qty <= 0) { cart = cart.filter(i => i.productId !== id); closeModal("modal-product"); }
  else { const el = document.getElementById("mdl-qty-" + id); if (el) el.textContent = exist.qty; }
  saveCart(); updateCartBadge(); renderCartPanel(); refreshProductCards();
};

// ═══════════════════════════════════════════════
// CART
// ═══════════════════════════════════════════════
window.addToCart = function (id, e) {
  if (e) e.stopPropagation();
  const p = products.find(x => x.id === id);
  if (!p) return;
  const exist = cart.find(i => i.productId === id);
  if (exist) {
    if (exist.qty >= (p.quantity || 0)) return showToast("Yetarli miqdor yo'q!", "error");
    exist.qty++;
  } else {
    if ((p.quantity || 0) <= 0) return showToast("Mahsulot tugagan", "error");
    cart.push({ productId: id, name: p.name, price: p.price || 0, qty: 1, imageUrl: p.imageUrl || "", unit: p.unit || "dona" });
  }
  saveCart(); updateCartBadge(); renderCartPanel();
  showToast(`${p.name} savatga qo'shildi ✓`, "success");
  refreshProductCards();
};

window.changeCartQty = function (id, delta, e) {
  if (e) e.stopPropagation();
  const p = products.find(x => x.id === id);
  const exist = cart.find(i => i.productId === id);
  if (!exist) return;
  if (delta > 0 && exist.qty >= (p?.quantity || 999)) return showToast("Yetarli miqdor yo'q!", "error");
  exist.qty += delta;
  if (exist.qty <= 0) cart = cart.filter(i => i.productId !== id);
  saveCart(); updateCartBadge(); renderCartPanel(); refreshProductCards();
};

window.removeFromCart = function (id) {
  cart = cart.filter(i => i.productId !== id);
  saveCart(); updateCartBadge(); renderCartPanel(); refreshProductCards();
};

function updateCartBadge() {
  const cnt = cartCount();
  ["hdr-cart-badge", "bn-cart-badge"].forEach(bid => {
    const el = document.getElementById(bid);
    if (!el) return;
    el.textContent = cnt;
    el.classList.toggle("show", cnt > 0);
  });
}

function renderCartPanel() {
  const el = document.getElementById("cp-items");
  const foot = document.getElementById("cp-footer-wrap");
  if (!el) return;
  const countEl = document.getElementById("cp-count");
  if (countEl) countEl.textContent = cartCount() + " ta";

  if (!cart.length) {
    el.innerHTML = `<div class="cp-empty">
      <div class="cp-empty-icon">🛒</div>
      <h3>Savat bo'sh</h3><p>Hali hech narsa qo'shilmagan</p>
      <button class="btn btn-primary" onclick="goPage('catalog');closeCart()">
        <i class="fas fa-th-large"></i> Katalogga o'tish
      </button></div>`;
    if (foot) foot.style.display = "none";
    return;
  }

  el.innerHTML = cart.map(item => `
    <div class="cp-item">
      <div class="cp-item-img">${item.imageUrl ? `<img src="${item.imageUrl}" onerror="this.textContent='📦'">` : `<span style="font-size:22px">📦</span>`}</div>
      <div class="cp-item-info">
        <div class="cp-item-name">${item.name}</div>
        <div class="cp-item-price">${fmt(item.price * item.qty)} so'm</div>
        <div class="cp-item-qty">
          <button class="cpq-btn" onclick="changeCartQty('${item.productId}',-1,null)">−</button>
          <span class="cpq-num">${item.qty}</span>
          <button class="cpq-btn" onclick="changeCartQty('${item.productId}',1,null)">+</button>
          <span class="cpq-unit">× ${fmt(item.price)}</span>
        </div>
      </div>
      <button class="cp-item-del" onclick="removeFromCart('${item.productId}')"><i class="fas fa-trash"></i></button>
    </div>`).join("");

  const sub = cartTotal(), cnt = cartCount();
  let discRate = 0;
  if (cnt >= 10) discRate = 0.15;
  else if (cnt >= 5) discRate = 0.10;
  else if (cnt >= 3) discRate = 0.05;
  const discAmt = Math.round(sub * discRate), grand = sub - discAmt;

  const subEl = document.getElementById("cp-sub-total");
  const discRow = document.getElementById("cp-discount-row");
  const discVal = document.getElementById("cp-discount-val");
  const grandEl = document.getElementById("cp-grand-total");
  if (subEl) subEl.textContent = fmt(sub) + " so'm";
  if (grandEl) grandEl.textContent = fmt(grand) + " so'm";
  if (discRow) discRow.style.display = discAmt > 0 ? "flex" : "none";
  if (discVal) discVal.textContent = `−${fmt(discAmt)} so'm (${Math.round(discRate * 100)}%)`;
  if (foot) foot.style.display = "block";
}

window.openCart = function () { renderCartPanel(); document.getElementById("cart-overlay")?.classList.add("open"); document.getElementById("cart-panel")?.classList.add("open"); };
window.closeCart = function () { document.getElementById("cart-overlay")?.classList.remove("open"); document.getElementById("cart-panel")?.classList.remove("open"); };

function refreshProductCards() {
  const pid = document.querySelector(".page.active")?.id?.replace("page-", "");
  if (pid === "home") { renderHomeProducts(); renderHomeNewProducts(); }
  else if (pid === "catalog") renderCatalogPage();
  else if (pid === "search") doPageSearch();
}

// ═══════════════════════════════════════════════
// ORDER FLOW
// ═══════════════════════════════════════════════
window.startOrderFlow = function () {
  if (!cart.length) return showToast("Savat bo'sh!", "error");
  if (!currentUser) {
    closeCart();
    showToast("Buyurtma uchun avval kiring!", "warning");
    openModal("modal-auth");
    return;
  }
  closeCart();
  orderStep = 1;
  orderData = {
    name: currentUser.fullName || "",
    phone: currentUser.phone || "",
    telegram: currentUser.telegramUsername || ""
  };
  renderOrderStep();
  openModal("modal-order");
};

function stepsBarHTML() {
  const steps = ["Ma'lumot", "Manzil", "To'lov"];
  return `<div class="steps-bar">
    ${steps.map((s, i) => {
    const n = i + 1, done = orderStep > n, cur = orderStep === n;
    return `<div class="step-item${cur ? " current" : ""}${done ? " done" : ""}">
        <div class="step-circle">${done ? '<i class="fas fa-check"></i>' : n}</div>
        <div>${s}</div></div>`;
  }).join("")}
  </div>`;
}

function orderSummaryHTML() {
  const sub = cartTotal(), cnt = cartCount();
  let discRate = 0;
  if (cnt >= 10) discRate = 0.15; else if (cnt >= 5) discRate = 0.10; else if (cnt >= 3) discRate = 0.05;
  const disc = Math.round(sub * discRate), grand = sub - disc;
  return `<div class="order-summary-box">
    <div class="order-summary-title">Savat xulosasi</div>
    ${cart.map(i => `<div class="order-sum-row"><span>${i.name} × ${i.qty}</span><span>${fmt(i.price * i.qty)} so'm</span></div>`).join("")}
    ${disc > 0 ? `<div class="order-sum-row" style="color:var(--green)"><span>🎁 Chegirma (${Math.round(discRate * 100)}%)</span><span>−${fmt(disc)} so'm</span></div>` : ""}
    <div class="order-sum-total"><span>Jami:</span><span>${fmt(grand)} so'm</span></div>
  </div>`;
}

function renderOrderStep() {
  const body = document.getElementById("morder-body");
  const title = document.getElementById("morder-title");
  if (!body) return;

  if (orderStep === 1) {
    if (title) title.textContent = "1-qadam: Aloqa ma'lumotlari";
    body.innerHTML = stepsBarHTML() + orderSummaryHTML() + `
      <div class="form-group">
        <label class="form-label">Ism Familiya <span>*</span></label>
        <input class="form-control" id="ord-name" value="${orderData.name}">
      </div>
      <div class="form-group">
        <label class="form-label">Telefon <span>*</span></label>
        <input class="form-control" id="ord-phone" type="tel" value="${orderData.phone}">
      </div>
      <div class="form-group">
        <label class="form-label">Telegram @username</label>
        <div style="position:relative">
          <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted)">@</span>
          <input class="form-control" id="ord-telegram" placeholder="username" style="padding-left:28px" value="${(orderData.telegram || "").replace("@", "")}">
        </div>
        <div class="form-hint"><i class="fab fa-telegram" style="color:#2ca5e0"></i> Buyurtma holati haqida xabar keladi (bot ID kerak)</div>
      </div>
      <div class="form-group">
        <label class="form-label">Izoh</label>
        <textarea class="form-control" id="ord-note" placeholder="Qo'shimcha ma'lumot...">${orderData.note || ""}</textarea>
      </div>
      <button class="btn btn-primary btn-wide" onclick="orderNext1()">
        Davom etish <i class="fas fa-arrow-right"></i>
      </button>`;

  } else if (orderStep === 2) {
    if (title) title.textContent = "2-qadam: Yetkazib berish manzili";
    body.innerHTML = stepsBarHTML() + `
      <div class="alert-banner blue" style="margin-bottom:14px">
        <i class="fas fa-location-crosshairs alert-icon"></i>
        <div><strong>Aniq manzil uchun:</strong> GPS yoki xaritadan tanlang — narx avtomatik hisoblanadi.</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:14px">
        <button class="btn btn-primary" onclick="getMyLocation()">
          <i class="fas fa-location-crosshairs"></i> GPS bilan aniqlash
        </button>
        <button class="btn btn-secondary" onclick="openOrderMapPicker()">
          <i class="fas fa-map-location-dot"></i> Xaritadan tanlash
        </button>
      </div>
      <div id="delivery-calc-box" style="margin-bottom:14px">
        ${orderData.deliveryFee ? `<div class="delivery-result-ok">
          ✅ Manzil aniqlangan<br>
          📍 ${orderData.address || "—"}<br>
          📏 <strong>${orderData.distance} km</strong> · 🚚 <strong>${fmt(orderData.deliveryFee)} so'm</strong>
        </div>` : ""}
      </div>
      <div class="form-group">
        <label class="form-label">Manzil matni (ko'cha, uy, mo'ljal) <span>*</span></label>
        <input class="form-control" id="ord-address" placeholder="Ko'cha, uy, mo'ljal..." value="${orderData.address || ""}">
        <div class="form-hint"><i class="fas fa-info-circle"></i> GPS/xaritadan tanlanganda avtomatik to'ldiriladi</div>
      </div>
      <div class="form-row" style="margin-bottom:6px">
        <div class="form-group">
          <label class="form-label">Kenglik (Lat)</label>
          <input class="form-control" id="ord-lat" type="number" step="any" placeholder="41.2995"
            value="${orderData.lat || ""}">
        </div>
        <div class="form-group">
          <label class="form-label">Uzunlik (Lng)</label>
          <input class="form-control" id="ord-lng" type="number" step="any" placeholder="69.2401"
            value="${orderData.lng || ""}">
        </div>
      </div>
      <button class="btn btn-primary btn-wide" onclick="orderNext2()">
        <i class="fas fa-calculator"></i> Narxni hisoblash va davom etish
      </button>
      <button class="btn btn-ghost btn-wide" style="margin-top:7px" onclick="orderStep=1;renderOrderStep()">
        <i class="fas fa-arrow-left"></i> Orqaga
      </button>`;

  } else if (orderStep === 3) {
    if (title) title.textContent = "3-qadam: To'lov";
    const prodTotal = cartTotal(), cnt = cartCount();
    let discRate = 0;
    if (cnt >= 10) discRate = 0.15; else if (cnt >= 5) discRate = 0.10; else if (cnt >= 3) discRate = 0.05;
    const disc = Math.round(prodTotal * discRate), netProd = prodTotal - disc,
      grand = netProd + (orderData.deliveryFee || 0);

    body.innerHTML = stepsBarHTML() + `
      <div class="delivery-infobox" style="margin-bottom:14px">
        <div class="delivery-infobox-grid">
          <div><div class="di-label">Manzil</div><div class="di-value sm">${orderData.address || "—"}</div></div>
          <div><div class="di-label">Masofa</div><div class="di-value">${orderData.distance || 0} km</div></div>
          <div><div class="di-label">Yetkazib berish</div><div class="di-value">${fmt(orderData.deliveryFee || 0)} so'm</div></div>
          <div><div class="di-label">JAMI</div><div class="di-value" style="font-size:22px">${fmt(grand)} so'm</div></div>
        </div>
        ${orderData.discount ? `<div style="margin-top:10px;background:rgba(255,255,255,.1);border-radius:6px;padding:6px 12px;font-size:12px;color:#a0f0c0">🎁 ${orderData.discount}</div>` : ""}
      </div>
      <div style="font-size:13px;font-weight:700;margin-bottom:10px">To'lov turini tanlang:</div>
      <div class="payment-grid">
        <div class="payment-option${orderData.payment === "cash" ? " selected" : ""}" onclick="selectPayment('cash',this)">
          <span class="payment-option-icon">💵</span>
          <div class="payment-option-name">Naqd pul</div>
          <div class="payment-option-sub">Yetkazuvchiga</div>
        </div>
        <div class="payment-option${orderData.payment === "card" ? " selected" : ""}" onclick="selectPayment('card',this)">
          <span class="payment-option-icon">💳</span>
          <div class="payment-option-name">Plastik karta</div>
          <div class="payment-option-sub">Oldindan o'tkazma</div>
        </div>
      </div>
      <div id="card-info-block" style="display:${orderData.payment === "card" ? "block" : "none"}">
        <div class="card-info-block">
          <div style="font-size:12px;font-weight:700;color:var(--blue)">To'lov kartasi:</div>
          <div class="card-number">${CARD_NUM}</div>
          <div style="font-size:12px;color:var(--text-secondary)">${CARD_OWNER}</div>
          <div style="font-size:13px;color:var(--blue);margin-top:6px">Summa: <strong>${fmt(grand)} so'm</strong></div>
          <button class="btn-copy" onclick="copyCardNum()"><i class="fas fa-copy"></i> Nusxa olish</button>
        </div>
      </div>
      <button class="btn btn-primary btn-wide" id="confirm-btn" onclick="confirmOrder()" style="margin-top:10px">
        <i class="fas fa-check-circle"></i> Buyurtmani tasdiqlash
      </button>
      <button class="btn btn-ghost btn-wide" style="margin-top:7px" onclick="orderStep=2;renderOrderStep()">
        <i class="fas fa-arrow-left"></i> Orqaga
      </button>`;
  }
}

window.orderNext1 = function () {
  const name = document.getElementById("ord-name")?.value.trim();
  const phone = document.getElementById("ord-phone")?.value.trim();
  const telegram = document.getElementById("ord-telegram")?.value.trim().replace(/^@/, "");
  if (!name) return showToast("Ismingizni kiriting", "error");
  if (!phone || phone.length < 9) return showToast("Telefon raqamni to'g'ri kiriting", "error");
  orderData.name = name; orderData.phone = phone; orderData.telegram = telegram;
  orderData.note = document.getElementById("ord-note")?.value.trim() || "";
  orderStep = 2; renderOrderStep();
};

window.orderNext2 = function () {
  const address = document.getElementById("ord-address")?.value.trim();
  const latRaw = document.getElementById("ord-lat")?.value;
  const lngRaw = document.getElementById("ord-lng")?.value;
  const lat = latRaw !== "" ? parseFloat(latRaw) : NaN;
  const lng = lngRaw !== "" ? parseFloat(lngRaw) : NaN;

  if (!address && (isNaN(lat) || isNaN(lng))) return showToast("Manzil yoki koordinat kiriting", "error");

  const addressText = address || (!isNaN(lat) && !isNaN(lng) ? `${lat.toFixed(4)},${lng.toFixed(4)}` : "");

  // Restricted words check
  if (RESTRICTED_WORDS.some(w => addressText.toLowerCase().includes(w)))
    return showToast("Bu hududga yetkazib bo'lmaydi!", "error");

  orderData.address = addressText;

  if (!isNaN(lat) && !isNaN(lng)) {
    const dist = haversine(41.299496, 69.240073, lat, lng);
    const res = calcDeliveryFee(dist);
    // KM limit yo'q — har doim ok
    orderData.lat = lat; orderData.lng = lng;
    orderData.distance = res.km; orderData.deliveryFee = res.fee; orderData.discount = res.discount;
  } else {
    orderData.lat = null; orderData.lng = null;
    orderData.distance = 0; orderData.deliveryFee = BASE_FEE; orderData.discount = null;
    showToast("Koordinata berilmadi — boshlang'ich narx qo'llanildi.", "warning", 4000);
  }
  orderStep = 3; renderOrderStep();
};

window.selectPayment = function (type, el) {
  orderData.payment = type;
  document.querySelectorAll(".payment-option").forEach(e => e.classList.remove("selected"));
  el?.classList.add("selected");
  const cb = document.getElementById("card-info-block");
  if (cb) cb.style.display = type === "card" ? "block" : "none";
};

window.copyCardNum = function () {
  navigator.clipboard?.writeText(CARD_NUM.replace(/\s/g, ""))
    .then(() => showToast("Nusxalandi!", "success"))
    .catch(() => showToast("Nusxa olinmadi", "error"));
};

window.confirmOrder = async function () {
  if (!orderData.payment) return showToast("To'lov turini tanlang", "error");
  if (!currentUser) return showToast("Avval tizimga kiring", "error");
  const btn = document.getElementById("confirm-btn");
  if (btn) { btn.disabled = true; btn.innerHTML = `<div class="spinner"></div> Yuborilmoqda...`; }

  const prodTotal = cartTotal(), cnt = cartCount();
  let discRate = 0;
  if (cnt >= 10) discRate = 0.15; else if (cnt >= 5) discRate = 0.10; else if (cnt >= 3) discRate = 0.05;
  const disc = Math.round(prodTotal * discRate), netProd = prodTotal - disc,
    grand = netProd + (orderData.deliveryFee || 0);
  const orderNum = "BS-" + Date.now().toString().slice(-6);

  const orderObj = {
    orderNumber: orderNum,
    customerId: currentUser.id,
    customerName: orderData.name,
    customerPhone: orderData.phone,
    telegramUsername: orderData.telegram || currentUser.telegramUsername || "",
    telegramId: currentUser.telegramId || "",   // Raqam — bot orqali to'ldiriladi
    items: cart.map(i => ({ ...i })),
    total: netProd,
    deliveryFee: orderData.deliveryFee || 0,
    grandTotal: grand,
    discount: disc,
    discountRate: Math.round(discRate * 100),
    paymentType: orderData.payment,
    paymentStatus: "pending",
    status: "pending",
    deliveryAddress: orderData.address || "",
    location: orderData.lat ? { lat: orderData.lat, lng: orderData.lng } : null,
    deliveryDistance: orderData.distance || 0,
    note: orderData.note || "",
    source: "web",
    createdAt: serverTimestamp()
  };

  try {
    await addDoc(collection(db, "orders"), orderObj);

    // Mahsulot miqdorini kamaytirish
    for (const item of cart) {
      const prod = products.find(p => p.id === item.productId);
      if (prod) {
        try {
          await updateDoc(doc(db, "products", item.productId), {
            quantity: Math.max(0, (prod.quantity || 0) - item.qty)
          });
          prod.quantity = Math.max(0, (prod.quantity || 0) - item.qty);
        } catch { /* davom etamiz */ }
      }
    }

    // Foydalanuvchi statistikasi
    try {
      await updateDoc(doc(db, "users", currentUser.id), {
        orderCount: (currentUser.orderCount || 0) + 1,
        totalSpent: (currentUser.totalSpent || 0) + grand,
        lastOrderAt: serverTimestamp(),
        ...(orderData.phone ? { phone: orderData.phone } : {}),
        ...(orderData.telegram ? { telegramUsername: orderData.telegram } : {})
      });
      currentUser.orderCount = (currentUser.orderCount || 0) + 1;
      currentUser.totalSpent = (currentUser.totalSpent || 0) + grand;
    } catch { /* davom etamiz */ }

    // ─── TELEGRAM XABAR ──────────────────────────
    // FAQAT telegramId (raqam) bilan yuboriladi
    // telegramId — foydalanuvchi botni /start qilganida Firestore ga yoziladi
    const tgId = currentUser.telegramId || "";

    const tgMsgMijoz =
      `✅ <b>Buyurtmangiz qabul qilindi!</b>\n\n` +
      `📋 № <b>${orderNum}</b>\n` +
      `👤 ${orderData.name}\n` +
      `📱 ${orderData.phone}\n` +
      `📦 ${cnt} ta mahsulot\n` +
      `💵 Mahsulotlar: ${fmt(netProd)} so'm\n` +
      `🚚 Yetkazib berish: ${fmt(orderData.deliveryFee || 0)} so'm\n` +
      `💰 Jami: <b>${fmt(grand)} so'm</b>\n` +
      `💳 To'lov: ${orderData.payment === "card" ? "💳 Plastik karta" : "💵 Naqd pul"}\n` +
      `📍 ${orderData.address || "—"}\n` +
      (orderData.distance ? `📏 Masofa: ${orderData.distance} km\n` : "") +
      `\nTez orada operatorimiz bog'lanadi! 📞\n` +
      `\n<b>Buyurtma holati o'zgarganda xabar keladi.</b>`;

    let tgSent = false;
    if (tgId) {
      tgSent = await tgSend(tgId, tgMsgMijoz);
    }

    // Cart tozalash
    cart = []; saveCart(); updateCartBadge(); renderCartPanel();

    // Muvaffaqiyat ekrani
    const body = document.getElementById("morder-body");
    if (body) body.innerHTML = `
      <div style="text-align:center;padding:20px 0">
        <div style="font-size:60px;margin-bottom:14px">🎉</div>
        <h2 style="font-size:20px;font-weight:700;margin-bottom:10px;color:var(--green)">Buyurtma qabul qilindi!</h2>
        <div class="order-summary-box">
          <div class="order-sum-row"><span>Buyurtma №:</span><span><strong>${orderNum}</strong></span></div>
          <div class="order-sum-row"><span>Mahsulotlar:</span><span>${fmt(netProd)} so'm</span></div>
          <div class="order-sum-row"><span>Yetkazib berish:</span><span>${fmt(orderData.deliveryFee || 0)} so'm</span></div>
          <div class="order-sum-total"><span>JAMI:</span><span>${fmt(grand)} so'm</span></div>
        </div>
        ${tgSent ? `<div class="alert-banner green" style="margin-bottom:12px">
          <i class="fab fa-telegram alert-icon"></i>
          <div>Telegram'ga bildirishnoma yuborildi! ✓ Holat o'zgarganda ham xabar keladi.</div>
        </div>` : (tgId ? `<div class="alert-banner orange" style="margin-bottom:12px">
          <i class="fas fa-exclamation-triangle alert-icon"></i>
          <div>Telegram xabar yuborilmadi. Botni avval <a href="https://t.me/boomstroy_bot" target="_blank">/start</a> qiling.</div>
        </div>` : `<div class="alert-banner blue" style="margin-bottom:12px">
          <i class="fab fa-telegram alert-icon"></i>
          <div>Telegram bildirish nomalari uchun botni start qiling: <a href="https://t.me/boomstroy_bot" target="_blank" style="font-weight:700">@boomstroy_bot</a></div>
        </div>`)}
        ${orderData.payment === "card" ? `<div class="alert-banner blue" style="margin-bottom:12px">
          <i class="fas fa-info-circle alert-icon"></i>
          <div>Karta to'lovingiz tekshirilmoqda. Tasdiqlangach xabar yuboramiz.</div>
        </div>` : ""}
        <button class="btn btn-primary btn-wide" onclick="closeModal('modal-order');goPage('orders')">
          <i class="fas fa-clipboard-list"></i> Buyurtmalarimni ko'rish
        </button>
        <button class="btn btn-secondary btn-wide" style="margin-top:8px" onclick="closeModal('modal-order');goPage('catalog')">
          <i class="fas fa-th-large"></i> Xaridni davom ettirish
        </button>
      </div>`;

    renderHomeStats();

  } catch (e) {
    if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-check-circle"></i> Buyurtmani tasdiqlash`; }
    showToast("Xatolik: " + e.message, "error");
    console.error("confirmOrder xatosi:", e);
  }
};

// ═══════════════════════════════════════════════
// ORDERS LIST
// ═══════════════════════════════════════════════
window.switchOrderTab = function (el, status) {
  currentOrderTab = status;
  document.querySelectorAll(".orders-tab").forEach(t => t.classList.remove("active"));
  el?.classList.add("active");
  renderOrdersList(status);
};

function renderOrdersList(statusFilter = "all") {
  const el = document.getElementById("orders-list-container");
  if (!el) return;
  if (!currentUser) {
    el.innerHTML = `<div class="empty-state">
      <span class="empty-state-icon">👤</span><h3>Kirish kerak</h3>
      <p>Buyurtmalaringizni ko'rish uchun kiring</p>
      <button class="btn btn-primary" style="margin-top:12px" onclick="openModal('modal-auth')">
        <i class="fas fa-sign-in-alt"></i> Kirish
      </button></div>`;
    return;
  }
  let orders = [...allOrders];
  if (statusFilter === "pending") orders = orders.filter(o => ["pending", "paid_pending", "confirmed", "processing"].includes(o.status));
  else if (statusFilter === "shipped") orders = orders.filter(o => o.status === "shipped");
  else if (statusFilter === "delivered") orders = orders.filter(o => ["delivered", "completed"].includes(o.status));
  else if (statusFilter === "cancelled") orders = orders.filter(o => o.status === "cancelled");

  if (!orders.length) {
    el.innerHTML = `<div class="empty-state">
      <span class="empty-state-icon">📋</span><h3>Buyurtma yo'q</h3>
      <button class="btn btn-primary" style="margin-top:12px" onclick="goPage('catalog')">
        <i class="fas fa-shopping-cart"></i> Xarid qilish
      </button></div>`;
    return;
  }
  el.innerHTML = orders.map(o => {
    const st = STATUS_MAP[o.status] || { cls: "status-pending", icon: "fa-question-circle", lbl: o.status || "—" };
    return `<div class="order-card" onclick="showOrderDetail('${o.id}')">
      <div class="order-card-top">
        <div>
          <div class="order-num"><i class="fas fa-receipt" style="color:var(--brand-primary)"></i> ${o.orderNumber || "#" + o.id.slice(-6)}</div>
          <div class="order-date"><i class="fas fa-calendar-alt"></i> ${fmtDate(o.createdAt)}</div>
        </div>
        <span class="status-badge ${st.cls}"><i class="fas ${st.icon}"></i> ${st.lbl}</span>
      </div>
      <div class="order-items-list">
        ${(o.items || []).slice(0, 3).map(i => `${i.name} ×${i.qty}`).join(" · ")}
        ${(o.items || []).length > 3 ? `+${(o.items || []).length - 3} ta` : ""}
      </div>
      <div class="order-card-bottom">
        <div class="order-total">${fmt(o.grandTotal || o.total)} so'm</div>
        <span><i class="fas fa-${o.paymentType === "card" ? "credit-card" : "money-bill-wave"}"></i> ${o.paymentType === "card" ? "Karta" : "Naqd"}</span>
      </div>
    </div>`;
  }).join("");
}

window.showOrderDetail = function (id) {
  const o = allOrders.find(x => x.id === id);
  if (!o) return;
  const st = STATUS_MAP[o.status] || { cls: "status-pending", icon: "fa-question-circle", lbl: o.status || "—" };
  document.getElementById("morderdetail-title").textContent = "Buyurtma " + (o.orderNumber || "#" + id.slice(-6));
  document.getElementById("morderdetail-body").innerHTML = `
    <div style="text-align:center;margin-bottom:16px">
      <span class="status-badge ${st.cls}" style="font-size:13px;padding:8px 16px">
        <i class="fas ${st.icon}"></i> ${st.lbl}
      </span>
    </div>
    <div class="order-summary-box">
      <div style="font-size:13px;line-height:2.4">
        <div><i class="fas fa-receipt" style="color:var(--brand-primary);width:20px"></i> <strong>№:</strong> ${o.orderNumber || "—"}</div>
        <div><i class="fas fa-user" style="color:var(--brand-primary);width:20px"></i> <strong>Mijoz:</strong> ${o.customerName || "—"}</div>
        <div><i class="fas fa-phone" style="color:var(--brand-primary);width:20px"></i> <strong>Telefon:</strong> ${o.customerPhone || "—"}</div>
        <div><i class="fas fa-calendar-alt" style="color:var(--brand-primary);width:20px"></i> <strong>Sana:</strong> ${fmtDate(o.createdAt)}</div>
        <div><i class="fas fa-map-marker-alt" style="color:var(--brand-primary);width:20px"></i> <strong>Manzil:</strong> ${o.deliveryAddress || "—"}</div>
        ${o.deliveryDistance ? `<div><i class="fas fa-road" style="color:var(--brand-primary);width:20px"></i> <strong>Masofa:</strong> ${o.deliveryDistance} km</div>` : ""}
        ${o.telegramUsername ? `<div><i class="fab fa-telegram" style="color:#2ca5e0;width:20px"></i> <strong>Telegram:</strong> @${o.telegramUsername}</div>` : ""}
        ${o.note ? `<div><i class="fas fa-comment" style="color:var(--brand-primary);width:20px"></i> <strong>Izoh:</strong> ${o.note}</div>` : ""}
      </div>
    </div>
    <div class="order-summary-box">
      <div class="order-summary-title">Mahsulotlar</div>
      ${(o.items || []).map((item, i) => `
        <div class="order-sum-row" style="${i > 0 ? "border-top:1px solid var(--border-light);padding-top:8px;margin-top:4px" : ""}">
          <span>${item.name} ×${item.qty}</span>
          <span>${fmt(item.price * item.qty)} so'm</span>
        </div>`).join("")}
    </div>
    <div class="order-summary-box">
      <div class="order-sum-row"><span>Mahsulotlar:</span><span>${fmt(o.total)} so'm</span></div>
      ${o.discount > 0 ? `<div class="order-sum-row" style="color:var(--green)"><span>🎁 Chegirma:</span><span>−${fmt(o.discount)} so'm</span></div>` : ""}
      <div class="order-sum-row"><span>Yetkazib berish:</span><span>${fmt(o.deliveryFee || 0)} so'm</span></div>
      <div class="order-sum-total"><span>JAMI:</span><span>${fmt(o.grandTotal || o.total)} so'm</span></div>
    </div>
    ${o.location?.lat ? `<a href="https://www.google.com/maps?q=${o.location.lat},${o.location.lng}" target="_blank"
      class="btn btn-secondary btn-wide" style="text-decoration:none;margin-bottom:8px">
      <i class="fas fa-map-marked-alt"></i> Xaritada ko'rish</a>` : ""}`;
  document.getElementById("morderdetail-footer").innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal('modal-order-detail')">
      <i class="fas fa-times"></i> Yopish
    </button>`;
  openModal("modal-order-detail");
};

// ═══════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════
function renderProfilePage() {
  const el = document.getElementById("profile-page-content");
  if (!el) return;
  if (!currentUser) {
    el.innerHTML = `<div class="empty-state">
      <span class="empty-state-icon">👤</span><h3>Kirish kerak</h3>
      <button class="btn btn-primary" style="margin-top:12px" onclick="openModal('modal-auth')">
        <i class="fas fa-sign-in-alt"></i> Kirish
      </button></div>`;
    return;
  }
  const u = currentUser;
  const delivered = allOrders.filter(o => ["delivered", "completed"].includes(o.status)).length;
  const hasTgId = !!(u.telegramId);

  el.innerHTML = `
    <div class="profile-hero">
      <div class="profile-avatar">${(u.fullName || "?")[0].toUpperCase()}</div>
      <div>
        <div class="profile-name">${u.fullName || "—"}</div>
        <div class="profile-phone">${u.phone || "—"}</div>
        <div class="profile-type">🌐 Web${u.telegramUsername ? "  ·  📱 @" + u.telegramUsername : ""}</div>
      </div>
    </div>

    ${!hasTgId ? `<div class="alert-banner blue" style="margin-bottom:14px">
      <i class="fab fa-telegram alert-icon"></i>
      <div>
        <strong>Telegram xabarlari uchun:</strong><br>
        1. Botni ochin: <a href="https://t.me/boomstroy_bot" target="_blank" style="color:#1d4ed8;font-weight:700">@boomstroy_bot</a><br>
        2. /start bosing — bot sizga ID beradi<br>
        3. Shu ID ni quyidagi "Telegram ID" maydoniga kiriting
      </div>
    </div>` : `<div class="alert-banner green" style="margin-bottom:14px">
      <i class="fab fa-telegram alert-icon"></i>
      <div>✅ Telegram ulangan! Buyurtma xabarlari keladi.</div>
    </div>`}

    <div class="profile-stats">
      <div class="pstat-card"><div class="pstat-val">${allOrders.length}</div><div class="pstat-label">Jami buyurtma</div></div>
      <div class="pstat-card"><div class="pstat-val">${delivered}</div><div class="pstat-label">Yetkazildi</div></div>
      <div class="pstat-card"><div class="pstat-val">${fmt(u.totalSpent || 0)}</div><div class="pstat-label">Jami so'm</div></div>
    </div>

    <div class="content-card">
      <div class="content-card-title"><i class="fas fa-user-edit"></i> Tahrirlash</div>
      <div class="form-group"><label class="form-label">Ism Familiya</label>
        <input class="form-control" id="pf-name" value="${u.fullName || ""}"></div>
      <div class="form-group"><label class="form-label">Telefon</label>
        <input class="form-control" id="pf-phone" type="tel" value="${u.phone || ""}"></div>
      <div class="form-group"><label class="form-label">Telegram @username</label>
        <div style="position:relative">
          <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-muted)">@</span>
          <input class="form-control" id="pf-tg" style="padding-left:28px" value="${(u.telegramUsername || "").replace("@", "")}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Telegram ID (raqam) 
          <span style="font-size:11px;color:var(--text-muted);font-weight:400">— xabar olish uchun</span>
        </label>
        <input class="form-control" id="pf-tgid" type="text" placeholder="Masalan: 123456789" value="${u.telegramId || ""}">
        <div class="form-hint">
          <i class="fab fa-telegram" style="color:#2ca5e0"></i>
          <a href="https://t.me/boomstroy_bot" target="_blank" style="color:#2ca5e0">@boomstroy_bot</a> ga /start bosib ID oling
        </div>
      </div>
      <div class="form-group"><label class="form-label">Yangi parol (ixtiyoriy)</label>
        <input class="form-control" id="pf-pwd" type="password" placeholder="O'zgartirish uchun kiriting">
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" onclick="saveProfile()"><i class="fas fa-save"></i> Saqlash</button>
        <button class="btn btn-danger"  onclick="doLogout()"><i class="fas fa-sign-out-alt"></i> Chiqish</button>
      </div>
    </div>

    <div class="content-card">
      <div class="content-card-title"><i class="fas fa-clipboard-list"></i> So'nggi buyurtmalar</div>
      ${allOrders.slice(0, 3).map(o => {
    const st = STATUS_MAP[o.status] || { cls: "status-pending", lbl: o.status || "—" };
    return `<div class="order-card" style="box-shadow:none;background:var(--bg-base)" onclick="showOrderDetail('${o.id}')">
          <div class="order-card-top">
            <div><div class="order-num">${o.orderNumber || "#" + o.id.slice(-6)}</div><div class="order-date">${fmtDate(o.createdAt)}</div></div>
            <span class="status-badge ${st.cls}">${st.lbl}</span>
          </div>
          <div class="order-total">${fmt(o.grandTotal || o.total)} so'm</div>
        </div>`;
  }).join("") || `<p style="color:var(--text-muted);font-size:13px">Hali buyurtma yo'q</p>`}
      <button class="btn btn-secondary btn-wide" style="margin-top:8px" onclick="goPage('orders')">
        <i class="fas fa-list"></i> Barcha buyurtmalar
      </button>
    </div>`;
}

window.saveProfile = async function () {
  if (!currentUser) return;
  const name = document.getElementById("pf-name")?.value.trim();
  const phone = document.getElementById("pf-phone")?.value.trim();
  const tg = document.getElementById("pf-tg")?.value.trim().replace(/^@/, "");
  const tgId = document.getElementById("pf-tgid")?.value.trim();
  const pwd = document.getElementById("pf-pwd")?.value;

  const upd = {
    fullName: name,
    phone,
    telegramUsername: tg,
    telegramId: tgId || ""
  };

  if (pwd && pwd.length >= 6) upd.passwordHash = await hashPassword(pwd);
  else if (pwd && pwd.length > 0) return showToast("Yangi parol kamida 6 ta belgi", "error");

  try {
    await updateDoc(doc(db, "users", currentUser.id), upd);
    Object.assign(currentUser, upd);
    saveSession(currentUser);
    showToast("Profil yangilandi!", "success");
    updateHeaderUser();
    renderProfilePage();

    // Telegram ID saqlangandan keyin test xabar yuborish
    if (tgId && tgId !== (currentUser.telegramId || "")) {
      const testSent = await tgSend(tgId,
        `🔔 <b>BoomStroy</b> — Telegram ulandi!\n\n` +
        `✅ Salom, ${name}!\n` +
        `Endi buyurtma xabarlari shu yerga keladi.`
      );
      if (testSent) {
        showToast("Telegram ID saqlandi! Test xabar yuborildi ✓", "success");
      } else {
        showToast("Telegram ID saqlandi, lekin xabar yuborilmadi. ID to'g'riligini tekshiring.", "warning", 6000);
      }
    }
  } catch (e) { showToast("Xatolik: " + e.message, "error"); }
};

// ═══════════════════════════════════════════════
// FAQ
// ═══════════════════════════════════════════════
function renderFAQ() {
  const faqs = [
    {
      q: "Buyurtma berish uchun ro'yxatdan o'tish shartmi?",
      a: "Ha, buyurtma berish uchun telefon raqam va parol bilan kirish shart."
    },
    {
      q: "GPS lokatsiya noto'g'ri ko'rsatyaptimi?",
      a: "GPS tugmasini bosganingizda brauzer ruxsat so'raydi — 'Allow' bosing. Ochiq joyda yaxshiroq ishlaydi. Agar GPS ishlamasa, xaritadan qo'lda tanlang."
    },
    {
      q: "Yetkazib berish narxi qanday hisoblanadi?",
      a: "Boshlang'ich narx 10 000 so'm + har km uchun 2 000 so'm. Hech qanday km cheklovi yo'q."
    },
    {
      q: "Telegram bildirishnoma qanday ishlaydi?",
      a: "1. @boomstroy_bot ga o'ting. 2. /start bosing — bot sizga Telegram ID beradi. 3. Profilingizga shu ID ni kiriting va saqlang. Shundan keyin barcha buyurtma xabarlari keladi."
    },
    {
      q: "Chegirmalar qanday ishlaydi?",
      a: "3+ mahsulot: 5% chegirma · 5+ ta: 10% · 10+ ta: 15% chegirma mahsulotlar summasiga qo'llaniladi."
    },
    {
      q: "Parolimni unutsam nima qilaman?",
      a: "Operatorga murojaat qiling: +998 71 000 00 00. Parolni qayta tiklash funksiyasi yaqinda qo'shiladi."
    }
  ];
  const el = document.getElementById("faq-list");
  if (!el) return;
  el.innerHTML = faqs.map((f, i) => `
    <div class="faq-item">
      <div class="faq-q" id="faq-q-${i}" onclick="toggleFAQ(${i})">
        ${f.q} <i class="fas fa-chevron-down"></i>
      </div>
      <div class="faq-a" id="faq-a-${i}">${f.a}</div>
    </div>`).join("");
}

window.toggleFAQ = function (i) {
  const a = document.getElementById("faq-a-" + i);
  const q = document.getElementById("faq-q-" + i);
  const open = a?.classList.toggle("open");
  q?.classList.toggle("open", open);
};

// ═══════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════
async function init() {
  loadCart();
  updateCartBadge();
  renderCartPanel();
  buildAuthModal();

  await restoreSession();
  updateHeaderUser();

  if (currentUser) {
    await loadMyOrders();
    startOrdersListener();
    renderHomeStats();
  }

  await loadAll();
  setTimeout(renderFAQ, 100);
}

init();