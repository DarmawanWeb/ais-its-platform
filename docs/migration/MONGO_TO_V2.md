# Runbook: migrasi data MVP (MongoDB) ke AIS Maritime Intelligence v2

> **English summary.** This runbook moves the MVP data (`ais-its-mvp-api`, MongoDB) into the v2
> services with [`tools/mongo-migrator`](../../tools/mongo-migrator/README.md). Master and reference
> data (vessel types, fuels, engines, fuel formulas, ports, vessels, reduction factors, annual CII)
> go through the owning services' APIs as a platform admin, so FLEET snapshots, outbox events and
> audit records flow as in production; history (AIS positions, fuel readings, legacy transhipment
> results) is written with direct SQL by the least-privilege role `mongo_migrator`, never through an
> outbox or the telemetry publication queue, so no historical record becomes a live event or an
> alert. Registry particulars are imported by the fleet service's own importer. Sequence: pre-checks
> → backups → enable `mongo_migrator` → `plan` (dry run) and review → MVP read-only → final MongoDB
> backup → `run` (idempotent, resumable) → `verify` → post-migration checks (refresh `positions_1m`,
> FLEET projections, spot checks in the web app) → disable `mongo_migrator` → keep the MVP read-only
> until sign-off. `verify` must exit 0; the conflicts it lists (v2 keeps its own record: an MMSI or
> manual CII entered in v2, a seeded Z value, a migrated record edited in v2 — never reverted
> without `--overwrite-v2-edits`) are signed off by the data owner. A shadow-mode top-up is
> `run --fresh --since <first run startedAt − 24 h>` (documents changed since, with all their
> items). Rollback: v2 stays empty of live tenants until sign-off, so the primary rollback is
> restoring the PostgreSQL snapshot taken right before the run; targeted clean-up statements are
> listed for every entity. Daily CII, the transhipment queue and users are deliberately not migrated.

## 1. Ruang lingkup

| Data MVP (koleksi) | Tujuan v2 | Jalur tulis |
|---|---|---|
| `shiptypes`, `fuels`, `mainengines`, `auxiliaryengines`, `firstfuelformulas`, `ports` | data referensi fleet | API fleet (`reference:write`) |
| `ships` + `shipgenerals` + `shipsizes` | `fleet.vessels` (+ dimensi, mesin, pelabuhan) milik **satu organisasi target** | API fleet `POST /api/v2/vessels` |
| `secondaryships` | `fleet.registry_particulars` | importer milik fleet (`pnpm registry:import`) |
| `zvalues` | `emission.reduction_factors` | API emission `PUT /api/v2/reduction-factors` |
| `annualciis` | `emission.cii_annual_manual` (hanya cadangan untuk tahun tanpa segmen, spec §15.3) | API emission |
| `ais` | `ais.positions` + `ais.vessel_latest` | SQL, role `mongo_migrator` |
| `fueldatas`, `telemetries` | `telemetry.fuel_readings` (`source = 'import'`, `published_at` terisi) | SQL, role `mongo_migrator` |
| `illegaltranshipmentresults` (positif) | `surveillance.events` (status `resolved`) + `surveillance.transhipment_results` | SQL, role `mongo_migrator` |

Tidak dimigrasikan (selalu tercantum di laporan, tetap ada di backup MongoDB):

- `dailyciis` — snapshot akumulator CII seumur hidup milik MVP; v2 menghitung CII harian/tahunan
  dari segmen per tahun kalender (spec §15.3).
- `illegaltranshipmentqueues` — antrean kerja sementara; surveillance membangun pasangan kandidat
  dari posisi live.
- `users` (hanya ada di build awal MVP) — MVP tidak punya model user; hash bcrypt tidak bisa
  menjadi argon2id dan v2 mewajibkan persetujuan: undang orang lewat
  `POST /api/v2/organizations/:id/members`.
- Foto kapal (`photoUrl`) — tercantum per kapal di laporan; unggah ulang lewat
  `POST /api/v2/vessels/:id/photo`.

Berkas data bawaan MVP (bukan MongoDB) sudah dimiliki layanan v2 dan **tidak** dibawa oleh tool:

| Berkas MVP | Pemilik v2 | Cara masuk |
|---|---|---|
| `be/data/pipeline.json` (61 titik KP) | geo, zona global `mvp-pipeline` (`pipeline`) | `pnpm seed` di geo |
| `be/data/batam.json` (area Batam) | geo, zona global `mvp-batam-transhipment` (`transhipment_area`) | `pnpm seed` di geo |
| `be/data/indonesia.json` (garis pantai) | ais-pipeline, `data/coastline.geojson` (dibundel) | ikut image processor |
| `fe/src/data/ilegal.json` (penangkapan ikan ilegal 2015–2017) | surveillance, `fishing_violations` | `pnpm seed` di surveillance |

## 2. Peran

| Peran | Tugas |
|---|---|
| Operator migrasi | menjalankan tool, membaca laporan |
| DBA PostgreSQL | backup/snapshot, mengaktifkan dan menonaktifkan `mongo_migrator`, refresh agregat |
| Pemilik data (domain) | menyetujui hasil `plan` (dokumen yang ditolak/disesuaikan) dan hasil `verify` |
| Admin platform | akun `super_admin` khusus migrasi (tanpa MFA selama jendela migrasi), organisasi target |

## 3. Pra-pemeriksaan

1. Versi: Node.js 24, pnpm 10.28.0. Di `tools/mongo-migrator`: `pnpm install && pnpm build`.
2. Layanan v2 sehat (`GET /health/ready` = 200): auth, fleet, emission, ais-processor (dan
   ingestor), telemetry, surveillance, safety, notification. Consumer FLEET berjalan (emission dan
   telemetry mengenal kapal hasil migrasi dari stream FLEET).
3. Seed fleet sudah dijalankan (`pnpm seed` di fleet): tipe kapal IMO, bahan bakar MEPC.364(79),
   mesin/formula/pelabuhan studi kasus — tool memakai ulang baris yang setara, bukan duplikat.
   Seed geo (zona pipa dan area transhipment Batam) dan seed surveillance (`fishing_violations`)
   juga sudah dijalankan (`pnpm seed` di masing-masing layanan): bukan prasyarat tool, tetapi
   EWS, deteksi transhipment, dan lapisan historis membutuhkannya setelah cut-over (§1).
4. Organisasi target ada (`POST /api/v2/organizations`, `kind: shipping_company`); catat `id`-nya.
5. Akun admin platform tanpa MFA; uji login `POST /api/v2/auth/login`.
6. Akses baca ke MongoDB MVP (sebaiknya secondary). Hitung dokumen sebagai patokan (`MONGO_URL` dan
   `MONGO_DB` sudah diekspor, lihat langkah 8):
   `mongosh "$MONGO_URL" --quiet --eval "const d = db.getSiblingDB('$MONGO_DB'); d.getCollectionNames().sort().forEach(c => print(c, d[c].countDocuments()))"`.
7. Ruang disk PostgreSQL cukup untuk riwayat (perkiraan: ~150 B per posisi, ~100 B per bacaan BBM).
8. Isi lingkungan tool dari [`.env.example`](../../tools/mongo-migrator/.env.example). Password
   hanya lewat variabel lingkungan sesi (`read -s`), **jangan** ditulis ke file.

## 4. Backup

1. **MongoDB MVP** (sumber kebenaran sampai sign-off), database yang sama dengan yang dibaca tool:
   ```bash
   mongodump --uri "$MONGO_URL" --db "$MONGO_DB" --gzip --archive="mvp-$(date +%F).archive.gz" 2>&1 | tee mvp-dump.log
   grep 'done dumping' mvp-dump.log    # "<db>.<koleksi> (N documents)": harus sama dengan hitungan §3.6
   ```
   Nama database salah berarti arsip tanpa data MVP — karena itu jumlah per koleksi dicocokkan.
   Simpan minimal 1 tahun (berisi juga data yang tidak dimigrasikan).
2. **PostgreSQL v2** sesaat sebelum `run`: snapshot volume/instance (dikelola) atau
   `pg_dump -Fc -d aisits -f aisits-pre-migration.dump` sebagai superuser. Ini jalur rollback utama.
3. Catat waktu backup dan jumlah dokumen per koleksi di lembar kerja migrasi.

## 5. Mengaktifkan role `mongo_migrator`

Role dibuat oleh `infra/postgres/bootstrap.sql` (langkah 5b) dalam keadaan `NOLOGIN`. Grant tabel
butuh tabel layanan, jadi jalankan bootstrap **setelah** layanan menerapkan migrasinya:

```bash
# compose: password acak hanya untuk jendela migrasi, disimpan di variabel sesi (bukan file);
# hex agar aman di URL. Variabel yang sama dipakai lagi di §8 (PGPASSWORD).
MIGRATOR_PASSWORD="$(openssl rand -hex 24)" && export MIGRATOR_PASSWORD
REPO="$(git rev-parse --show-toplevel)"   # path compose di bawah benar dari direktori mana pun
docker compose -f "$REPO/infra/compose/docker-compose.yml" \
  exec -T -e MIGRATOR_PASSWORD postgres bash /opt/aisits/postgres/bootstrap.sh
# cluster terkelola: psql … -v migrator_password='…' -f infra/postgres/bootstrap.sql (plus password role lain)
```

Hak role: `SELECT, INSERT` pada `ais.positions`, `telemetry.fuel_readings`, `surveillance.events`,
`surveillance.transhipment_results`; `SELECT, INSERT, UPDATE` pada `ais.vessel_latest`; `SELECT`
pada `telemetry.fuel_readings_unpublished`. Tidak ada akses ke outbox, antrean publikasi, DDL,
skema lain. Bukti: `tools/mongo-migrator/scripts/check-bootstrap.sh`. Tool memeriksa hak ini
sebelum menulis dan berhenti dengan exit code 2 bila kurang.

## 6. Dry run (`plan`) dan review

```bash
cd tools/mongo-migrator
node dist/main.js plan            # hanya butuh MONGO_URL/MONGO_DB; tidak menulis apa pun
node dist/main.js report --input .migration-state/reports/latest-plan.json | less
```

Periksa di `.migration-state/reports/latest-plan.md` (dan `*.issues.ndjson` untuk daftar lengkap):

- **rejected** — dokumen yang tidak bisa dimigrasikan (MMSI tidak valid, sub-dokumen hilang, vektor
  d tidak naik, posisi 91/181, bacaan negatif, …). Perbaiki di MongoDB bila perlu lalu ulangi `plan`.
- **adjusted** — dokumen yang dimigrasikan dengan nilai yang dikonversi atau dibuang (angka dari
  string, SFOC kg/kWh → g/kWh, densitas kg/m³ → t/m³, IMO tidak valid, bendera dipetakan, kuantitas
  mesin bantu disesuaikan, …). Minta pemilik data menyetujui heuristik satuan.
  `caret_semantics_changed`: rumus BBM pertama memakai `^`, yang di MVP (JavaScript) adalah XOR
  bitwise dan di v2 pangkat (spec §15.4); laporan memuat nilai MVP dan v2 pada 5/10/15 knot.
  Pemilik data memutuskan per rumus: terima (nilai v2), atau tulis ulang rumusnya di MongoDB
  sebelum `run`.
- Bacaan BBM yang sama `(mmsi, time)` di beberapa dokumen: dokumen terbaru menang (seperti CII MVP
  yang membaca dokumen `fueldatas` terbaru), `fueldatas` sebelum `telemetries`; nilai sama →
  `duplicate_reading` (skipped), nilai berbeda → `conflicting_duplicate` (rejected, kedua dokumen
  dan nilainya disebut).
- **skipped** — dikecualikan sesuai desain (referensi yang tidak dipakai kapal mana pun, hasil
  transhipment negatif, melewati retensi, koleksi yang tidak dimigrasikan).
- **inventory** — semua koleksi beserta jumlahnya; `unknown_collection` harus ditinjau.

`plan --strict` keluar dengan kode 3 bila ada dokumen yang ditolak (untuk gerbang otomatis).
Disarankan: gladi bersih penuh (`run` + `verify`) pada salinan staging beberapa hari sebelumnya.

## 7. Urutan cut-over (MVP tetap berjalan read-only)

| Waktu | Langkah |
|---|---|
| T−7 hari | gladi bersih di staging dengan salinan MongoDB produksi dan state directory sendiri (`--state-dir .migration-state-staging`: checkpoint staging tidak boleh terbawa ke produksi); ukur durasi |
| T−1 hari | `plan` pada produksi; sign-off pemilik data atas daftar rejected/adjusted |
| T0 | umumkan jendela pemeliharaan |
| T0 + 5 mnt | **MVP read-only**: kosongkan `LEGACY_AIS_PRIMARY_URL`/`LEGACY_AIS_BATAM_URL` (tidak ada feed AIS baru ke MVP) dan set `LEGACY_ALLOWED_ORIGINS` ke origin yang tidak dipakai (penulisan dari browser ditolak 403), lalu `docker compose --profile legacy up -d legacy-be`. MVP tetap melayani pembacaan `/api/v1` |
| | konfirmasi read-only: hitung dokumen `ais`/`fueldatas` dua kali berselang 5 menit — harus sama |
| | pastikan ingestor v2 tersambung ke feed AIS (posisi live mulai masuk ke v2) |
| T0 + 15 mnt | backup MongoDB final (§4.1) dan snapshot PostgreSQL (§4.2) |
| T0 + 20 mnt | aktifkan `mongo_migrator` (§5) |
| T0 + 25 mnt | `node dist/main.js run` (atau bertahap: `--only master`, lalu `--only history`) |
| | `node dist/main.js verify` — harus exit 0; daftar `conflict`-nya disetujui pemilik data (§9) |
| | pemeriksaan pasca-migrasi (§9) |
| | nonaktifkan `mongo_migrator`: jalankan bootstrap **tanpa** `MIGRATOR_PASSWORD` |
| T0 + 1 hari … | MVP read-only sebagai referensi; setelah sign-off, matikan profil `legacy` |

Bila v2 sudah berjalan paralel (shadow) sebelum cut-over, jalankan `run` lebih awal lalu tutup
selisihnya tepat sebelum cut-over (setelah MVP read-only) dengan **satu** perintah:

```bash
# startedAt laporan run penuh PERTAMA (bukan latest-run.json bila sesudahnya ada run lain),
# dikurangi tumpang-tindih yang lega: semua penulisan idempoten
FIRST=.migration-state/reports/run-<waktu-run-pertama>.json
SINCE="$(node -e "const r = require(require('node:path').resolve(process.argv[1])); console.log(new Date(Date.parse(r.startedAt) - 24 * 3600e3).toISOString())" "$FIRST")"
node dist/main.js run --fresh --since "$SINCE"
```

- `--fresh` mengulang data master juga (kapal baru, CII tahunan, tahun Z baru); record yang sudah
  diedit di v2 tidak dikembalikan (lihat §8, `changed_in_v2`).
- `--since` memilih **dokumen** yang dibuat atau diubah sejak waktu itu (`updatedAt`, `createdAt`,
  waktu ObjectId, atau timestamp salah satu itemnya) dan menulis **semua** itemnya: unggahan
  tertunda dari perangkat dan posisi yang disimpan sebagai `timestamp − utc` (hingga 59 detik
  sebelum diterima) tidak hilang. Gunakan `startedAt` run pertama, bukan waktu selesainya.
- Posisi atau bacaan yang sudah diterima live oleh v2 dengan nilai berbeda dicatat sebagai
  `conflict` dan nilai v2 dipertahankan.

## 8. Menjalankan migrasi

```bash
export MONGO_URL='mongodb://…' MONGO_DB=aisits_legacy
export V2_GATEWAY_URL=https://ais.example.id          # atau V2_AUTH_URL/V2_FLEET_URL/V2_EMISSION_URL
export MIGRATION_ADMIN_EMAIL=migrasi@example.id
read -rs MIGRATION_ADMIN_PASSWORD && export MIGRATION_ADMIN_PASSWORD
export MIGRATION_TARGET_ORG_ID=<uuid organisasi>
export PGPASSWORD="$MIGRATOR_PASSWORD"               # dari §5 (atau: read -rs PGPASSWORD && export PGPASSWORD)
# compose (tanpa TLS): tanpa sslmode. Password dari PGPASSWORD.
export DATABASE_URL='postgres://mongo_migrator@localhost:5432/aisits'
# klaster dengan TLS: node-postgres membaca sslmode=require sebagai verify-full, jadi sebutkan CA-nya:
#   export DATABASE_URL='postgres://mongo_migrator@db.example.id:5432/aisits?sslmode=verify-full&sslrootcert=/etc/ssl/aisits-ca.pem'
# Importer registry milik fleet. Perintah dijalankan lewat /bin/sh di direktori kerja saat itu;
# {file} = path absolut ekspor. Stack compose hanya berisi layanan pendukung, layanan platform
# berjalan di host dengan .env masing-masing (path absolut diisi saat export, tanda kutip ganda):
export FLEET_REGISTRY_IMPORT_CMD="cd '$(git rev-parse --show-toplevel)/services/fleet' && node --env-file=.env dist/registry-import.js {file}"
# fleet di container: export FLEET_REGISTRY_IMPORT_CMD='docker exec -i <container-fleet> node dist/registry-import.js /dev/stdin < {file}'
node dist/main.js run
```

- Idempoten: menjalankan ulang tidak membuat duplikat (kunci alami: kode `legacy_<ObjectId>`, kode
  pelabuhan, MMSI + `legacyId`, `(mmsi, tahun)`, `(mmsi, time)`, UUID deterministik).
- Bisa dilanjutkan: Ctrl+C (atau SIGTERM) menyelesaikan batch berjalan, menyimpan checkpoint dan
  keluar dengan kode 130; jalankan perintah yang sama untuk melanjutkan. `--fresh` mengabaikan
  checkpoint (tetap tanpa duplikat).
- `--strict` menolak menulis apa pun bila sumber berisi dokumen yang ditolak.
- Hanya satu `run` per state directory (`.migration-state/run.lock`) dan, untuk riwayat, per
  database (advisory lock PostgreSQL); `run` kedua keluar dengan kode 2. Jangan jalankan
  `--only master` dan `--only history` paralel.
- Record yang ditulis migrasi lalu **diedit di v2** (kapal, baris referensi `legacy_<id>`, CII
  manual hasil impor) tidak dikembalikan oleh run berikutnya (juga dengan `--fresh`): dicatat
  sebagai `conflict` `changed_in_v2` (atau `differs_from_legacy` bila state directory tidak punya
  catatan penulisannya). Perubahan di MVP setelah run pertama tetap diterapkan selama v2 belum
  mengubah record itu (`converged`). Bila nilai MVP yang harus berlaku:
  `run --only <entitas> --fresh --overwrite-v2-edits`. Simpan `.migration-state/` (termasuk
  `ledger.ndjson`) sampai sign-off.
- Status entitas: `incomplete` = ada dokumen yang ditolak karena kondisi di v2 (kapal belum ada,
  proyeksi FLEET tertinggal, penolakan layanan) — run berikutnya (tanpa `--fresh`) mengulang
  entitas itu; `manual` = impor registry belum dijalankan; `failed` = importer registry gagal (run
  tetap melanjutkan entitas lain, kode keluar 1). Outcome laporan saat itu `incomplete`/`failed`.
- Kode keluar: 0 sukses, 1 gagal, 2 konfigurasi/hak akses/run lain sedang berjalan, 3 dokumen
  ditolak (`--strict`), 4 verifikasi tidak cocok, 130 terhenti.

## 9. Pemeriksaan pasca-migrasi

1. `node dist/main.js verify` (dengan state directory yang sama dengan `run`) → exit 0; setiap
   entitas `missing = 0`, `mismatched = 0`, checksum sampel cocok. Kolom `conflicts` (outcome
   `conflicts`) adalah keputusan run untuk mempertahankan data v2, bukan kegagalan: `mmsi_taken`,
   `other_organization`, `manual_record_exists`, `value_differs` (Z), `changed_in_v2`,
   `differs_from_legacy`, `stored_with_other_values` (riwayat). Pemilik data menyetujui daftar itu
   (dari `latest-verify.md`/`*.issues.ndjson`) di berita acara; yang tidak disetujui diselesaikan
   per §11 lalu `run --only <entitas> --fresh` dan `verify` lagi.
2. Agregat 1 menit AIS: kebijakan refresh hanya mencakup 2 hari terakhir. Untuk posisi lama yang
   diimpor, sebagai `ais_svc` atau superuser:
   `CALL refresh_continuous_aggregate('ais.positions_1m', '<min time>', now() - interval '2 days');`
   (`min time` = `SELECT min(time) FROM ais.positions`). Agregat telemetri (`fuel_hourly`,
   `fuel_daily`) dan CII ter-refresh otomatis.
3. Proyeksi FLEET: jumlah kapal di emission/telemetry sama dengan fleet (`SELECT count(*) FROM
   emission.vessel_profiles`, `telemetry.vessels`, `ais.vessel_refs`). Bila ada yang tertinggal
   (mis. stream FLEET dipurge), republish: `POST /api/v2/vessels/:id/republish` per kapal atau
   restart satu replika fleet dengan `FLEET_REPUBLISH_ON_BOOT=true`. Outbox fleet harus kosong:
   `SELECT count(*) FROM fleet.outbox WHERE published_at IS NULL`.
4. Tidak ada event live dari riwayat: `fleet`/`emission` boleh menerbitkan, tetapi stream
   `AIS_POSITION`, `FUEL` dan `ALERTS` tidak bertambah karena migrasi; `telemetry.fuel_readings_unpublished`
   tidak berisi baris `source = 'import'`; tidak ada alert baru di kotak masuk.
5. Uji tampilan di web: daftar kapal organisasi target, detail teknis (dimensi, mesin, formula),
   CII tahunan (tahun dari catatan manual), jejak AIS 24 jam terakhir, telemetri, transhipment
   historis (status `resolved`).
6. Laporan `run` dan `verify` (`.migration-state/reports/*.md`) dilampirkan pada berita acara.
7. Nonaktifkan `mongo_migrator` (§5 tanpa password; `NOLOGIN`, grant tetap) dan cabut sesi admin
   migrasi (`POST /api/v2/auth/logout`) atau nonaktifkan akunnya, lalu hapus rahasia dari sesi:
   ```bash
   docker compose -f "$(git rev-parse --show-toplevel)/infra/compose/docker-compose.yml" exec -T postgres bash /opt/aisits/postgres/bootstrap.sh
   unset MIGRATOR_PASSWORD PGPASSWORD MIGRATION_ADMIN_PASSWORD
   ```

## 10. Strategi rollback

Sampai sign-off, MVP (read-only) tetap menjadi sumber kebenaran, jadi rollback tidak kehilangan data.

1. **Rollback penuh (utama):** pulihkan snapshot/dump PostgreSQL dari §4.2 dan buka kembali
   penulisan MVP (kembalikan `LEGACY_ALLOWED_ORIGINS` dan feed AIS). Data live v2 yang masuk setelah
   snapshot hilang — karena itu snapshot diambil tepat sebelum `run`, setelah MVP read-only.
   Untuk mengulang migrasi sesudahnya gunakan `run --fresh` (checkpoint menganggap entitas sudah
   selesai). State directory yang sama boleh dipakai: penanda registry
   (`exports/secondaryships.imported.json`) dicek terhadap target dan diabaikan oleh `--fresh`,
   dan ledger hanya mengizinkan konvergensi untuk record yang persis sama dengan yang dulu ditulis.
2. **Rollback terarah** (bila hanya sebagian yang salah), semuanya dapat dikenali:
   - kapal: `legacyId` terisi → `DELETE /api/v2/vessels/:id` (tombstone FLEET dikirim ke konsumen);
   - referensi: kode `legacy_<ObjectId>` → `DELETE /api/v2/{vessel-types,fuels,engines,fuel-formulas}/:id`
     setelah kapalnya dihapus; pelabuhan: `source` berisi `Imported from the legacy MVP`;
   - faktor Z: `source` berisi `Legacy MVP MongoDB zvalues` → `PUT /api/v2/reduction-factors`
     dengan nilai seed;
   - CII tahunan manual: `note` diawali `Imported from the legacy MVP` → hapus sebagai `emission_svc`
     (`DELETE FROM emission.cii_annual_manual WHERE note LIKE 'Imported from the legacy MVP%'`);
   - bacaan BBM hasil migrasi (bukan bacaan yang diunggah pengguna lewat API dengan
     `?source=import`, yang diterbitkan relay belakangan): sebagai `telemetry_svc`
     `DELETE FROM telemetry.fuel_readings WHERE source = 'import' AND device_id IS NULL AND published_at = received_at`
     (opsional dibatasi `AND received_at BETWEEN '<mulai run>' AND '<selesai run>'`);
   - transhipment: `DELETE FROM surveillance.transhipment_results r USING surveillance.events e
     WHERE e.id = r.event_id AND e.data->>'legacy' = 'true'`, lalu `DELETE FROM surveillance.events
     WHERE data->>'legacy' = 'true'` (sebagai `surveillance_svc`);
   - posisi AIS tidak punya penanda; hapus berdasarkan MMSI dan rentang waktu riwayat yang diimpor
     (sebelum waktu cut-over) sebagai `ais_svc`, atau gunakan rollback penuh.
3. Setelah rollback terarah, jalankan ulang `plan`, `run --only <entitas> --fresh`, `verify` — tool
   idempoten.

## 11. Penanganan masalah

| Gejala | Penyebab / tindakan |
|---|---|
| exit 2, `lacks privileges for the history entities` | bootstrap belum dijalankan ulang setelah migrasi layanan, atau tanpa `migrator_password` (§5) |
| exit 2, `cannot sign in` / `429 RATE_LIMITED` | password salah atau throttle login (5 gagal/15 menit per e-mail): tunggu, perbaiki variabel |
| exit 2, `holds the state directory` / `advisory lock` | run lain sedang berjalan (state directory atau database yang sama): tunggu sampai selesai; lock proses yang sudah mati di host yang sama diambil alih otomatis, dari host lain hapus `.migration-state/run.lock` setelah memastikan prosesnya tidak ada |
| `vessel_unknown_to_emission` | emission belum menerima snapshot FLEET: periksa consumer `emission-fleet` dan outbox fleet; run berikutnya (`run` atau `run --only cii_annual`) mengulang entitas `incomplete` itu |
| `vessel_not_migrated` | kapal MVP-nya valid tetapi belum ada di organisasi target (entitas `vessels` belum jalan, conflict, ditolak layanan): selesaikan kapalnya; run berikutnya mengulang otomatis. `vessel_not_in_migration` = MMSI tanpa dokumen Ship yang bisa dimigrasikan (final) |
| `mmsi_taken` / `other_organization` (conflict) | MMSI sudah ada di v2 dan bukan hasil migrasi ini: putuskan manual (tool tidak mengubahnya); setelah diselesaikan di v2: `run --only vessels --fresh` (CII dan bacaan BBM kapal itu diulang otomatis) |
| `changed_in_v2` / `differs_from_legacy` (conflict) | record hasil migrasi diedit di v2 (atau asalnya tidak tercatat): nilai v2 dipertahankan. Bila nilai MVP yang benar: `run --only <entitas> --fresh --overwrite-v2-edits` |
| `manual_record_exists` / `value_differs` (conflict) | CII manual yang dimasukkan di v2 / nilai Z seed dipertahankan; Z MVP hanya dengan `--overwrite-reduction-factors` |
| `position_exists` / `reading_exists` (conflict) | v2 sudah menyimpan nilai lain pada `(mmsi, time)` itu (data live): nilai v2 dipertahankan |
| `conflicting_duplicate` / `duplicate_reading` | bacaan yang sama di beberapa dokumen MVP: dokumen terbaru dipakai; tinjau bila nilainya berbeda |
| registry `manual` | `FLEET_REGISTRY_IMPORT_CMD` kosong: set variabelnya (§8) lalu `run --only registry` (entitas belum dianggap selesai), atau jalankan `pnpm registry:import <file>` di layanan fleet |
| registry `failed` (exit 1) | importer gagal: periksa perintahnya (dijalankan di direktori kerja saat ini, path relatif!) lalu `run --only registry` |
| exit 130 | dihentikan; jalankan perintah yang sama untuk melanjutkan dari checkpoint |
| exit 4 pada `verify` | lihat `latest-verify.md` (`missing`, `mismatched`, `legacy_changed`); jalankan `run --only <entitas> --fresh` lalu `verify` lagi. `conflicts` tidak menyebabkan exit 4 |
