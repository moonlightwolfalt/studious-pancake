FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
# mirror v1.mope.io, deobfuscate client.js and apply the patches (generated game data is committed)
RUN bun mopeio.ts build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "mopeio.ts", "serve"]
