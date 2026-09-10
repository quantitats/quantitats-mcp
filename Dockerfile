# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# quantitats-mcp — a single bundled file on distroless/nodejs.
# -----------------------------------------------------------------------------
# Every platform is built by whichever runner picks the job up, with QEMU
# standing in for anything that runner is not. That is affordable here in a way
# it would not be for a compiler: nothing in this image is architecture-specific
# — the output is JavaScript, and the only work is npm ci, tsc and esbuild — so
# an emulated build produces byte-identical output to a native one and costs only
# time. See .github/workflows/ci.yml, which builds both platforms in one
# invocation and pushes the manifest directly.
#
# What this image IS: an MCP server that speaks JSON-RPC over stdin and stdout.
# It listens on no port and serves no HTTP, so it is run the way a client
# launches a local tool rather than the way a service is deployed:
#
#   docker run -i --rm \
#     -e QUANTITATS_API_KEY_ID=ak_... \
#     -e QUANTITATS_API_SECRET=... \
#     <image>
#
# `-i` is not optional. Without a stdin the transport has nothing to read and
# the process exits having answered nothing.
FROM node:22-alpine AS build
WORKDIR /src

# Dependency resolution is cached separately from the source. `npm ci` and not
# `npm install`: the lockfile is what makes this build reproducible, and an
# install free to resolve a different tree builds something nobody tested.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# The version the built server reports.
#
# Passed in rather than derived here, because .dockerignore excludes .git — an
# image build cannot see the repository, and a version that quietly said
# "unknown" on every published image would be worse than one that is wrong.
# CI computes it once and passes it to every architecture, so the image tag and
# the string a client reads from serverInfo cannot disagree. See
# scripts/version.mjs for what an absent value falls back to.
ARG BUILD_VERSION=""
ENV QUANTITATS_MCP_VERSION=$BUILD_VERSION

# Typecheck inside the image build as well as in CI. The image is the artifact
# that ships; a build that cannot fail on a type error is a build that can ship
# one that CI happened not to run.
RUN npm run typecheck
RUN npm run build

# -----------------------------------------------------------------------------
# distroless/nodejs ships a Node runtime, ca-certificates and nothing else — no
# shell, no package manager. ca-certificates is not optional: every request this
# process makes is HTTPS to the published API.
#
# ENTRYPOINT is already /nodejs/bin/node, so CMD is just the script path — not
# ["node", "..."], which would try to run a file called "node".
# debian13, not debian12: the Debian 12 Node images reached end of life in
# January 2026 and the registry marks nodejs22-debian12 deprecated.
FROM gcr.io/distroless/nodejs22-debian13:nonroot
WORKDIR /app
# .mjs because nothing beside it declares "type": "module" — see scripts/build.mjs.
COPY --from=build /src/dist/server.mjs /app/server.mjs
COPY --from=build /src/dist/server.mjs.map /app/server.mjs.map

# The bundle ships with a source map, which is only of any use if Node is told
# to read it — otherwise a stack trace points into generated code and the map is
# dead weight in the image.
ENV NODE_OPTIONS=--enable-source-maps

# Restated as a label so the version is readable with `docker inspect`, without
# starting the container to ask it.
ARG BUILD_VERSION=""
LABEL org.opencontainers.image.title="quantitats-mcp" \
      org.opencontainers.image.description="MCP server over the published Quantitats trading API." \
      org.opencontainers.image.version="$BUILD_VERSION" \
      org.opencontainers.image.licenses="MIT"

USER nonroot:nonroot

# No EXPOSE and no HEALTHCHECK. There is no port: the transport is stdio, and a
# container that has exited because its stdin closed is doing exactly what it
# should. There is also no shell in this image to run a healthcheck with.
CMD ["/app/server.mjs"]
