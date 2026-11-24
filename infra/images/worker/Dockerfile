# Worker, scheduler, fetch sidecar and egress/database gateways (design 0004 §3). One image, one uid per role.
# Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
FROM python:3.12.16-slim-trixie@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b
# Debian security fixes the pinned base predates (design 0004 §7, CI job supply-chain): exact versions, signed by
# Debian, applied until the base image is rebuilt upstream and re-locked. Remove a line once the base carries it.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then echo 'Acquire::https::CaInfo "/run/secrets/extra_ca";' > /etc/apt/apt.conf.d/99extra-ca; fi; \
    apt-get update \
 && apt-get install -y --no-install-recommends \
      libc6=2.41-12+deb13u5 libc-bin=2.41-12+deb13u5 zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99extra-ca
RUN groupadd -g 10010 mandato \
 && useradd -u 10001 -g mandato -M -s /usr/sbin/nologin worker \
 && useradd -u 10002 -M -s /usr/sbin/nologin scheduler \
 && useradd -u 10003 -g mandato -M -s /usr/sbin/nologin fetch \
 && useradd -u 10004 -M -s /usr/sbin/nologin egress \
 && install -d -o 10003 -g 10010 -m 0770 /run/mandato-fetch \
 && install -d -o 10001 -g 10010 -m 0770 /var/lib/mandato/raw
WORKDIR /app
COPY workers/requirements.txt workers/requirements.txt
# extra_ca: optional build secret for a TLS-intercepting build proxy; never stored in a layer.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export PIP_CERT=/run/secrets/extra_ca; fi; \
    pip install --no-cache-dir --no-deps --require-hashes -r workers/requirements.txt
COPY workers workers
ENV PYTHONPATH=/app PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MANDATO_FETCH=sidecar \
    MANDATO_FETCH_SOCKET=/run/mandato-fetch/fetch.sock
USER 10001
