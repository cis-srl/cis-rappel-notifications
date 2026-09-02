// Rappel programmé (GitHub Actions) pour l'application Inventaire CIS Saint-Raphaël.
// Vérifie, comme le bandeau dans l'application, si le SOJ/Chef de Garde doit être prévenu
// (problème matériel non pris en compte, inventaire du matin ou du soir non fait) — et
// envoie une notification push, une seule fois par jour, si c'est le cas.
// N'écrit rien dans le Journal ni ailleurs à part la marque "déjà envoyé aujourd'hui".

const admin = require("firebase-admin");

const DEFAULT_HORAIRES = { bandeau: "17:00", soirDebut: "19:45", traceMatin: "19:30", traceSoir: "21:00" };

function parseHM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str || "");
  return m ? { h: parseInt(m[1], 10), m: parseInt(m[2], 10) } : null;
}

// Heure et date "locales" (Europe/Paris, gère automatiquement l'heure d'été/hiver)
function parisNow(ref) {
  const d = ref || new Date();
  const fmt = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = {};
  fmt.formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", weekday: "short" });
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    weekday: weekdayMap[weekdayFmt.format(d)],
  };
}

function isAtOrAfter(now, hmStr, fallbackH, fallbackM) {
  const parsed = parseHM(hmStr) || { h: fallbackH, m: fallbackM };
  return now.hour > parsed.h || (now.hour === parsed.h && now.minute >= parsed.m);
}

function localDateKeyOf(iso) {
  const fmt = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = {};
  fmt.formatToParts(new Date(iso)).forEach((p) => { parts[p.type] = p.value; });
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isEveningCheckIso(iso, horaires) {
  const fmt = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = {};
  fmt.formatToParts(new Date(iso)).forEach((p) => { parts[p.type] = p.value; });
  const h = parseInt(parts.hour, 10), m = parseInt(parts.minute, 10);
  const parsed = parseHM(horaires.soirDebut) || { h: 19, m: 45 };
  return h > parsed.h || (h === parsed.h && m >= parsed.m);
}

function isScheduledToday(vehicle, weekday) {
  return Array.isArray(vehicle.joursControle) && vehicle.joursControle.includes(weekday);
}

// Calcule s'il faut prévenir, à partir des mêmes données que le bandeau dans l'application.
// Fonction pure (aucun accès réseau) pour pouvoir être testée facilement.
function computeShouldNotify({ now, horaires, vehicles, checksToday }) {
  if (!isAtOrAfter(now, horaires.bandeau, 17, 0)) return { shouldNotify: false, reason: "avant l'heure du bandeau" };

  const hasUnvalidatedProblemsToday = checksToday.some((c) =>
    Object.values(c.results || {}).some((r) => r.manquant || r.deteriore)
  );
  const hasPendingDayInventory = vehicles.some((v) =>
    isScheduledToday(v, now.weekday) && !v.indisponible &&
    !checksToday.some((c) => c.vehicleId === v.id)
  );
  const hasPendingEveningInventory = vehicles.some((v) =>
    v.soirInventaire && !v.indisponible &&
    !checksToday.some((c) => c.vehicleId === v.id && isEveningCheckIso(c.date, horaires))
  );

  const shouldNotify = hasUnvalidatedProblemsToday || hasPendingDayInventory || hasPendingEveningInventory;
  return { shouldNotify, hasUnvalidatedProblemsToday, hasPendingDayInventory, hasPendingEveningInventory };
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("La variable d'environnement FIREBASE_SERVICE_ACCOUNT est manquante.");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();

  const now = parisNow();

  const settingsSnap = await db.collection("caserne").doc("settings").get();
  const settingsData = settingsSnap.data() || {};
  const horaires = { ...DEFAULT_HORAIRES, ...(settingsData.horaires || {}) };

  if (!isAtOrAfter(now, horaires.bandeau, 17, 0)) {
    console.log("Avant l'heure du bandeau, rien à faire.");
    return;
  }

  const validationSnap = await db.collection("validations").doc(now.dayKey).get();
  if (validationSnap.exists) {
    console.log("Journée déjà prise en compte, rien à envoyer.");
    return;
  }

  const usersSnap = await db.collection("caserne").doc("users").get();
  const users = (usersSnap.data() && usersSnap.data().users) || [];
  const sojUsers = users.filter((u) => u.actif !== false && Array.isArray(u.fonctions) && u.fonctions.includes("SOJ_CDG"));
  if (sojUsers.length === 0) {
    console.log("Aucun compte SOJ/Chef de Garde, rien à envoyer.");
    return;
  }

  const vehiclesSnap = await db.collection("vehicles").get();
  const vehicles = vehiclesSnap.docs.map((d) => d.data());

  const startOfDayIso = new Date(`${now.dayKey}T00:00:00`).toISOString();
  const checksSnap = await db.collection("checks").where("date", ">=", startOfDayIso).get();
  const checksToday = checksSnap.docs.map((d) => d.data()).filter((c) => localDateKeyOf(c.date) === now.dayKey);

  const result = computeShouldNotify({ now, horaires, vehicles, checksToday });
  if (!result.shouldNotify) {
    console.log("Rien à signaler pour l'instant.");
    return;
  }

  // Une seule notification par jour, même si cette tâche s'exécute toutes les 15 minutes.
  const pushStateRef = db.collection("caserne").doc("pushState");
  const pushStateSnap = await pushStateRef.get();
  const pushState = pushStateSnap.data() || {};
  if (pushState.dayKey === now.dayKey && pushState.sent) {
    console.log("Déjà envoyé aujourd'hui.");
    return;
  }

  const uidSet = new Set(sojUsers.map((u) => u.uid));
  const tokensSnap = await db.collection("fcm_tokens").get();
  const tokens = tokensSnap.docs.filter((d) => uidSet.has(d.id)).map((d) => d.data().token).filter(Boolean);

  if (tokens.length === 0) {
    console.log("Aucun compte SOJ/Chef de Garde n'a activé les notifications pour l'instant.");
    return;
  }

  const message = {
    notification: {
      title: settingsData.appName || "Inventaire CIS Saint-Raphaël",
      body: "Des problèmes ou inventaires du jour restent à prendre en compte.",
    },
    data: { url: "./" },
    tokens,
  };

  const response = await admin.messaging().sendEachForMulticast(message);
  console.log(`Notifications envoyées : ${response.successCount} réussie(s), ${response.failureCount} échouée(s).`);

  await pushStateRef.set({ dayKey: now.dayKey, sent: true, sentAt: new Date().toISOString() });
}

module.exports = { parisNow, isAtOrAfter, localDateKeyOf, isEveningCheckIso, isScheduledToday, computeShouldNotify };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
