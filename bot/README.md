# BoomStroy Telegram Bot (@BoomStroyBot)

Bu bot foydalanuvchiga **Telegram ID** sini beradi. Foydalanuvchi botda
**Start → "👤 Profilim"** bosadi, ID ni nusxalaydi va saytdagi
**Profil → Telegram ID** maydoniga qo'yadi. Shundan keyin buyurtma holati va
**aksiya/chegirma** xabarlari shu foydalanuvchining Telegram'iga keladi.

## Nima uchun alohida server kerak?
Sayt va admin panel Telegram'ga faqat **xabar yuboradi**. Lekin botning
buyruqlarga (`/start`, "Profilim") **javob berishi** uchun doimiy ishlaydigan
server (bu skript) kerak.

## Ishga tushirish

1. **Node.js 18+** o'rnatilgan bo'lsin (built-in `fetch` uchun).
2. Bot tokenini muhit o'zgaruvchisiga bering:
   ```bash
   # Linux / Mac
   export BOT_TOKEN="SIZNING_BOT_TOKENINGIZ"
   # Windows (cmd)
   set BOT_TOKEN=SIZNING_BOT_TOKENINGIZ
   ```
   Tokenni [@BotFather](https://t.me/BotFather) dan olasiz.
3. Botni ishga tushiring:
   ```bash
   node bot.js
   ```
   Konsolda `🤖 Bot ishga tushdi: @BoomStroyBot` chiqsa — tayyor.

## Doimiy ishlashi uchun (24/7)
Kompyuterni o'chirsangiz bot to'xtaydi. Doimiy ishlashi uchun bittasini tanlang:

- **Railway** yoki **Render** (bepul reja) — repodan deploy qiling, `BOT_TOKEN`
  ni Environment Variables ga qo'shing, start buyrug'i: `node bot/bot.js`.
- **VPS + pm2**:
  ```bash
  npm i -g pm2
  BOT_TOKEN="..." pm2 start bot/bot.js --name boomstroy-bot
  pm2 save
  ```

## Tekshirish
Telegram'da botga `/start` yuboring → "👤 Profilim" tugmasini bosing →
bot sizning ID raqamingizni qaytaradi.
