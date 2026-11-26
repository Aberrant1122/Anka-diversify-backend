# Operator builds and reviews this image separately. Supply a reviewed base
# image by immutable digest; no tag/default or automatic download at dispatch.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
LABEL org.anka.sandbox.protocol="1"
COPY runner.cjs /opt/anka/runner.cjs
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/opt/anka/runner.cjs"]
