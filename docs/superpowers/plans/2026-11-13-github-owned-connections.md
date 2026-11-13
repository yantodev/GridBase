# Isolasi koneksi per akun Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Batasi koneksi database pada pemilik GitHub yang login, termasuk data lama dan cache browser.

**Architecture:** Identitas sesi memakai ID GitHub. Registry per akun memuat store SQLite berfilter owner; browser menunggu identitas dan memakai namespace akun.

**Tech Stack:** Java HTTP/JDBC, SQLite, Node.js, JavaScript browser.

**Spec:** `docs/superpowers/specs/2026-11-13-github-owned-connections-design.md`.

## Global Constraints

- Pemilik berasal dari sesi terverifikasi; input owner klien tidak memberi hak akses.
- Profil lama hanya dimigrasikan ke ID tujuan dari konfigurasi operator.
- Tidak memindahkan tag/release `V1.0.0` atau menerbitkan release baru tanpa permintaan.

## Review Focus

- ID akun stabil setelah username berubah atau dipakai ulang.
- Akses silang ditolak sebelum test koneksi maupun SQL berjalan.
- Migrasi atomik dan ciphertext tidak dapat dipindahkan antar pemilik.
- Request paralel dan default koneksi tidak tertukar antar akun.
- Tab/cache dari sesi lama tidak tampil atau menulis sebagai akun baru.

### Task 1: Server dan persistence

**Files:** `GitHubAuth.java`, `JsonUtil.java`, `ConnectionStore.java`, `ConnectionRegistry.java`, `ConnectionWorkspaces.java`, `ThriftQueryServer.java`, `AppConfig.java`, serta tes Java terkait.

- [x] Tulis tes HTTP dua akun dan amati kegagalan akses silang pada implementasi lama.
- [x] Tulis tes store/migrasi serta identitas numerik, lalu implementasikan scope pemilik dan transaksi migrasi.
- [x] Jalankan tes Java sampai semua akses silang dan migrasi terbukti benar.

### Task 2: Browser dan Node legacy

**Files:** `public/session.js`, `public/app.js`, `public/index.html`, `src/github-auth.js`, `server.js`, serta tes Node/browser.

- [x] Tulis tes cache dua akun, bootstrap setelah sesi, dan pergantian akun; amati kegagalan awal.
- [x] Implementasikan namespace dan header akun, ID sesi stabil, serta pemilik eksplisit untuk koneksi Node legacy.
- [x] Jalankan seluruh `npm test` dan `npm run check`.

### Task 3: Dokumentasi, review, dan data lokal

- [x] Perbarui README, OpenAPI, `.env.example`, serta Compose sesuai kepemilikan per akun.
- [x] Lakukan review akses silang dan migrasi, lalu verifikasi ulang temuan yang diperbaiki.
- [x] Atur ID migrasi lokal sesuai pilihan pengguna; backup dan migrasikan database nyata hanya ketika aman terhadap proses lama.
