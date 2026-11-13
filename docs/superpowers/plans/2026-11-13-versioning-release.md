# Versioning dan Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rilis `V1.0.0` dan sediakan pengelolaan versi yang konsisten.

**Architecture:** `VERSION` menjadi sumber versi; skrip Node.js menyinkronkan metadata paket dan OpenAPI. Tag dan GitHub Release dibuat sesudah verifikasi.

**Tech Stack:** Node.js, Git, GitHub Releases API, Markdown.

**Spec:** `docs/superpowers/specs/2026-11-13-versioning-release-design.md`.

## Global Constraints

- Versi stabil memakai `MAJOR.MINOR.PATCH`; tag memakai awalan `V`.
- Tidak menambahkan dependensi npm atau mengubah runtime aplikasi.
- Tidak menampilkan atau menyimpan token GitHub dalam repository.

## Review Focus

- Bump minor/major harus mereset komponen yang lebih rendah.
- Pemeriksaan versi berbeda harus gagal tanpa mengubah berkas.
- Input tidak valid dan downgrade tidak boleh mengubah metadata.
- Perintah harus memakai direktori proyeknya, bukan cwd pemanggil.
- Tag dan release harus menunjuk commit yang sudah diverifikasi.

### Task 1: CLI versioning

**Files:** `scripts/version.js`, `test/version.test.js`, `VERSION`, `package.json`, `openapi.yaml`.

**Interfaces:** `node scripts/version.js --check|patch|minor|major|X.Y.Z`; exit 0 berarti sukses, exit nonzero berarti ditolak.

- [ ] Tulis dan jalankan tes CLI pada fixture sementara untuk sync, bump, drift, invalid input, downgrade, dan cwd berbeda; pastikan gagal sebelum implementasi.
- [ ] Implementasikan sinkronisasi tiga berkas tanpa operasi Git; hubungkan skrip npm dan pemeriksaan versi ke suite.
- [ ] Jalankan tes CLI dan pastikan lulus.

### Task 2: Dokumentasi dan metadata release

**Files:** `VERSIONING.md`, `docs/releases/V1.0.0.md`, `README.md`.

- [ ] Jelaskan SemVer, perintah versi, langkah verifikasi, tag, serta contoh `gh release create --notes-file`.
- [ ] Siapkan deskripsi release dengan fitur, konfigurasi GitHub OAuth, Docker, dan batasan yang sudah diketahui.
- [ ] Set versi `1.0.0`, jalankan seluruh suite dan pemeriksaan, lalu periksa diff.

### Task 3: Publikasi

- [ ] Pastikan autentikasi GitHub dan tag `V1.0.0` belum dipakai.
- [ ] Commit perubahan yang terkait release, buat annotated tag, dan push tanpa force.
- [ ] Terbitkan GitHub Release beserta deskripsi; verifikasi tag, commit, status publikasi, dan isi deskripsi.
