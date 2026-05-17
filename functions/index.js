// V3 REAL FIX: waitlist cleanup + existing appointment choice support
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
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

const WHATSAPP_TOKEN_SECRET = defineSecret("WHATSAPP_TOKEN");
const PHONE_NUMBER_ID_SECRET = defineSecret("PHONE_NUMBER_ID");
const VERIFY_TOKEN_SECRET = defineSecret("VERIFY_TOKEN");
const APP_BASE_URL_SECRET = defineSecret("APP_BASE_URL");

function getWhatsappToken() {
  return String(WHATSAPP_TOKEN_SECRET.value() || process.env.WHATSAPP_TOKEN || "").trim();
}

function getPhoneNumberId() {
  return String(PHONE_NUMBER_ID_SECRET.value() || process.env.PHONE_NUMBER_ID || "").trim();
}

function getVerifyToken() {
  return String(VERIFY_TOKEN_SECRET.value() || process.env.VERIFY_TOKEN || "gal_verify_token").trim();
}

function getAppBaseUrl() {
  return String(APP_BASE_URL_SECRET.value() || process.env.APP_BASE_URL || "https://gal-business-system.web.app/").trim();
}

const DEFAULT_WHATSAPP_MODE = process.env.DEFAULT_WHATSAPP_MODE || "central";
const WAITLIST_TEMPLATE_NAME = process.env.WAITLIST_TEMPLATE_NAME || "waitlist_slot_available";
const WAITLIST_TEMPLATE_LANGUAGE = process.env.WAITLIST_TEMPLATE_LANGUAGE || "he";

console.log("✅ WhatsApp secrets configured for runtime", {
  whatsappTokenSecret: "WHATSAPP_TOKEN",
  phoneNumberIdSecret: "PHONE_NUMBER_ID",
  verifyTokenSecret: "VERIFY_TOKEN",
  appBaseUrlSecret: "APP_BASE_URL",
});

const BUSINESS_SETTINGS_COLLECTION = "businessSettings";
const APPOINTMENTS_COLLECTION = "appointments";
const WAITLIST_COLLECTION = "waitlist";
const WAITLIST_CLAIMS_COLLECTION = "waitlistClaims";
const SESSIONS_COLLECTION = "wa_sessions";

const SLOT_STEP_MINUTES = 30;
const MAX_DAYS_TO_SHOW = 7;
const WAITLIST_CLAIM_TTL_MS = 10 * 60 * 1000; // 10 דקות לתפיסת תור מרשימת המתנה

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

  if (mode === "subscribe" && token === getVerifyToken()) {
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
// Frontend endpoint: create appointment
// =======================
app.post("/appointments/create", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    const name = String(body.name || "").trim();
    const phoneDisplay = whatsappToIsraeliPhone(body.phone || "");
    const service = String(body.service || "").trim();
    const date = String(body.date || "").trim();
    const time = String(body.time || "").trim();
    const notes = String(body.notes || "").trim();
    const source = String(body.source || "אפליקציה").trim() || "אפליקציה";
    const forceCreate = body.forceCreate === true;
    const replaceExisting = body.replaceExisting === true;
    const existingAppointmentId = String(body.existingAppointmentId || "").trim();

    if (!businessId || !name || !phoneDisplay || !service || !date || !isValidTime(time)) {
      return res.status(400).json({ ok: false, error: "missing_required_fields", message: "חסרים פרטים לקביעת התור" });
    }

    if (!/^05\d{8}$/.test(phoneDisplay)) {
      return res.status(400).json({ ok: false, error: "invalid_phone", message: "יש להזין מספר פלאפון מלא שמתחיל ב-05" });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "invalid_date", message: "תאריך לא תקין" });
    }

    const business = await getBusinessSettings(businessId);
    if (!business) {
      return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });
    }

    if (business.appFrozen === true || business.isFrozen === true || business.active === false) {
      return res.status(403).json({ ok: false, error: "business_frozen", message: "האפליקציה לא פעילה כרגע" });
    }

    const dateObj = parseDateKeyToDate(date);
    if (!dateObj) {
      return res.status(400).json({ ok: false, error: "invalid_date", message: "תאריך לא תקין" });
    }

    const validSlots = getSlotsForDate(dateObj, business);
    if (!validSlots.includes(time) || isPastSlot(dateObj, time)) {
      return res.status(409).json({ ok: false, error: "outside_working_hours", message: "השעה שנבחרה לא זמינה" });
    }

    const normalizedPhone = normalizePhone(phoneDisplay);
    const appointmentRef = db.collection(APPOINTMENTS_COLLECTION).doc();

    await db.runTransaction(async (tx) => {
      const slotQuery = db.collection(APPOINTMENTS_COLLECTION)
        .where("businessId", "==", businessId)
        .where("date", "==", date)
        .where("time", "==", time);

      const slotSnap = await tx.get(slotQuery);
      const slotTaken = slotSnap.docs.some((doc) => isActiveAppointment(doc.data() || {}));
      if (slotTaken) throw new Error("slot_taken");

      const businessAppointmentsQuery = db.collection(APPOINTMENTS_COLLECTION)
        .where("businessId", "==", businessId);
      const businessAppointmentsSnap = await tx.get(businessAppointmentsQuery);
      const duplicateFuture = businessAppointmentsSnap.docs
        .map((doc) => ({ id: doc.id, ...doc.data() }))
        .find((appt) => {
          if (!isActiveAppointment(appt)) return false;
          if (normalizePhone(appt.phone) !== normalizedPhone) return false;
          if (replaceExisting && existingAppointmentId && appt.id === existingAppointmentId) return false;
          return appointmentDateTime(appt) >= new Date();
        });

      if (duplicateFuture && !forceCreate && !replaceExisting) {
        const duplicateError = new Error("duplicate_future_appointment");
        duplicateError.existingAppointment = {
          id: duplicateFuture.id,
          date: duplicateFuture.date || "",
          datePretty: formatDatePrettyFromKey(duplicateFuture.date || ""),
          time: duplicateFuture.time || "",
          service: duplicateFuture.service || "",
        };
        throw duplicateError;
      }

      if (replaceExisting) {
        const idToReplace = existingAppointmentId || duplicateFuture?.id || "";
        if (!idToReplace) throw new Error("existing_appointment_not_found");
        const existingRef = db.collection(APPOINTMENTS_COLLECTION).doc(idToReplace);
        const existingSnap = await tx.get(existingRef);
        if (!existingSnap.exists) throw new Error("existing_appointment_not_found");
        const existingData = existingSnap.data() || {};
        if (String(existingData.businessId || "") !== businessId) throw new Error("existing_appointment_mismatch");
        if (normalizePhone(existingData.phone || "") !== normalizedPhone) throw new Error("existing_appointment_mismatch");
        tx.delete(existingRef);
      }

      tx.set(appointmentRef, {
        businessId,
        businessName: business.businessName || business.name || String(body.businessName || ""),
        name,
        phone: phoneDisplay,
        service,
        date,
        time,
        status: "נקבע",
        source,
        notes,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtMs: Date.now(),
      });
    });

    await db.collection("logs").add({
      businessId,
      type: "appointment_created",
      source,
      appointmentId: appointmentRef.id,
      phone: phoneDisplay,
      date,
      time,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    }).catch((err) => console.warn("appointment log failed", getErrorPayload(err)));

    await removeMatchingWaitlistEntries({
      businessId,
      date,
      phone: phoneDisplay,
      appointmentId: appointmentRef.id,
      source: "appointment_created",
    });

    return res.status(200).json({
      ok: true,
      appointmentId: appointmentRef.id,
      appointment: { id: appointmentRef.id, businessId, name, phone: phoneDisplay, service, date, time, status: "נקבע", source },
      message: "התור נשמר בהצלחה",
    });
  } catch (err) {
    const payload = getErrorPayload(err);
    const code = String(err?.message || payload || "create_appointment_failed");
    const status = ["slot_taken", "duplicate_future_appointment", "outside_working_hours", "existing_appointment_not_found", "existing_appointment_mismatch"].includes(code) ? 409 : 500;
    const messages = {
      slot_taken: "השעה הזו כבר נתפסה",
      duplicate_future_appointment: "נמצא תור קיים - יש לבחור החלפה או תור נוסף",
      outside_working_hours: "השעה שנבחרה לא זמינה",
      existing_appointment_not_found: "התור הקודם לא נמצא",
      existing_appointment_mismatch: "התור הקודם לא תואם למספר הזה",
    };
    console.error("appointments/create error:", payload);
    return res.status(status).json({ 
      ok: false, 
      error: code, 
      existingAppointment: err?.existingAppointment || null,
      message: messages[code] || "שגיאה בשמירת התור" 
    });
  }

});


// =======================
// Frontend endpoint: cancel appointment + automatic waitlist notify
// =======================
app.post("/appointments/cancel", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    const appointmentId = String(body.appointmentId || body.id || "").trim();
    const source = String(body.source || "app").trim() || "app";
    const shouldNotifyWaitlist = body.notifyWaitlist !== false;

    if (!businessId || !appointmentId) {
      return res.status(400).json({
        ok: false,
        error: "missing_business_or_appointment",
        message: "חסרים פרטים לביטול התור",
      });
    }

    const appointmentRef = db.collection(APPOINTMENTS_COLLECTION).doc(appointmentId);
    const appointmentSnap = await appointmentRef.get();

    if (!appointmentSnap.exists) {
      return res.status(404).json({
        ok: false,
        error: "appointment_not_found",
        message: "התור לא נמצא",
      });
    }

    const appointment = { id: appointmentSnap.id, ...appointmentSnap.data() };

    if (String(appointment.businessId || "") !== businessId) {
      return res.status(403).json({
        ok: false,
        error: "business_mismatch",
        message: "התור לא שייך לעסק הזה",
      });
    }

    if (!isActiveAppointment(appointment)) {
      return res.status(409).json({
        ok: false,
        error: "appointment_already_cancelled",
        message: "התור כבר בוטל",
      });
    }

    const business = await getBusinessSettings(businessId);
    if (!business) {
      return res.status(404).json({
        ok: false,
        error: "business_not_found",
        message: "העסק לא נמצא",
      });
    }

    await appointmentRef.delete();

    await db.collection("logs").add({
      businessId,
      type: "appointment_cancelled",
      source,
      appointmentId,
      phone: appointment.phone || "",
      date: appointment.date || "",
      time: appointment.time || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    }).catch((err) => console.warn("appointment cancel log failed", getErrorPayload(err)));

    let waitlist = null;
    if (shouldNotifyWaitlist && appointment.date && appointment.time) {
      waitlist = await notifyWaitlistForFreedSlot(business, appointment.date, appointment.time);
    }

    return res.status(200).json({
      ok: true,
      appointmentId,
      freedDate: appointment.date || "",
      freedTime: appointment.time || "",
      waitlist,
      message: "התור בוטל בהצלחה",
    });
  } catch (err) {
    const payload = getErrorPayload(err);
    console.error("appointments/cancel error:", payload);
    return res.status(500).json({
      ok: false,
      error: "cancel_appointment_failed",
      message: "שגיאה בביטול התור",
      details: payload,
    });
  }
});

// =======================
// Frontend endpoint: join waitlist
// =======================
app.post("/waitlist/join", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const name = String(body.name || `${firstName} ${lastName}`).trim();
    const phoneDisplay = whatsappToIsraeliPhone(body.phone || "");
    const phoneIntl = toWhatsAppRecipient(phoneDisplay);
    const service = String(body.service || "לא נבחר").trim() || "לא נבחר";
    const date = String(body.date || "").trim();

    if (!businessId || !firstName || !lastName || !phoneDisplay || !date) {
      return res.status(400).json({ ok: false, error: "missing_required_fields", message: "יש למלא שם, שם משפחה ופלאפון" });
    }

    if (!/^05\d{8}$/.test(phoneDisplay)) {
      return res.status(400).json({ ok: false, error: "invalid_phone", message: "יש להזין מספר פלאפון מלא שמתחיל ב-05" });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseDateKeyToDate(date)) {
      return res.status(400).json({ ok: false, error: "invalid_date", message: "תאריך לא תקין" });
    }

    const business = await getBusinessSettings(businessId);
    if (!business) {
      return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });
    }

    if (business.appFrozen === true || business.isFrozen === true || business.active === false) {
      return res.status(403).json({ ok: false, error: "business_frozen", message: "האפליקציה לא פעילה כרגע" });
    }

    const normalizedPhone = normalizePhone(phoneDisplay);
    const existingSnap = await db.collection(WAITLIST_COLLECTION)
      .where("businessId", "==", businessId)
      .where("date", "==", date)
      .get();

    const existing = existingSnap.docs.find((doc) => {
      const entry = normalizeWaitlistEntry({ id: doc.id, ...doc.data() });
      return normalizePhone(entry.phone) === normalizedPhone && String(entry.status || "ממתין") === "ממתין";
    });

    if (existing) {
      const existingEntry = normalizeWaitlistEntry({ id: existing.id, ...existing.data() });
      return res.status(200).json({
        ok: true,
        duplicate: true,
        waitlistId: existing.id,
        entry: existingEntry,
        message: "הלקוח כבר נמצא ברשימת ההמתנה לתאריך הזה",
      });
    }

    const waitlistRef = db.collection(WAITLIST_COLLECTION).doc();
    const claimToken = createClaimToken();
    const entry = {
      businessId,
      businessName: business.businessName || business.name || String(body.businessName || ""),
      firstName,
      lastName,
      name,
      phone: phoneDisplay,
      phoneDisplay,
      customerPhone: phoneDisplay,
      clientPhone: phoneDisplay,
      customerWhatsapp: phoneIntl,
      clientWhatsapp: phoneIntl,
      service,
      date,
      claimToken,
      offerToken: "",
      offeredTime: "",
      status: "ממתין",
      createdAtMs: Date.now(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await waitlistRef.set(entry);

    await db.collection("logs").add({
      businessId,
      type: "waitlist_joined",
      waitlistId: waitlistRef.id,
      phone: phoneDisplay,
      date,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    }).catch((err) => console.warn("waitlist log failed", getErrorPayload(err)));

    return res.status(200).json({
      ok: true,
      waitlistId: waitlistRef.id,
      entry: { id: waitlistRef.id, ...entry },
      message: "נכנסת לרשימת ההמתנה",
    });
  } catch (err) {
    const payload = getErrorPayload(err);
    console.error("waitlist/join error:", payload);
    return res.status(500).json({ ok: false, error: "waitlist_join_failed", message: "שגיאה בשמירת רשימת ההמתנה" });
  }
});



// =======================
// Frontend endpoint: delete waitlist entry
// =======================
app.post("/waitlist/delete", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    const waitlistId = String(body.waitlistId || body.id || "").trim();

    if (!businessId || !waitlistId) {
      return res.status(400).json({
        ok: false,
        error: "missing_business_or_waitlist_id",
        message: "חסרים פרטים למחיקת הממתין",
      });
    }

    const waitlistRef = db.collection(WAITLIST_COLLECTION).doc(waitlistId);
    const waitlistSnap = await waitlistRef.get();

    if (!waitlistSnap.exists) {
      return res.status(404).json({
        ok: false,
        error: "waitlist_not_found",
        message: "הממתין לא נמצא",
      });
    }

    const entry = waitlistSnap.data() || {};
    if (String(entry.businessId || "") !== businessId) {
      return res.status(403).json({
        ok: false,
        error: "business_mismatch",
        message: "הממתין לא שייך לעסק הזה",
      });
    }

    await waitlistRef.delete();

    await db.collection("logs").add({
      businessId,
      type: "waitlist_deleted",
      waitlistId,
      phone: entry.phone || entry.phoneDisplay || entry.customerPhone || "",
      date: entry.date || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    }).catch((err) => console.warn("waitlist delete log failed", getErrorPayload(err)));

    return res.status(200).json({
      ok: true,
      waitlistId,
      message: "הממתין נמחק בהצלחה",
    });
  } catch (err) {
    const payload = getErrorPayload(err);
    console.error("waitlist/delete error:", payload);
    return res.status(500).json({
      ok: false,
      error: "waitlist_delete_failed",
      message: "שגיאה במחיקת הממתין",
      details: payload,
    });
  }
});

// =======================
// Manager endpoints: business status and deletion
// =======================
app.post("/businesses/freeze", async (req, res) => {
  try {
    const businessId = cleanBusinessId(req.body?.businessId || "");
    const frozen = Boolean(req.body?.frozen);
    if (!businessId) return res.status(400).json({ ok: false, error: "missing_business_id", message: "חסר מזהה עסק" });

    const ref = db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });

    const payload = {
      isFrozen: frozen,
      appFrozen: frozen,
      active: !frozen,
      status: frozen ? "frozen" : "active",
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (frozen) {
      payload.frozenMessage = "האפליקציה לא פעילה כעת. עמכם הסליחה.";
      payload.frozenAtMs = Date.now();
    } else {
      payload.frozenMessage = admin.firestore.FieldValue.delete();
      payload.frozenAtMs = admin.firestore.FieldValue.delete();
    }

    await ref.set(payload, { merge: true });
    await writeManagerLog(businessId, frozen ? "business_frozen" : "business_unfrozen", { frozen });
    return res.status(200).json({ ok: true, businessId, frozen });
  } catch (err) {
    console.error("businesses/freeze error:", getErrorPayload(err));
    return res.status(500).json({ ok: false, error: "freeze_failed", message: "עדכון סטטוס העסק נכשל" });
  }
});

app.post("/businesses/owner-access", async (req, res) => {
  try {
    const businessId = cleanBusinessId(req.body?.businessId || "");
    const ownerAccess = Boolean(req.body?.ownerAccess);
    if (!businessId) return res.status(400).json({ ok: false, error: "missing_business_id", message: "חסר מזהה עסק" });

    const ref = db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });

    await ref.set({
      ownerAccess,
      clientOwnerAccess: ownerAccess,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await writeManagerLog(businessId, ownerAccess ? "owner_access_opened" : "owner_access_closed", { ownerAccess });
    return res.status(200).json({ ok: true, businessId, ownerAccess });
  } catch (err) {
    console.error("businesses/owner-access error:", getErrorPayload(err));
    return res.status(500).json({ ok: false, error: "owner_access_failed", message: "עדכון גישת בעל עסק נכשל" });
  }
});

app.post("/businesses/whatsapp", async (req, res) => {
  try {
    const businessId = cleanBusinessId(req.body?.businessId || "");
    const mode = String(req.body?.mode || "off").trim().toLowerCase();
    if (!businessId) return res.status(400).json({ ok: false, error: "missing_business_id", message: "חסר מזהה עסק" });
    if (!["off", "central", "private"].includes(mode)) return res.status(400).json({ ok: false, error: "invalid_mode", message: "מצב וואטסאפ לא תקין" });

    const ref = db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });

    await ref.set({
      whatsappBotMode: mode,
      whatsappMode: mode,
      whatsappEnabled: mode !== "off",
      whatsappBotEnabled: mode !== "off",
      botEnabled: mode !== "off",
      waBotEnabled: mode !== "off",
      plan: mode === "off" ? "basic" : (mode === "private" ? "whatsapp-private" : "whatsapp-central"),
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await writeManagerLog(businessId, "business_whatsapp_changed", { mode });
    return res.status(200).json({ ok: true, businessId, mode });
  } catch (err) {
    console.error("businesses/whatsapp error:", getErrorPayload(err));
    return res.status(500).json({ ok: false, error: "whatsapp_update_failed", message: "עדכון וואטסאפ נכשל" });
  }
});

app.post("/businesses/delete", async (req, res) => {
  try {
    const businessId = cleanBusinessId(req.body?.businessId || "");
    const confirmBusinessId = cleanBusinessId(req.body?.confirmBusinessId || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "missing_business_id", message: "חסר מזהה עסק" });
    if (confirmBusinessId !== businessId) {
      return res.status(400).json({ ok: false, error: "delete_confirmation_mismatch", message: "אישור המחיקה לא תואם למזהה העסק" });
    }

    const businessRef = db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId);
    const businessSnap = await businessRef.get();
    if (!businessSnap.exists) return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });

    const deleted = {};
    deleted.appointments = await deleteCollectionByBusinessId(APPOINTMENTS_COLLECTION, businessId);
    deleted.waitlist = await deleteCollectionByBusinessId(WAITLIST_COLLECTION, businessId);
    deleted.waitlistClaims = await deleteCollectionByBusinessId(WAITLIST_CLAIMS_COLLECTION, businessId);
    deleted.sessions = await deleteCollectionByBusinessId(SESSIONS_COLLECTION, businessId);
    deleted.logs = await deleteCollectionByBusinessId("logs", businessId);

    await businessRef.delete();

    return res.status(200).json({ ok: true, businessId, deleted, message: "העסק וכל הנתונים הנלווים נמחקו" });
  } catch (err) {
    console.error("businesses/delete error:", getErrorPayload(err));
    return res.status(500).json({ ok: false, error: "delete_business_failed", message: "מחיקה נכשלה" });
  }
});

async function writeManagerLog(businessId, type, extra = {}) {
  try {
    await db.collection("logs").add({
      businessId,
      type,
      ...extra,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    });
  } catch (err) {
    console.warn("manager log failed", getErrorPayload(err));
  }
}

async function deleteCollectionByBusinessId(collectionName, businessId) {
  let total = 0;
  while (true) {
    const snap = await db.collection(collectionName).where("businessId", "==", businessId).limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    total += snap.size;
    if (snap.size < 400) break;
  }
  return total;
}


// =======================
// Manager endpoint: create/update business
// =======================
app.post("/business/save", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    const businessName = String(body.businessName || body.name || "").trim();
    const whatsappNumber = normalizePhone(body.whatsappNumber || body.phone || "");
    const selectedMode = String(body.whatsappBotMode || body.whatsappMode || "off").trim().toLowerCase();
    const whatsappBotMode = selectedMode === "bot" ? "central" : selectedMode;

    if (!businessId) {
      return res.status(400).json({ ok: false, error: "missing_business_id", message: "חסר מזהה עסק" });
    }

    if (!businessName) {
      return res.status(400).json({ ok: false, error: "missing_business_name", message: "חסר שם עסק" });
    }

    if (!/^9725\d{8}$/.test(whatsappNumber)) {
      return res.status(400).json({ ok: false, error: "invalid_whatsapp_number", message: "מספר וואטסאפ חייב להתחיל ב־972 ולהיות 12 ספרות" });
    }

    if (!["off", "central", "private"].includes(whatsappBotMode)) {
      return res.status(400).json({ ok: false, error: "invalid_whatsapp_mode", message: "מצב וואטסאפ לא תקין" });
    }

    const whatsappPhoneNumberId = String(body.whatsappPhoneNumberId || body.phoneNumberId || body.waPhoneNumberId || "").trim();
    const whatsappAccessToken = String(body.whatsappAccessToken || body.accessToken || body.waAccessToken || "").trim();

    if (whatsappBotMode === "private" && !whatsappPhoneNumberId) {
      return res.status(400).json({ ok: false, error: "missing_phone_number_id", message: "במצב בעל עסק חייבים למלא Phone Number ID" });
    }

    const whatsappEnabled = whatsappBotMode !== "off";
    const ownerAccess = body.ownerAccess === true || body.ownerAccess === "true" || body.clientOwnerAccess === true || body.clientOwnerAccess === "true";
    const ownerCode = String(body.ownerCode || "1234").replace(/\D/g, "").slice(0, 4) || "1234";
    const statsSettingsCode = String(body.statsSettingsCode || "4321").replace(/\D/g, "").slice(0, 4) || "4321";
    const centralBotNumber = normalizePhone(body.centralBotNumber || body.botWhatsappNumber || getCentralBotWhatsappNumber() || "972547674814");
    const whatsappUrl = whatsappBotMode === "central"
      ? `https://wa.me/${centralBotNumber}?text=${encodeURIComponent(`start_${businessId}`)}`
      : whatsappBotMode === "private"
        ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(`start_${businessId}`)}`
        : `https://wa.me/${whatsappNumber}`;

    const ref = db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId);
    const snap = await ref.get();
    const isNew = !snap.exists;

    const payload = {
      businessId,
      businessName,
      name: businessName,
      whatsappNumber,
      phone: whatsappNumber,
      centralBotNumber,
      botWhatsappNumber: centralBotNumber,
      whatsappBotMode,
      whatsappMode: whatsappBotMode,
      whatsappPhoneNumberId,
      phoneNumberId: whatsappPhoneNumberId,
      whatsappAccessToken,
      whatsappEnabled,
      whatsappBotEnabled: whatsappEnabled,
      botEnabled: whatsappEnabled,
      waBotEnabled: whatsappEnabled,
      ownerAccess,
      clientOwnerAccess: ownerAccess,
      plan: whatsappBotMode === "central" ? "whatsapp-central" : (whatsappBotMode === "private" ? "whatsapp-private" : "basic"),
      ownerCode,
      statsSettingsCode,
      appUrl: String(body.appUrl || `${getAppBaseUrl().replace(/\/$/, "")}/index.html?business=${encodeURIComponent(businessId)}`),
      whatsappUrl,
      updatedAtMs: Date.now(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isNew) {
      payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      payload.createdAtMs = Date.now();
      payload.active = true;
      payload.appFrozen = false;
      payload.isFrozen = false;
      payload.status = "active";
      payload.bookingTitle = "קביעת תור!";
      payload.businessTypeLabel = "מספרה";
      payload.ownerBadge = "עמוד בעל העסק";
      payload.logoSrc = "logo.png";
      payload.heroBg = "background-behind-logo.png";
      payload.businessSubtitle = "";
      payload.businessDescription = "";
      payload.importantNotice = "";
      payload.businessAddress = "";
      payload.freezeMessage = "האפליקציה לא פעילה כעת. עמכם הסליחה, נסו שוב מאוחר יותר.";
      payload.services = DEFAULT_SERVICES;
      payload.workingHours = DEFAULT_WORKING_HOURS;
    }

    await ref.set(payload, { merge: true });
    await writeManagerLog(businessId, isNew ? "business_created" : "business_updated", {
      whatsappBotMode,
      ownerAccess,
    });

    return res.status(200).json({
      ok: true,
      businessId,
      whatsappBotMode,
      whatsappEnabled,
      message: "העסק נשמר בהצלחה",
    });
  } catch (err) {
    console.error("business/save error:", getErrorPayload(err));
    return res.status(500).json({ ok: false, error: "business_save_failed", message: "שגיאת שרת" });
  }
});


// =======================
// Frontend endpoint: save in-app business settings
// =======================
app.post("/business/settings/save", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    if (!businessId) {
      return res.status(400).json({ ok: false, error: "missing_business_id", message: "חסר מזהה עסק" });
    }

    const existingRef = db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId);
    const existingSnap = await existingRef.get();
    if (!existingSnap.exists) {
      return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });
    }

    const allowedKeys = [
      "businessName", "businessSubtitle", "businessDescription", "importantNotice",
      "whatsappNumber", "businessAddress", "ownerCode", "statsSettingsCode",
      "services", "workingHours", "logoSrc", "heroBg", "heroBgSrc", "logoUrl", "heroBgUrl",
      "phoneNumber", "wazeAddress", "address", "bookingTitle", "businessTypeLabel",
      "ownerBadge", "frozenMessage", "freezeMessage"
    ];

    const payload = {};
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(body, key)) payload[key] = body[key];
    }

    payload.businessId = businessId;
    payload.updatedAtMs = Date.now();
    payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await existingRef.set(payload, { merge: true });
    await writeManagerLog(businessId, "business_settings_saved", { source: "app" });

    return res.status(200).json({ ok: true, businessId, message: "הגדרות העסק נשמרו" });
  } catch (err) {
    console.error("business/settings/save error:", getErrorPayload(err));
    return res.status(500).json({ ok: false, error: "settings_save_failed", message: "שמירת ההגדרות נכשלה" });
  }
});

app.post("/business/visit", async (req, res) => {
  try {
    const businessId = cleanBusinessId(req.body?.businessId || "");
    const dateKey = String(req.body?.dateKey || "").trim();
    if (!businessId || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({ ok: false, error: "invalid_visit" });
    }

    const businessRef = db.collection(BUSINESS_SETTINGS_COLLECTION).doc(businessId);
    const businessSnap = await businessRef.get();
    if (!businessSnap.exists) {
      return res.status(404).json({ ok: false, error: "business_not_found" });
    }

    await businessRef.set({
      visits: { [dateKey]: admin.firestore.FieldValue.increment(1) },
      visitsUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
      visitsUpdatedAtMs: Date.now(),
    }, { merge: true });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("business/visit error:", getErrorPayload(err));
    return res.status(200).json({ ok: false });
  }
});


// =======================
// Frontend endpoint: claim waitlist slot - first click wins
// =======================
app.post("/waitlist/claim", async (req, res) => {
  try {
    const body = req.body || {};
    const businessId = cleanBusinessId(body.businessId || "");
    const claimToken = String(body.claimToken || body.token || "").trim();
    const offerToken = String(body.offerToken || body.offer || "").trim();
    const time = String(body.time || "").trim();

    if (!businessId || !claimToken || !isValidTime(time)) {
      return res.status(400).json({ ok: false, error: "invalid_claim", message: "קישור האישור לא תקין" });
    }

    const business = await getBusinessSettings(businessId);
    if (!business) {
      return res.status(404).json({ ok: false, error: "business_not_found", message: "העסק לא נמצא" });
    }

    if (business.appFrozen === true || business.isFrozen === true || business.active === false) {
      return res.status(403).json({ ok: false, error: "business_frozen", message: "האפליקציה לא פעילה כרגע" });
    }

    let txResult = null;

    await db.runTransaction(async (tx) => {
      const waitQuery = db.collection(WAITLIST_COLLECTION)
        .where("businessId", "==", businessId)
        .where("claimToken", "==", claimToken)
        .limit(1);

      const waitSnap = await tx.get(waitQuery);
      if (waitSnap.empty) throw new Error("INVALID_WAITLIST");

      const waitDoc = waitSnap.docs[0];
      const entry = normalizeWaitlistEntry({ id: waitDoc.id, ...waitDoc.data() });
      const date = String(entry.date || "").trim();

      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_WAITLIST");
      if (String(entry.status || "ממתין") !== "ממתין") throw new Error("INVALID_WAITLIST");
      if (offerToken && entry.offerToken && offerToken !== entry.offerToken) throw new Error("INVALID_OFFER");
      if (entry.offeredTime && entry.offeredTime !== time) throw new Error("INVALID_OFFER");
      if (entry.offerExpiresAtMs && Date.now() > Number(entry.offerExpiresAtMs)) throw new Error("OFFER_EXPIRED");

      const claimId = `${businessId}_${date}_${time}_${offerToken || "no_offer"}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const appointmentId = `waitlist_${entry.id}_${date}_${time}`.replace(/[^a-zA-Z0-9_-]/g, "_");
      const claimRef = db.collection(WAITLIST_CLAIMS_COLLECTION).doc(claimId);
      const appointmentRef = db.collection(APPOINTMENTS_COLLECTION).doc(appointmentId);

      const slotQuery = db.collection(APPOINTMENTS_COLLECTION)
        .where("businessId", "==", businessId)
        .where("date", "==", date)
        .where("time", "==", time);

      const [claimSnap, appointmentSnap, slotSnap] = await Promise.all([
        tx.get(claimRef),
        tx.get(appointmentRef),
        tx.get(slotQuery),
      ]);

      if (appointmentSnap.exists) {
        const existing = { id: appointmentSnap.id, ...appointmentSnap.data() };
        if (isActiveAppointment(existing) && existing.waitlistId === entry.id) {
          txResult = { alreadyCreated: true, appointment: existing, waitlistId: entry.id };
          return;
        }
      }

      if (claimSnap.exists) {
        const claim = claimSnap.data() || {};
        if (claim.waitlistId !== entry.id) throw new Error("TAKEN_BY_OTHER");
        if (claim.status === "claimed" && claim.appointmentId) {
          txResult = { alreadyCreated: true, appointment: { id: claim.appointmentId, businessId, date, time }, waitlistId: entry.id, offerToken: offerToken || "" };
          return;
        }
      }

      const slotTaken = slotSnap.docs.some((doc) => {
        if (doc.id === appointmentRef.id) return false;
        return isActiveAppointment(doc.data() || {});
      });
      if (slotTaken) throw new Error("TAKEN_BY_OTHER");

      const phoneDisplay = whatsappToIsraeliPhone(entry.customerPhone || entry.phoneDisplay || entry.phone || "");
      const appointment = {
        businessId,
        businessName: business.businessName || business.name || "",
        name: entry.name || `${entry.firstName || ""} ${entry.lastName || ""}`.trim() || "לקוח מרשימת המתנה",
        phone: phoneDisplay,
        service: entry.service || "לא נבחר",
        date,
        time,
        status: "נקבע",
        source: "רשימת המתנה",
        notes: "",
        waitlistId: entry.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtMs: Date.now(),
      };

      tx.set(claimRef, {
        businessId,
        date,
        time,
        claimToken,
        offerToken: offerToken || "",
        waitlistId: entry.id,
        phone: phoneDisplay,
        appointmentId,
        status: "claimed",
        offerExpiresAtMs: entry.offerExpiresAtMs || 0,
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        claimedAtMs: Date.now(),
      }, { merge: true });

      tx.set(appointmentRef, appointment);
      tx.update(waitDoc.ref, {
        status: "נקבע",
        offeredTime: time,
        claimStatus: "claimed",
        claimedAppointmentId: appointmentId,
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        claimedAtMs: Date.now(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      txResult = { alreadyCreated: false, appointment: { id: appointmentId, ...appointment }, waitlistId: entry.id, offerToken: offerToken || "" };
    });

    if (!txResult?.appointment) throw new Error("CLAIM_FAILED");

    // Close the same offer for other waiting customers, so old links become inactive.
    if (txResult.offerToken) {
      const othersSnap = await db.collection(WAITLIST_COLLECTION)
        .where("businessId", "==", businessId)
        .where("offerToken", "==", txResult.offerToken)
        .get();

      const batch = db.batch();
      let count = 0;
      othersSnap.docs.forEach((doc) => {
        if (doc.id === txResult.waitlistId) return;
        const data = doc.data() || {};
        if (String(data.status || "ממתין") !== "ממתין") return;
        batch.set(doc.ref, {
          status: "נסגר",
          closedReason: "slot_claimed_by_other",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        count += 1;
      });
      if (count) await batch.commit();
    }

    await db.collection("logs").add({
      businessId,
      type: "waitlist_claimed",
      appointmentId: txResult.appointment.id,
      waitlistId: txResult.waitlistId || "",
      date: txResult.appointment.date || "",
      time: txResult.appointment.time || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    }).catch((err) => console.warn("waitlist claim log failed", getErrorPayload(err)));

    return res.status(200).json({
      ok: true,
      appointmentId: txResult.appointment.id,
      appointment: txResult.appointment,
      waitlistId: txResult.waitlistId,
      alreadyCreated: Boolean(txResult.alreadyCreated),
      message: "התור אושר בהצלחה",
    });
  } catch (err) {
    const code = String(err?.message || "CLAIM_FAILED");
    const messages = {
      INVALID_WAITLIST: "הקישור כבר לא פעיל",
      INVALID_OFFER: "הקישור כבר לא עדכני",
      OFFER_EXPIRED: "הקישור כבר לא פעיל",
      TAKEN_BY_OTHER: "מישהו כבר תפס את התור הזה",
      CLAIM_FAILED: "שגיאה באישור התור",
    };
    const status = ["INVALID_WAITLIST", "INVALID_OFFER", "OFFER_EXPIRED", "TAKEN_BY_OTHER"].includes(code) ? 409 : 500;
    console.error("waitlist/claim error:", getErrorPayload(err));
    return res.status(status).json({ ok: false, error: code, message: messages[code] || "שגיאה באישור התור" });
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
              offerExpiresAtMs: Date.now() + WAITLIST_CLAIM_TTL_MS,
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

  const whatsappAppointmentRef = db.collection(APPOINTMENTS_COLLECTION).doc();
  await db.runTransaction(async (tx) => {
    const slotQuery = db.collection(APPOINTMENTS_COLLECTION)
      .where("businessId", "==", business.businessId)
      .where("date", "==", session.selectedDate)
      .where("time", "==", session.selectedTime);

    const slotSnap = await tx.get(slotQuery);
    if (slotSnap.docs.some((doc) => isActiveAppointment(doc.data() || {}))) {
      throw new Error("slot_taken");
    }

    tx.set(whatsappAppointmentRef, {
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
  });

  await db.collection("logs").add({
    businessId: business.businessId,
    type: "appointment_created",
    source: "whatsapp",
    appointmentId: whatsappAppointmentRef.id,
    phone: normalizePhone(from),
    date: session.selectedDate,
    time: session.selectedTime,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtMs: Date.now(),
  }).catch((err) => console.warn("whatsapp appointment log failed", getErrorPayload(err)));

  await removeMatchingWaitlistEntries({
    businessId: business.businessId,
    date: session.selectedDate,
    phone: normalizePhone(from),
    appointmentId: whatsappAppointmentRef.id,
    source: "whatsapp_appointment_created",
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

    const appointmentRef = db.collection(APPOINTMENTS_COLLECTION).doc(appointment.id);
    const appointmentSnap = await appointmentRef.get();
    if (!appointmentSnap.exists || String((appointmentSnap.data() || {}).businessId || '') !== business.businessId) {
      await clearSession(from);
      await sendWhatsAppMessage(from, "לא מצאתי את התור לביטול 🙏");
      return;
    }

    await appointmentRef.delete();
    await db.collection("logs").add({
      businessId: business.businessId,
      type: "appointment_cancelled",
      source: "whatsapp",
      appointmentId: appointment.id,
      phone: normalizePhone(from),
      date: appointment.date || "",
      time: appointment.time || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    }).catch((err) => console.warn("whatsapp cancel log failed", getErrorPayload(err)));

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
async function removeMatchingWaitlistEntries({ businessId, date, phone, appointmentId = "", source = "appointment_created" }) {
  try {
    const cleanBusiness = cleanBusinessId(businessId || "");
    const cleanDate = String(date || "").trim();
    const normalizedPhone = normalizePhone(phone || "");

    if (!cleanBusiness || !cleanDate || !normalizedPhone) {
      return { deleted: 0 };
    }

    const snap = await db.collection(WAITLIST_COLLECTION)
      .where("businessId", "==", cleanBusiness)
      .where("date", "==", cleanDate)
      .get();

    const docsToDelete = snap.docs.filter((doc) => {
      const entry = normalizeWaitlistEntry({ id: doc.id, ...doc.data() });
      if (String(entry.status || "ממתין") !== "ממתין") return false;
      return normalizePhone(entry.phone) === normalizedPhone;
    });

    if (!docsToDelete.length) return { deleted: 0 };

    const batch = db.batch();
    docsToDelete.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    await db.collection("logs").add({
      businessId: cleanBusiness,
      type: "waitlist_auto_removed_after_booking",
      source,
      appointmentId,
      phone: normalizedPhone,
      date: cleanDate,
      deletedCount: docsToDelete.length,
      waitlistIds: docsToDelete.map((doc) => doc.id),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: Date.now(),
    }).catch((err) => console.warn("waitlist auto remove log failed", getErrorPayload(err)));

    console.log("✅ Removed matching waitlist entries after appointment", {
      businessId: cleanBusiness,
      date: cleanDate,
      phone: normalizedPhone,
      deleted: docsToDelete.length,
      source,
    });

    return { deleted: docsToDelete.length };
  } catch (err) {
    console.error("removeMatchingWaitlistEntries error:", getErrorPayload(err));
    return { deleted: 0, error: getErrorPayload(err) };
  }
}
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
    offerExpiresAtMs: Number(entry.offerExpiresAtMs || 0),
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
  const url = new URL(getAppBaseUrl());
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
  const cleanData = { ...data };
  if (cleanData.businessId) cleanData.businessId = cleanBusinessId(cleanData.businessId);

  await db.collection(SESSIONS_COLLECTION).doc(from).set(
    {
      ...cleanData,
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
    phoneNumberId: String(getPhoneNumberId() || store.incomingPhoneNumberId || "").trim(),
    token: String(getWhatsappToken() || "").trim(),
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

function parseDateKeyToDate(dateKey) {
  const [y, m, d] = String(dateKey || "").split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
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
    hasWhatsappToken: Boolean(getWhatsappToken()),
    centralPhoneNumberId: getPhoneNumberId() || "",
    verifyToken: getVerifyToken() ? "configured" : "missing",
    defaultWhatsappMode: DEFAULT_WHATSAPP_MODE,
    appBaseUrl: getAppBaseUrl(),
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

exports.api = onRequest(
  {
    region: "us-central1",
    secrets: [WHATSAPP_TOKEN_SECRET, PHONE_NUMBER_ID_SECRET, VERIFY_TOKEN_SECRET, APP_BASE_URL_SECRET],
  },
  app
);

if (require.main === module) {
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log(`WhatsApp API listening on ${port}`));
}
