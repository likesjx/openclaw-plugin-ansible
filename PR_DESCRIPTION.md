PR: Add package-lock and build hints for production deployments

Summary
- Add guidance and a small lockfile / build hints to make in-production plugin deployment reproducible and to avoid expensive in-place npm installs on low-memory production hosts.

Proposed changes (to be applied in the openclaw-plugin-ansible repo)
1) Commit package-lock.json generated from a stable node/npm version (if not already present).
2) Add a short CONTRIBUTING.md / BUILD.md with these suggestions:
   - Prefer building the plugin artifact (npm ci && npm run build) in CI and committing the built dist artifacts (or publishing the plugin to a private registry) rather than building on the production host.
   - If in-place installation on host is required, use npm ci --omit=dev or install only the necessary runtime deps (e.g., yjs) and avoid full npm ci on memory-constrained hosts.
3) Add a lightweight 'prepare-release.sh' script that runs npm ci --omit=dev && npm run build && tar -czf dist-release.tgz dist package.json package-lock.json openclaw.plugin.json

Why
- Production hosts (vps-jane) may not have adequate memory to run full npm ci safely, leading to OOM/killed installs (exit 137) and partial failures.
- Building in CI and shipping artifacts avoids runtime installs and makes rollbacks simpler.

How to open the PR
- Create a branch (e.g., chore/add-build-hints)
- Add package-lock.json if appropriate
- Add BUILD.md and prepare-release.sh
- Open PR describing the rationale and include a checklist for maintainers

I can open the PR draft on your behalf if you grant access to push to the remote repo. Otherwise, you can copy this PR description into GitHub when creating the PR.
