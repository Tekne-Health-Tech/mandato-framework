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
# Debian security fixes the pinned base predates (design 0004 §7, CI job supply-chain): exact versions, signed by
# Debian, applied until the base image is rebuilt upstream and re-locked. Remove a line once the base carries it.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then echo 'Acquire::https::CaInfo "/run/secrets/extra_ca";' > /etc/apt/apt.conf.d/99extra-ca; fi; \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      libc6=2.41-12+deb13u5 libc-bin=2.41-12+deb13u5 zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
      libgssapi-krb5-2=1.21.3-5+deb13u2 libk5crypto3=1.21.3-5+deb13u2 libkrb5-3=1.21.3-5+deb13u2 \
      libkrb5support0=1.21.3-5+deb13u2 \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99extra-ca
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=node /app /app
# gosu (a Go binary of the Postgres entrypoint, built with an older Go stdlib) is never used here: the entrypoint is
# the mandato CLI and the image runs as uid 10005. Removing it drops its Go stdlib findings from the scan.
RUN useradd -u 10005 -M -s /usr/sbin/nologin tools && rm -f /usr/local/bin/gosu
USER 10005
ENTRYPOINT ["node", "/app/packages/core-config/bin/mandato.js"]
