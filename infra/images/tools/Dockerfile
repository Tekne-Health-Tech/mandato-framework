# Operator tools for `mandato instance up`: psql (from the Postgres image) plus Node for the mandato CLI.
# Runs only as a one-shot container on the database network; never part of the running instance.
# Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
FROM node:22.23.4-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6 AS node
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && pnpm install --frozen-lockfile --ignore-scripts

FROM postgres:16.15-trixie@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=node /app /app
RUN useradd -u 10005 -M -s /usr/sbin/nologin tools
USER 10005
ENTRYPOINT ["node", "/app/packages/core-config/bin/mandato.js"]
