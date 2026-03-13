BUILD and release recommendations

1. Build in CI: run npm ci --omit=dev && npm run build
2. Commit built artifacts (dist) or publish to a registry to avoid building on low-memory production hosts.
