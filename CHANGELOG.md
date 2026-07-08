# Changelog

All notable changes to `@coralogix/opentelemetry` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the package is pre-1.0, breaking changes are released as minor version bumps.

## [0.4.0] - Unreleased

### Changed

- **Breaking (transaction naming output):** `CoralogixTransactionSampler` now resolves the
  **full** route template for prefix-mounted (`app.use('/api', router)`) and arbitrarily
  nested Express routers. Previously the mount prefix was dropped (e.g. `/users/:id`) or the
  route failed to resolve at all (falling back to the bare span name); routes now resolve
  with the full prefix (e.g. `GET /api/deep/orders/:oid`). Works on both Express 4 and
  Express 5. This changes the emitted transaction names for affected applications —
  dashboards, alerts, and saved views keyed on the previous names must be updated. The
  TypeScript public API is unchanged.

## [0.3.0] - 2026-07-07

### Fixed

- Restore Express 4 boot: on Express 4, `app.router` is a getter that throws
  (`'app.router' is deprecated!`), so `setExpressApp` threw during app startup (crashing
  NestJS 11 / Express 4 apps). `setExpressApp` now reads `app._router` first and falls back
  to the public `app.router` getter on Express 5. (#34)

### Changed

- Move `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` to `peerDependencies`. These
  packages carry global state (TracerProvider, context manager); shipping them as direct
  dependencies risked duplicate installs that break the global context for OpenTelemetry v2
  consumers. (#34)

## [0.2.1] - 2026-07-01

### Fixed

- Sampler route resolution now reads the stable `url.path` attribute first and falls back to
  the legacy `http.target`, so Express route-template transaction naming works across all
  HTTP semantic-convention modes (legacy, stable, and dup). `http.target` was removed from
  the stable `@opentelemetry/semantic-conventions` entry point, and which attribute an
  instrumentation emits depends on `OTEL_SEMCONV_STABILITY_OPT_IN`. (#33)

## [0.2.0] - 2026-06-30

### Changed

- **Breaking:** bump `@opentelemetry/sdk-trace-base` to 2.x, dropping the vulnerable OpenTelemetry
  core `<2.8.0`. (#32)

## [0.1.4] - 2026-06-22

### Added

- Support for Express 5 / NestJS 11 in `setExpressApp` (transaction sampler route
  resolution). (#27)

### Documentation

- Expanded the README with more information about the module. (#26)

## [0.1.3] - 2024-07-29

### Changed

- Express-related updates to the transaction sampler. (#19)
- README fix and version update. (#21)

## [0.1.2] - 2023-12-04

### Added

- `transaction root` attribute on the transaction sampler. (#16)

## [0.1.1] - 2023-11-22

### Fixed

- Fix a broken import. (#15)

### Changed

- Set up publishing to the private repository. (#13, #14)

## [0.1.0] - 2023-11-22

### Added

- Initial release: `CoralogixTransactionSampler`. (#6)

[0.4.0]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/coralogix/coralogix-opentelemetry-js/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/coralogix/coralogix-opentelemetry-js/releases/tag/v0.1.0
