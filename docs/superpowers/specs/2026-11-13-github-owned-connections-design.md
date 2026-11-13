# Koneksi milik akun GitHub

Tujuan: profil dan akses database hanya tersedia bagi akun GitHub pemiliknya.

- Gunakan ID numerik GitHub yang tetap, bukan username atau nilai owner yang dikirim klien.
- Sesi menyimpan ID dan username; pergantian username tidak memindahkan kepemilikan.
- SQLite menyimpan `owner_id`; seluruh load/save/delete dibatasi pemilik. Ciphertext AES-GCM terikat pada owner dan ID koneksi.
- Registry runtime dan koneksi default dipisahkan per akun; tidak ada state pemilik pada atribut HttpContext bersama.
- Semua endpoint koneksi, metadata, health, dan query menggunakan registry pemilik dari sesi.
- ID koneksi akun lain menghasilkan 404 dan ditolak sebelum JDBC atau perubahan data.
- `LEGACY_CONNECTION_OWNER_ID` adalah konfigurasi operator untuk migrasi profil lama dalam satu transaksi. Tanpa konfigurasi, profil lama tetap tersembunyi dan tidak dapat diklaim lewat login.
- Pengguna meminta seluruh profil lama dipindahkan ke akun GitHub yang telah dipilih; ID tujuan ditetapkan pada `.env` lokal.
- Backend Node legacy hanya memperlihatkan koneksi environment kepada ID pemilik yang dikonfigurasi.
- Workbench baru dimuat setelah identitas sesi terverifikasi. Cache koneksi, draft, dan history diberi namespace ID akun.
- Tab dengan akun yang berubah disembunyikan dan dimuat ulang. Header akun yang diharapkan menolak request tab lama sebelum operasi API berjalan.
- Backup/migrasi data lokal dilakukan setelah pengujian, dengan memperhatikan server lama yang mungkin masih berjalan.

Pendekatan: registry per akun dengan satu store SQLite berfilter owner. Ini mempertahankan batas 20 koneksi per akun dan perilaku console yang ada. Filter UI saja tidak cukup karena ID koneksi bisa dikirim langsung ke API.

Validasi: tes HTTP dua akun, pergantian username/akun, request paralel, migrasi dan integritas enkripsi, penolakan sebelum JDBC, serta simulasi browser untuk bootstrap dan cache per akun. Jalankan seluruh suite dan kompilasi sebelum menyatakan selesai.
