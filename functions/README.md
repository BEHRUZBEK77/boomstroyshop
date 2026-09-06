# inPAY avto-to'lov backend (hozircha DISABLED)

Bu papka BoomStroyShop uchun inPAY avto-to'lov (tokenlangan karta) integratsiyasini
xavfsiz (secret kalitni frontendda ochiq qoldirmasdan) ishga tushirish uchun tayyorlangan
Firebase Cloud Functions skeleti. Hozircha **ishlamaydi** — `ENABLED = false`.

## Ishga tushirish
1. Loyiha papkasida (agar hali qilinmagan bo'lsa):
   ```
   npm install -g firebase-tools
   firebase login
   firebase init functions   # mavjud "functions" papkasini tanlang
   ```
2. `functions/` papkasida:
   ```
   cd functions
   npm install
   ```
3. inPAY'dan avto-to'lov uchun key_id (ap_...) va secret olganingizdan keyin:
   ```
   firebase functions:config:set inpay.key_id="ap_..." inpay.secret="SIZNING_SECRET"
   ```
   yoki v2 uchun `.env` fayl:
   ```
   INPAY_KEY_ID=ap_...
   INPAY_SECRET=...
   ```
4. `index.js` faylida `const ENABLED = false;` qatorini `true` qiling.
5. Deploy:
   ```
   firebase deploy --only functions
   ```
6. Frontendda (`../index.js`) "Avto-to'lov" tugmasi hali ham "tez orada" deb ko'rinadi —
   uni faollashtirish uchun `selectPayment`ga `'autopay'` variantini qo'shib,
   `inpayBindCard`/`inpayChargeCard` callable funksiyalarini chaqiring
   (masalan: `httpsCallable(functions,'inpayBindCard')({returnUrl:...})`).
