const MAX_SQL_LENGTH = 20_000;

const SQL_START = /^(select|with|show|describe|desc|explain|create|insert|update|delete|merge|alter|drop|truncate)\b/i;
const SQL_QUOTE_OR_COMMENT = /'(?:''|\\[\s\S]|[^'\\])*'|"(?:""|\\[\s\S]|[^"\\])*"|`(?:``|[^`])*`|\/\*[\s\S]*?\*\/|--[^\r\n]*/g;

function stripSqlComments(sql) {
  return sql
    .replace(SQL_QUOTE_OR_COMMENT, (token) => token.startsWith("/*") || token.startsWith("--") ? " " : token)
    .trim();
}

function validateQuery(input, options = {}) {
  const maxLength = options.maxLength ?? MAX_SQL_LENGTH;

  if (typeof input !== "string") {
    return { ok: false, error: "Query harus berupa teks." };
  }

  if (input.length > maxLength) {
    return { ok: false, error: `Query terlalu panjang. Maksimal ${maxLength.toLocaleString("id-ID")} karakter.` };
  }
  if (/\0/.test(input)) {
    return { ok: false, error: "Query mengandung karakter yang tidak valid." };
  }
  const sql = stripSqlComments(input).replace(/;\s*$/, "").trim();
  if (!sql) {
    return { ok: false, error: "Query tidak boleh kosong." };
  }
  const code = sql.replace(SQL_QUOTE_OR_COMMENT, "?");
  if (code.includes(";") || /(^|\n)\s*!/.test(code)) {
    return { ok: false, error: "Jalankan satu perintah SQL dalam satu query." };
  }
  if (!SQL_START.test(code)) {
    return { ok: false, error: "Perintah SQL tidak didukung. Gunakan query data atau perintah CREATE, INSERT, UPDATE, DELETE, MERGE, ALTER, DROP, atau TRUNCATE." };
  }

  return { ok: true, sql };
}

function queryResultLimit(sql, defaultLimit = 50) {
  const masked = sql.replace(SQL_QUOTE_OR_COMMENT, token => (token.startsWith('/*') || token.startsWith('--') ? ' ' : '?').repeat(token.length));
  const words = [];
  let depth = 0;
  for (const token of masked.matchAll(/[a-z_][a-z0-9_$]*|[()]/gi)) {
    if (token[0] === '(') depth++;
    else if (token[0] === ')') depth--;
    else if (depth === 0) words.push({ word: token[0].toUpperCase(), start: token.index, end: token.index + token[0].length });
  }
  let command = words[0]?.word;
  if (command === 'WITH') command = words.find(t => /^(SELECT|INSERT|UPDATE|DELETE|MERGE)$/.test(t.word))?.word;
  if (command !== 'SELECT') return { sql, rowLimit: defaultLimit };
  for (let i = words.length - 1; i > 0; i--) {
    const token = words[i];
    if (token.word !== 'LIMIT') continue;
    const previous = words[i-1];
    if (/^(SELECT|FROM|JOIN|AS|WHERE|AND|OR|ON|BY|INTO|TABLE|UPDATE)$/.test(previous.word) && !masked.slice(previous.end,token.start).trim()) continue;
    const before = masked.slice(0,token.start).trimEnd();
    if (before && '.,><=!+-*/%'.includes(before.at(-1))) continue;
    if (words.slice(i+1).some(t => /^(SELECT|FROM|WHERE|GROUP|HAVING|ORDER|UNION|INTERSECT|EXCEPT|JOIN|LATERAL|WINDOW|QUALIFY|AS|ASC|DESC|NULLS|FIRST|LAST|INSERT|UPDATE|DELETE|MERGE)$/.test(t.word))) continue;
    const value = masked.slice(token.end);
    if (!/^\s*(?:NULL\b|ALL\b|CASE\b|[+-]?\d|\(|[a-z_][a-z0-9_$]*\s*\()/i.test(value)) continue;
    const nullValue = value.match(/^\s*NULL\b/i);
    if (nullValue) {
      const start = token.end + nullValue[0].length - 4;
      return { sql: sql.slice(0, start) + defaultLimit + sql.slice(start + 4), rowLimit: defaultLimit };
    }
    return { sql, rowLimit: null };
  }
  return { sql, rowLimit: defaultLimit };
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function parseCsv(text) {
  const records = [];
  let record = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      record.push(cell);
      cell = "";
    } else if (char === "\n" && !quoted) {
      record.push(cell.replace(/\r$/, ""));
      if (record.some((value) => value.length > 0)) records.push(record);
      record = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || record.length > 0) {
    record.push(cell.replace(/\r$/, ""));
    if (record.some((value) => value.length > 0)) records.push(record);
  }

  if (records.length === 0) {
    return { columns: [], rows: [] };
  }

  const columns = records[0];
  const rows = records.slice(1).map((values) => {
    return columns.reduce((record, column, index) => {
      record[column || `column_${index + 1}`] = values[index] ?? "";
      return record;
    }, {});
  });

  return { columns, rows };
}

function redactJdbcUrl(jdbcUrl) {
  if (typeof jdbcUrl !== "string" || !jdbcUrl) return null;
  return jdbcUrl.replace(/(password|token|secret)=[^;]*/gi, "$1=••••••");
}

function extractDatabases(result) {
  const preferredColumn = result.columns.find((column) => /^(namespace|database(name)?|schema)$/i.test(column));
  return result.rows
    .map((row) => preferredColumn ? row[preferredColumn] : Object.values(row)[0])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function extractNamespaces(result) {
  return extractDatabases(result);
}

module.exports = {
  extractDatabases,
  extractNamespaces,
  MAX_SQL_LENGTH,
  queryResultLimit,
  parseCsv,
  parseCsvLine,
  redactJdbcUrl,
  stripSqlComments,
  validateQuery,
};

