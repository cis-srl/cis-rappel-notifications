// Rappel programmé (GitHub Actions) pour l'application Inventaire CIS Saint-Raphaël.
// Vérifie, comme les bandeaux dans l'application, si quelqu'un doit être prévenu (problème
// matériel non pris en compte, inventaire du matin ou du soir non fait, point AMSEC en NON
// non traité, ou contrôle AMSEC pas encore fait) — et envoie une notification push, une seule
// fois par jour, si c'est le cas.
// N'écrit rien dans le Journal ni ailleurs à part la marque "déjà envoyé aujourd'hui".

const admin = require("firebase-admin");

const DEFAULT_HORAIRES = { bandeau: "17:00", soirDebut: "19:45", traceMatin: "19:30", traceSoir: "21:00", alerteAmsec: "10:00" };

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

// Calcule s'il faut prévenir, à partir des mêmes données que les bandeaux dans l'application.
// Fonction pure (aucun accès réseau) pour pouvoir être testée facilement.
// Un point AMSEC en NON non traité est signalé sans attendre l'heure du bandeau (17h) : c'est
// une anomalie de sécurité, pas une simple relance de fin de journée.
function computeShouldNotify({ now, horaires, vehicles, checksToday, missedToday, amsecChecksToday, saisonFDF }) {
  const pastBandeau = isAtOrAfter(now, horaires.bandeau, 17, 0);
  const pastAmsecAlert = isAtOrAfter(now, horaires.alerteAmsec, 10, 0);

  const hasUnvalidatedProblemsToday = pastBandeau && checksToday.some((c) =>
    Object.values(c.results || {}).some((r) => (r.manquant || r.deteriore) && !r.validated)
  );
  const hasUnvalidatedMissedToday = pastBandeau && (missedToday || []).some((m) => !m.validated);
  const hasPendingDayInventory = pastBandeau && vehicles.some((v) =>
    isScheduledToday(v, now.weekday) && !v.indisponible &&
    !checksToday.some((c) => c.vehicleId === v.id)
  );
  const hasPendingEveningInventory = pastBandeau && vehicles.some((v) =>
    v.soirInventaire && !v.indisponible &&
    !checksToday.some((c) => c.vehicleId === v.id && isEveningCheckIso(c.date, horaires))
  );
  const hasUnvalidatedAmsecToday = (amsecChecksToday || []).some((c) =>
    Object.values(c.results || {}).some((r) => r.value === "non" && !r.validated)
  );
  const hasPendingAmsecToday = !!saisonFDF && pastAmsecAlert && vehicles.some((v) =>
    v.amsecFiche && !v.indisponible && !(amsecChecksToday || []).some((c) => c.vehicleId === v.id)
  );

  const shouldNotify = hasUnvalidatedProblemsToday || hasUnvalidatedMissedToday || hasPendingDayInventory ||
    hasPendingEveningInventory || hasUnvalidatedAmsecToday || hasPendingAmsecToday;
  return {
    shouldNotify, hasUnvalidatedProblemsToday, hasUnvalidatedMissedToday,
    hasPendingDayInventory, hasPendingEveningInventory, hasUnvalidatedAmsecToday, hasPendingAmsecToday,
  };
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
  const saisonFDF = !!settingsData.saisonFDF;

  const usersSnap = await db.collection("caserne").doc("users").get();
  const users = (usersSnap.data() && usersSnap.data().users) || [];
  // Destinataires : la fonction SOJ/Chef de Garde, et systématiquement l'Administration (au même
  // titre que le bandeau dans l'application, qu'elle voit toujours quelle que soit sa fonction).
  const recipientUsers = users.filter((u) => u.actif !== false && (
    (Array.isArray(u.fonctions) && u.fonctions.includes("SOJ_CDG")) || u.role === "administration"
  ));
  if (recipientUsers.length === 0) {
    console.log("Aucun compte SOJ/Chef de Garde ou Administration, rien à envoyer.");
    return;
  }

  const vehiclesSnap = await db.collection("vehicles").get();
  const vehicles = vehiclesSnap.docs.map((d) => d.data());

  const startOfDayIso = new Date(`${now.dayKey}T00:00:00`).toISOString();
  const checksSnap = await db.collection("checks").where("date", ">=", startOfDayIso).get();
  const checksToday = checksSnap.docs.map((d) => d.data()).filter((c) => localDateKeyOf(c.date) === now.dayKey);

  const missedSnap = await db.collection("missed_checks").where("dayKey", "==", now.dayKey).get();
  const missedToday = missedSnap.docs.map((d) => d.data());

  const amsecSnap = await db.collection("amsec_checks").where("date", ">=", startOfDayIso).get();
  const amsecChecksToday = amsecSnap.docs.map((d) => d.data()).filter((c) => localDateKeyOf(c.date) === now.dayKey);

  const result = computeShouldNotify({ now, horaires, vehicles, checksToday, missedToday, amsecChecksToday, saisonFDF });
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

  const uidSet = new Set(recipientUsers.map((u) => u.uid));
  const tokensSnap = await db.collection("fcm_tokens").get();
  const tokens = tokensSnap.docs.filter((d) => uidSet.has(d.data().uid)).map((d) => d.data().token).filter(Boolean);

  if (tokens.length === 0) {
    console.log("Personne n'a activé les notifications pour l'instant.");
    return;
  }

  const body = (result.hasUnvalidatedAmsecToday || result.hasPendingAmsecToday)
    ? "AMSEC : un point signalé en NON reste à traiter, ou un contrôle AMSEC n'a pas encore été fait."
    : "Des problèmes ou inventaires du jour restent à prendre en compte.";

  const message = {
    notification: {
      title: settingsData.appName || "Inventaire CIS Saint-Raphaël",
      body,
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
