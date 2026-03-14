FROM oven/bun:1.1.29

WORKDIR /app

# Variavel de build
ARG APP_VERSION=unknown

# Variaveis de ambiente fixas (seguras, sem secrets)
ENV DOCKER_ENV=true
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
ENV PORT=3000

# Secrets sao passados em runtime via -e ou Portainer
# RABBITMQ_URL, AUTH_TOKEN, RABBITMQ_VHOST, MAX_RECONNECT_ATTEMPTS

COPY package.json ./

RUN bun install --production

COPY . .

EXPOSE 3000

CMD ["bun", "run", "start"]
