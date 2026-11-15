# Versioning dan release

GridBase memakai [Semantic Versioning](https://semver.org/lang/id/) dengan format
`MAJOR.MINOR.PATCH`. Versi aplikasi saat ini tersimpan di [`VERSION`](./VERSION).

- **PATCH**, misalnya `1.0.0` → `1.0.1`: perbaikan bug atau dokumentasi tanpa mengubah kompatibilitas.
- **MINOR**, misalnya `1.0.1` → `1.1.0`: fitur baru yang tetap kompatibel.
- **MAJOR**, misalnya `1.1.0` → `2.0.0`: perubahan yang tidak kompatibel dengan versi sebelumnya.

Versi yang sama harus tercantum di `VERSION`, `package.json`, dan `info.version`
dalam `openapi.yaml`. Field `openapi: 3.0.3` menyatakan versi spesifikasi OpenAPI
dan tidak mengikuti versi aplikasi. Tag Git memakai huruf **V** besar, misalnya `V1.0.0`.

## Memperbarui versi

Jalankan salah satu perintah berikut dari direktori proyek:

```bash
npm run version:patch
npm run version:minor
npm run version:major
```

Setiap perintah memperbarui ketiga berkas sekaligus. Minor mereset patch ke nol;
major mereset minor dan patch ke nol. Untuk menentukan versi secara eksplisit:

```bash
npm run version:set -- 1.1.0
```

Gunakan perintah bump pada awal persiapan release, bukan setiap kali mengedit.
Menetapkan versi yang sama boleh dilakukan untuk menyinkronkan metadata. Downgrade,
angka dengan leading zero, awalan `V`, serta versi prerelease ditolak oleh tooling ini.
Nilai `VERSION` dipakai sebagai acuan saat metadata lain berbeda.

Perintah versi hanya mengubah metadata lokal. Setelah metadata dan release notes
di-commit lalu masuk ke `master`, workflow Release membuat tag dan GitHub Release
secara otomatis. Bump versi tetap keputusan eksplisit, bukan otomatis setiap push.

## Memeriksa konsistensi

```bash
npm run version:check
```

Pemeriksaan tidak menulis berkas dan gagal jika ketiga versi berbeda. `npm test`
serta `npm run check` juga menjalankan pemeriksaan ini.

## Release otomatis (GitHub Actions)

Workflow [Release](./.github/workflows/release.yml) berjalan pada setiap push ke
`master`, atau melalui **Actions → Release → Run workflow** dengan branch `master`.

1. Jalankan bump yang sesuai dan siapkan `docs/releases/V<versi>.md`.
2. Commit metadata, release notes, dan fitur terkait, lalu push/merge ke `master`.
3. Actions menyiapkan Node 22, Java 17, dan Spark JDBC 3.5.6, lalu menjalankan
   seluruh `npm test` dan `npm run check`. Kegagalan menghentikan publikasi.
4. Setelah verifikasi, `npm run release:publish` membuat annotated tag `V<versi>`
   jika belum ada, lalu memublikasikan Release dengan judul `GridBase V<versi>` dan
   isi release notes. Rilis baru ditandai latest hanya jika lebih tinggi daripada
   latest yang sudah ada.

Workflow memakai `GITHUB_TOKEN` bawaan, bukan personal access token. Izin default
`contents: read`; hanya job publikasi memiliki `contents: write`. Tidak berjalan
pada pull request atau branch lain. Pastikan Actions diizinkan pada repository;
ruleset yang membatasi pembuatan tag juga harus mengizinkan actor Actions.

Menjalankan ulang tidak membuat Release duplikat atau memindahkan tag. Jika tag
sudah ada tetapi Release belum dibuat (misalnya V1.2.0), workflow memakai tag
tersebut setelah memeriksa commit-nya merupakan ancestor checkout, VERSION sesuai,
dan release notes sama. Push tanpa perubahan versi tidak membuat versi baru.
Catatan rilis yang hilang, drift versi, gangguan API, atau target tag yang tidak
sesuai menyebabkan gagal, bukan mengganti tag/rilis yang telah terbit. Draft atau
prerelease yang sudah ada memerlukan penanganan operator, tidak dipublikasikan diam-diam.

Periksa run Actions dan halaman **Releases** setelah push; keberadaan tag saja
bukan bukti publikasi berhasil. Job publikasi membaca kembali Release melalui API.

## Membuat release manual (alternatif)

1. Pastikan fitur yang akan dirilis sudah siap dan branch `master` sesuai dengan remote.
2. Jalankan perintah bump yang sesuai, atau `version:set` untuk versi yang sudah ditentukan.
3. Buat deskripsi pada `docs/releases/V<versi>.md`, misalnya
   [`docs/releases/V1.1.0.md`](./docs/releases/V1.1.0.md). Jelaskan fitur, perbaikan,
   perubahan kompatibilitas, kebutuhan konfigurasi, dan batasan yang relevan.
4. Jalankan `npm test` dan `npm run check`. Atur `SPARK_HOME` sesuai instalasi lokal;
   lihat [README](./README.md#menjalankan-secara-lokal).
5. Periksa diff lalu commit seluruh perubahan yang termasuk dalam release.
6. Buat annotated tag pada commit yang telah diperiksa dan push branch serta tag.
7. Terbitkan GitHub Release dengan tag dan berkas deskripsi tersebut.

Contoh setelah versi `1.1.0` sudah disiapkan dan seluruh pemeriksaan lulus:

```bash
git diff --check
git add VERSION package.json openapi.yaml docs/releases/V1.1.0.md
git commit -m "chore: prepare V1.1.0 release"
git tag -a V1.1.0 -m "GridBase V1.1.0"
git push origin master
git push origin V1.1.0
gh release create V1.1.0 --verify-tag --title "GridBase V1.1.0" --notes-file docs/releases/V1.1.0.md --latest
```

Sertakan juga berkas fitur/dokumentasi lain yang terkait dalam commit tersebut.
Contoh publikasi memakai [GitHub CLI](https://cli.github.com/) yang sudah login
melalui `gh auth login`. Alternatifnya, buka halaman **Releases → Draft a new release**
di GitHub, pilih tag, salin deskripsi, lalu publish.

Tag yang sudah diterbitkan tidak dipindahkan atau ditimpa. Jika ditemukan masalah
pada release, buat perbaikan dan terbitkan versi patch berikutnya.
