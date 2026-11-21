# Build progress — AIS Maritime Intelligence v2

Catatan progres pembangunan v2 (dihapus/diringkas jadi CHANGELOG setelah selesai). Diperbarui setiap
tahap selesai supaya pekerjaan bisa dilanjutkan kapan saja, termasuk dari sesi baru setelah limit reset.

## Keputusan yang sudah diambil
- Multi-repo + 1 repo pusat (`ais-its-platform`); prefix repo `ais-its-*`; nama produk **AIS Maritime Intelligence**.
- MVP repos di-rename dengan riwayat utuh dan tag `mvp-final`: `ais-its-platform`, `ais-its-web`, `ais-its-mvp-api`.
- Stack: Node 24, pnpm 10, TypeScript 6 (ESM), NestJS 12 + Fastify 5, PostgreSQL 17 + TimescaleDB 2.32 + PostGIS 3.7,
  NATS JetStream (+MQTT), Valkey, S3-compatible storage, Traefik, OpenTelemetry/Grafana; web React 19 + Vite 8 +
  TanStack Query + MapLibre/deck.gl.
- Domain dipisah: pipeline AIS hanya data; **safety** (EWS pipa, risiko tubrukan CPA/TCPA, detektor keselamatan lain),
  **surveillance** (transhipment, illegal fishing, dark vessel, anomali, pelanggaran zona), **geo** (zona/geofence),
  emission (CII/SEEMP), telemetry, fleet, auth, notification. Semua detektor memakai Detector SDK bersama.
- Setiap rumus/aturan harus punya sumber (lihat `docs/METHODOLOGY.md`, `docs/references/*`, spesifikasi §17).

## Tahap
| # | Tahap | Status |
|---|---|---|
| 1 | Spesifikasi + kerangka repo pusat | ✅ selesai |
| 2 | Fondasi v2: `@darmawanweb/ais-its-contracts` 0.2 + `@darmawanweb/ais-its-nest` (kit + Detector SDK) + template (+review, hardening) | 🔄 berjalan (contracts 0.1.0 selesai; dilanjutkan setelah limit) |
| 2b | Infrastruktur repo pusat: compose, Postgres bootstrap 9 role, NATS+MQTT, Traefik (18 router), Grafana, Helm `ais-its-*`, smoke 150/150 | ✅ selesai |
| 2c | Quick fix MVP: BE `fix/phase-0-hardening` (242 test) dan FE `fix/phase-0` | ✅ selesai, ter-push |
| 2d | Riset metodologi & referensi (inventaris 90 rumus, 127 referensi ✅; verifikasi + penulisan 🔄) | 🔄 berjalan |
| 3 | Rename `ais-its` + pemisahan safety/geo/surveillance + Detector SDK + contracts v0.2 | 🔄 digabung ke tahap 2 (spec v1.1 ✅) |
| 4 | 9 service backend: auth, pipeline, fleet, telemetry, emission, geo, safety, surveillance, notification (build → review → fix) + migrator Mongo | ⏳ |
| 5 | Web v2 (foundation → fitur → integrasi) | ⏳ |
| 6 | Integrasi, E2E seluruh stack, dokumentasi, push semua repo | ⏳ |

## Cara melanjutkan (untuk sesi berikutnya)
1. Clone `ais-its-platform` branch `feat/platform-v2` beserta repo `ais-its-*` lain yang sudah ter-push.
2. Siapkan registry npm lokal (Verdaccio) untuk scope `@darmawanweb` bila package belum ada di GitHub Packages,
   dan image Docker yang dipakai test (`timescale/timescaledb-ha:pg17`, `nats`, `valkey/valkey:8-alpine`, `axllent/mailpit`, `rustfs/rustfs`).
3. Lanjutkan tahap pertama yang belum ✅ pada tabel di atas; semua instruksi teknis ada di `docs/PLATFORM_SPEC.md`.

## Catatan limit pemakaian
- Jendela limit 5 jam. Check-in otomatis tiap 2 jam (scheduled task "Auto-lanjut build AIS Maritime Intelligence")
  me-resume workflow yang terpotong; hasil agent yang sudah selesai tidak diulang.
- 2026-11-20 16:00 UTC: limit pertama — fondasi (platform/template/review), perbaikan infra, polish MVP, verifikasi
  metodologi tertunda; di-resume 2026-11-21 08:30 UTC.
