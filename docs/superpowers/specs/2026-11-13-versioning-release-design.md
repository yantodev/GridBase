# Versioning dan release GridBase

Tujuan: menerbitkan GitHub Release `V1.0.0` dengan deskripsi fitur aktual, sekaligus memudahkan release berikutnya.

- `VERSION` menjadi sumber versi aplikasi dengan format stabil SemVer `MAJOR.MINOR.PATCH`.
- `package.json` dan `openapi.yaml` harus memakai versi yang sama; tag Git memakai awalan `V`.
- Perintah npm menaikkan patch/minor/major atau menetapkan versi eksplisit dan menyinkronkan ketiga berkas.
- Mode pemeriksaan mendeteksi versi yang tidak sinkron tanpa menulis berkas.
- Input tidak valid, versi yang mundur, atau metadata rusak ditolak sebelum berkas ditulis.
- Perintah versi tidak membuat commit, tag, push, atau release. Penerbitan tetap langkah yang eksplisit.
- `VERSIONING.md` menjelaskan SemVer, perintah versi, pemeriksaan, tag, dan pembuatan GitHub Release.
- `docs/releases/V1.0.0.md` menjadi isi deskripsi release perdana.
- Sertakan perubahan badge README yang sudah diminta dan samakan metadata release ke `1.0.0`.

Pendekatan: gunakan skrip Node.js tanpa dependensi karena Node sudah diperlukan untuk tooling proyek.
Mengubah metadata secara manual dipertimbangkan, tetapi mudah meninggalkan versi yang berbeda.
Tidak menambahkan layanan CI atau publikasi otomatis; alur lokal cukup untuk kebutuhan release ini.

Validasi: tes CLI pada proyek fixture sementara, seluruh `npm test`, `npm run check`, pemeriksaan diff, serta verifikasi commit/tag dan isi GitHub Release setelah publikasi.
