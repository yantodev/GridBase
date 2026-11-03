const MAX_SQL_LENGTH = 20_000;

const READ_ONLY_START = /^(select|with|show|describe|desc|explain)\b/i;
const MUTATION_WORD = /\b(insert|update|delete|drop|alter|truncate|create|merge|grant|revoke|msck|load|set|reset|use)\b/i;

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .trim();
}

function validateQuery(input, options = {}) {
  const maxLength = options.maxLength ?? MAX_SQL_LENGTH;

  if (typeof input !== "string") {
    return { ok: false, error: "Query harus berupa teks." };
  }

  const sql = stripSqlComments(input).replace(/;+\s*$/, "").trim();
  if (!sql) {
    return { ok: false, error: "Query tidak boleh kosong." };
  }
  if (sql.length > maxLength) {
    return { ok: false, error: `Query terlalu panjang. Maksimal ${maxLength.toLocaleString("id-ID")} karakter.` };
  }
  if (/\0/.test(sql)) {
    return { ok: false, error: "Query mengandung karakter yang tidak valid." };
  }
  if (!READ_ONLY_START.test(sql)) {
    return { ok: false, error: "Mode aman hanya mengizinkan SELECT, WITH, SHOW, DESCRIBE, dan EXPLAIN." };
  }
  if (MUTATION_WORD.test(sql)) {
    return { ok: false, error: "Query perubahan data diblokir karena workbench berjalan dalam mode read-only." };
  }

  return { ok: true, sql };
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
  parseCsv,
  parseCsvLine,
  redactJdbcUrl,
  stripSqlComments,
  validateQuery,
};

