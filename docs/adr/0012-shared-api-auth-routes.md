# ADR-0012: Account routes on the shared Connection API

- Status: Accepted for the unreleased DSH 0.1.5-rc.2 compatibility fix
- Baseline: dsh-grok-provider 1.0.4, commit 693b564

The desktop upgrade to Harness 0.1.5-rc.2 leaves the Grok settings page visible,
but POST /grok-auth/status returns HTTP 405 and diagnostics cannot return the
plugin version. The actual HostConnectionService custom-channel registration
throws `cannot get property "webServer" without inject`. Adding webServer to the
plugin's injection does not repair the service-owned context access.

Register six exact POST routes below /api/grok-auth through the public
connection.fetch registry. The browser uses the existing Connection RPC caller
with channel /api and namespaced methods. The host-owned carrier retains browser
session authentication, Host/Origin checks and buffered-body limits. The plugin
uses the host's clientRequestSchema and rejects a method/path mismatch before
calling any account operation. Credential, login, logout, model and billing
contracts are unchanged. Routes are removed with the plugin's fiber.

This source targets Harness 0.1.5-rc.2. It is not a published replacement for the
existing 1.0.4 npm artifact. Validation includes the real Connection registry,
request correlation, malformed input, cancellation, route disposal and the
existing host/client/protocol suite. A new release must assign a new version and
complete the repository's existing release process.

## Local verification, 2026-09-13

- Node 24.19.0; fresh locked npm install: 26 audited packages, zero vulnerabilities.
- `npm test`: 278 tests, 276 passed, 2 skipped, 0 failed. The skips are pre-existing platform-specific checks; this run is macOS only.
- Real desktop-bundled DSH 0.1.5-rc.2, separate temporary DSH_HOME: status,
  diagnostics and dashboard all return HTTP 200. Official CLI 1.0.5 is ready;
  models grok-4.6 and grok-4.5 and quota are available. The first model request
  failed transiently; a direct catalog read and a repeated dashboard read passed.
- The shared carrier rejects an unauthenticated request with 401 and a foreign
  Origin with 403. No login, logout or credential replacement was performed.
- The installed desktop remains on the original managed plugin generation.
  Neither npm publication nor current-profile installation was performed.
- Live model generation and Windows UI/login were not exercised in this fix.
