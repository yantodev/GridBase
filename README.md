# Thrift Query Workbench

GUI lokal untuk menjalankan query read-only ke Spark Thrift Server melalui
Beeline. Browser tidak pernah menerima JDBC URL, username, atau password;
semua koneksi berlangsung dari backend Node di mesin yang menjalankan Beeline.

## Menjalankan

Pastikan Beeline bisa dipanggil dari terminal yang sama:

```bash
command -v beeline
beeline -u "$THRIFT_JDBC_URL" -n "$THRIFT_USERNAME" -p "$THRIFT_PASSWORD"
```

Jika command `beeline` hanya ada di instalasi Spark lokal, set path executable
secara eksplisit sebelum menjalankan server:

```bash
export BEELINE_BIN=/home/buana/.local/opt/spark-3.5.6-bin-hadoop3/bin/beeline
```

Server juga mencoba menemukan Beeline di `PATH` dan direktori
`/home/buana/.local/opt/spark*/bin/beeline` secara otomatis.

Jika koneksi CLI sudah berhasil:

```bash
cd /home/buana/workspace/thrift-query-ui
source ~/.bashrc
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
- SQL ditulis ke stdin Beeline; input tidak dilewatkan melalui shell.

## Endpoint

Kontrak API tersedia di [`openapi.yaml`](./openapi.yaml):

- `GET /api/health` — status konfigurasi tanpa mengembalikan secret.
- `GET /api/namespaces` — daftar namespace/database dari `SHOW DATABASES`.
- `POST /api/query` — body `{ "sql": "SELECT ..." }`.

## Pengembangan

```bash
npm test
npm run check
```

