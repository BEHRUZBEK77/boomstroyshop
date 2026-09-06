/**
 * BoomStroyShop — inPAY avto-to'lov (tokenlangan karta) backend
 * ==============================================================
 * HOZIRGI HOLAT: ISHLAMAYDI (disabled). Barcha endpointlar "inPAY_NOT_CONFIGURED"
 * xatosini qaytaradi, chunki hali key_id/secret o'rnatilmagan.
 *
 * NEGA BACKEND KERAK?
 * inPAY /api/v1/cards/* so'rovlari HMAC-SHA256 imzo bilan yuboriladi
 * (X-Inpay-Signature). Bu imzoni hisoblash uchun "secret" kalit ishlatiladi —
 * uni frontendda (index.js, brauzer) hech qachon ochiq qoldirib bo'lmaydi,
 * aks holda uni ko'rgan har kim mijoz nomidan pul yechishi mumkin bo'ladi.
 * Shuning uchun bu operatsiyalar shu yerda — serverda (Cloud Functions) —
 * bajariladi, frontend esa faqat shu funksiyalarni chaqiradi.
 *
 * QANDAY FAOLLASHTIRISH KERAK (inPAY hisobingiz tayyor bo'lganda):
 * 1. inPAY kabinet → Avto to'lov → ariza yuboring, admin tasdiqlagach
 *    key_id (ap_...) va secret olasiz.
 * 2. Terminalda:
 *      firebase functions:config:set inpay.key_id="ap_..." inpay.secret="..."
 *    (yoki v2 uchun .env fayliga INPAY_KEY_ID / INPAY_SECRET)
 * 3. Quyidagi ENABLED = true qiling.
 * 4. deploy: firebase deploy --only functions
 *
 * Frontend (BoomStroyShop) checkout'da quyidagilarni chaqiradi (hozircha
 * tugma "Avto-to'lov (tez orada)" deb disabled turadi — index.js'da
 * INPAY_AUTOPAY_ENABLED=false o'rnatilgan):
 *   - bindCard      → mijozga inPAY'ning bir martalik form_url havolasini beradi
 *   - chargeCard    → bog'langan kartadan kod so'ramasdan pul yechadi
 *   - listCards     → mijozning bog'langan kartalari
 *   - removeCard    → kartani bekor qilish
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ─── SOZLAMALAR ──────────────────────────────────────────────
const ENABLED = false; // ← inPAY kaliti o'rnatilgach TRUE qiling
const INPAY_BASE = "https://inpay.uz";
function getCreds() {
  // Firebase Functions v2: process.env orqali (.env yoki Secret Manager)
  return {
    keyId: process.env.INPAY_KEY_ID || "",
    secret: process.env.INPAY_SECRET || "",
  };
}

function notConfigured() {
  throw new HttpsError(
    "failed-precondition",
    "inPAY avto-to'lov hali sozlanmagan. Admin: functions/index.js dagi ENABLED=true qiling va INPAY_KEY_ID/INPAY_SECRET ni o'rnating."
  );
}

// ─── inPAY /api/v1/cards/* uchun HMAC imzo (dokumentatsiya bo'yicha) ──
function signRequest(method, path, body, keyId, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString("hex");
  const json = JSON.stringify(body || {});
  const bodyHash = crypto.createHash("sha256").update(json).digest("hex");
  const base = `${method}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
  const signature = crypto.createHmac("sha256", secret).update(base).digest("hex");
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Inpay-Key": keyId,
      "X-Inpay-Timestamp": String(ts),
      "X-Inpay-Nonce": nonce,
      "X-Inpay-Signature": signature,
    },
    json,
  };
}

async function inpayCardsRequest(action, body) {
  const { keyId, secret } = getCreds();
  if (!ENABLED || !keyId || !secret) return notConfigured();
  const path = `/api/v1/cards/${action}`;
  const { headers, json } = signRequest("POST", path, body, keyId, secret);
  const res = await fetch(INPAY_BASE + path, { method: "POST", headers, body: json });
  const data = await res.json();
  return data;
}

// ─── 1. Kartani bog'lash — mijozga form_url beriladi ──────────
exports.inpayBindCard = onCall(async (req) => {
  if (!ENABLED) return notConfigured();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Avval tizimga kiring");
  const customerRef = uid; // BoomStroyShop mijoz ID'si customer_ref sifatida ishlatiladi
  const data = await inpayCardsRequest("bind", {
    customer_ref: customerRef,
    return_url: req.data?.returnUrl || undefined,
  });
  if (data?.success) {
    await db.collection("users").doc(uid).collection("pendingCardBinds").add({
      bindRef: data.data.bind_ref,
      cardId: data.data.card_id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return data;
});

// ─── 2. Bog'langan kartadan pul yechish (SMS kod so'ramasdan) ─
exports.inpayChargeCard = onCall(async (req) => {
  if (!ENABLED) return notConfigured();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Avval tizimga kiring");
  const { cardId, amount, reason, orderRef } = req.data || {};
  if (!cardId || !amount || !reason) {
    throw new HttpsError("invalid-argument", "cardId, amount, reason majburiy");
  }
  const idemKey = `${uid}-${orderRef || Date.now()}`;
  const data = await inpayCardsRequest("charge", {
    card_id: cardId,
    amount,
    idem_key: idemKey,
    reason,
    order_ref: orderRef || "",
  });
  return data;
});

// ─── 3. Mijozning bog'langan kartalari ─────────────────────────
exports.inpayListCards = onCall(async (req) => {
  if (!ENABLED) return notConfigured();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Avval tizimga kiring");
  const { keyId, secret } = getCreds();
  const path = "/api/v1/cards/list";
  const { headers } = signRequest("GET", path, "", keyId, secret);
  const res = await fetch(`${INPAY_BASE}${path}?customer_ref=${encodeURIComponent(uid)}`, { headers });
  return res.json();
});

// ─── 4. Kartani bog'lanishdan chiqarish ────────────────────────
exports.inpayRemoveCard = onCall(async (req) => {
  if (!ENABLED) return notConfigured();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Avval tizimga kiring");
  const { cardId } = req.data || {};
  if (!cardId) throw new HttpsError("invalid-argument", "cardId majburiy");
  const data = await inpayCardsRequest("remove", { card_id: cardId });
  return data;
});

// ─── inPAY webhook qabul qilish (oddiy to'lovlar uchun, /create oqimi) ─
exports.inpayWebhook = onRequest(async (req, res) => {
  if (!ENABLED) return res.status(503).send("inPAY not configured");
  try {
    const { order_id, status, amount, transaction_id } = req.body || {};
    if (!order_id) return res.status(400).send("order_id yo'q");
    const q = await db.collection("orders").where("orderNumber", "==", order_id).limit(1).get();
    if (!q.empty) {
      await q.docs[0].ref.update({
        paymentStatus: status === "success" ? "paid" : "failed",
        inpayTransactionId: transaction_id || null,
        inpayAmount: amount || null,
      });
    }
    res.status(200).send("OK");
  } catch (e) {
    console.error(e);
    res.status(500).send("error");
  }
});
