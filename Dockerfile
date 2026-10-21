# Gladiator als Container (Selbsthosten, optional): `docker compose --profile app up -d`.
# Die bestehende Betriebsart (Node direkt + systemd, siehe SELFHOST.md) bleibt unverändert.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Abhängigkeiten zuerst (Cache), dann der Code; tsx führt TypeScript direkt aus
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run build:web

# Nie als root laufen
RUN chown -R node:node /app
USER node

EXPOSE 3010
ENTRYPOINT ["sh", "deploy/docker/entrypoint.sh"]
CMD ["start"]
