const state = {
  query: "",
  running: false,
  history: [],
};

const editor = document.querySelector("#sql-editor");
const lineNumbers = document.querySelector("#line-numbers");
const runButton = document.querySelector("#run-query");
const resultsEmpty = document.querySelector("#results-empty");
const resultsLoading = document.querySelector("#results-loading");
const resultsError = document.querySelector("#results-error");
const resultsTable = document.querySelector("#results-table-wrap");
const toast = document.querySelector("#toast");
const s3tablesList = document.querySelector("#s3tables-list");
const refreshS3TablesButton = document.querySelector("#refresh-s3tables");

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
  result.rows.forEach((row) => {
    const tableRow = document.createElement("tr");
    result.columns.forEach((column) => {
      const cell = document.createElement("td");
      cell.textContent = row[column] ?? "";
      cell.title = cell.textContent;
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
  state.history.slice(0, 5).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    const title = document.createElement("strong");
    title.textContent = item.sql.split("\n")[0].slice(0, 34);
    const time = document.createElement("small");
    time.textContent = `${item.rows} rows · ${item.time}`;
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
      editor.value = `SHOW TABLES IN \`${escapedNamespace}\`;`;
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
  if (state.running) return;
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
    state.history.unshift({ sql: editor.value, rows: payload.rowCount, time: new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) });
    state.history = state.history.slice(0, 5);
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
    const badge = document.querySelector("#health-badge");
    badge.textContent = health.configured ? "ready" : "needs setup";
    badge.className = `health-badge ${health.configured ? "" : "is-error"}`;
    document.querySelector("#connection-detail").textContent = health.configured ? "Read-only session · credentials ready" : "Set server-side credentials to connect";
    if (health.target) document.querySelector("#connection-host").textContent = health.target.replace(/^jdbc:hive2:\/\//, "").split(";")[0];
  } catch {
    document.querySelector("#health-badge").textContent = "offline";
    document.querySelector("#health-badge").className = "health-badge is-error";
    document.querySelector("#connection-detail").textContent = "Workbench API is not reachable";
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
  editor.value = "";
  updateEditorMeta();
  setResultMode("empty");
  editor.focus();
});
refreshS3TablesButton.addEventListener("click", loadS3Tables);
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

updateEditorMeta();
renderHistory();
checkHealth();
loadS3Tables();

