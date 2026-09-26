# Debian-based (not alpine) so sharp's and ffmpeg's prebuilt native
# binaries install cleanly without extra build tooling.
FROM node:20-bookworm-slim

WORKDIR /app

# Install dependencies first so this layer is cached unless package.json changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Now copy the rest of the app.
COPY server.js ./
COPY public ./public

# Uploads live here; mount a volume over this path to persist/access files
# from the host (see docker-compose.yml or the README's `docker run` example).
RUN mkdir -p uploads/.thumbnails

ENV PORT=8080
EXPOSE 8080

# Bind explicitly to 0.0.0.0 (server.js already does this) so Docker's
# port publishing / host networking can reach it.
CMD ["node", "server.js"]
