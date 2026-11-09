# SendMail Tools

Outil web local pour envoyer des emails de prospection à partir d'un fichier Excel.

- **Long terme (progressif)** : ex. 50 emails par jour, étalés automatiquement sur une plage horaire (9h–18h, du lundi au vendredi…), avec un léger décalage aléatoire entre les envois.
- **Court terme (en masse)** : ex. 1 000 emails d'un coup, avec un délai réglable entre chaque email (2–5 s recommandé).
- **Import Excel / CSV** : chaque colonne devient une variable (`{{Prénom}}`, `{{Entreprise}}`…). La colonne email est détectée automatiquement ; doublons, adresses invalides et désinscrits sont écartés.
- Aperçu par contact, email de test, suivi des envois, export des résultats en CSV, relance des échecs.
- Liste de désinscrits commune à toutes les campagnes + mention de désinscription en bas de chaque email.

## Protection anti-blocage

L'outil détecte le fournisseur (via le serveur SMTP et l'adresse) et applique automatiquement des garde-fous :

| | Gmail perso / Outlook.com | Google Workspace / Microsoft 365 | Autre SMTP |
|---|---|---|---|
| Plafond absolu / jour | 100 | 500 | limite globale réglable |
| Envoi en masse | **désactivé** | autorisé (≥ 5 s entre emails) | autorisé (≥ 2 s) |
| Montée en charge / jour | 20 → 40 → 70 → 100 (par semaine) | 30 → 60 → 120 → 250 → 500 | — |

**Bloquant** (la campagne ne peut pas être lancée) : envoi en masse sur Gmail/Outlook perso, liens raccourcis (bit.ly…), envois suspendus après un signal de limite du fournisseur.

**Automatique** : arrêt de toutes les campagnes pendant 24 h si le fournisseur répond « quota / limite atteinte » (le contact n'est pas perdu), pause après 3 échecs d'affilée, mention de désinscription toujours ajoutée, une seule instance de l'outil à la fois (évite les doubles envois).

**Alertes** (risque modéré) : plusieurs liens, images, HTML chargé, mots « spammy », objet en majuscules / avec « ! » / faux « RE: », pas de personnalisation, message trop long, envois la nuit ou le week-end, fichier avec beaucoup d'adresses invalides ou génériques.

## Démarrer

Prérequis : [Node.js](https://nodejs.org) **22.13 ou plus**.

Double-cliquez sur `demarrer.bat`, ou :

```bash
npm install
npm start
```

Puis ouvrez <http://localhost:3000>.

> Les envois ne partent **que pendant que le serveur tourne**. Pour une campagne long terme, laissez la fenêtre ouverte (ou installez l'outil sur un serveur / un PC allumé en permanence).

## Utilisation

1. **Paramètres** → renseignez votre serveur SMTP (boutons de pré-remplissage Gmail, Outlook, OVH, IONOS, Brevo) puis envoyez un email de test.
2. **Campagnes** → créez une campagne long terme ou court terme.
3. Glissez votre fichier Excel (première ligne = noms des colonnes).
4. Rédigez l'objet et le message en cliquant sur les colonnes pour insérer les variables. Valeur par défaut si la cellule est vide : `{{Prénom|Madame, Monsieur}}`.
5. Vérifiez l'aperçu, envoyez-vous un test, puis **Lancer la campagne**.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port de l'interface |
| `HOST` | `127.0.0.1` | Mettre `0.0.0.0` pour rendre l'outil accessible depuis le réseau |
| `APP_PASSWORD` | _(vide)_ | Protège l'interface par mot de passe (à activer si l'outil est accessible depuis Internet) |

Les données (campagnes, contacts, paramètres SMTP) sont stockées localement dans `data/sendmail.db`.

## Bonnes pratiques (délivrabilité et légalité)

- **Limites des fournisseurs** : Gmail ≈ 500/jour, Google Workspace ≈ 2 000/jour, Outlook.com ≈ 300/jour. Pour 1 000 emails d'un coup, utilisez un service d'envoi (Brevo, Mailjet, Amazon SES…) ou un domaine dédié. Réglez la « limite globale par jour » dans les Paramètres pour ne jamais la dépasser.
- **Domaine** : configurez SPF, DKIM et DMARC sur votre domaine, et idéalement utilisez un sous-domaine / domaine secondaire pour la prospection.
- **RGPD / CNIL (B2B)** : la prospection par email vers des professionnels est autorisée si le message est en lien avec leur activité, si vous indiquez qui vous êtes et si un moyen simple de se désinscrire est proposé. Respectez immédiatement les demandes de désinscription (onglet *Désinscrits*). La prospection vers des particuliers nécessite leur consentement préalable.
- **Lien de désinscription** : si l'outil est accessible depuis Internet, indiquez son adresse publique dans les Paramètres pour activer un vrai lien « Se désinscrire » (et l'en-tête `List-Unsubscribe`). Sinon, les emails invitent à répondre « STOP ».
