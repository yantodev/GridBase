const METADATA_LIMIT = 10000;
function quoteIdentifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Identifier wajib diisi, maksimal 256 karakter, tanpa karakter kontrol.');
  }
  return '`' + value.replace(/`/g, '``') + '`';
}
function metadataSql(namespace, table) {
  const qualified = '`s3tables`.' + quoteIdentifier(namespace);
  return table === undefined ? 'SHOW TABLES IN ' + qualified : 'DESCRIBE ' + qualified + '.' + quoteIdentifier(table);
}
function extractTables(parsed) {
  const column = parsed.columns.find(c => /^(tablename|table_name)$/i.test(c)) || parsed.columns[1] || parsed.columns[0];
  return [...new Set(parsed.rows.slice(0, METADATA_LIMIT).map(row => row[column]).filter(v => typeof v === 'string' && v.trim()))];
}
function extractColumns(parsed) {
  const [nameKey, typeKey, commentKey] = parsed.columns;
  const seen = new Set();
  return parsed.rows.slice(0, METADATA_LIMIT).flatMap(row => {
    const name = row[nameKey];
    const type = row[typeKey] || '';
    const marker = name?.trim().startsWith('#') && (!type.trim() || /^#\s*col_name$/i.test(name.trim()) && /^data_type$/i.test(type.trim()));
    if (!name?.trim() || marker || seen.has(name)) return [];
    seen.add(name);
    return [{ name, type, comment: row[commentKey] || '' }];
  });
}
module.exports = { METADATA_LIMIT, quoteIdentifier, metadataSql, extractTables, extractColumns };
