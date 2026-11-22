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
| 2 | Fondasi v2: `@darmawanweb/ais-its-contracts` 0.3.0 (+katalog referensi) dan `@darmawanweb/ais-its-nest` 0.2.0 (kit + Detector SDK), template + generator; 2 review, 36/37 temuan diperbaiki | ✅ selesai |
| 2b | Infrastruktur repo pusat: compose, Postgres bootstrap 9 role, NATS+MQTT, Traefik (18 router), Grafana, Helm `ais-its-*`, smoke 150/150 | ✅ selesai |
| 2c | Quick fix MVP: BE `fix/phase-0-hardening` (242 test) dan FE `fix/phase-0` | ✅ selesai, ter-push |
| 2d | Metodologi & referensi: `docs/METHODOLOGY.md`, 91 metode, 140 referensi (88 verified, 41 corrected, 11 unverified), 67 metode perlu sitasi tesis | ✅ selesai |
| 3 | Rename `ais-its` + pemisahan safety/geo/surveillance + Detector SDK | ✅ selesai (digabung ke tahap 2) |
| 4 | 9 service backend: auth, pipeline, fleet, telemetry, emission, geo, safety, surveillance, notification (build → review → fix) + migrator Mongo | ✅ 9/9 service selesai (build, review 75 temuan, perbaikan + test regresi), ter-push ke `main` masing-masing; migrator ✅ (tahap 5d) |
| 5 | Web v2 (foundation → fitur → integrasi) | 🔄 foundation ✅, review ✅ (16 temuan) dan perbaikan ✅ ter-push (`feat/platform-v2`, klien API 10 service); fitur: persiapan ✅ (mock route per fitur + mock socket.io), 5 kelompok berjalan (ops & surv dulu) → integrasi → review 3 lensa → perbaikan |
| 5b | Hardening platform: 45 laporan masalah kit/contracts dari 9 service → triage → perbaikan (nats, contracts, analytics, core) → rilis `ais-its-contracts` 0.4.0 + `ais-its-nest` 0.3.0 + template | 🔄 triage ✅, nats ✅, contracts ✅, analytics ✅, core berjalan, lalu rilis |
| 5c | Upgrade 9 service ke kit baru: hapus workaround lokal, event resolusi alert, celah API dari web | ⏳ setelah 5b (rilis) dan celah API dari kelompok fitur web |
| 5d | Migrator MongoDB → v2 (`tools/mongo-migrator`, plan/run/verify/report, idempoten) | ✅ selesai: ledger fingerprint (edit di v2 tidak ditimpa), lock, retry penolakan sisi target; 14 temuan review diperbaiki; 191 unit test + 16 integration test; runbook `docs/migration/MONGO_TO_V2.md` |
| 6 | Integrasi, E2E seluruh stack, dokumentasi, push semua repo | ⏳ |

## Workflow aktif (sesi ini)
Resume bila terpotong limit: `Workflow({scriptPath: "<scratchpad>/<script>", resumeFromRunId: "<run id>"})`.

| Workflow | Run ID | Script di scratchpad |
|---|---|---|
| Fitur web (prep → 5 kelompok → integrasi → review → perbaikan) | `wf_e119b954-096` | `fe-features-workflow.js` |
| Hardening kit (triage → nats/contracts/analytics/core → rilis) | `wf_f1f66318-c72` | `kit-hardening-workflow.js` |
| Migrator Mongo (build → review → perbaikan) — ✅ selesai 2026-11-22 11:55 UTC | `wf_8f7d6d22-70f` | `migrator-workflow.js` |

Berikutnya (script sudah siap di scratchpad):
- Tahap 5c: `node gen-upgrade-notes.mjs` (catatan per service di `seemp-ref/notes/upgrade/` dari triage kit, panduan
  rilis dan `apiGaps` web), lalu `services-upgrade-workflow.js` dengan `args.services`: U1 safety, surveillance, geo
  (setelah kelompok web ops & surv), U2 auth, fleet, ais-pipeline, telemetry, emission, notification (setelah kelompok
  fleet, emis, admin).
- Tahap 6: `integration-workflow.js`: sinkronisasi web → workspace/submodule/mode stack → E2E API + UI → review 2 lensa
  → perbaikan per kluster + dokumentasi → verifikasi akhir (clone baru).

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
- 2026-11-21 13:20 UTC: limit kedua (hardening fondasi tertunda); di-resume 14:27 UTC.
- 2026-11-21 ~16:20 UTC: limit ketiga (build 9 service + perbaikan web tertunda); WIP ter-push 18:28 UTC; resume terjadwal 19:23 UTC.
- 2026-11-21 20:27 UTC: limit keempat (build telemetry/safety/notification, review dan perbaikan tertunda); hasil build
  6 service ter-push; di-resume 22:28 UTC.
- 2026-11-21 23:47 UTC: limit kelima (review telemetry dan perbaikan review 6 service tertunda); di-resume
  2026-11-22 04:30 UTC setelah reset 03:20 UTC.
- 2026-11-22 ~07:00 UTC: limit keenam (fitur web, hardening kit, migrator tertunda); di-resume 10:28 UTC setelah reset
  09:20 UTC.
