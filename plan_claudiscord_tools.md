# Plan - tools Claudiscord

## Probleme

En mode sandbox, `allowedTools` ne suffit pas pour neutraliser proprement les tools qui entrent en conflit avec l'architecture Claudiscord, en particulier `CronCreate`, `CronDelete`, `CronList`, `Monitor` et quelques tools "meta" (`AskUserQuestion`, `EnterPlanMode`, etc.). Le projet a deja son propre scheduler persistant base sur `scheduled-jobs.json` + `node-cron`, donc les outils de scheduling internes a Claude Code creent un second systeme concurrent.

## Constats verifies

### 1. La policy actuelle est globale, pas profilee par contexte

Sources projet :

- `src/config.js:30-31`
- `src/claude.js:18-23,38-42`
- `src/container.js:117-137`
- `index.js:45-60`
- `src/scheduler.js:230-249`

Constat :

- `ALLOWED_TOOLS` et `DISALLOWED_TOOLS` sont definis une seule fois dans `src/config.js`.
- `buildClaudeArgs()` injecte ces flags par defaut dans tous les appels Claude CLI.
- Les memes bases sont reutilisees pour :
  - DM admin sur l'hote
  - DM sandbox dans le container
  - jobs admin
  - jobs sandbox

Conclusion : le projet n'a pas aujourd'hui de notion explicite de "tool policy profile" par contexte.

### 2. Le prompt metier existe deja, mais la policy technique reste centralisee dans un gros string

Sources projet :

- `src/prompts.js:7-24`
- `CLAUDE.md:112-118`

Constat :

- Le prompt explique deja clairement la regle metier : il faut utiliser le systeme de scheduling Claudiscord via le fichier JSON, et ne pas utiliser d'autres mecanismes (`crontab`, `setTimeout`, `node-cron`, etc.).
- En revanche, le blocage technique repose surtout sur `DISALLOWED_TOOLS`, une blacklist monolithique stockee dans `src/config.js`.

Conclusion : il y a deja une bonne couche "intention metier", mais la couche "enforcement technique" est encore peu structuree.

### 3. `allowedTools` ne restreint pas la disponibilite des tools

Sources externes :

- sortie locale `claude --help` (2026-04-11)
- https://code.claude.com/docs/en/cli-reference
- https://github.com/anthropics/claude-code/issues/20242

Constat :

- La CLI documente `--allowedTools` comme une liste de tools qui s'executent sans prompt.
- La meme doc precise explicitement : pour restreindre les tools disponibles, il faut utiliser `--tools`.

Conclusion : utiliser seulement `allowedTools` ne suffit pas pour retirer des capabilities au modele.

### 4. Les tools Cron n'ont pas de permission prompt

Source externe :

- https://code.claude.com/docs/en/tools-reference

Constat :

- `CronCreate`, `CronDelete`, `CronList` sont listes avec `Permission Required: No`.

Conclusion : une strategie basee uniquement sur l'approval/permission prompt ne peut pas etre suffisante pour ces tools.

### 5. L'historique du repo confirme que la suppression de `disallowedTools` a deja echoue

Sources git :

- commit `e26e3eb` - suppression de `--disallowedTools`
- commit `d9ad86b` - restauration de `--disallowedTools`

Constat :

- Le commit `e26e3eb` a tente d'unifier host et sandbox en s'appuyant uniquement sur `--allowedTools`.
- Le commit `d9ad86b` l'a revert, avec ce motif : sans `--disallowedTools`, les users sandbox voient encore des tools deferes (`CronCreate`, `Monitor`, etc.).

Conclusion : dans ce projet, le besoin d'un deny explicite est deja valide par l'experience.

### 6. ToolSearch complique le sujet

Sources externes :

- https://code.claude.com/docs/en/tools-reference
- https://github.com/anthropics/claude-code/issues/31002

Constat :

- La doc officielle indique que `ToolSearch` sert a charger les deferred tools a la demande.
- Une issue publique (`#31002`) rapporte que, depuis Claude Code v2.1.69, meme les built-in system tools sont deferes derriere `ToolSearch`.
- La version locale observee est `claude 2.1.101`.

Conclusion :

- Il faut rester prudent avant de desactiver `ToolSearch` globalement.
- Cette piste risque de casser plus que les seuls tools problematiques.

## Direction recommandee

### Recommandation principale

Ne pas chercher a supprimer la denylist. La rendre plus elegante en la sortant du runtime global et en la transformant en vraie policy sandbox.

### Option la plus propre

Mettre la policy sandbox dans l'image Docker via un fichier de managed settings, par exemple :

- chemin cible : `/etc/claude-code/managed-settings.json`
- mecanisme : `permissions.deny`

Sources externes :

- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/permissions
- https://code.claude.com/docs/en/tools-reference

Pourquoi c'est plus propre :

- la policy devient declarative
- elle est attachee au sandbox lui-meme, pas dispersee dans le code Node.js
- les managed settings ont la priorite la plus forte
- la separation host / sandbox devient plus nette

### Important : niveau de certitude

La documentation officielle dit qu'ajouter un tool au `deny` le desactive completement. Je n'ai pas valide localement, dans ce projet, si un `permissions.deny` livre via managed settings masque exactement les memes tools deferred que `--disallowedTools`. Cette verification reste a faire par un test cible.

## Architecture cible proposee

### 1. Introduire des profils de tools explicites

Au lieu de :

- `ALLOWED_TOOLS`
- `DISALLOWED_TOOLS`

utiliser des profils nommes, par exemple :

- `adminDm`
- `sandboxDm`
- `adminJob`
- `sandboxJob`

Chaque profil devrait porter clairement :

- `tools` : surface maximale disponible
- `allowedTools` : auto-approval uniquement
- `disallowedTools` : override ponctuel / filet de securite
- eventuellement `extraArgs`

Interet :

- lecture plus simple
- moins d'ambiguite entre host et sandbox
- plus facile de faire evoluer jobs et DM separement

### 2. Mettre l'enforcement sandbox dans l'image

Dans `Dockerfile`, ajouter la policy sandbox sous forme de managed settings avant `USER claude`.

Exemple de direction :

```json
{
  "permissions": {
    "deny": [
      "CronCreate",
      "CronDelete",
      "CronList",
      "Monitor",
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "EnterWorktree",
      "ExitWorktree",
      "NotebookEdit"
    ]
  }
}
```

Note : la liste exacte doit rester alignee avec les besoins Claudiscord. Les tools MCP d'auth (`mcp__claude_ai_Gmail__authenticate`, etc.) et certains skills internes peuvent aussi faire partie de cette policy si on veut conserver le comportement actuel.

### 3. Garder un filet de securite cote runtime pendant la transition

Meme si la cible ideale est une policy dans le container, garder temporairement `--disallowedTools` cote sandbox peut etre prudent tant que le comportement n'a pas ete valide en conditions reelles.

Position recommandee :

- court terme : policy Docker + `--disallowedTools` sandbox
- moyen terme : si les tests montrent que la policy Docker suffit, simplifier ensuite le runtime

### 4. Continuer a utiliser le prompt metier, mais ne pas lui demander seul de faire la police

Le prompt actuel sur le scheduling est bon et doit rester.

Mais il ne doit pas etre la defense principale contre `CronCreate` & co. Le prompt explique l'intention ; la policy technique doit porter le blocage.

## Ce que je ne recommande pas

### 1. S'appuyer uniquement sur `allowedTools`

Raison :

- ce flag ne restreint pas la disponibilite
- c'est deja documente par la CLI
- c'est deja contredit par l'historique du repo

### 2. Desactiver `ToolSearch` globalement

Raison :

- les deferred tools semblent faire partie du fonctionnement normal recent de Claude Code
- cela risque de casser des built-ins utiles, pas seulement `Cron*`

### 3. Laisser une seule policy globale pour tous les contextes

Raison :

- les besoins host/admin et sandbox ne sont pas les memes
- les jobs et les DM n'ont pas non plus exactement les memes contraintes

## Plan d'implementation propose

1. Creer un module de profils, par exemple `src/tool-policies.js`, pour decrire les policies par contexte.
2. Brancher `index.js` et `src/scheduler.js` sur ces profils explicites au lieu de consommer directement les constantes globales.
3. Ajouter une policy sandbox en managed settings dans l'image Docker.
4. Rebuilder l'image sandbox et recreer un container de test.
5. Verifier en pratique, dans le container, que `CronCreate`, `CronDelete`, `CronList`, `Monitor` et les autres tools bloques ne sont plus utilisables.
6. Si les managed settings suffisent reellement, simplifier ensuite le runtime sandbox.
7. Documenter la nouvelle architecture dans `CLAUDE.md`.

## Tests de validation a faire

### A. Sandbox DM

Verifier qu'un user sandbox ne peut pas :

- creer un cron interne Claude Code
- lancer `Monitor`
- entrer en plan/worktree si on choisit de les bloquer

Verifier qu'il peut toujours :

- lire/ecrire dans son workspace
- utiliser Bash
- utiliser WebFetch/WebSearch si on les conserve

### B. Sandbox job

Verifier qu'un job sandbox continue a fonctionner dans le scheduler Claudiscord sans reintroduire les tools bloques.

### C. Admin host

Verifier que le mode admin ne perd pas de capabilities utiles a cause d'une policy trop globale.

## Resume

La meilleure piste n'est pas "supprimer la denylist", mais "arreter de la porter comme un gros string global". La direction la plus propre est :

- profils de tools explicites dans le code
- policy sandbox declarative dans l'image Docker
- prompt metier conserve comme couche de guidage
- `--disallowedTools` garde temporairement comme filet de securite tant que la policy Docker n'est pas validee
