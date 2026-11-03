const HISTORY_STORAGE_KEY = "thrift-query-workbench:history:v1";
const MAX_HISTORY_ITEMS = 5;

function loadHistory() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.sql === "string" && item.sql.trim() && Number.isFinite(item.rows) && Number.isFinite(item.ranAt))
      .slice(0, MAX_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)));
  } catch {
    // Private browsing and strict storage policies can disable localStorage.
  }
}

function formatHistoryTime(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

const state = {
  query: "",
  running: false,
  configured: false,
  history: loadHistory(),
};

const editor = document.querySelector("#sql-editor");
const lineNumbers = document.querySelector("#line-numbers");
const runButton = document.querySelector("#run-query");
const resultsEmpty = document.querySelector("#results-empty");
const resultsLoading = document.querySelector("#results-loading");
const resultsError = document.querySelector("#results-error");
const resultsTable = document.querySelector("#results-table-wrap");
const rowDetail = document.querySelector("#row-detail");
const closeRowDetailButton = document.querySelector("#close-row-detail");
const rowDetailTable = document.querySelector("#row-detail-table-wrap");
const toast = document.querySelector("#toast");
const s3tablesList = document.querySelector("#s3tables-list");
const refreshS3TablesButton = document.querySelector("#refresh-s3tables");
const setupGate = document.querySelector("#setup-gate");
const setupForm = document.querySelector("#setup-form");
const setupJdbcUrl = document.querySelector("#setup-jdbc-url");
const setupUsername = document.querySelector("#setup-username");
const setupPassword = document.querySelector("#setup-password");
const setupSubmit = document.querySelector("#setup-submit");
const setupError = document.querySelector("#setup-error");
const appShell = document.querySelector(".app-shell");
let rowDetailTrigger = null;

function updateEditorMeta() {
  state.query = editor.value;
  const lineCount = Math.max(1, editor.value.split("\n").length);
  lineNumbers.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  document.querySelector("#char-count").textContent = `${editor.value.length.toLocaleString("id-ID")} characters`;
}

function setResultMode(mode) {
  resultsEmpty.hidden = mode !== "empty";
  resultsLoading.hidden = mode !== "loading";
  resultsError.hidden = mode !== "error";
  resultsTable.hidden = mode !== "table";
}

function setToast(message) {
  toast.textContent = message;
  window.clearTimeout(setToast.timeout);
  setToast.timeout = window.setTimeout(() => { toast.textContent = ""; }, 2600);
}

function escapeSqlIdentifier(value) {
  return String(value ?? "").replace(/`/g, "``");
}

function buildTableDataQuery(namespace, tableName) {
  return `SELECT * FROM \`s3tables\`.\`${escapeSqlIdentifier(namespace)}\`.\`${escapeSqlIdentifier(tableName)}\` LIMIT 1000;`;
}

function closeRowDetail(restoreFocus = true) {
  rowDetail.hidden = true;
  rowDetailTable.replaceChildren();
  document.body.classList.remove("row-detail-open");
  if (restoreFocus && rowDetailTrigger?.isConnected) rowDetailTrigger.focus();
  rowDetailTrigger = null;
}

function openRowDetail(row, columns, trigger) {
  rowDetailTable.replaceChildren();
  const table = document.createElement("table");
  table.className = "row-detail-table";
  const tbody = document.createElement("tbody");
  columns.forEach((column) => {
    const tableRow = document.createElement("tr");
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = column;
    const cell = document.createElement("td");
    const value = row[column];
    const isNull = value === null || value === undefined;
    cell.textContent = isNull ? "NULL" : String(value);
    if (isNull) cell.className = "row-detail-null";
    cell.title = cell.textContent;
    tableRow.append(heading, cell);
    tbody.append(tableRow);
  });
  table.append(tbody);
  rowDetailTable.append(table);
  rowDetailTrigger = trigger;
  rowDetail.hidden = false;
  document.body.classList.add("row-detail-open");
  closeRowDetailButton.focus();
}

function renderResults(result) {
  document.querySelector("#row-count").textContent = `${result.rowCount.toLocaleString("id-ID")} rows${result.truncated ? " · capped" : ""}`;
  document.querySelector("#duration").textContent = `${result.durationMs} ms`;

  resultsTable.replaceChildren();
  if (!result.columns.length) {
    const note = document.createElement("div");
    note.className = "table-note";
    note.textContent = "Query selesai tanpa result set.";
    resultsTable.append(note);
    setResultMode("table");
    return;
  }

  const table = document.createElement("table");
  table.className = "results-table";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  result.columns.forEach((column) => {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = column;
    headerRow.append(header);
  });
  thead.append(headerRow);
  const tbody = document.createElement("tbody");
  const tableNameColumn = result.columns.find((column) => column.toLowerCase() === "tablename");
  const namespaceColumn = result.columns.find((column) => column.toLowerCase() === "namespace");
  const rows = tableNameColumn
    ? [...result.rows].sort((left, right) => String(left[tableNameColumn] ?? "").localeCompare(String(right[tableNameColumn] ?? ""), "en", { sensitivity: "base" }))
    : result.rows;
  rows.forEach((row) => {
    const tableRow = document.createElement("tr");
    if (!tableNameColumn) {
      tableRow.tabIndex = 0;
      tableRow.setAttribute("aria-label", "Open row detail");
      const showRowDetail = () => openRowDetail(row, result.columns, tableRow);
      tableRow.addEventListener("click", showRowDetail);
      tableRow.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        showRowDetail();
      });
    }
    result.columns.forEach((column) => {
      const cell = document.createElement("td");
      const value = row[column] ?? "";
      cell.title = value;
      if (tableNameColumn && namespaceColumn && column === tableNameColumn && value) {
        const tableLink = document.createElement("button");
        tableLink.type = "button";
        tableLink.className = "table-link";
        tableLink.textContent = value;
        tableLink.title = `Load data from ${row[namespaceColumn]}.${value}`;
        tableLink.addEventListener("click", () => {
          editor.value = buildTableDataQuery(row[namespaceColumn], value);
          updateEditorMeta();
          runQuery();
        });
        cell.append(tableLink);
      } else {
        cell.textContent = value;
      }
      tableRow.append(cell);
    });
    tbody.append(tableRow);
  });
  table.append(thead, tbody);
  resultsTable.append(table);
  if (result.truncated) {
    const note = document.createElement("div");
    note.className = "table-note";
    note.textContent = "Showing the first 1,000 rows to keep the workbench responsive.";
    resultsTable.append(note);
  }
  setResultMode("table");
}

function renderHistory() {
  const list = document.querySelector("#history-list");
  document.querySelector("#history-count").textContent = state.history.length;
  list.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Your recent runs will appear here.";
    list.append(empty);
    return;
  }
  state.history.slice(0, MAX_HISTORY_ITEMS).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    const title = document.createElement("strong");
    title.textContent = item.sql.split("\n")[0].slice(0, 34);
    const time = document.createElement("small");
    time.textContent = `${item.rows} rows · ${formatHistoryTime(item.ranAt)}`;
    button.append(title, time);
    button.addEventListener("click", () => {
      editor.value = item.sql;
      updateEditorMeta();
      editor.focus();
      setToast("Query loaded from history");
    });
    list.append(button);
  });
}

function createS3TablesIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3.5 6.5h5l1.4 1.7h6.6v6.3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V6.5Z");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", "M3.5 8.2h13");
  svg.append(path, line);
  return svg;
}

function renderS3TablesState(message, isError = false) {
  s3tablesList.replaceChildren();
  const stateMessage = document.createElement("p");
  stateMessage.className = `s3tables-state${isError ? " is-error" : ""}`;
  stateMessage.textContent = message;
  s3tablesList.append(stateMessage);
  if (isError) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "s3tables-retry";
    retry.textContent = "Try again";
    retry.addEventListener("click", loadS3Tables);
    s3tablesList.append(retry);
  }
}

function renderS3Tables(namespaces) {
  s3tablesList.replaceChildren();
  if (!namespaces.length) {
    renderS3TablesState("No s3tables namespaces found.");
    return;
  }
  namespaces.forEach((namespace) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "s3tables-item";
    item.title = `Prepare a table query for ${namespace}`;
    const icon = document.createElement("span");
    icon.className = "s3tables-icon";
    icon.append(createS3TablesIcon());
    const label = document.createElement("span");
    label.textContent = namespace;
    item.append(icon, label);
    item.addEventListener("click", () => {
      const escapedNamespace = namespace.replace(/`/g, "``");
      editor.value = `SHOW TABLES IN \`s3tables\`.\`${escapedNamespace}\`;`;
      updateEditorMeta();
      editor.focus();
      setToast(`Query prepared for ${namespace}`);
    });
    s3tablesList.append(item);
  });
}

async function loadS3Tables() {
  refreshS3TablesButton.disabled = true;
  renderS3TablesState("Loading s3tables…");
  try {
    const response = await fetch("/api/databases");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "s3tables tidak dapat dimuat.");
    renderS3Tables(Array.isArray(payload.databases) ? payload.databases : []);
  } catch {
    renderS3TablesState("Unable to load s3tables.", true);
  } finally {
    refreshS3TablesButton.disabled = false;
  }
}

function formatQuery() {
  const formatted = editor.value
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ",\n  ")
    .replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|HAVING)\s+/gi, "\n$1 ")
    .trim();
  editor.value = formatted;
  updateEditorMeta();
  setToast("Query formatted");
}

async function runQuery() {
  if (state.running || !state.configured) {
    if (!state.configured) showSetupGate();
    return;
  }
  closeRowDetail(false);
  state.running = true;
  runButton.disabled = true;
  runButton.querySelector("span:nth-child(2)").textContent = "Running…";
  setResultMode("loading");
  document.querySelector("#row-count").textContent = "— rows";
  document.querySelector("#duration").textContent = "—";

  try {
    const response = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql: editor.value }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Query gagal dijalankan.");
    renderResults(payload);
    state.history.unshift({ sql: editor.value, rows: payload.rowCount, ranAt: Date.now() });
    state.history = state.history.slice(0, MAX_HISTORY_ITEMS);
    saveHistory(state.history);
    renderHistory();
    setToast("Query completed");
  } catch (error) {
    document.querySelector("#error-message").textContent = error.message;
    setResultMode("error");
  } finally {
    state.running = false;
    runButton.disabled = false;
    runButton.querySelector("span:nth-child(2)").textContent = "Run query";
  }
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    state.configured = Boolean(health.configured);
    const badge = document.querySelector("#health-badge");
    badge.textContent = health.configured ? "ready" : "needs setup";
    badge.className = `health-badge ${health.configured ? "" : "is-error"}`;
    document.querySelector("#connection-detail").textContent = health.configured ? "Read-only session · credentials ready" : "Enter credentials to connect";
    if (health.target) document.querySelector("#connection-host").textContent = health.target.replace(/^jdbc:hive2:\/\//, "").split(";")[0];
    if (health.configured) hideSetupGate();
    else showSetupGate();
    return state.configured;
  } catch {
    state.configured = false;
    document.querySelector("#health-badge").textContent = "offline";
    document.querySelector("#health-badge").className = "health-badge is-error";
    document.querySelector("#connection-detail").textContent = "Workbench API is not reachable";
    showSetupGate("Workbench API is not reachable. Start the server, then try again.");
    return false;
  }
}

function showSetupGate(message = "") {
  setupGate.hidden = false;
  appShell.inert = true;
  appShell.setAttribute("aria-hidden", "true");
  setupError.textContent = message;
  setupError.hidden = !message;
  if (document.activeElement === document.body) setupUsername.focus();
}

function hideSetupGate() {
  setupGate.hidden = true;
  appShell.inert = false;
  appShell.removeAttribute("aria-hidden");
  setupError.hidden = true;
}

async function submitSetup(event) {
  event.preventDefault();
  setupError.hidden = true;
  setupSubmit.disabled = true;
  setupSubmit.querySelector("span:first-child").textContent = "Connecting…";
  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jdbcUrl: setupJdbcUrl.value,
        username: setupUsername.value,
        password: setupPassword.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Connection setup failed.");
    setupPassword.value = "";
    await checkHealth();
    if (state.configured) {
      await loadS3Tables();
      editor.focus();
      setToast("Connection ready");
    }
  } catch (error) {
    showSetupGate(error.message);
  } finally {
    setupSubmit.disabled = false;
    setupSubmit.querySelector("span:first-child").textContent = "Connect to Spark";
  }
}

editor.addEventListener("input", updateEditorMeta);
editor.addEventListener("scroll", () => { lineNumbers.scrollTop = editor.scrollTop; });
runButton.addEventListener("click", runQuery);
document.querySelector("#format-query").addEventListener("click", formatQuery);
document.querySelector("#copy-query").addEventListener("click", async () => {
  await navigator.clipboard.writeText(editor.value);
  setToast("Query copied");
});
document.querySelector("#new-query").addEventListener("click", () => {
  closeRowDetail(false);
  editor.value = "";
  updateEditorMeta();
  setResultMode("empty");
  editor.focus();
});
refreshS3TablesButton.addEventListener("click", loadS3Tables);
setupForm.addEventListener("submit", submitSetup);
closeRowDetailButton.addEventListener("click", () => closeRowDetail());
rowDetail.addEventListener("click", (event) => {
  if (event.target === rowDetail) closeRowDetail();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !rowDetail.hidden) closeRowDetail();
});
editor.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runQuery();
  }
});
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach((item) => item.classList.remove("is-active"));
    button.classList.add("is-active");
    if (button.dataset.view === "history") document.querySelector("#history-list").scrollIntoView({ behavior: "smooth", block: "nearest" });
    else editor.focus();
  });
});

async function initialize() {
  updateEditorMeta();
  renderHistory();
  if (await checkHealth()) await loadS3Tables();
}

initialize();

