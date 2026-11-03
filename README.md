# Thrift Query Workbench

GUI lokal untuk menjalankan query read-only ke Spark Thrift Server melalui
Hive JDBC langsung dari Java. Browser tidak pernah menerima JDBC URL, username,
atau password; semua koneksi berlangsung dari backend Java.

## Tech stack

<p align="center">
  <code>Java</code>&nbsp;&nbsp;
  <code>Apache Spark</code>&nbsp;&nbsp;
  <code>Hive JDBC</code>&nbsp;&nbsp;
  <code>Node.js</code>&nbsp;&nbsp;
  <code>JavaScript</code>&nbsp;&nbsp;
  <code>HTML/CSS</code>
</p>

## Menjalankan

Pastikan instalasi Spark memiliki Hive JDBC driver:

```bash
ls /home/buana/.local/opt/spark-3.5.6-bin-hadoop3/jars/hive-jdbc-2.3.9.jar
```

Jika Spark terpasang di lokasi standar:

```bash
cd /home/buana/workspace/thrift-query-ui
npm start
```

Jika lokasi Spark berbeda:

```bash
export SPARK_HOME=/path/ke/spark-3.5.6-bin-hadoop3
npm start
```

Buka <http://127.0.0.1:4173>. Pada pemakaian pertama, workbench akan meminta:

- `THRIFT_JDBC_URL`
- `THRIFT_USERNAME`
- `THRIFT_PASSWORD`

Credential tersebut dikirim ke endpoint setup lokal, dipakai oleh Java JDBC,
dan hanya disimpan di memory proses server. Credential tidak disimpan di
`.env`, `localStorage`, atau dikembalikan oleh endpoint health. Setelah server
direstart, setup akan diminta kembali.

`.env` tetap tersedia untuk pengaturan non-secret seperti port, timeout, dan
batas jumlah baris. Tiga nilai credential tidak dibaca dari environment atau
`.env`, sehingga setup form selalu menjadi sumber konfigurasi koneksi.

## Perilaku aman

- Workbench hanya menerima `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, dan `EXPLAIN`.
- Hasil dibatasi maksimal 1.000 baris dan query memiliki timeout 30 detik.
- Query dan hasil tidak dikirim ke penyimpanan permanen; lima Recent queries
  terakhir disimpan sebagai JSON di `localStorage` browser agar tetap tersedia
  setelah reload.
- Backend bind ke `127.0.0.1` secara default. Jika dipasang di server bersama,
  letakkan di belakang autentikasi/reverse proxy dan gunakan akun database
  read-only.
- SQL dikirim langsung ke `java.sql.Statement`; tidak ada shell atau proses CLI.

## Endpoint

Kontrak API tersedia di [`openapi.yaml`](./openapi.yaml):

- `GET /api/health` — status konfigurasi tanpa mengembalikan secret.
- `POST /api/setup` — menerima `jdbcUrl`, `username`, dan `password` untuk sesi
  server saat ini; password tidak pernah dikembalikan.
- `GET /api/databases` — daftar namespace dari katalog `s3tables` melalui `SHOW NAMESPACES IN s3tables`.
- `GET /api/namespaces` — alias deprecated untuk klien lama; gunakan `/api/databases`.
- `POST /api/query` — body `{ "sql": "SELECT ..." }`.

## Pengembangan

```bash
npm test
npm run check
```

`npm start` sekarang menjalankan backend Java JDBC. `node server.js` hanya
tersisa sebagai backend Node legacy dan tidak digunakan oleh jalur utama.

