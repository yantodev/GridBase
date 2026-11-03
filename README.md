# Thrift Query Workbench

GUI lokal untuk menjalankan query read-only ke Spark Thrift Server melalui
Hive JDBC langsung dari Java. Browser tidak pernah menerima JDBC URL, username,
atau password; semua koneksi berlangsung dari backend Java.

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

Buka <http://127.0.0.1:4173>.

Alternatif yang lebih aman daripada menyimpan password di `.bashrc` adalah
mengisi `.env` lokal dari `.env.example`, lalu membatasi aksesnya:

```bash
cp .env.example .env
chmod 600 .env
```

Isi `THRIFT_USERNAME` dan `THRIFT_PASSWORD` hanya di `.env`. File tersebut
sudah masuk `.gitignore` dan tidak boleh di-commit.

## Perilaku aman

- Workbench hanya menerima `SELECT`, `WITH`, `SHOW`, `DESCRIBE`, dan `EXPLAIN`.
- Hasil dibatasi maksimal 1.000 baris dan query memiliki timeout 30 detik.
- Query dan hasil hanya disimpan di memori tab browser selama sesi berjalan.
- Backend bind ke `127.0.0.1` secara default. Jika dipasang di server bersama,
  letakkan di belakang autentikasi/reverse proxy dan gunakan akun database
  read-only.
- SQL dikirim langsung ke `java.sql.Statement`; tidak ada shell atau proses CLI.

## Endpoint

Kontrak API tersedia di [`openapi.yaml`](./openapi.yaml):

- `GET /api/health` — status konfigurasi tanpa mengembalikan secret.
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

