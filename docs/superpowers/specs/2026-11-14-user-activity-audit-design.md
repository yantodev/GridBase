# Audit aktivitas pengguna GridBase

## Tujuan dan keputusan pengguna

Simpan aktivitas operasional berdasarkan akun GitHub agar mudah ditelusuri lintas sesi
dan restart. Pengguna melihat riwayatnya sendiri; admin audit dapat melihat seluruh akun.
Pengguna memilih `yantodev` sebagai admin. Gunakan ID GitHub tetap `49233072` untuk
konfigurasi lokal; jangan hardcode akun pribadi pada kode atau konfigurasi contoh.

Kepemilikan koneksi dari V1.1.0 tetap berlaku. Hak admin audit hanya memberikan akses
ke catatan aktivitas; tidak memberikan akses ke kredensial, eksekusi query, atau hasil
database akun lain.

## Pendekatan penyimpanan

- **SQLite terpisah di server, `data/audit.sqlite` — rekomendasi untuk implementasi ini.**
  Memakai driver dan volume persisten yang sudah tersedia. Mendukung pencarian SQL,
  indeks per akun/waktu, dan backup mandiri. File terpisah mengurangi persaingan tulis
  dengan penyimpanan kredensial. Cocok untuk deployment satu instance saat ini.
- **PostgreSQL terpusat.** Cocok untuk beberapa instance dan beban audit yang lebih besar;
  membutuhkan layanan, kredensial, dan pengoperasian database tambahan. Ini jalur
  pengembangan selanjutnya, bukan dependensi baru untuk fitur pertama.

SQLite adalah keputusan implementer yang diajukan berdasarkan arsitektur saat ini.
Pencatatan berada di backend Java yang dijalankan melalui `npm start`.

## Aktivitas dan data yang disimpan

Catat login berhasil/gagal, logout, Save/Test/Connect/Edit/Disconnect/Delete koneksi,
eksekusi query berhasil/gagal, penelusuran database/schema/tabel/kolom, dan permintaan
ekspor CSV/JSON. Catat juga penolakan akses untuk request operasional yang teridentifikasi.
Health check, file statis, pemeriksaan sesi otomatis, pengetikan editor, dan klik navigasi
biasa tidak menjadi event audit agar riwayat tetap berguna untuk penelusuran.

Setiap operasi memiliki request ID dari server, waktu UTC, ID dan snapshot username
GitHub, jenis aktivitas, ID koneksi bila relevan, status, durasi, HTTP status, serta kode
kegagalan yang aman. Query menambahkan jenis operasi dan jumlah baris hasil/terdampak
bila tersedia. Login gagal sebelum identitas diverifikasi mempunyai actor kosong dan
hanya dapat dilihat admin.

Usulan default: tidak menyimpan teks SQL lengkap, hasil query, password, JDBC URL lengkap,
token GitHub, cookie, kode/state OAuth, request body, atau pesan exception database mentah.
Fingerprint SHA-256 SQL dapat dipakai untuk menghubungkan eksekusi query yang sama tanpa
menyalin teksnya. Tidak menyimpan IP atau user agent pada tahap pertama.

Permintaan ekspor dilaporkan browser dan diberi sumber `browser`; tindakan server diberi
sumber `server`. Catatan ekspor menyatakan permintaan ekspor, bukan bukti bahwa file
selesai disimpan. Server menetapkan actor dari sesi dan memvalidasi keterkaitan dengan
eksekusi query milik pengguna; klien tidak dapat menyatakan tindakan server atau memilih
actor. Mencatat pengetikan/perubahan draft dan menyimpan SQL lengkap membutuhkan
keputusan cakupan baru.

## Ketahanan dan batas jaminan

Simpan intent `pending` sebelum operasi database dijalankan, lalu lengkapi hasilnya.
Jika intent tidak dapat disimpan, tolak operasi database sebelum JDBC dibuka. Jangan
menahan lock SQLite selama menjalankan JDBC. Crash meninggalkan intent yang hasilnya
belum tercatat, bukan keberhasilan palsu.

Jika penyimpanan hasil audit gagal setelah SQL selesai, jangan mengubah hasil SQL yang
berhasil menjadi pesan yang menyiratkan SQL tidak dijalankan. Intent tetap tersedia;
laporkan masalah audit secara aman pada server/respons. Transaksi SQLite audit tidak
dapat menjamin transaksi atomik bersama database JDBC eksternal. Logout tetap mencabut
sesi meskipun pencatatan mengalami gangguan.

Catatan tidak dapat diedit atau dihapus melalui aplikasi. Tidak menghapus catatan secara
otomatis pada tahap pertama; operator mengelola backup/arsip ketika ukuran bertambah.
SQLite ini bukan penyimpanan kebal perubahan oleh administrator sistem operasi.
File/direktori memakai izin privat dan tidak disajikan sebagai file statis.

## Akses dan konfigurasi

Tambahkan `AUDIT_ADMIN_IDS`, daftar ID numerik GitHub dipisahkan koma, default kosong.
Konfigurasi contoh tetap kosong. Lokal memakai `49233072` sesuai pilihan pengguna.
Hak admin tidak disimpulkan dari `LEGACY_CONNECTION_OWNER_ID`, username, parameter
request, atau data browser.

API audit memakai sesi GitHub dan pemeriksaan `X-GridBase-Account` yang sudah tersedia.
Scope default adalah akun sendiri. Scope seluruh akun dan filter actor lintas akun
memerlukan `AUDIT_ADMIN_IDS`; percobaan oleh pengguna biasa menghasilkan `403`.
Hak admin ditampilkan sebagai capability dari server, tetapi seluruh keputusan akses
tetap diverifikasi pada backend. Endpoint audit tidak memerlukan pembukaan JDBC atau
pemuatan profil koneksi sehingga tetap berguna saat penyimpanan profil bermasalah.

## Halaman dan API

Tambahkan tool **Activity** di sidebar yang mengikuti pola Database dan Query history.
Tampilkan waktu, akun, aktivitas, koneksi, status, dan durasi; detail menampilkan request
ID, waktu UTC, jumlah baris, dan kode hasil. Pengguna biasa hanya melihat riwayatnya.
Admin memperoleh pilihan Aktivitas saya / Semua pengguna serta filter akun.

```text
Activity                 [Aktivitas saya / Semua pengguna*]
[Dari] [Sampai] [Aktivitas] [Status] [Akun*] [Terapkan]
Waktu       Akun       Aktivitas           Koneksi   Status    Durasi
10:24:08    @pengguna  Query SELECT        db-...    Berhasil  34 ms
10:23:52    @pengguna  Connect             db-...    Gagal     105 ms
[Detail / Request ID]                                  [Berikutnya]
* hanya admin
```

Rencana kontrak: `GET /api/activity` untuk pencarian berpaginasi, `GET /api/activity/users`
untuk pilihan akun admin, dan endpoint terbatas untuk event ekspor browser. Gunakan
prepared statements, limit maksimum, dan cursor stabil. Filter tanggal, jenis aktivitas,
hasil, koneksi, dan akun divalidasi. Akses daftar audit sendiri tidak menghasilkan event
rekursif pada tahap pertama.

Indeks mendukung akun + urutan event, waktu, dan jenis aktivitas. Audit tetap tersimpan
saat koneksi dihapus; ID/snapshot deskriptif yang aman tidak bergantung pada profil aktif.
Membaca hasil audit tidak mengembalikan data profil kredensial.

## Dokumentasi dan kompatibilitas

Perbarui README, OpenAPI, `.env.example`, dan Compose. Backup audit adalah file tersendiri
di volume data; penyimpanan audit tidak mengubah schema atau key profil koneksi.
Backend Node legacy harus menyatakan fitur audit tidak didukung; dukungan penuh tahap
pertama berada pada backend Java. Tidak mengubah tag/release V1.1.0 yang sudah terbit.
Commit, versi, dan release fitur ini hanya dilakukan bila diminta pengguna.

## Verifikasi

Uji event berhasil/gagal, atribusi sesi tepercaya, admin dan isolasi dua akun, username
berubah/dipakai ulang, input filter/cursor, restart, operasi paralel, penolakan sebelum
JDBC saat intent gagal disimpan, serta outcome audit yang belum selesai. Pastikan secret,
teks SQL, dan hasil baris tidak tersimpan atau keluar melalui API. Uji capability, filter,
paginasi, ekspor browser, dan pergantian akun di frontend. Jalankan suite penuh dan
pemeriksaan build sebelum menyatakan fitur selesai.

Status: disetujui pengguna pada 2026-11-14 dengan instruksi “Lanjut sesuai rancangan”.
