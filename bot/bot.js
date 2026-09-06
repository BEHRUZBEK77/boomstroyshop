// ═══════════════════════════════════════════════════════════
//  BoomStroy Telegram Bot — @BoomStroyBot
//  Vazifasi: foydalanuvchiga uning Telegram ID sini berish.
//  Foydalanuvchi: Start -> "👤 Profilim" -> ID ni nusxalaydi ->
//  saytdagi Profil sahifasidagi "Telegram ID" maydoniga qo'yadi.
//  Shundan keyin buyurtma holati va aksiya/chegirma xabarlari
//  ushbu foydalanuvchining Telegram'iga keladi.
//
//  Ishga tushirish:
//    1) Node.js 18+ o'rnatilgan bo'lsin (fetch built-in).
//    2) Bot tokenini muhit o'zgaruvchisiga bering:
//         export BOT_TOKEN="123456:ABC..."   (Linux/Mac)
//         set BOT_TOKEN=123456:ABC...         (Windows)
//    3) node bot.js
//  Doimiy ishlashi uchun Railway / Render / VPS / pm2 dan foydalaning.
// ═══════════════════════════════════════════════════════════

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN muhit o'zgaruvchisi berilmagan. Masalan: export BOT_TOKEN=\"123:ABC\"");
  process.exit(1);
}
const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r.json();
}

const profileKeyboard = {
  keyboard: [[{ text: "👤 Profilim" }]],
  resize_keyboard: true
};

function welcomeText() {
  return (
    "👋 <b>Assalomu alaykum! BoomStroy botiga xush kelibsiz.</b>\n\n" +
    "Saytdagi buyurtma holati va <b>aksiya/chegirma</b> xabarlarini Telegram orqali olish uchun " +
    "o'zingizning <b>Telegram ID</b> ingizni saytga ulashingiz kerak.\n\n" +
    "👉 Pastdagi <b>\"👤 Profilim\"</b> tugmasini bosing — men sizga ID beraman."
  );
}

function profileText(from) {
  const id = from.id;
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Foydalanuvchi";
  return (
    `👤 <b>${name}</b>\n\n` +
    `🆔 Sizning Telegram ID ingiz:\n\n` +
    `<code>${id}</code>\n\n` +
    `📋 Yuqoridagi raqamni <b>bosib nusxalang</b>, so'ng saytda:\n` +
    `<b>Profil → Telegram ID</b> maydoniga qo'ying va <b>Saqlash</b> bosing.\n\n` +
    `✅ Shundan keyin buyurtma holati va aksiya/chegirma e'lonlari shu yerga keladi.`
  );
}

async function handleUpdate(u) {
  try {
    // Tugma bosilganda (callback)
    if (u.callback_query) {
      const cq = u.callback_query;
      await tg("answerCallbackQuery", { callback_query_id: cq.id });
      await tg("sendMessage", {
        chat_id: cq.from.id,
        text: profileText(cq.from),
        parse_mode: "HTML",
        reply_markup: profileKeyboard
      });
      return;
    }

    const msg = u.message;
    if (!msg || !msg.chat) return;
    const text = (msg.text || "").trim();

    if (text === "/start") {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: welcomeText(),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "👤 Profilim (ID olish)", callback_data: "profile" }]],
          keyboard: profileKeyboard.keyboard,
          resize_keyboard: true
        }
      });
      return;
    }

    if (text === "👤 Profilim" || /profil|id/i.test(text)) {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: profileText(msg.from),
        parse_mode: "HTML",
        reply_markup: profileKeyboard
      });
      return;
    }

    // Boshqa har qanday xabar
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "ℹ️ ID olish uchun <b>\"👤 Profilim\"</b> tugmasini bosing.",
      parse_mode: "HTML",
      reply_markup: profileKeyboard
    });
  } catch (e) {
    console.error("handleUpdate xato:", e.message);
  }
}

// ─── Long polling ────────────────────────────────────────────
let offset = 0;
async function poll() {
  while (true) {
    try {
      const res = await tg("getUpdates", { offset, timeout: 30 });
      if (res.ok && Array.isArray(res.result)) {
        for (const u of res.result) {
          offset = u.update_id + 1;
          await handleUpdate(u);
        }
      }
    } catch (e) {
      console.error("poll xato:", e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

(async () => {
  const me = await tg("getMe", {});
  if (me.ok) console.log(`🤖 Bot ishga tushdi: @${me.result.username}`);
  else { console.error("❌ getMe muvaffaqiyatsiz — token noto'g'ri bo'lishi mumkin:", JSON.stringify(me)); process.exit(1); }
  poll();
})();
