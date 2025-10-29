
FROM oven/bun:1.1.29

WORKDIR /app

COPY . .

RUN bun install --production

EXPOSE 3000

# Comando padrão pra iniciar o app
CMD ["bun", "run", "start"]
