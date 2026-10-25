FROM oven/bun:1
WORKDIR /app

# no lockfile on purpose: its format depends on the bun version that wrote it, and a mismatch
# with the image's bun fails the build ("bun install --frozen-lockfile ... exit code 1")
COPY package.json ./
# --ignore-scripts: skip native builds (webcrack's optional isolated-vm needs a compiler; we use node:vm)
RUN bun install --ignore-scripts

COPY . .
# mirror v1.mope.io, deobfuscate client.js and apply the patches (generated game data is committed)
RUN bun mopeio.ts build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "mopeio.ts", "serve"]
