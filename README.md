<h1 align="center">GridBase</h1>

<p align="center">
  <img alt="Java" src="https://img.shields.io/badge/Java-ED8B00?logo=openjdk&logoColor=white" />
  <img alt="Apache Spark" src="https://img.shields.io/badge/Apache%20Spark-E25A1C?logo=apachespark&logoColor=white" />
  <img alt="Hive JDBC" src="https://img.shields.io/badge/Hive%20JDBC-FDEE21?logo=apache&logoColor=black" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white" />
  <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black" />
  <img alt="HTML/CSS" src="https://img.shields.io/badge/HTML%2FCSS-E34F26?logo=html5&logoColor=white" />
</p>

GUI lokal untuk membaca, membuat, memperbarui, dan menghapus data melalui JDBC langsung dari Java.
Connection manager bergaya DataGrip mendukung Spark Thrift / Hive, PostgreSQL, dan MySQL.
Password dikirim hanya saat test/connect. Password dan JDBC URL tidak disimpan di browser.

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
atau Spark Thrift / Hive, isi detail koneksi, lalu gunakan **Test connection** atau **Connect**.
Maksimal 20 koneksi dapat tersedia bersamaan. Nama boleh sama; setiap koneksi mempunyai ID sendiri.

- Expand masing-masing data source untuk melihat schema, tabel, dan kolomnya.
- Tombol console pada data source membuat tab SQL untuk koneksi tersebut. Membuka tabel juga
  membuat tab pada koneksi asalnya, meskipun nama schema/tabel sama dengan database lain.
- Pilihan **Connection** di toolbar mengatur koneksi tab SQL aktif. Memilih data source lain
  di explorer tidak mengubah koneksi tab yang sudah ada. Pilihan dikunci selama eksekusi.
- Ikon pengaturan pada data source membuka detailnya untuk reconnect atau **Disconnect**.
  Disconnect hanya memutus koneksi tersebut; tabnya tetap tersimpan dan tidak dialihkan otomatis.
- Profil non-secret, hubungan tab dengan koneksi, dan riwayat tersimpan di browser. Koneksi
  aktif beserta kredensialnya hanya berada di memori server: reload browser tetap mengenalinya,
  sedangkan restart server membutuhkan reconnect. Tidak ada koneksi database otomatis saat startup.
  Untuk profil Hive, JDBC URL dan password perlu diisi lagi saat reconnect.

Image Docker sudah membawa driver JDBC PostgreSQL dan MySQL. Untuk menjalankan lokal, letakkan
driver tambahan di folder `drivers/` atau set `JDBC_DRIVER_DIR` ke folder yang berisi
`postgresql-*.jar` dan `mysql-connector-j-*.jar`.

File `.env` hanya berisi pengaturan aplikasi:

```dotenv
PORT=4173
QUERY_TIMEOUT_MS=30000
DEFAULT_QUERY_LIMIT=50
```

Salin `.env.example` menjadi `.env` bila belum ada. Nilai environment proses untuk tiga
pengaturan ini memiliki prioritas lebih tinggi. File `.env` diabaikan Git dan tidak
masuk Docker image. Compose meneruskan timeout dan limit serta menggunakan `PORT`
sebagai port akses di host.

Semua koneksi PostgreSQL, MySQL, dan Spark Thrift / Hive ditambahkan dari **Add connection**
di panel Database. Kredensial Spark lama dari `.env` atau environment tidak membuat
koneksi default di backend Java. Aplikasi mulai dengan daftar koneksi aktif kosong;
profil yang tersimpan di browser perlu dihubungkan kembali setelah restart server.

Jika belum ada koneksi, status menunjukkan `Not configured` dan tombol query dinonaktifkan.
Username dan password tidak dikembalikan oleh endpoint health.

## Menjalankan secara lokal

Mode lokal membutuhkan instalasi Spark 3.5.6 yang memiliki Hive JDBC driver. PostgreSQL/MySQL
membutuhkan driver JDBC tambahan seperti dijelaskan di atas:

```bash
ls /home/buana/.local/opt/spark-3.5.6-bin-hadoop3/jars/hive-jdbc-2.3.9.jar
```

Jika Spark terpasang di lokasi standar:

```bash
cd /home/buana/Documents/Project/thrift-query-ui
npm start
```

Jika lokasi Spark berbeda:

```bash
export SPARK_HOME=/path/ke/spark-3.5.6-bin-hadoop3
npm start
```

## Menjalankan dengan Docker Compose

Mode Docker tidak membutuhkan instalasi Java atau Spark di komputer host.
Image menyediakan Java runtime, distribusi Apache Spark 3.5.6 lengkap di
`/opt/spark`, serta Hive JDBC client secara otomatis.

Compose menjalankan aplikasi workbench. Spark Thrift Server yang menjadi target
query tetap harus tersedia sebagai service eksternal dan dikonfigurasi melalui
`.env` seperti pada bagian konfigurasi koneksi.

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
PORT=8080 docker compose up --build -d
```

Hentikan container dengan:

```bash
docker compose down
```

Buka <http://127.0.0.1:4173> untuk langsung menggunakan workspace.

Konfigurasi Docker yang tersedia:

- `PORT` — port host untuk workbench, default `4173`.
- `QUERY_TIMEOUT_MS` — batas waktu query, default `30000`.
- `DEFAULT_QUERY_LIMIT` — batas hasil jika LIMIT tidak ditulis atau bernilai NULL, default `50`. LIMIT eksplisit pada SQL mengambil prioritas.

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
  terakhir disimpan sebagai JSON di `localStorage` browser agar tetap tersedia
  setelah reload.
- Backend bind ke `127.0.0.1` secara default. Jika dipasang di server bersama,
  letakkan di belakang autentikasi/reverse proxy dan gunakan akun database
  dengan izin sesuai operasi yang dibutuhkan.
- SQL dikirim langsung ke `java.sql.Statement`; tidak ada shell atau proses CLI.

## Endpoint

Kontrak API tersedia di [`openapi.yaml`](./openapi.yaml):

- `GET /api/health` — status konfigurasi tanpa mengembalikan secret.
- `POST /api/connections/test` — menguji detail JDBC tanpa mengaktifkannya.
- `GET /api/connections` — daftar koneksi dengan ID stabil dan metadata tanpa secret.
- `POST /api/connections/connect` — tambah koneksi; sertakan `connectionId` untuk reconnect ID yang sama.
- `POST /api/connections/disconnect` — body `{ "connectionId": "..." }`, menghapus satu koneksi dari memori.
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

## Pengembangan

```bash
npm test
npm run check
```

`npm start` sekarang menjalankan backend Java JDBC. `node server.js` hanya
tersisa sebagai backend Node legacy dan tidak digunakan oleh jalur utama.


Pengujian mencakup policy SQL, eksekusi JDBC dengan fixture, metadata di atas 10 baris, model draft, parsing statement, formatting, serta controller dengan simulasi DOM. Simulasi DOM tidak memverifikasi render browser. Pada sesi implementasi ini host browser tidak tersedia sehingga tampilan desktop/mobile dan interaksi browser belum diverifikasi secara visual. Tidak ada query mutasi pengujian yang dijalankan ke database asli.
