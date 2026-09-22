// Rappel programmé (GitHub Actions) pour l'application Inventaire CIS Saint-Raphaël.
// Vérifie, comme les bandeaux dans l'application, si quelqu'un doit être prévenu (problème
// matériel non pris en compte, inventaire du matin ou du soir non fait, point AMSEC en NON
// non traité, ou contrôle AMSEC pas encore fait) — et envoie une notification push, une seule
// fois par jour, si c'est le cas.
// Vérifie aussi, séparément et sans cette limite d'une fois par jour, si une demande d'accès
// (« Première connexion ») attend d'être validée — et prévient alors l'Administration
// immédiatement à la première détection, puis en rappel toutes les heures tant qu'elle traîne.
// N'écrit rien dans le Journal ni ailleurs à part les marques de suivi de ces deux envois.

const admin = require("firebase-admin");

const DEFAULT_HORAIRES = { bandeau: "17:00", soirDebut: "19:45", traceMatin: "19:30", traceSoir: "21:00", alerteAmsec: "10:00" };
const PENDING_USERS_REMINDER_INTERVAL_MS = 60 * 60 * 1000; // 1h

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

// Calcule s'il faut prévenir l'Administration pour des demandes d'accès en attente. Fonction
// pure (aucun accès réseau), indépendante de computeShouldNotify : ni sa limite d'une fois par
// jour, ni ses destinataires (celle-ci ne concerne que l'Administration) ne s'appliquent ici.
// Se déclenche dès qu'une demande n'a encore jamais été signalée (nouvelle arrivée), ou que le
// dernier rappel remonte à plus d'une heure alors qu'au moins une demande traîne toujours.
function computePendingUsersNotification({ nowMs, pending, lastReminderAtIso, reminderIntervalMs }) {
  if (!pending || pending.length === 0) return { shouldNotify: false, newIds: [], body: null };
  const newOnes = pending.filter((p) => !p.notifiedAt);
  const lastReminderAt = lastReminderAtIso ? new Date(lastReminderAtIso).getTime() : 0;
  const intervalPassed = (nowMs - lastReminderAt) >= (reminderIntervalMs || PENDING_USERS_REMINDER_INTERVAL_MS);
  const shouldNotify = newOnes.length > 0 || intervalPassed;
  if (!shouldNotify) return { shouldNotify: false, newIds: [], body: null };
  const body = pending.length === 1
    ? `Une demande d'accès attend d'être validée : ${pending[0].name || "un agent"}.`
    : `${pending.length} demandes d'accès attendent d'être validées.`;
  return { shouldNotify: true, newIds: newOnes.map((p) => p.id), body };
}

async function sendPush(db, { tokens, title, body }) {
  if (tokens.length === 0) return { successCount: 0, failureCount: 0 };
  const message = { notification: { title, body }, data: { url: "./" }, tokens };
  const response = await admin.messaging().sendEachForMulticast(message);
  console.log(`Notifications envoyées (${body}) : ${response.successCount} réussie(s), ${response.failureCount} échouée(s).`);
  return response;
}

async function tokensForUsers(db, users) {
  const uidSet = new Set(users.map((u) => u.uid));
  const tokensSnap = await db.collection("fcm_tokens").get();
  return tokensSnap.docs.filter((d) => uidSet.has(d.data().uid)).map((d) => d.data().token).filter(Boolean);
}

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("La variable d'environnement FIREBASE_SERVICE_ACCOUNT est manquante.");
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  const db = admin.firestore();

  const now = parisNow();
  const nowMs = Date.now();

  const settingsSnap = await db.collection("caserne").doc("settings").get();
  const settingsData = settingsSnap.data() || {};
  const horaires = { ...DEFAULT_HORAIRES, ...(settingsData.horaires || {}) };
  const saisonFDF = !!settingsData.saisonFDF;
  const appName = settingsData.appName || "Inventaire CIS Saint-Raphaël";

  const usersSnap = await db.collection("caserne").doc("users").get();
  const users = (usersSnap.data() && usersSnap.data().users) || [];

  // --- Volet 1 : demandes d'accès en attente (Administration uniquement, sans limite de fréquence) ---
  const adminUsers = users.filter((u) => u.actif !== false && u.role === "administration");
  if (adminUsers.length === 0) {
    console.log("Aucun compte Administration, rien à envoyer pour les demandes d'accès.");
  } else {
    const pendingSnap = await db.collection("pending_users").get();
    const pending = pendingSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const reminderStateRef = db.collection("caserne").doc("pendingUsersReminderState");
    const reminderStateSnap = await reminderStateRef.get();
    const reminderState = reminderStateSnap.data() || {};

    const pendingResult = computePendingUsersNotification({
      nowMs, pending, lastReminderAtIso: reminderState.lastReminderAt,
    });

    if (pendingResult.shouldNotify) {
      const adminTokens = await tokensForUsers(db, adminUsers);
      await sendPush(db, { tokens: adminTokens, title: appName, body: pendingResult.body });
      // Marque toutes les demandes actuellement en attente comme déjà signalées au moins une
      // fois, et note l'heure de ce rappel pour cadencer le suivant.
      const batch = db.batch();
      pending.forEach((p) => {
        if (!p.notifiedAt) batch.update(db.collection("pending_users").doc(p.id), { notifiedAt: new Date().toISOString() });
      });
      batch.set(reminderStateRef, { lastReminderAt: new Date().toISOString() });
      await batch.commit();
    } else {
      console.log(pending.length === 0 ? "Aucune demande d'accès en attente." : "Demande(s) d'accès déjà signalée(s) récemment.");
    }
  }

  // --- Volet 2 : problèmes/inventaires/AMSEC du jour (SOJ/Chef de Garde + Administration, une fois par jour) ---
  // Destinataires : la fonction SOJ/Chef de Garde, et systématiquement l'Administration (au même
  // titre que le bandeau dans l'application, qu'elle voit toujours quelle que soit sa fonction).
  const recipientUsers = users.filter((u) => u.actif !== false && (
    (Array.isArray(u.fonctions) && u.fonctions.includes("SOJ_CDG")) || u.role === "administration"
  ));
  if (recipientUsers.length === 0) {
    console.log("Aucun compte SOJ/Chef de Garde ou Administration, rien à envoyer pour les problèmes du jour.");
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
    console.log("Rien à signaler pour l'instant côté problèmes/inventaires/AMSEC.");
    return;
  }

  // Une seule notification par jour pour ce volet, même si cette tâche s'exécute toutes les 15 minutes.
  const pushStateRef = db.collection("caserne").doc("pushState");
  const pushStateSnap = await pushStateRef.get();
  const pushState = pushStateSnap.data() || {};
  if (pushState.dayKey === now.dayKey && pushState.sent) {
    console.log("Déjà envoyé aujourd'hui pour ce volet.");
    return;
  }

  const recipientTokens = await tokensForUsers(db, recipientUsers);
  if (recipientTokens.length === 0) {
    console.log("Personne n'a activé les notifications pour l'instant.");
    return;
  }

  const body = (result.hasUnvalidatedAmsecToday || result.hasPendingAmsecToday)
    ? "AMSEC : un point signalé en NON reste à traiter, ou un contrôle AMSEC n'a pas encore été fait."
    : "Des problèmes ou inventaires du jour restent à prendre en compte.";

  await sendPush(db, { tokens: recipientTokens, title: appName, body });
  await pushStateRef.set({ dayKey: now.dayKey, sent: true, sentAt: new Date().toISOString() });
}

module.exports = {
  parisNow, isAtOrAfter, localDateKeyOf, isEveningCheckIso, isScheduledToday,
  computeShouldNotify, computePendingUsersNotification,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
