'use strict';
(() => {
  const actions = ['auth.start','auth.login','auth.logout','connection.list','connection.save','connection.test','connection.connect','connection.details','connection.disconnect','connection.delete','query.execute','metadata.databases','metadata.namespaces','metadata.tables','metadata.columns','result.export_requested'];
  const outcomes = {pending:'Pending · hasil belum tercatat',success:'Berhasil',failure:'Gagal',denied:'Ditolak'};
  function node(tag, text) {
    const result = document.createElement(tag);
    if (text !== undefined) result.textContent = String(text);
    return result;
  }
  function mount({api,user,capabilities}) {
    const $ = id => document.querySelector('#activity-' + id);
    const admin = capabilities?.auditAdmin === true;
    let generation = 0, cursor = null, filters = {}, opened = false;
    $('admin-filters').hidden = !admin;
    $('scope').value = 'mine'; $('user').value = '';
    for (const action of actions) { const option = node('option', action); option.value = action; $('action').append(option); }
    function readFilters() {
      const next = {};
      for (const key of ['from','to','action','outcome','connectionId']) {
        const value = $(key).value.trim();
        if (value) next[key] = key === 'from' || key === 'to' ? new Date(value).toISOString() : value;
      }
      next.scope = admin && $('scope').value === 'all' ? 'all' : 'mine';
      if (admin && next.scope === 'all' && $('user').value) next.userId = $('user').value;
      return next;
    }
    function details(event) {
      $('detail').textContent = [
        'Request ID: ' + event.requestId, 'Akun: ' + (event.login ? '@' + event.login : 'Belum terverifikasi') + ' · ' + (event.userId || '—'),
        'Mulai UTC: ' + event.startedAt, 'Selesai UTC: ' + (event.finishedAt || 'Belum tercatat'),
        'Status: ' + (outcomes[event.outcome] || event.outcome), 'HTTP: ' + (event.httpStatus ?? '—'),
        'Kode: ' + (event.code || '—'), 'Sumber: ' + event.source, 'Baris hasil: ' + (event.returnedRows ?? '—'),
        'Baris terdampak: ' + (event.affectedRows ?? '—'), 'SQL fingerprint: ' + (event.sqlHash || '—'),
        'Referensi query: ' + (event.queryRequestId || '—'), 'Format ekspor: ' + (event.exportFormat || '—')
      ].join('\n');
      $('detail').hidden = false;
    }
    function render(events) {
      const head = node('thead'), headings = node('tr');
      for (const label of ['Waktu UTC','Akun','Aktivitas','Koneksi','Status','Durasi','Detail']) { const th = node('th', label); th.setAttribute('scope','col'); headings.append(th); }
      head.append(headings);
      const body = node('tbody');
      for (const event of events) {
        const row = node('tr');
        for (const value of [event.startedAt,event.login ? '@' + event.login : 'Belum terverifikasi',event.action + (event.sqlOperation ? ' · ' + event.sqlOperation : ''),event.connectionId || '—',outcomes[event.outcome] || event.outcome,event.durationMs == null ? '—' : event.durationMs + ' ms']) row.append(node('td',value));
        const cell = node('td'), button = node('button','Detail'); button.type = 'button'; button.className = 'text-button';
        button.addEventListener('click',()=>details(event)); cell.append(button); row.append(cell); body.append(row);
      }
      $('table').replaceChildren(head,body);
    }
    async function load(next = false) {
      const attempt = ++generation;
      $('status').textContent = 'Memuat aktivitas…'; $('next').disabled = true; $('detail').hidden = true;
      $('table').replaceChildren(); $('panel').setAttribute('aria-busy','true');
      try {
        const params = new URLSearchParams(filters);
        if (next && cursor) params.set('cursor',cursor);
        const data = await api('/api/activity?' + params);
        if (attempt !== generation) return;
        if (!Array.isArray(data.events)) throw new Error('Format aktivitas tidak valid.');
        render(data.events); cursor = data.nextCursor || null;
        $('status').textContent = data.events.length ? data.events.length + ' aktivitas · terbaru dahulu' : 'Belum ada aktivitas untuk filter ini.';
        $('next').disabled = !cursor;
      } catch (error) { if (attempt === generation) $('status').textContent = 'Aktivitas gagal dimuat. ' + error.message; }
      finally { if (attempt === generation) $('panel').setAttribute('aria-busy','false'); }
    }
    async function apply() {
      try { filters = readFilters(); cursor = null; await load(); }
      catch { generation++; $('table').replaceChildren(); $('detail').hidden = true; $('next').disabled = true; $('status').textContent = 'Periksa rentang waktu filter.'; $('panel').setAttribute('aria-busy','false'); }
    }
    $('scope').addEventListener('change',()=>{ $('user').disabled = $('scope').value !== 'all'; });
    $('user').disabled = true;
    $('filters').addEventListener('submit',event=>{ event.preventDefault(); return apply(); });
    $('next').addEventListener('click',()=>load(true));
    $('refresh').addEventListener('click',apply);
    async function show() {
      if (!opened) {
        opened = true;
        if (admin) api('/api/activity/users').then(data=>{
          for (const actor of data.users || []) { const option = node('option','@' + actor.login + ' · ' + actor.id); option.value = actor.id; $('user').append(option); }
        }).catch(()=>{});
      }
      return apply();
    }
    async function exportRequested(queryRequestId,format,rowCount) {
      if (!queryRequestId) throw new Error('Jalankan query kembali untuk memperoleh referensi audit ekspor.');
      const response = await api('/api/activity/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({queryRequestId,format,rowCount})});
      if (!response.ok || response.auditIncomplete) throw new Error('Catatan ekspor belum lengkap. Periksa Activity sebelum mengunduh.');
    }
    return Object.freeze({show,exportRequested});
  }
  window.GridBaseActivity = Object.freeze({mount});
})();
