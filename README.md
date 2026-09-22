Notifications push — mise en service
Ce dossier contient le petit programme externe qui envoie une notification (même appli
fermée) s'il reste des problèmes ou inventaires à traiter à partir de 17h, ou — sans
attendre cette heure — si un point AMSEC est signalé en NON, ou si le contrôle AMSEC du
jour n'a toujours pas été fait passé l'heure réglée (10h par défaut). Il prévient aussi
l'Administration, séparément et sans attendre, dès qu'une demande d'accès (« Première
connexion ») est en attente de validation — puis en rappel toutes les heures tant qu'elle
n'a pas été traitée. Il tourne gratuitement sur GitHub Actions, indépendamment de
l'application.
Il y a 4 étapes, à faire une seule fois. Aucune carte bancaire nécessaire nulle part.
Étape 1 — Générer la clé VAPID (côté application)
Va dans la console Firebase → ton projet
`cis-srl-inventaires` → l'icône ⚙️ (roue crantée) → Paramètres du projet
Onglet Cloud Messaging
Section Certificats Web Push → bouton Générer une paire de clés
Copie la clé affichée (elle commence par une longue suite de lettres/chiffres)
Dans le fichier `app.js` de l'application, remplace `COLLEZ_VOTRE_CLE_VAPID_ICI` par
cette clé, puis redéploie l'application comme d'habitude
Étape 2 — Générer la clé de service (côté serveur, pour ce dossier-ci)
Toujours dans Paramètres du projet → onglet Comptes de service
Bouton Générer une nouvelle clé privée → confirme → un fichier `.json` se télécharge
Garde ce fichier confidentiel — il donne un accès complet à la base de données.
Ne le mets jamais dans le code de l'application ni sur un dépôt public.
Étape 3 — Ajouter la règle Firestore pour les jetons de notification
Dans la console Firebase → Firestore Database → Règles, ajoute ce bloc (au même niveau
que les autres `match /...`) :
```
match /fcm_tokens/{uid} {
  allow read: if request.auth != null && (
    !exists(/databases/$(database)/documents/caserne/users) ||
    request.auth.uid in get(/databases/$(database)/documents/caserne/users).data.uids
  );
  allow write: if request.auth != null && request.auth.uid == uid;
}
```
Publie les règles.
Étape 4 — Créer le dépôt GitHub et y déposer ce dossier
Va sur github.com, crée un compte si besoin (gratuit)
Crée un nouveau dépôt (bouton New), nom au choix (ex. `cis-rappel-notifications`),
coche Private (privé — pour ne pas exposer publiquement)
Mets-y tous les fichiers de ce dossier (`send-reminder.js`, `package.json`, le
dossier `.github/`) — le plus simple est de glisser-déposer les fichiers dans
l'interface web de GitHub ("Add file" → "Upload files")
Dans le dépôt : onglet Settings → Secrets and variables → Actions
Bouton New repository secret :
Nom : `FIREBASE_SERVICE_ACCOUNT`
Valeur : ouvre le fichier `.json` téléchargé à l'étape 2 avec un éditeur de texte,
colle tout son contenu tel quel
Enregistre
C'est terminé — GitHub va exécuter le rappel automatiquement toutes les 15 minutes.
Tester avant de faire confiance
Dans l'onglet Actions du dépôt GitHub, tu peux lancer le rappel manuellement
("Rappel SOJ/CDG (notifications push)" → Run workflow) pour vérifier tout de suite
que ça fonctionne, sans attendre l'heure réelle. Le journal d'exécution affiche ce que
le script a décidé de faire (et pourquoi), utile en cas de souci.
Qui reçoit la notification ?
Ça dépend du sujet :
Demande d'accès en attente — uniquement les comptes Administration. Dès la
première détection, puis en rappel toutes les heures tant qu'elle n'est pas validée ou
refusée — aucune limite d'une fois par jour sur ce point-là.
Problèmes, inventaires et AMSEC du jour — les comptes ayant la fonction
SOJ / Chef de Garde, et systématiquement les comptes Administration (comme le
bandeau dans l'application, qu'elle voit toujours). Une seule notification par jour sur
ce point-là, même si le rappel tourne toutes les 15 minutes.
Dans les deux cas, il faut avoir cliqué sur "Activer" dans la bannière bleue qui apparaît
en haut de l'application pour recevoir quoi que ce soit.
