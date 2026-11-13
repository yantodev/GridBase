<h1 align="center">GridBase</h1>

<p align="center">
  <img alt="Java" src="https://img.shields.io/badge/Java-ED8B00?logo=openjdk&logoColor=white" />
  <img alt="Apache Spark" src="https://img.shields.io/badge/Apache%20Spark-E25A1C?logo=apachespark&logoColor=white" />
  <img alt="Hive JDBC" src="https://img.shields.io/badge/Hive%20JDBC-FDEE21?logo=apache&logoColor=black" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white" />
  <img alt="MySQL" src="https://img.shields.io/badge/MySQL-4479A1?logo=mysql&logoColor=white" />
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white" />
  <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black" />
  <img alt="HTML/CSS" src="https://img.shields.io/badge/HTML%2FCSS-E34F26?logo=html5&logoColor=white" />
  <img alt="Bash" src="https://img.shields.io/badge/Bash-4EAA25?logo=gnubash&logoColor=white" />
  <img alt="GitHub OAuth" src="https://img.shields.io/badge/GitHub%20OAuth-181717?logo=github&logoColor=white" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white" />
  <img alt="Docker Compose" src="https://img.shields.io/badge/Docker%20Compose-2496ED?logo=docker&logoColor=white" />
  <img alt="OpenAPI" src="https://img.shields.io/badge/OpenAPI-6BA539?logo=openapiinitiative&logoColor=white" />
</p>

GUI lokal untuk membaca, membuat, memperbarui, dan menghapus data melalui JDBC langsung dari Java.
Connection manager bergaya DataGrip mendukung Spark Thrift / Hive, PostgreSQL, dan MySQL.
Konfigurasi, termasuk password dan JDBC URL, disimpan terenkripsi di SQLite pada server.
Browser tidak menyimpan kedua nilai tersebut di localStorage.

## Login GitHub wajib

Workbench dan seluruh API database memerlukan login GitHub. Membuka aplikasi tanpa sesi
akan mengarahkan pengguna ke `/login`; request API tanpa sesi mengembalikan `401`.
Jika OAuth belum dikonfigurasi, aplikasi tetap terkunci.

1. Buat **OAuth App** di [GitHub Developer Settings](https://github.com/settings/developers).
2. Untuk lokal, isi **Homepage URL** dengan `http://127.0.0.1:4173` dan
   **Authorization callback URL** dengan `http://127.0.0.1:4173/auth/github/callback`.
3. Salin Client ID dan Client Secret ke `.env` (jangan commit atau memasukkan secret ke browser):

   ```dotenv
   APP_URL=http://127.0.0.1:4173
   GITHUB_CLIENT_ID=client-id-dari-github
   GITHUB_CLIENT_SECRET=client-secret-dari-github
   GITHUB_ALLOWED_USERS=username-anda
   ```

4. Jalankan ulang `npm start` atau buat ulang container Compose, lalu buka URL yang sama
   dengan `APP_URL`. Klik **Masuk dengan GitHub** untuk membuka workbench.

`GITHUB_ALLOWED_USERS` bersifat opsional: daftar username GitHub dipisahkan koma, tanpa
membedakan huruf besar/kecil. Jika kosong, semua akun GitHub dapat login. Setiap akun
hanya dapat melihat dan mengelola koneksi database miliknya, termasuk kredensial Edit,
query, metadata, dan koneksi default. Pemilik memakai **ID numerik GitHub yang tetap**,
sehingga perubahan username tidak memindahkan kepemilikan. Daftar izin login tetap memakai username.
Draft SQL, riwayat, dan cache koneksi browser dipisahkan menurut ID akun; aplikasi baru
memuat data setelah identitas sesi terverifikasi. Tab lama dimuat ulang jika akun berubah.

Pada server, gunakan `APP_URL=https://domain-anda` dan callback
`https://domain-anda/auth/github/callback` di OAuth App. `APP_URL` hanya berupa origin,
tanpa subpath; HTTP hanya diterima untuk loopback lokal. Reverse proxy perlu meneruskan
request pada domain tersebut ke aplikasi. Jika mengganti port host, ubah `APP_URL` dan
callback GitHub agar sesuai. Environment proses mengalahkan nilai `.env`.

Login memakai OAuth state, PKCE S256, dan cookie HttpOnly dengan SameSite=Lax (Secure
pada HTTPS). Token GitHub hanya dipakai di server untuk membaca identitas publik lalu
dibuang; izin repository tidak diminta. Sesi bertahan maksimal 8 jam dan disimpan dalam
memori satu instance: restart server mengharuskan login ulang. Tombol **Keluar** mencabut
sesi di server. Profil database, draft SQL, dan history tetap mengikuti penyimpanan
workbench yang sudah ada; login GitHub tidak memisahkan data per pengguna.

## Workspace bergaya DataGrip

Tema dark dengan alur inti yang mengacu pada [query consoles dan query output DataGrip](https://www.jetbrains.com/help/datagrip/services-tool-window.html):

- **Database explorer:** buka schema, klik nama tabel untuk membuka console dengan `SELECT ... LIMIT 50`, dan buka panah di samping tabel untuk melihat kolom beserta tipenya. Tombol refresh memuat ulang metadata. Filter mencari objek yang sudah dimuat.
- **SQL consoles:** tombol `+` membuat console. Klik tab untuk berpindah, klik dua kali atau tombol rename untuk mengganti nama, dan tutup melalui tombol pada tab. Draft maksimal 20 console dipulihkan setelah reload; hasil query tidak disimpan.
- **Editor:** syntax highlighting, nomor baris, indentasi Tab/Shift+Tab (Escape melepas fokus ke toolbar), Format, serta Ctrl+Space untuk saran keyword dan objek yang telah dimuat. Ctrl/Cmd+Enter menjalankan seleksi atau statement di posisi caret. Satu request tetap menjalankan satu statement.
- **Results / Output:** hasil terikat ke console asal, termasuk saat berpindah tab selama query berjalan. Klik heading kolom untuk sort, gunakan filter untuk mencari baris yang sudah dikembalikan, lalu unduh seluruh hasil filter melalui CSV/JSON. Klik nomor baris atau klik dua kali pada baris untuk detail vertikal.
- **Layout:** rail kiri membuka Database atau History. Geser pembatas explorer/editor atau fokuskan pembatas lalu gunakan tombol panah, Home, dan End. Pada layar kecil explorer tampil sebagai overlay yang dapat ditutup dengan Escape.

Setiap data source menampilkan status konfigurasi dan error metadata beserta retry. Status di title bar serta dialect editor mengikuti koneksi tab SQL yang aktif.

Implementasi ini mempertahankan branding GridBase dan tidak memakai aset JetBrains. Pengeditan sel langsung serta pengelolaan transaksi belum termasuk; perubahan data dijalankan melalui SQL sesuai dukungan Spark dan izin akun.

## Konfigurasi koneksi

Klik **Add connection** di panel **Database sebelah kiri**. Pilih PostgreSQL, MySQL,
atau Spark Thrift / Hive, isi detail koneksi, lalu gunakan **Save**, **Test connection**, atau **Connect**.
Save menyimpan konfigurasi tanpa menghubungi database; Connect menguji dan menyimpan koneksi.
Maksimal 20 koneksi per akun dapat tersedia bersamaan. Nama boleh sama; setiap koneksi mempunyai ID sendiri.

- Expand masing-masing data source untuk melihat schema, tabel, dan kolomnya.
- Tombol console pada data source membuat tab SQL untuk koneksi tersebut. Membuka tabel juga
  membuat tab pada koneksi asalnya, meskipun nama schema/tabel sama dengan database lain.
- Pilihan **Connection** di toolbar mengatur koneksi tab SQL aktif. Memilih data source lain
  di explorer tidak mengubah koneksi tab yang sudah ada. Pilihan dikunci selama eksekusi.
- Ikon pengaturan pada data source membuka detailnya untuk reconnect atau **Disconnect**.
  Disconnect hanya memutus koneksi tersebut; tabnya tetap tersimpan dan tidak dialihkan otomatis.
- **Edit** memuat konfigurasi tersimpan, termasuk password yang tetap ditampilkan sebagai karakter
  tertutup dan JDBC URL lengkap. Untuk PostgreSQL/MySQL, URL mengikuti host, port, database, dan SSL.
- Konfigurasi tersimpan di `data/gridbase.sqlite`; seluruh detail dienkripsi AES-GCM menggunakan
  kunci otomatis `data/credentials.key`; ciphertext juga terikat ke ID pemilik dan koneksi. Keduanya dibutuhkan untuk backup/pemulihan. Folder data
  dan driver lokal diabaikan Git dan Docker build. Jangan menghapus kunci ketika masih memakai database itu.
- Setelah restart, profil dipulihkan dalam status disconnected tanpa koneksi default. Klik Connect
  untuk mengaktifkan koneksi lagi. Disconnect mempertahankan konfigurasi; ikon hapus menghapusnya dari server.
- Cache browser lama tanpa informasi pemilik tidak dimuat. Tambahkan kembali profil melalui akun
  yang benar; password/JDBC URL yang tidak pernah disimpan di server perlu diisi ulang.
- Pemilik koneksi dapat mengakses kredensialnya melalui endpoint Edit. Gunakan workbench ini pada
  lingkungan tepercaya; daftar koneksi dan health tidak mengembalikan password atau parameter JDBC rahasia.

Image Docker sudah membawa driver JDBC PostgreSQL dan MySQL. Untuk menjalankan lokal, letakkan
driver tambahan di folder `drivers/` atau set `JDBC_DRIVER_DIR` ke folder yang berisi
`postgresql-*.jar` dan `mysql-connector-j-*.jar`.

File `.env` berisi pengaturan aplikasi dan OAuth GitHub:

```dotenv
PORT=4173
QUERY_TIMEOUT_MS=30000
DEFAULT_QUERY_LIMIT=50
APP_URL=http://127.0.0.1:4173
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_ALLOWED_USERS=
LEGACY_CONNECTION_OWNER_ID=
```

Salin `.env.example` menjadi `.env` bila belum ada, lalu isi konfigurasi GitHub sesuai
bagian login di atas. Nilai environment proses memiliki prioritas lebih tinggi. File
`.env` diabaikan Git dan tidak masuk Docker image. Compose meneruskan timeout, limit,
dan konfigurasi OAuth serta menggunakan `PORT` sebagai port akses di host.

Semua koneksi PostgreSQL, MySQL, dan Spark Thrift / Hive ditambahkan dari **Add connection**
di panel Database. Kredensial Spark lama dari `.env` atau environment tidak membuat
koneksi default di backend Java. Aplikasi mulai dengan daftar koneksi aktif kosong;
profil SQLite tetap tersedia untuk Edit dan perlu dihubungkan kembali setelah restart server.

### Migrasi profil koneksi lama

Profil SQLite dari versi sebelum isolasi akun belum memiliki pemilik. Operator harus
menentukan satu akun tujuan sebelum menjalankan versi baru:

1. Hentikan seluruh instance aplikasi yang memakai volume data tersebut.
2. Backup `data/gridbase.sqlite` dan `data/credentials.key` bersama-sama ke lokasi privat.
   Untuk Docker, backup kedua file dari volume `gridbase-data`.
3. Ambil ID numerik akun tujuan dari field `id` di `https://api.github.com/users/USERNAME`.
   Isi `LEGACY_CONNECTION_OWNER_ID=ID_NUMERIK` di `.env` atau environment deployment.
4. Jalankan aplikasi. Startup memindahkan semua profil tanpa pemilik ke ID tujuan dan
   mengenkripsi ulang kredensial dalam satu transaksi. Profil milik akun lain tidak berubah;
   migrasi berulang tidak memindahkan profil yang sudah memiliki pemilik.
5. Login sebagai akun tujuan, lalu klik Connect pada profil yang akan dipakai.

Tanpa `LEGACY_CONNECTION_OWNER_ID`, profil lama tetap tersimpan tetapi tidak terlihat
oleh akun mana pun. Login pertama tidak dapat mengklaim data tersebut. Jika profil rusak,
migrasi gagal tanpa memindahkan sebagian data. Konfigurasi ini dapat dikosongkan setelah
migrasi selesai. Schema SQLite naik ke versi 2; untuk kembali ke aplikasi versi lama,
hentikan versi baru lalu pulihkan database **dan** key dari backup sebelum upgrade.

Backend Node legacy memakai `LEGACY_CONNECTION_OWNER_ID` untuk membatasi satu koneksi
Beeline dari environment pada akun tersebut. Akun lain, atau konfigurasi owner kosong,
tidak memperoleh akses. Pengelolaan multi koneksi memakai backend Java melalui `npm start`.

Jika belum ada koneksi, status menunjukkan `Not configured` dan tombol query dinonaktifkan.
Username dan password tidak dikembalikan oleh endpoint health.

## Menjalankan secara lokal

Mode lokal membutuhkan instalasi Spark 3.5.6 yang memiliki Hive JDBC driver. PostgreSQL/MySQL
membutuhkan driver JDBC tambahan seperti dijelaskan di atas.

Script startup dan pengujian mengunduh driver SQLite versi terkunci dari Maven Central ke
`build/deps` dan memverifikasi SHA-256. Unduhan hanya diperlukan bila cache belum tersedia.

Jalankan dari direktori proyek dan atur `SPARK_HOME` sesuai lokasi instalasi Spark
di komputer Anda. Ganti `/path/ke/GridBase` dan `/path/ke/spark-3.5.6-bin-hadoop3`
pada contoh berikut dengan direktori yang digunakan:

```bash
cd /path/ke/GridBase
export SPARK_HOME="/path/ke/spark-3.5.6-bin-hadoop3"
ls "$SPARK_HOME/jars/hive-jdbc-2.3.9.jar"
npm start
```

## Menjalankan dengan Docker Compose

Mode Docker tidak membutuhkan instalasi Java atau Spark di komputer host.
Image menyediakan Java runtime, distribusi Apache Spark 3.5.6 lengkap di
`/opt/spark`, serta Hive JDBC client secara otomatis.

Compose menjalankan aplikasi workbench. Spark Thrift Server yang menjadi target
query tetap harus tersedia sebagai service eksternal dan ditambahkan melalui Add connection.
Volume bernama `gridbase-data` dipasang pada `/app/data` sehingga profil dan kunci enkripsi
bertahan saat container dibuat ulang. `docker compose down -v` menghapus volume beserta konfigurasi.

```bash
docker compose up --build -d
```

Distribusi Spark di dalam container dapat diverifikasi dengan:

```bash
docker compose exec thrift-query spark-submit --version
```

Perintah Spark yang tersedia di dalam container antara lain `spark-submit`,
`spark-sql`, dan `spark-shell`.

Untuk menggunakan port host lain:

```bash
PORT=8080 APP_URL=http://127.0.0.1:8080 docker compose up --build -d
```

Hentikan container dengan:

```bash
docker compose down
```

Buka <http://127.0.0.1:4173> dan login dengan GitHub sebelum menggunakan workspace.

Konfigurasi Docker yang tersedia:

- `PORT` — port host untuk workbench, default `4173`.
- `QUERY_TIMEOUT_MS` — batas waktu query, default `30000`.
- `DEFAULT_QUERY_LIMIT` — batas hasil jika LIMIT tidak ditulis atau bernilai NULL, default `50`. LIMIT eksplisit pada SQL mengambil prioritas.
- `LEGACY_CONNECTION_OWNER_ID` — ID numerik akun tujuan migrasi profil lama; kosong membuat profil tanpa pemilik tetap tersembunyi.
- `APP_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWED_USERS` — konfigurasi login GitHub seperti dijelaskan di atas. Callback OAuth App harus sesuai dengan `APP_URL`.

## Perilaku query

- Workbench menerima `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `CREATE`,
  `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `ALTER`, `DROP`, dan `TRUNCATE`.
  Tombol Execute atau Ctrl/Cmd+Enter menjalankan SQL yang dipilih, atau statement di posisi caret.
- LIMIT eksplisit mengikuti SQL: `LIMIT 20` mengembalikan hingga 20 baris dan `LIMIT 75` hingga 75 baris, tanpa dipotong oleh batas default server. Tanpa LIMIT, hasil dibatasi 50 baris; `LIMIT NULL` diganti dengan `LIMIT 50`. Nilai fallback ini dapat dikonfigurasi lewat `DEFAULT_QUERY_LIMIT`.
  Query otomatis saat membuka tabel menggunakan `LIMIT 50`. Query memiliki timeout 30 detik. Pagination tetap 10 baris per halaman: 20 baris menjadi 2 halaman, 50 baris menjadi 5 halaman.
  LIMIT di dalam subquery atau CTE tidak dianggap sebagai LIMIT hasil utama; teks literal dan komentar tidak dianggap sebagai klausa LIMIT.
- Perintah tulis dijalankan sesuai SQL dan izin akun database. Batas default 50 baris
  berlaku untuk hasil baca, bukan jumlah baris yang diubah atau dihapus.
  UI menampilkan status berhasil dan jumlah baris terdampak jika tersedia dari driver.
- Hasil baca tidak disimpan oleh workbench; lima Recent queries
  terakhir disimpan sebagai JSON di `localStorage` browser, terpisah per akun, agar tetap tersedia
  setelah reload.
- Backend bind ke `127.0.0.1` secara default. Pada server bersama, gunakan reverse proxy
  HTTPS, isi `GITHUB_ALLOWED_USERS`, dan gunakan akun database dengan izin sesuai operasi
  yang dibutuhkan. Seluruh API database memerlukan sesi login GitHub.
- SQL dikirim langsung ke `java.sql.Statement`; tidak ada shell atau proses CLI.

## Endpoint

Kontrak API tersedia di [`openapi.yaml`](./openapi.yaml):

- `GET /login` — halaman login; pengguna dengan sesi valid diarahkan ke workspace.
- `GET /auth/github` dan `GET /auth/github/callback` — mulai dan selesaikan OAuth GitHub.
- `GET /api/auth/session` — status konfigurasi login dan identitas sesi; dapat diakses tanpa login, tanpa secret.
- `POST /auth/logout` — cabut sesi; gunakan `Content-Type: application/json` dan body `{}`.
- `GET /healthz` — liveness publik minimal untuk Docker, tanpa metadata database.
- `GET /api/health` — status konfigurasi tanpa mengembalikan secret.
- `POST /api/connections/test` — menguji detail JDBC tanpa mengaktifkannya.
- `GET /api/connections` — daftar koneksi dengan ID stabil dan metadata tanpa secret.
- `POST /api/connections` — simpan konfigurasi tanpa menghubungi database; `connectionId` memperbarui profil yang sama dan menonaktifkannya sampai Connect.
- `GET /api/connections/{id}` — detail untuk Edit, termasuk password/JDBC lengkap; respons `Cache-Control: no-store`.
- `DELETE /api/connections/{id}` — hapus konfigurasi tersimpan dan nonaktifkan koneksinya.
- `POST /api/connections/connect` — uji, simpan, dan aktifkan koneksi; sertakan `connectionId` untuk reconnect ID yang sama.
- `POST /api/connections/disconnect` — body `{ "connectionId": "..." }`, nonaktifkan koneksi tanpa menghapus konfigurasinya.
- `GET /api/databases?connectionId=...` — daftar schema/database dari koneksi yang dipilih.
- `GET /api/tables?connectionId=...&namespace=...` — daftar tabel pada namespace.
- `GET /api/columns?connectionId=...&namespace=...&table=...` — daftar kolom, tipe, dan komentar.
- `GET /api/namespaces` — alias deprecated untuk klien lama; gunakan `/api/databases`.
- `POST /api/query` — body `{ "connectionId": "...", "sql": "SELECT ..." }`.

Klien lama tanpa ID menggunakan koneksi pertama yang ditambahkan saat runtime.
Jika koneksi tersebut di-disconnect, request tanpa ID tidak dialihkan ke koneksi lain;
koneksi implicit baru ditentukan saat connect berikutnya. ID yang tidak dikenal
mengembalikan 404. Backend Node legacy hanya mendukung Beeline; gunakan backend Java
untuk pengelolaan koneksi melalui UI.

Metadata memiliki batas terpisah 10.000 baris sehingga tidak terpotong oleh `DEFAULT_QUERY_LIMIT=50`. Identifier metadata di-escape dan divalidasi pada server.

Endpoint database di atas memerlukan cookie `gridbase_session` dari login GitHub.
ID koneksi milik akun lain menghasilkan `404` dan tidak menjalankan JDBC. Klien browser
mengirim header `X-GridBase-Account` berisi ID sesi yang diharapkan; jika cookie sudah
berpindah akun, server mengembalikan `409` sebelum menjalankan operasi. Header ini opsional
untuk klien API dan tidak dapat memilih atau mengganti pemilik.
Request mutasi harus berasal dari origin aplikasi; POST menggunakan JSON. Respons
autentikasi, halaman workbench, dan API memakai `Cache-Control: no-store`.

## Pengembangan

Versi aplikasi tersimpan di [`VERSION`](./VERSION). Panduan Semantic Versioning,
perintah bump versi, dan alur penerbitan release tersedia di
[`VERSIONING.md`](./VERSIONING.md).

```bash
npm test
npm run check
```

Jika instalasi Spark berada di lokasi lain, set `SPARK_HOME` untuk kedua perintah.
Pengujian autentikasi Java dan Node memakai HTTP lokal dengan penyedia identitas tiruan;
tidak membutuhkan OAuth App atau menghubungi GitHub. Login langsung ke GitHub memerlukan
Client ID/Secret yang valid dan callback terdaftar.

`npm start` sekarang menjalankan backend Java JDBC. `node server.js` hanya
tersisa sebagai backend Node legacy dan tidak digunakan oleh jalur utama.


Pengujian mencakup policy SQL, eksekusi JDBC dengan fixture, metadata di atas 10 baris, model draft, parsing statement, formatting, serta controller dengan simulasi DOM. Simulasi DOM tidak memverifikasi render browser. Pada sesi implementasi ini host browser tidak tersedia sehingga tampilan desktop/mobile dan interaksi browser belum diverifikasi secara visual. Tidak ada query mutasi pengujian yang dijalankan ke database asli.
