# Changelog

All notable changes to `__PACKAGE_NAME__` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The first release is `0.1.0`
(`package.json`): on release, move the entries below under `## [0.1.0] - <date>` and tag `v0.1.0`.

## [Unreleased]

### Added

- Service scaffold generated from the platform template (`templates/nest-service`): configuration,
  health, metrics, OpenAPI, authentication, migrations, CI, Docker image and
  `GET /api/v2/__SERVICE_NAME__/methodology`.
<!-- @template:if example -->
- Example feature: vessel notes CRUD with audit events, and the `estimateArrival` domain function.
<!-- @template:endif -->
<!-- @template:if detector -->
- Detector SDK wiring: `events` hypertable, `GET /api/v2/__SERVICE_NAME__/detectors` and the toy
  `speed_limit` detector.
<!-- @template:endif -->

[Unreleased]: https://github.com/DarmawanWeb/__PACKAGE_NAME__/commits/main
