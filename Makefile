COMPOSE = docker compose
EXEC = $(COMPOSE) exec salon

.PHONY: help up down restart logs mock mock-logs sh typecheck projet

.DEFAULT_GOAL := help

help: ## Affiche les commandes disponibles
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'

up: ## Démarre le conteneur du Salon
	$(COMPOSE) up -d

down: ## Arrête le conteneur du Salon
	$(COMPOSE) down

restart: ## Redémarre le conteneur du Salon
	$(COMPOSE) restart

logs: ## Affiche les logs du serveur
	$(COMPOSE) logs -f salon

mock: ## Démarre le faux serveur OpenAI
	$(COMPOSE) up -d mock

mock-logs: ## Affiche les logs du faux serveur
	$(COMPOSE) logs -f mock

sh: ## Ouvre un shell dans le conteneur
	$(EXEC) bash

typecheck: ## Vérifie la compilation TypeScript
	$(EXEC) npm run typecheck

projet: ## Lance Le Salon
	$(EXEC) npm run projet
