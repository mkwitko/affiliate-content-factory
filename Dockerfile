FROM node:24-bookworm-slim

ENV COREPACK_HOME=/usr/local/share/.cache/node/corepack
ENV PNPM_HOME=/usr/local/share/.cache/node/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates openssl ffmpeg fontconfig fonts-inter \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.19.0 --activate

# Caption fonts beyond Inter (OFL, see docs/operations/fonts.md).
COPY deploy/fonts/*.ttf /usr/local/share/fonts/money-maker/
RUN fc-cache -f

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/providers/prisma7.config.ts packages/providers/prisma7.config.ts
COPY packages/providers/prisma/schema.prisma packages/providers/prisma/schema.prisma

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

ENV NODE_ENV=production

CMD ["node", "apps/api/dist/server.js"]
