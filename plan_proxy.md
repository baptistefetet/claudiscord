# Plan : proxy d'auth Anthropic pour le sandbox (idée, non implémentée)

> Statut : **idée notée, pas implémentée.** À reprendre plus tard.
> Objectif : que le token Anthropic ne soit **jamais présent** dans le container sandbox,
> pour qu'un agent (potentiellement victime de prompt injection via la skill browser et
> tournant en `--dangerously-skip-permissions`) ne puisse pas l'exfiltrer.

## Contexte / menace

Le sandbox bind-monte tout `SANDBOX_HOME` dans le container (`/home/claude`). Les secrets
qui s'y trouvent sont **lisibles par l'agent**, car le process claude tourne *en tant que*
l'utilisateur qui possède ces fichiers — les permissions `0600` ne protègent donc de rien
contre l'agent lui-même. Canaux d'exfil nombreux : browser (chromium), `curl`,
`gws-drive-upload`, etc. + réseau bridge ouvert.

Décisions déjà prises (mai 2026) :
- **Clé SSH supprimée** du sandbox (`~/.ssh/id_ed25519` + `.pub`) et mention retirée du
  `CLAUDE.md` du sandbox. Plus de `git push` depuis le sandbox.
- Comptes **Google / gws / notebooklm** : compte jetable sans valeur → risque accepté.
- **Reste un seul secret à protéger : le token Anthropic** (`~/.claude/.credentials.json`).

## Pourquoi un proxy (et pas une allowlist réseau)

Une allowlist de domaines est incompatible avec un browser généraliste (naviguer librement
= canal d'exfil ouvert par définition). Le bon modèle n'est pas « bloquer le réseau » mais
**exposer une capacité, pas le secret** : le token vit côté hôte, le container ne reçoit
qu'une URL vers un proxy local qui injecte l'auth.

## Architecture retenue : reverse-proxy explicite (PAS de MITM)

Point clé : **Claude Code honore `ANTHROPIC_BASE_URL`**. On *redirige* donc le client vers
notre endpoint au lieu d'intercepter sa connexion TLS. Résultat = deux connexions séparées,
terminées normalement chacune. **Aucun déchiffrement de TLS tiers, aucune CA custom.**

```
container (claude)
  ANTHROPIC_BASE_URL=http://<gateway-docker>:<port>
  ANTHROPIC_API_KEY=dummy            # bidon, le proxy la jette
        │  HTTP simple (sur le bridge / loopback → pas de TLS à gérer)
        ▼
proxy sur l'hôte (dans claudiscord)
  - détient le VRAI secret Anthropic
  - jette la clé bidon, injecte le vrai header :
      * x-api-key: <clé>                         (si clé API console)
      * ou Authorization: Bearer <oauth>
        + anthropic-beta: oauth-…                (si OAuth .credentials.json)
  - forwarde vers https://api.anthropic.com via client HTTPS standard (fetch/https)
  - relaie le flux SSE en streaming
        │  HTTPS normal (TLS client classique)
        ▼
api.anthropic.com
```

## Implémentation (esquisse)

- ~1 petit module, ex. `src/anthropic-proxy.js`, démarré au boot de claudiscord.
- Serveur HTTP qui n'accepte QUE les chemins nécessaires (`POST /v1/messages`,
  `/v1/messages/count_tokens`) vers `api.anthropic.com` — **sinon l'agent s'en sert comme
  relais SSRF ouvert**.
- Binder le proxy sur l'IP du bridge docker (pas `0.0.0.0` exposé), ou réseau user-defined
  dédié. Le container joint l'hôte via la gateway du bridge.
- Côté `container.js` : passer `-e ANTHROPIC_BASE_URL=…` et `-e ANTHROPIC_API_KEY=dummy`
  au `docker create`/`docker exec`, et **cesser d'écrire** `.credentials.json` dans le
  volume (supprimer `writeCredentials`/`/login` côté sandbox, ou le neutraliser).

## Points d'attention

- **Streaming SSE** : bien relayer le flux (piper la réponse upstream vers le client), ne
  pas bufferiser.
- **OAuth = refresh** : `.credentials.json` (login abonnement) **expire** et doit être
  rafraîchi. Le proxy devrait gérer le refresh, OU — plus simple — héberger une **clé API
  console** (stable, pas de refresh) côté hôte.
- **HTTP vs HTTPS sur le leg entrant** : HTTP simple suffit sur le bridge privé. Si claude
  exigeait HTTPS, générer un cert auto-signé pour *notre* endpoint (NODE_EXTRA_CA_CERTS dans
  le container) — ça reste notre cert pour notre endpoint, **pas** du MITM d'Anthropic.
- Le proxy protège le **secret**, pas le **quota** : l'agent peut toujours *utiliser* Claude
  (et cramer du quota) — c'est voulu.

## Hors périmètre de ce plan

- **Protéger des creds gws / clients non-redirigeables** : eux tapent `*.googleapis.com` en
  dur, pas d'override de base URL → nécessiterait un **MITM transparent** (CA custom dans le
  trust store, déchiffre/rechiffre). Plus lourd. Non retenu (compte gws jetable).
- **Inspection / blocage d'egress du browser** (DLP sur HTTPS arbitraire) : également du
  ressort d'un MITM transparent. Autre chantier, optionnel.

## Réf

Pattern identique à « OneCLI » de nanoclaw (https://github.com/nanocoai/nanoclaw), qui fait
exactement ça via `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` — ici en version minimale
maison, sans le reste de leur archi (SDK, 1 container/groupe, micro-VM) dont on n'a pas
besoin en single-user.
