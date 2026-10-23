# Le Salon

Mini-projet de chat d'équipe avec un participant IA, réalisé en TypeScript et exécuté
entièrement dans Docker.

## Démarrage

```bash
cp .env.example .env
make up
```

Le serveur sera disponible sur <http://localhost:3001> après l'implémentation du
serveur applicatif. Le conteneur reste actif entre-temps pour permettre les vérifications
et les prochains lots.

## Commandes utiles

```bash
make help
make typecheck
make logs
make sh
make down
```

Les dépendances npm sont installées dans le conteneur et dans le volume Docker
`salon_node_modules`. Rien n'est installé dans l'environnement local.
