const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const axios = require("axios");
const { AsyncLocalStorage } = require("async_hooks");

admin.initializeApp();

const db = admin.firestore();
const app = express();
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(204).send("");
  return next();
});
app.use(express.json({ limit: "2mb" }));

const whatsappContext = new AsyncLocalStorage();

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "gal_verify_token";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://galhadad-app.github.io/Master-B/";
const DEFAULT_WHATSAPP_MODE = process.env.DEFAULT_WHATSAPP_MODE || "central";
const WAITLIST_TEMPLATE_NAME = process.env.WAITLIST_TEMPLATE_NAME || "waitlist_slot_available";
const WAITLIST_TEMPLATE_LANGUAGE = process.env.WAITLIST_TEMPLATE_LANGUAGE || "he";

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
  console.error("❌ חסר WHATSAPP_TOKEN או PHONE_NUMBER_ID");
}

console.log("✅ WhatsApp env loaded", {
  hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
  phoneNumberId: PHONE_NUMBER_ID || "",
  verifyTokenConfigured: Boolean(VERIFY_TOKEN),
});

const BUSINESS_SETTINGS_COLLECTION = "businessSettings";
const APPOINTMENTS_COLLECTION = "appointments";
const WAITLIST_COLLECTION = "waitlist";
const WAITLIST_CLAIMS_COLLECTION = "waitlistClaims";
const SESSIONS_COLLECTION = "wa_sessions";

const SLOT_STEP_MINUTES = 30;
const MAX_DAYS_TO_SHOW = 7;

const dayKeys = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const dayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

const DEFAULT_SERVICES = [
  { text: "תספורת", price: "60", label: "תספורת - ₪60", value: "תספורת - ₪60" },
  { text: "תספורת + זקן", price: "80", label: "תספורת + זקן - ₪80", value: "תספורת + זקן - ₪80" },
];

const DEFAULT_WORKING_HOURS = {
  sunday: { start: "10:00", end: "20:00", closed: false },
  monday: { start: "10:00", end: "20:00", closed: false },
  tuesday: { start: "10:00", end: "20:00", closed: false },
  wednesday: { start: "10:00", end: "20:00", closed: false },
  thursday: { start: "10:00", end: "20:00", closed: false },
  friday: { start: "09:00", end: "14:00", closed: false },
  saturday: { start: "", end: "", closed: true },
};

// =======================
// Health
// =======================
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "whatsapp-appointments-api",
    time: new Date().toISOString(),
  });
});

// =======================
// Webhook verification
// =======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// =======================
// Incoming WhatsApp messages
// =======================
app.post("/webhook", async (req, res) => {
  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = change?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = extractMessageText(message);
    const metadata = change?.metadata || {};

    await whatsappContext.run(
      {
        incomingPhoneNumberId: String(metadata.phone_number_id || ""),
        displayPhoneNumber: String(metadata.display_phone_number || ""),
      },
      async () => {
        if (!from || !text) {
          if (from) await sendWhatsAppMessage(from, "לא קיבלתי טקסט תקין 🙏");
          return;
        }

        await handleIncomingText(from, text, metadata);
      }
    );

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", getErrorPayload(err));
    return res.sendStatus(200);
  }
});

// =======================
// Frontend endpoint: automatic waitlist notify
// =======================
app.post("/waitlist/notify", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    const businessName = String(body.businessName || "").trim();
    const date = String(body.date || "").trim();
    const time = String(body.time || "").trim();
    // מקור אמת אחד: השרת מחפש בעצמו את רשימת ההמתנה לפי businessId + date.
    // לא מקבלים יותר entries/message/phone מהאפליקציה, כדי למנוע שליחה לבוט/בעל העסק בטעות.

    if (!businessId || !date || !isValidTime(time)) {
      return res.status(400).json({ ok: false, error: "missing_business_date_or_time" });
    }

    const business = await getBusinessSettings(businessId);
    if (isWhatsappBotDisabled(business)) {
      return res.status(200).json({
        ok: true,
        sent: 0,
        failed: 0,
        totalRecipients: 0,
        message: "whatsapp_bot_disabled",
      });
    }

    const finalBusinessName = businessName || business?.businessName || business?.name || "העסק";

    const candidates = await getWaitingEntriesForDate(businessId, date);

    const waiting = candidates
      .map((entry) => normalizeWaitlistEntry(entry))
      .filter((entry) => normalizePhone(entry.phone))
      .filter((entry) => String(entry.status || "ממתין") === "ממתין");

    if (!waiting.length) {
      return res.status(200).json({ ok: true, sent: 0, failed: 0, totalRecipients: 0, message: "no_waiting_entries" });
    }

    const offerToken = createClaimToken();
    let sent = 0;
    let failed = 0;
    const results = [];

    for (const entry of waiting) {
      try {
        const phone = getWaitlistRecipientPhone(entry, business);
        if (!phone) throw new Error("invalid_waitlist_recipient");

        const waitlistId = entry.id || entry.waitlistId || "";
        const claimToken = entry.claimToken || createClaimToken();
        const claimUrl = buildClaimUrl({ claimToken, offerToken, businessId }, time);

        if (waitlistId) {
          await db.collection(WAITLIST_COLLECTION).doc(waitlistId).set(
            {
              offeredTime: time,
              offerToken,
              claimToken,
              notifiedAtMs: Date.now(),
              notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        const message = buildWaitlistMessage({
          name: entry.firstName || entry.name || "",
          businessName: finalBusinessName,
          date,
          time,
          claimUrl,
        });

        if (getProtectedWhatsappNumbers(business).has(normalizePhone(phone))) {
          throw new Error("protected_waitlist_recipient_bot_number");
        }

        const apiResult = await sendWaitlistTemplateMessage(phone, {
          business,
          customerName: entry.firstName || entry.name || "לקוח",
          businessName: finalBusinessName,
          date: formatDatePrettyFromKey(date),
          time,
          claimUrl,
        });
        sent += 1;
        results.push({ phone, ok: true, claimUrl, messageId: apiResult?.messages?.[0]?.id || "" });
      } catch (err) {
        failed += 1;
        results.push({ phone: normalizePhone(entry.phone), ok: false, error: getErrorPayload(err) });
        console.error("❌ Waitlist notify failed:", getErrorPayload(err));
      }
    }

    return res.status(200).json({
      ok: sent > 0,
      sent,
      failed,
      totalRecipients: waiting.length,
      results,
    });
  } catch (err) {
    console.error("waitlist/notify error:", getErrorPayload(err));
    return res.status(500).json({ ok: false, error: getErrorPayload(err) });
  }
});

// =======================
// Main conversation logic
// =======================
async function handleIncomingText(from, rawText, metadata = {}) {
  const text = cleanText(rawText);
  const session = await getSession(from);
  const incomingPhoneNumberId = String(metadata?.phone_number_id || getWhatsappContext()?.incomingPhoneNumberId || "");

  console.log("📩 Incoming WhatsApp message", {
    from,
    text,
    incomingPhoneNumberId,
    hasSession: Boolean(session),
    sessionBusinessId: session?.businessId || "",
  });

  // Important: first allow start_<businessId> to create/link a session.
  // Only after that, if no session exists, reply with simple instructions.
  const startBusinessId = extractStartBusinessId(text);
  if (startBusinessId) {
    const business = await getBusinessSettings(startBusinessId);
    if (!business) {
      await clearSession(from);
      await sendWhatsAppMessage(from, "לא מצאתי את העסק הזה במערכת 🙏");
      return;
    }

    if (isWhatsappBotDisabled(business)) {
      await clearSession(from);
      console.log("⏸️ WhatsApp bot is disabled for business start flow", {
        businessId: startBusinessId,
        from,
      });
      return;
    }

    setWhatsappBusinessContext(business);

    await saveSession(from, {
      step: "main_menu",
      businessId: startBusinessId,
      businessName: business.businessName || business.name || "העסק",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await sendMainMenu(from, business);
    return;
  }

  if (["התחל", "התחל מחדש", "menu", "תפריט", "איפוס"].includes(text.toLowerCase())) {
    if (!session?.businessId) {
      await sendWhatsAppMessage(
        from,
        "כדי להתחיל צריך להיכנס דרך קישור העסק שקיבלת.\nלדוגמה: wa.me/...text=start_shimon"
      );
      return;
    }

    const business = await getBusinessSettings(session.businessId);
    if (!business) {
      await clearSession(from);
      await sendWhatsAppMessage(from, "העסק לא נמצא במערכת 🙏");
      return;
    }

    if (isWhatsappBotDisabled(business)) {
      await clearSession(from);
      console.log("⏸️ WhatsApp bot is disabled for business menu flow", {
        businessId: session.businessId,
        from,
      });
      return;
    }

    await saveSession(from, { step: "main_menu" });
    await sendMainMenu(from, business);
    return;
  }

  if (!session?.businessId) {
    await sendWhatsAppMessage(
      from,
      "הבוט עובד ✅\nכדי להתחיל בפעם הראשונה צריך להיכנס דרך אייקון הוואטסאפ באפליקציה של העסק."
    );
    return;
  }

  const business = await getBusinessSettings(session.businessId);
  if (!business) {
    await clearSession(from);
    await sendWhatsAppMessage(from, "העסק לא נמצא במערכת 🙏");
    return;
  }

  if (isWhatsappBotDisabled(business)) {
    await clearSession(from);
    console.log("⏸️ WhatsApp bot is disabled for existing session", {
      businessId: session.businessId,
      from,
    });
    return;
  }

  setWhatsappBusinessContext(business);

  const step = session.step || "main_menu";

  if (step === "main_menu") return handleMainMenu(from, text, business, session);
  if (step === "choose_day") return handleChooseDay(from, text, business, session);
  if (step === "choose_time") return handleChooseTime(from, text, business, session);
  if (step === "choose_service") return handleChooseService(from, text, business, session);
  if (step === "ask_name") return handleAskName(from, text, business, session);
  if (step === "cancel_select") return handleCancelSelect(from, text, business, session);
  if (step === "cancel_confirm") return handleCancelConfirm(from, text, business, session);

  await saveSession(from, { step: "main_menu" });
  await sendMainMenu(from, business);
}

async function handleMainMenu(from, text, business, session) {
  const lowered = text.toLowerCase();

  if (text === "1" || lowered.includes("קביע")) {
    const days = await getAvailableDays(business.businessId, business);
    if (!days.length) {
      await sendWhatsAppMessage(from, "כרגע אין ימים עם שעות פנויות 🙏");
      return;
    }

    await saveSession(from, { step: "choose_day", days });

    let msg = `בחר יום לקביעת תור ב${business.businessName || business.name || "העסק"}:\n\n`;
    days.forEach((d, i) => {
      msg += `${i + 1}. ${d.label} ${d.pretty}\n`;
    });
    msg += "\nשלח את מספר היום שבחרת.\n\n0. חזרה לתפריט";

    await sendWhatsAppMessage(from, msg);
    return;
  }

  if (text === "2" || lowered.includes("ביטול") || lowered.includes("לבטל")) {
    const active = await getFutureAppointmentsByPhone(business.businessId, from);
    if (!active.length) {
      await sendWhatsAppMessage(from, "לא מצאתי תור עתידי למספר הזה 🙏\n\n0. חזרה לתפריט");
      return;
    }

    await saveSession(from, { step: "cancel_select", cancelOptions: active });

    let msg = "מצאתי את התורים הבאים:\n\n";
    active.forEach((a, i) => {
      msg += `${i + 1}. ${formatDatePrettyFromKey(a.date)} בשעה ${a.time} - ${a.service || "שירות"}\n`;
    });
    msg += "\nשלח מספר תור לביטול.\n\n0. חזרה לתפריט";

    await sendWhatsAppMessage(from, msg);
    return;
  }

  if (text === "3" || lowered.includes("שעות")) {
    await sendWhatsAppMessage(from, buildHoursMessage(business));
    return;
  }

  await sendMainMenu(from, business);
}

async function handleChooseDay(from, text, business, session) {
  if (text === "0") {
    await saveSession(from, { step: "main_menu" });
    await sendMainMenu(from, business);
    return;
  }

  const index = Number(text) - 1;
  const day = session.days?.[index];

  if (!day) {
    await sendWhatsAppMessage(from, "בחירה לא תקינה 🙏 שלח מספר יום מהרשימה.");
    return;
  }

  await saveSession(from, {
    step: "choose_time",
    selectedDate: day.date,
    selectedDateLabel: `${day.label} ${day.pretty}`,
    times: day.availableTimes,
  });

  let msg = `בחר שעה ל${day.label} ${day.pretty}:\n\n`;
  day.availableTimes.forEach((time, i) => {
    msg += `${i + 1}. ${time}\n`;
  });
  msg += "\nשלח את מספר השעה שבחרת.\n\n0. חזרה לתפריט";

  await sendWhatsAppMessage(from, msg);
}

async function handleChooseTime(from, text, business, session) {
  if (text === "0") {
    await saveSession(from, { step: "main_menu" });
    await sendMainMenu(from, business);
    return;
  }

  const index = Number(text) - 1;
  const time = session.times?.[index];

  if (!time) {
    await sendWhatsAppMessage(from, "בחירה לא תקינה 🙏 שלח מספר שעה מהרשימה.");
    return;
  }

  const taken = await isSlotTaken(business.businessId, session.selectedDate, time);
  if (taken) {
    await sendWhatsAppMessage(from, "השעה הזאת נתפסה בינתיים 🙏 שלח 0 וחזור לבחור מחדש.");
    return;
  }

  const services = normalizeServices(business.services);

  await saveSession(from, { step: "choose_service", selectedTime: time, services });

  let msg = "בחר שירות:\n\n";
  services.forEach((service, i) => {
    msg += `${i + 1}. ${service.label || service.value || service.text}\n`;
  });
  msg += "\nשלח את מספר השירות.\n\n0. חזרה לתפריט";

  await sendWhatsAppMessage(from, msg);
}

async function handleChooseService(from, text, business, session) {
  if (text === "0") {
    await saveSession(from, { step: "main_menu" });
    await sendMainMenu(from, business);
    return;
  }

  const index = Number(text) - 1;
  const service = session.services?.[index];

  if (!service) {
    await sendWhatsAppMessage(from, "בחירה לא תקינה 🙏 שלח מספר שירות מהרשימה.");
    return;
  }

  await saveSession(from, {
    step: "ask_name",
    selectedService: service.label || service.value || service.text,
  });

  await sendWhatsAppMessage(
    from,
    "מעולה 👍\nשלח שם מלא לקביעת התור.\n\nלדוגמה: יוסי כהן\n\n0. חזרה לתפריט"
  );
}

async function handleAskName(from, text, business, session) {
  if (text === "0") {
    await saveSession(from, { step: "main_menu" });
    await sendMainMenu(from, business);
    return;
  }

  const name = text.trim();
  if (name.length < 2) {
    await sendWhatsAppMessage(from, "שלח שם מלא בבקשה 🙏");
    return;
  }

  const taken = await isSlotTaken(business.businessId, session.selectedDate, session.selectedTime);
  if (taken) {
    await saveSession(from, { step: "main_menu" });
    await sendWhatsAppMessage(from, "השעה נתפסה בינתיים 🙏 חזור לתפריט ובחר שעה אחרת.");
    await sendMainMenu(from, business);
    return;
  }

  await db.collection(APPOINTMENTS_COLLECTION).add({
    businessId: business.businessId,
    businessName: business.businessName || business.name || "",
    name,
    phone: normalizePhone(from),
    service: session.selectedService || "",
    date: session.selectedDate,
    time: session.selectedTime,
    status: "נקבע",
    source: "whatsapp",
    notes: "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtMs: Date.now(),
  });

  await saveSession(from, {
    step: "main_menu",
    businessId: business.businessId,
    businessName: business.businessName || business.name || "העסק",
  });

  await sendWhatsAppMessage(
    from,
    `התור נקבע בהצלחה ✅\n\n` +
      `עסק: ${business.businessName || business.name || ""}\n` +
      `שם: ${name}\n` +
      `תאריך: ${formatDatePrettyFromKey(session.selectedDate)}\n` +
      `שעה: ${session.selectedTime}\n` +
      `שירות: ${session.selectedService || ""}`
  );
}

async function handleCancelSelect(from, text, business, session) {
  if (text === "0") {
    await saveSession(from, { step: "main_menu" });
    await sendMainMenu(from, business);
    return;
  }

  const index = Number(text) - 1;
  const appointment = session.cancelOptions?.[index];

  if (!appointment) {
    await sendWhatsAppMessage(from, "בחירה לא תקינה 🙏 שלח מספר תור מהרשימה.");
    return;
  }

  await saveSession(from, { step: "cancel_confirm", cancelAppointment: appointment });

  await sendWhatsAppMessage(
    from,
    `לבטל את התור?\n\n` +
      `${formatDatePrettyFromKey(appointment.date)} בשעה ${appointment.time}\n\n` +
      `1. כן, בטל\n` +
      `2. לא, חזור לתפריט`
  );
}

async function handleCancelConfirm(from, text, business, session) {
  if (text === "1") {
    const appointment = session.cancelAppointment;
    if (!appointment?.id) {
      await clearSession(from);
      await sendWhatsAppMessage(from, "לא מצאתי את התור לביטול 🙏");
      return;
    }

    await db.collection(APPOINTMENTS_COLLECTION).doc(appointment.id).delete();
    await saveSession(from, {
      step: "main_menu",
      businessId: business.businessId,
      businessName: business.businessName || business.name || "העסק",
    });

    await sendWhatsAppMessage(
      from,
      `התור בוטל בהצלחה ✅\n${formatDatePrettyFromKey(appointment.date)} בשעה ${appointment.time}`
    );

    await notifyWaitlistForFreedSlot(business, appointment.date, appointment.time);
    return;
  }

  await saveSession(from, { step: "main_menu" });
  await sendMainMenu(from, business);
}

// =======================
// Waitlist automation
// =======================
async function notifyWaitlistForFreedSlot(business, date, time) {
  try {
    if (!business?.businessId || !date || !isValidTime(time)) return { sent: 0, failed: 0 };
    if (isWhatsappBotDisabled(business)) {
      console.log("⏸️ Waitlist notify skipped because WhatsApp bot is disabled", {
        businessId: business.businessId,
        date,
        time,
      });
      return { sent: 0, failed: 0, disabled: true };
    }

    const waiting = await getWaitingEntriesForDate(business.businessId, date);
    if (!waiting.length) {
      console.log("ℹ️ No waitlist entries for freed slot", { businessId: business.businessId, date, time });
      return { sent: 0, failed: 0 };
    }

    const offerToken = createClaimToken();
    let sent = 0;
    let failed = 0;

    for (const entry of waiting) {
      try {
        const phone = getWaitlistRecipientPhone(entry, business);
        if (!phone) throw new Error("invalid_waitlist_recipient");

        const claimToken = entry.claimToken || createClaimToken();
        const claimUrl = buildClaimUrl({ claimToken, offerToken, businessId: business.businessId }, time);

        await db.collection(WAITLIST_COLLECTION).doc(entry.id).set(
          {
            claimToken,
            offerToken,
            offeredTime: time,
            notifiedAtMs: Date.now(),
            notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        const message = buildWaitlistMessage({
          name: entry.firstName || entry.name || "",
          businessName: business.businessName || business.name || "העסק",
          date,
          time,
          claimUrl,
        });

        if (getProtectedWhatsappNumbers(business).has(normalizePhone(phone))) {
          throw new Error("protected_waitlist_recipient_bot_number");
        }

        await sendWaitlistTemplateMessage(phone, {
          business,
          customerName: entry.firstName || entry.name || "לקוח",
          businessName: business.businessName || business.name || "העסק",
          date: formatDatePrettyFromKey(date),
          time,
          claimUrl,
        });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error("❌ Auto waitlist message failed:", getErrorPayload(err));
      }
    }

    console.log("✅ Auto waitlist notify completed", {
      businessId: business.businessId,
      date,
      time,
      total: waiting.length,
      sent,
      failed,
    });

    return { sent, failed, total: waiting.length };
  } catch (err) {
    console.error("notifyWaitlistForFreedSlot error:", getErrorPayload(err));
    return { sent: 0, failed: 0, error: getErrorPayload(err) };
  }
}

async function getWaitingEntriesForDate(businessId, date) {
  const snap = await db
    .collection(WAITLIST_COLLECTION)
    .where("businessId", "==", businessId)
    .where("date", "==", date)
    .get();

  return snap.docs
    .map((doc) => normalizeWaitlistEntry({ id: doc.id, ...doc.data() }))
    .filter((entry) => String(entry.status || "ממתין") === "ממתין")
    .sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
}

function normalizeWaitlistEntry(entry) {
  const fullName =
    String(entry.name || "").trim() ||
    `${String(entry.firstName || "").trim()} ${String(entry.lastName || "").trim()}`.trim();

  const customerSource =
    entry.customerWhatsapp ||
    entry.clientWhatsapp ||
    entry.customerPhone ||
    entry.clientPhone ||
    entry.phoneDisplay ||
    entry.displayPhone ||
    entry.mobile ||
    entry.phone ||
    "";

  const customerIntl = toWhatsAppRecipient(customerSource);
  const displayPhone = whatsappToIsraeliPhone(customerIntl || customerSource);

  return {
    ...entry,
    id: entry.id || entry.waitlistId || "",
    name: fullName,
    firstName: String(entry.firstName || "").trim(),
    lastName: String(entry.lastName || "").trim(),
    phone: customerIntl,
    phoneDisplay: displayPhone,
    customerPhone: customerIntl,
    clientPhone: customerIntl,
    customerWhatsapp: customerIntl,
    clientWhatsapp: customerIntl,
    service: String(entry.service || "").trim(),
    status: String(entry.status || "ממתין").trim(),
    claimToken: String(entry.claimToken || "").trim(),
    offerToken: String(entry.offerToken || "").trim(),
    createdAtMs: Number(entry.createdAtMs || 0),
  };
}


function getCentralBotWhatsappNumber() {
  return normalizePhone(process.env.CENTRAL_BOT_WHATSAPP_NUMBER || process.env.BOT_WHATSAPP_NUMBER || "972547674814");
}

function getProtectedWhatsappNumbers(business = {}) {
  // חשוב:
  // כאן מגנים רק על מספרי בוט/שליחה, ולא על מספר הטלפון הרגיל של בעל העסק.
  // בעבר business.phone / businessPhone נכנסו לרשימת החסומים,
  // ולכן אם בעל העסק בדק כלקוח ברשימת המתנה - המספר שלו נפסל בטעות.
  const protectedNumbers = new Set([
    getCentralBotWhatsappNumber(),
    "972547674814",
    process.env.CENTRAL_BOT_WHATSAPP_NUMBER,
    process.env.BOT_WHATSAPP_NUMBER,
    business.botWhatsappNumber,
    business.centralBotNumber,
    business.centralBotWhatsappNumber,
    business.whatsappBotNumber,
    business.waBotNumber,
  ].map(normalizePhone).filter(Boolean));
  return protectedNumbers;
}

function getWaitlistRecipientPhone(entry = {}, business = {}) {
  const protectedNumbers = getProtectedWhatsappNumbers(business);

  const candidates = [
    entry.customerWhatsapp,
    entry.clientWhatsapp,
    entry.customerPhone,
    entry.clientPhone,
    entry.phoneDisplay,
    entry.displayPhone,
    entry.mobile,
    entry.phone,
  ];

  for (const candidate of candidates) {
    const normalized = toWhatsAppRecipient(candidate);
    if (!normalized) continue;

    // Never send a waitlist offer to the bot number or the business contact number.
    if (protectedNumbers.has(normalized)) {
      console.warn("⚠️ Skipping protected waitlist recipient number", {
        waitlistId: entry.id || entry.waitlistId || "",
        businessId: business.businessId || business.id || "",
        phone: normalized,
      });
      continue;
    }

    if (!/^9725\d{8}$/.test(normalized)) {
      console.warn("⚠️ Skipping invalid Israeli mobile waitlist recipient", {
        waitlistId: entry.id || entry.waitlistId || "",
        phone: normalized,
      });
      continue;
    }

    console.log("✅ Waitlist recipient selected", {
      waitlistId: entry.id || entry.waitlistId || "",
      businessId: business.businessId || business.id || "",
      phone: normalized,
    });
    return normalized;
  }

  console.warn("⚠️ No valid customer recipient found for waitlist entry", {
    waitlistId: entry.id || entry.waitlistId || "",
    businessId: business.businessId || business.id || "",
    rawPhone: entry.phone || "",
    phoneDisplay: entry.phoneDisplay || "",
    customerPhone: entry.customerPhone || "",
    customerWhatsapp: entry.customerWhatsapp || "",
  });
  return "";
}

function buildClaimUrl(entry, time) {
  const url = new URL(APP_BASE_URL);
  if (entry.businessId) url.searchParams.set("business", entry.businessId);
  url.searchParams.set("claimWaitlist", entry.claimToken);
  url.searchParams.set("time", time);
  if (entry.offerToken) url.searchParams.set("offer", entry.offerToken);
  return url.toString();
}

function buildWaitlistMessage({ name, businessName, date, time, claimUrl }) {
  const cleanName = String(name || "").trim();
  const hello = cleanName ? `שלום ${cleanName},` : "שלום,";
  return (
    `${hello}\n` +
    `התפנה תור ב${businessName || "העסק"} ✅\n\n` +
    `תאריך: ${formatDatePrettyFromKey(date)}\n` +
    `שעה: ${time}\n\n` +
    `לאישור התור לחץ כאן:\n${claimUrl}\n\n` +
    `הראשון שמאשר מקבל את התור.`
  );
}

// =======================
// Menu messages
// =======================
async function sendMainMenu(from, business) {
  const name = business.businessName || business.name || "העסק";

  const msg =
    `שלום 👋\n` +
    `ברוך הבא ל${name}\n\n` +
    `בחר פעולה:\n` +
    `1. קביעת תור\n` +
    `2. ביטול תור\n` +
    `3. שעות פתיחה\n\n` +
    `שלח מספר פעולה.`;

  await sendWhatsAppMessage(from, msg);
}

// =======================
// Business data
// =======================
async function getBusinessSettings(businessId) {
  if (!businessId) return null;

  const doc = await db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId).get();
  if (!doc.exists) return null;

  const data = doc.data() || {};
  return {
    ...data,
    businessId: data.businessId || businessId,
    workingHours: normalizeWorkingHours(data.workingHours),
    services: normalizeServices(data.services),
  };
}

async function getBusinessByPhoneNumberId(phoneNumberId) {
  const id = String(phoneNumberId || "").trim();
  if (!id) return null;

  const fields = ["whatsappPhoneNumberId", "phoneNumberId", "waPhoneNumberId"];
  for (const field of fields) {
    const snap = await db.collection(BUSINESS_SETTINGS_COLLECTION).where(field, "==", id).limit(1).get();
    if (!snap.empty) {
      const doc = snap.docs[0];
      const data = doc.data() || {};
      return {
        ...data,
        businessId: data.businessId || doc.id,
        workingHours: normalizeWorkingHours(data.workingHours),
        services: normalizeServices(data.services),
      };
    }
  }

  return null;
}

function normalizeWorkingHours(hours) {
  const output = {};
  for (const key of dayKeys) {
    output[key] = {
      ...(DEFAULT_WORKING_HOURS[key] || { start: "", end: "", closed: true }),
      ...((hours && hours[key]) || {}),
    };
  }
  return output;
}

function normalizeServices(services) {
  if (!Array.isArray(services) || !services.length) return DEFAULT_SERVICES;

  const cleaned = services
    .map((s) => {
      const text = String(s?.text || s?.label || s?.value || "").trim();
      const price = String(s?.price || "").trim();
      const label = s?.label || s?.value || (price ? `${text} - ₪${price}` : text);
      return { text, price, label, value: label };
    })
    .filter((s) => s.text || s.label);

  return cleaned.length ? cleaned : DEFAULT_SERVICES;
}

// =======================
// Days and slots
// =======================
async function getAvailableDays(businessId, business) {
  const days = [];
  const now = new Date();

  for (let offset = 0; offset < 14 && days.length < MAX_DAYS_TO_SHOW; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const dateKey = formatDateKey(date);
    const allSlots = getSlotsForDate(date, business);
    if (!allSlots.length) continue;

    const taken = await getTakenSlotsForDate(businessId, dateKey);
    const availableTimes = allSlots.filter((time) => {
      if (taken.includes(time)) return false;
      if (isPastSlot(date, time)) return false;
      return true;
    });

    if (!availableTimes.length) continue;

    days.push({
      date: dateKey,
      label: getDayLabel(date, now),
      pretty: formatDatePretty(date),
      availableTimes,
    });
  }

  return days;
}

function getSlotsForDate(date, business) {
  const dayKey = dayKeys[date.getDay()];
  const cfg = business.workingHours?.[dayKey];

  if (!cfg || cfg.closed) return [];
  if (!isValidTime(cfg.start) || !isValidTime(cfg.end)) return [];

  const start = timeToMinutes(cfg.start);
  const end = timeToMinutes(cfg.end);
  if (end < start) return [];

  const slots = [];
  for (let m = start; m <= end; m += SLOT_STEP_MINUTES) {
    slots.push(minutesToTime(m));
  }

  return slots;
}

async function getTakenSlotsForDate(businessId, dateKey) {
  const snap = await db
    .collection(APPOINTMENTS_COLLECTION)
    .where("businessId", "==", businessId)
    .where("date", "==", dateKey)
    .get();

  return snap.docs
    .map((d) => d.data())
    .filter((a) => isActiveAppointment(a))
    .map((a) => a.time)
    .filter(Boolean);
}

async function isSlotTaken(businessId, dateKey, time) {
  const snap = await db
    .collection(APPOINTMENTS_COLLECTION)
    .where("businessId", "==", businessId)
    .where("date", "==", dateKey)
    .where("time", "==", time)
    .get();

  return snap.docs.some((d) => isActiveAppointment(d.data()));
}

// =======================
// Cancel appointments
// =======================
async function getFutureAppointmentsByPhone(businessId, whatsappPhone) {
  const phone = whatsappToIsraeliPhone(whatsappPhone);

  const snap = await db.collection(APPOINTMENTS_COLLECTION).where("businessId", "==", businessId).get();

  return snap.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((a) => isActiveAppointment(a))
    .filter((a) => normalizePhone(a.phone) === normalizePhone(phone))
    .filter((a) => appointmentDateTime(a) >= new Date())
    .sort((a, b) => appointmentDateTime(a) - appointmentDateTime(b))
    .slice(0, 5);
}

function isActiveAppointment(a) {
  const status = String(a?.status || "").toLowerCase();
  return !["cancelled", "canceled", "בוטל"].includes(status);
}

// =======================
// Sessions
// =======================
async function getSession(from) {
  const doc = await db.collection(SESSIONS_COLLECTION).doc(from).get();
  return doc.exists ? doc.data() : null;
}

async function saveSession(from, data) {
  await db.collection(SESSIONS_COLLECTION).doc(from).set(
    {
      ...data,
      phone: from,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

async function clearSession(from) {
  await db.collection(SESSIONS_COLLECTION).doc(from).delete().catch(() => {});
}

// =======================
// WhatsApp API - text messages + waitlist templates
// =======================

async function sendWaitlistTemplateMessage(to, data = {}) {
  const activeBusiness = data.business || getWhatsappContext()?.business || null;

  if (activeBusiness && isWhatsappBotDisabled(activeBusiness)) {
    console.log("⏸️ Waitlist template skipped because bot is disabled", {
      businessId: activeBusiness.businessId || activeBusiness.id || "",
      to,
    });
    return null;
  }

  const config = resolveWhatsAppConfig(activeBusiness, { waitlistMessage: true });

  if (!config.token || !config.phoneNumberId) {
    console.error("Missing WhatsApp token or phoneNumberId for waitlist template", {
      mode: config.mode,
      businessId: config.businessId || "",
      hasToken: Boolean(config.token),
      hasPhoneNumberId: Boolean(config.phoneNumberId),
    });
    return null;
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) throw new Error("invalid_whatsapp_recipient");

  const url = `https://graph.facebook.com/v25.0/${config.phoneNumberId}/messages`;

  const params = [
    String(data.customerName || "לקוח"),
    String(data.businessName || "העסק"),
    String(data.date || ""),
    String(data.time || ""),
    String(data.claimUrl || ""),
  ];

  console.log("➡️ Sending waitlist TEMPLATE", {
    to: recipient,
    mode: config.mode,
    businessId: config.businessId || "",
    phoneNumberId: config.phoneNumberId,
    template: WAITLIST_TEMPLATE_NAME,
    language: WAITLIST_TEMPLATE_LANGUAGE,
    paramsPreview: params,
  });

  let response;
  try {
    response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: {
          name: WAITLIST_TEMPLATE_NAME,
          language: { code: WAITLIST_TEMPLATE_LANGUAGE },
          components: [
            {
              type: "body",
              parameters: params.map((value) => ({
                type: "text",
                text: value,
              })),
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("❌ Waitlist template send failed", {
      to: recipient,
      mode: config.mode,
      businessId: config.businessId || "",
      phoneNumberId: config.phoneNumberId,
      template: WAITLIST_TEMPLATE_NAME,
      language: WAITLIST_TEMPLATE_LANGUAGE,
      error: getErrorPayload(err),
    });
    throw err;
  }

  console.log("✅ Waitlist template sent", {
    to: recipient,
    mode: config.mode,
    businessId: config.businessId || "",
    phoneNumberId: config.phoneNumberId,
    messageId: response.data?.messages?.[0]?.id || "",
  });

  return response.data;
}

async function sendWhatsAppMessage(to, body, options = {}) {
  const activeBusiness = options.business || getWhatsappContext()?.business || null;
  if (activeBusiness && isWhatsappBotDisabled(activeBusiness)) {
    console.log("⏸️ WhatsApp message skipped because bot is disabled", {
      businessId: activeBusiness.businessId || activeBusiness.id || "",
      to,
      preview: String(body || "").slice(0, 120),
    });
    return null;
  }

  const config = resolveWhatsAppConfig(activeBusiness, options);

  if (!config.token || !config.phoneNumberId) {
    console.error("Missing WhatsApp token or phoneNumberId", {
      mode: config.mode,
      businessId: config.businessId || "",
      hasToken: Boolean(config.token),
      hasPhoneNumberId: Boolean(config.phoneNumberId),
    });
    return null;
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) throw new Error("invalid_whatsapp_recipient");

  const url = `https://graph.facebook.com/v25.0/${config.phoneNumberId}/messages`;

  console.log("➡️ Sending WhatsApp text", {
    to: recipient,
    mode: config.mode,
    businessId: config.businessId || "",
    phoneNumberId: config.phoneNumberId,
    hasToken: Boolean(config.token),
    preview: String(body || "").slice(0, 120),
  });

  let response;
  try {
    response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: {
          preview_url: true,
          body: String(body || ""),
        },
      },
      {
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("❌ WhatsApp send failed", {
      to: recipient,
      mode: config.mode,
      businessId: config.businessId || "",
      phoneNumberId: config.phoneNumberId,
      error: getErrorPayload(err),
    });
    throw err;
  }

  console.log("✅ WhatsApp text sent", {
    to: recipient,
    mode: config.mode,
    businessId: config.businessId || "",
    phoneNumberId: config.phoneNumberId,
    messageId: response.data?.messages?.[0]?.id || "",
    preview: String(body || "").slice(0, 160),
  });

  return response.data;
}

function getWhatsappContext() {
  return whatsappContext.getStore() || null;
}

function setWhatsappBusinessContext(business) {
  const store = getWhatsappContext();
  if (!store || !business) return;
  store.business = business;
  store.businessId = business.businessId || business.id || "";
}

function resolveWhatsAppConfig(business, options = {}) {
  const store = getWhatsappContext() || {};
  const activeBusiness = business || store.business || null;
  const mode = getWhatsappBotMode(activeBusiness);

  if (mode === "private") {
    return {
      mode: "private",
      businessId: activeBusiness?.businessId || activeBusiness?.id || store.businessId || "",
      phoneNumberId: String(
        activeBusiness?.whatsappPhoneNumberId ||
        activeBusiness?.phoneNumberId ||
        activeBusiness?.waPhoneNumberId ||
        ""
      ).trim(),
      token: String(
        activeBusiness?.whatsappAccessToken ||
        activeBusiness?.accessToken ||
        activeBusiness?.waAccessToken ||
        ""
      ).trim(),
    };
  }

  return {
    mode: "central",
    businessId: activeBusiness?.businessId || activeBusiness?.id || store.businessId || "",
    phoneNumberId: String(PHONE_NUMBER_ID || store.incomingPhoneNumberId || "").trim(),
    token: String(WHATSAPP_TOKEN || "").trim(),
  };
}

function extractMessageText(message) {
  if (message?.type === "text") return message.text?.body || "";
  if (message?.type === "button") return message.button?.text || message.button?.payload || "";
  if (message?.type === "interactive") {
    return (
      message.interactive?.button_reply?.id ||
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.id ||
      message.interactive?.list_reply?.title ||
      ""
    );
  }
  return "";
}

// =======================
// Helpers
// =======================

function getWhatsappBotMode(business) {
  const explicit = String(
    business?.whatsappBotMode ||
    business?.whatsappMode ||
    business?.waMode ||
    ""
  ).trim().toLowerCase();

  // New 3-mode system from business-manager:
  // regular = no bot, bot = central bot number, owner = business-owned WhatsApp Cloud number.
  if (["regular", "רגיל", "off", "none", "no", "disabled", "כבוי"].includes(explicit)) return "off";
  if (["bot", "central", "בוט"].includes(explicit)) return "central";
  if (["owner", "private", "business", "בעל עסק"].includes(explicit)) return "private";

  const legacyEnabled = business?.whatsappEnabled ?? business?.whatsappBotEnabled ?? business?.botEnabled ?? business?.waBotEnabled;
  if (legacyEnabled === false || legacyEnabled === 0) return "off";

  const legacyText = String(legacyEnabled ?? "").trim().toLowerCase();
  if (["false", "0", "off", "regular", "רגיל", "כבוי", "disabled", "no"].includes(legacyText)) return "off";

  const fallbackMode = String(DEFAULT_WHATSAPP_MODE || "central").trim().toLowerCase();
  if (["owner", "private", "business"].includes(fallbackMode)) return "private";
  if (["regular", "off", "none"].includes(fallbackMode)) return "off";
  return "central";
}

function isWhatsappBotDisabled(business) {
  return getWhatsappBotMode(business) === "off";
}

function extractStartBusinessId(text) {
  const match = String(text || "").trim().match(/^start[_\s-]+([a-z0-9_-]+)$/i);
  return match ? cleanBusinessId(match[1]) : "";
}

function cleanBusinessId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function cleanText(text) {
  return String(text || "").trim();
}

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");

  // Fix common Israeli mobile formats for WhatsApp Cloud API:
  // 0523971954  -> 972523971954
  // 523971954   -> 972523971954
  // 972523971954 stays as-is
  // 9720523971954 -> 972523971954
  if (!digits) return "";
  if (digits.startsWith("9720")) return `972${digits.slice(4)}`;
  if (digits.startsWith("972")) return digits;
  if (digits.startsWith("0")) return `972${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith("5")) return `972${digits}`;
  return digits;
}

function toWhatsAppRecipient(phone) {
  const digits = normalizePhone(phone);
  if (!digits) return "";
  if (digits.startsWith("972") && digits.length >= 11) return digits;
  return digits;
}

function whatsappToIsraeliPhone(whatsappPhone) {
  const digits = normalizePhone(whatsappPhone);
  if (digits.startsWith("972")) return "0" + digits.slice(3);
  return digits;
}

function isValidTime(time) {
  return /^\d{2}:\d{2}$/.test(String(time || ""));
}

function timeToMinutes(time) {
  const [h, m] = String(time).split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDatePretty(date) {
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function formatDatePrettyFromKey(dateKey) {
  const [y, m, d] = String(dateKey || "").split("-");
  if (!y || !m || !d) return dateKey || "";
  return `${d}/${m}/${y}`;
}

function getDayLabel(date, now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const current = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((current - base) / 86400000);
  if (diff === 0) return "היום";
  if (diff === 1) return "מחר";
  return "יום " + dayNames[date.getDay()];
}

function isPastSlot(date, time) {
  const [h, m] = String(time).split(":").map(Number);
  const slotDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h || 0, m || 0);
  return slotDate < new Date();
}

function appointmentDateTime(a) {
  const [y, mo, d] = String(a.date || "").split("-").map(Number);
  const [h, mi] = String(a.time || "").split(":").map(Number);
  return new Date(y || 2000, (mo || 1) - 1, d || 1, h || 0, mi || 0);
}

function buildHoursMessage(business) {
  let msg = `שעות פתיחה - ${business.businessName || business.name || "העסק"}:\n\n`;

  for (let i = 0; i < dayKeys.length; i++) {
    const key = dayKeys[i];
    const cfg = business.workingHours?.[key];

    if (!cfg || cfg.closed || !cfg.start || !cfg.end) {
      msg += `${dayNames[i]}: סגור\n`;
    } else {
      msg += `${dayNames[i]}: ${cfg.start} - ${cfg.end}\n`;
    }
  }

  msg += "\n0. חזרה לתפריט";
  return msg;
}

function createClaimToken() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function getErrorPayload(err) {
  return err?.response?.data || err?.message || String(err);
}

app.get("/debug/whatsapp", async (req, res) => {
  res.status(200).json({
    ok: true,
    hasWhatsappToken: Boolean(WHATSAPP_TOKEN),
    centralPhoneNumberId: PHONE_NUMBER_ID || "",
    verifyToken: VERIFY_TOKEN ? "configured" : "missing",
    defaultWhatsappMode: DEFAULT_WHATSAPP_MODE,
    appBaseUrl: APP_BASE_URL,
    centralBotWhatsappNumber: getCentralBotWhatsappNumber(),
    waitlistTemplateName: WAITLIST_TEMPLATE_NAME,
    waitlistTemplateLanguage: WAITLIST_TEMPLATE_LANGUAGE,
  });
});

app.get("/debug/send-test", async (req, res) => {
  try {
    const to = String(req.query.to || "").trim();
    if (!to) return res.status(400).json({ ok: false, error: "missing_to" });
    const result = await sendWhatsAppMessage(to, "בדיקת שליחה מהשרת ✅");
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: getErrorPayload(err) });
  }
});

exports.api = functions.https.onRequest(app);

if (require.main === module) {
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log(`WhatsApp API listening on ${port}`));
}
