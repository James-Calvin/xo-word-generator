(function bootstrapSettingsPage(globalScope) {
  "use strict";

  const sharedApi = globalScope.LOVE_LANGUAGE_SHARED || {};
  const sharedUtils = sharedApi.utils || {};
  const rulesApi = globalScope.LOVE_LANGUAGE_RULES || {};

  const trimOrEmpty =
    typeof sharedUtils.trimOrEmpty === "function"
      ? sharedUtils.trimOrEmpty
      : (value) => (typeof value === "string" ? value.trim() : "");
  const escapeHtml =
    typeof sharedUtils.escapeXml === "function"
      ? sharedUtils.escapeXml
      : (text) =>
          String(text)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&apos;");
  const createRowId =
    typeof sharedUtils.createRowId === "function"
      ? sharedUtils.createRowId
      : () => `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const TRANSITION_SCOPES = Array.isArray(rulesApi.TRANSITION_SCOPES)
    ? rulesApi.TRANSITION_SCOPES
    : ["word", "syllable", "boundary"];
  const SYLLABLE_PATTERN_KEYS = Array.isArray(rulesApi.SYLLABLE_PATTERN_KEYS)
    ? rulesApi.SYLLABLE_PATTERN_KEYS
    : ["single", "initial", "medial", "final"];
  const loadDraftRuleConfig =
    typeof rulesApi.loadDraftRuleConfig === "function" ? rulesApi.loadDraftRuleConfig : () => null;
  const loadActiveRuleConfig =
    typeof rulesApi.loadActiveRuleConfig === "function" ? rulesApi.loadActiveRuleConfig : () => null;
  const createBlankRuleConfig =
    typeof rulesApi.createBlankRuleConfig === "function"
      ? rulesApi.createBlankRuleConfig
      : () => ({
          version: 1,
          vowels: [],
          consonants: [],
          syllablePatterns: { single: [], initial: [], medial: [], final: [] },
          transitionRules: [],
          wordEndBans: [],
          syllableEndBans: []
        });
  const cloneRuleConfig =
    typeof rulesApi.cloneRuleConfig === "function" ? rulesApi.cloneRuleConfig : (config) => config;
  const normalizeRuleConfig =
    typeof rulesApi.normalizeRuleConfig === "function"
      ? rulesApi.normalizeRuleConfig
      : (config) => config;
  const validateRuleConfig =
    typeof rulesApi.validateRuleConfig === "function"
      ? rulesApi.validateRuleConfig
      : () => ({ isValid: true, errors: [], config: null });
  const applyDraftRuleConfig =
    typeof rulesApi.applyDraftRuleConfig === "function"
      ? rulesApi.applyDraftRuleConfig
      : (config) => ({
          draft: config,
          active: config,
          validation: { isValid: true, errors: [], config },
          applied: true
        });
  const restoreDefaultRuleConfig =
    typeof rulesApi.restoreDefaultRuleConfig === "function"
      ? rulesApi.restoreDefaultRuleConfig
      : () => createBlankRuleConfig();

  const storageKeys =
    rulesApi.storageKeys && typeof rulesApi.storageKeys === "object" ? rulesApi.storageKeys : {};
  const draftStorageKey = typeof storageKeys.draft === "string" ? storageKeys.draft : "";
  const activeStorageKey = typeof storageKeys.active === "string" ? storageKeys.active : "";

  const ROW_KINDS = {
    INVENTORY: "inventory",
    PATTERN: "pattern",
    TRANSITION: "transition",
    BAN: "ban"
  };
  const PATTERN_SECTION_KEY = "syllablePatterns";
  const SECTION_DEFINITIONS = [
    { sectionKey: "vowels", kind: ROW_KINDS.INVENTORY },
    { sectionKey: "consonants", kind: ROW_KINDS.INVENTORY },
    { sectionKey: "transitionRules", kind: ROW_KINDS.TRANSITION },
    { sectionKey: "syllableEndBans", kind: ROW_KINDS.BAN },
    { sectionKey: "wordEndBans", kind: ROW_KINDS.BAN }
  ];

  const app = document.querySelector(".app-settings");
  const importRulesBtn = document.getElementById("importRulesBtn");
  const exportRulesBtn = document.getElementById("exportRulesBtn");
  const blankSlateBtn = document.getElementById("blankSlateBtn");
  const restoreDefaultsBtn = document.getElementById("restoreDefaultsBtn");
  const importRulesInput = document.getElementById("importRulesInput");
  const applyStatus = document.getElementById("settingsApplyStatus");
  const importStatus = document.getElementById("settingsImportStatus");
  const errorList = document.getElementById("settingsErrorList");
  const vowelsList = document.getElementById("vowelsList");
  const consonantsList = document.getElementById("consonantsList");
  const syllablePatternsGrid = document.getElementById("syllablePatternsGrid");
  const transitionRulesList = document.getElementById("transitionRulesList");
  const syllableEndBansList = document.getElementById("syllableEndBansList");
  const wordEndBansList = document.getElementById("wordEndBansList");
  const knownRuleSymbols = document.getElementById("knownRuleSymbols");

  let draftConfig = cloneRuleConfig(loadDraftRuleConfig());
  let activeConfig = cloneRuleConfig(loadActiveRuleConfig());
  let draftValidation = validateRuleConfig(draftConfig);
  let importFeedbackMessage = "";
  let importFeedbackIsError = false;
  let pendingDeleteKey = "";
  let pendingFocusRowId = "";
  let pendingFocusFieldName = "";
  let uiState = createUiStateFromDraftConfig();

  function capitalizeLabel(value) {
    const normalizedValue = trimOrEmpty(value);
    return normalizedValue ? normalizedValue.charAt(0).toUpperCase() + normalizedValue.slice(1) : "";
  }

  function hasVisibleText(value) {
    return trimOrEmpty(value).length > 0;
  }

  function getPatternLabel(key) {
    switch (key) {
      case "single":
        return "Single-syllable";
      case "initial":
        return "Initial";
      case "medial":
        return "Medial";
      case "final":
        return "Final";
      default:
        return capitalizeLabel(key);
    }
  }

  function getEmptyMessage(sectionKey) {
    switch (sectionKey) {
      case "vowels":
        return "No vowels yet.";
      case "consonants":
        return "No consonants yet.";
      case "transitionRules":
        return "No transition rules yet.";
      case "syllableEndBans":
        return "No syllable-end bans yet.";
      case "wordEndBans":
        return "No word-end bans yet.";
      default:
        return "No rules yet.";
    }
  }

  function getDisplayValue(value) {
    const normalizedValue = trimOrEmpty(value);
    return normalizedValue || "(empty)";
  }

  function getPatternEmptyMessage(patternKey) {
    return `No ${getPatternLabel(patternKey).toLowerCase()} patterns yet.`;
  }

  function getRowLabel(row) {
    if (!row) {
      return "row";
    }

    if (row.kind === ROW_KINDS.INVENTORY) {
      return row.sectionKey === "vowels" ? "vowel" : "consonant";
    }

    if (row.kind === ROW_KINDS.PATTERN) {
      return `${getPatternLabel(row.patternKey).toLowerCase()} pattern`;
    }

    if (row.kind === ROW_KINDS.TRANSITION) {
      return "transition rule";
    }

    return row.sectionKey === "syllableEndBans" ? "syllable-end ban" : "word-end ban";
  }

  function getDeleteButtonText(isPendingDelete) {
    return isPendingDelete ? "Confirm delete" : "Delete row";
  }

  function buildDeleteKey(rowId) {
    return trimOrEmpty(rowId);
  }

  function clearPendingDeleteState() {
    if (!pendingDeleteKey) {
      return;
    }

    pendingDeleteKey = "";
    syncPendingDeleteButtons();
  }

  function createEmptyUiState() {
    return {
      vowels: [],
      consonants: [],
      transitionRules: [],
      syllableEndBans: [],
      wordEndBans: [],
      syllablePatterns: { single: [], initial: [], medial: [], final: [] }
    };
  }

  function createBlankDraftValue(kind) {
    if (kind === ROW_KINDS.INVENTORY) {
      return { symbol: "", ipa: "" };
    }

    if (kind === ROW_KINDS.TRANSITION) {
      return { scope: TRANSITION_SCOPES[0] || "word", triggerSymbol: "", blockedNextSymbols: "" };
    }

    if (kind === ROW_KINDS.BAN) {
      return { symbol: "" };
    }

    return "";
  }

  function createDraftValueFromPersisted(kind, persistedValue) {
    if (kind === ROW_KINDS.INVENTORY) {
      return {
        symbol: persistedValue && typeof persistedValue === "object" ? persistedValue.symbol || "" : "",
        ipa: persistedValue && typeof persistedValue === "object" ? persistedValue.ipa || "" : ""
      };
    }

    if (kind === ROW_KINDS.PATTERN) {
      return typeof persistedValue === "string" ? persistedValue : "";
    }

    if (kind === ROW_KINDS.TRANSITION) {
      return {
        scope:
          persistedValue && TRANSITION_SCOPES.includes(persistedValue.scope)
            ? persistedValue.scope
            : TRANSITION_SCOPES[0] || "word",
        triggerSymbol:
          persistedValue && typeof persistedValue === "object" ? persistedValue.triggerSymbol || "" : "",
        blockedNextSymbols:
          persistedValue &&
          typeof persistedValue === "object" &&
          Array.isArray(persistedValue.blockedNextSymbols)
            ? persistedValue.blockedNextSymbols.join(", ")
            : ""
      };
    }

    return { symbol: typeof persistedValue === "string" ? persistedValue : "" };
  }

  function createSavedRow(kind, { sectionKey = "", patternKey = "", sourceIndex }) {
    return { rowId: createRowId(), kind, sectionKey, patternKey, sourceIndex, isNew: false, isEditing: false, draftValue: null };
  }

  function createNewRow(kind, { sectionKey = "", patternKey = "" }) {
    return {
      rowId: createRowId(),
      kind,
      sectionKey,
      patternKey,
      sourceIndex: -1,
      isNew: true,
      isEditing: true,
      draftValue: createBlankDraftValue(kind)
    };
  }

  function getPersistedList(sectionKey, patternKey = "") {
    if (sectionKey === PATTERN_SECTION_KEY) {
      draftConfig.syllablePatterns = draftConfig.syllablePatterns || {};
      if (!Array.isArray(draftConfig.syllablePatterns[patternKey])) {
        draftConfig.syllablePatterns[patternKey] = [];
      }
      return draftConfig.syllablePatterns[patternKey];
    }

    if (!Array.isArray(draftConfig[sectionKey])) {
      draftConfig[sectionKey] = [];
    }

    return draftConfig[sectionKey];
  }

  function getUiRows(sectionKey, patternKey = "") {
    return sectionKey === PATTERN_SECTION_KEY ? uiState.syllablePatterns[patternKey] : uiState[sectionKey];
  }

  function getPersistedValueForRow(row) {
    if (!row || row.isNew || row.sourceIndex < 0) {
      return null;
    }

    const list = getPersistedList(row.sectionKey, row.patternKey);
    return list[row.sourceIndex] ?? null;
  }

  function createUiStateFromDraftConfig() {
    const nextState = createEmptyUiState();

    for (const definition of SECTION_DEFINITIONS) {
      nextState[definition.sectionKey] = getPersistedList(definition.sectionKey).map((entry, index) =>
        createSavedRow(definition.kind, { sectionKey: definition.sectionKey, sourceIndex: index })
      );
    }

    for (const patternKey of SYLLABLE_PATTERN_KEYS) {
      nextState.syllablePatterns[patternKey] = getPersistedList(PATTERN_SECTION_KEY, patternKey).map(
        (pattern, index) =>
          createSavedRow(ROW_KINDS.PATTERN, {
            sectionKey: PATTERN_SECTION_KEY,
            patternKey,
            sourceIndex: index
          })
      );
    }

    return nextState;
  }

  function reconcileUiRows(previousRows, definition) {
    const persistedLength = getPersistedList(definition.sectionKey, definition.patternKey).length;
    const savedRows = previousRows.filter((row) => !row.isNew);
    const unsavedRows = previousRows.filter((row) => row.isNew);
    const nextRows = [];

    for (let index = 0; index < persistedLength; index += 1) {
      const existingRow = savedRows[index];
      nextRows.push(
        existingRow
          ? { ...existingRow, sectionKey: definition.sectionKey, patternKey: definition.patternKey || "", sourceIndex: index, isNew: false }
          : createSavedRow(definition.kind, {
              sectionKey: definition.sectionKey,
              patternKey: definition.patternKey,
              sourceIndex: index
            })
      );
    }

    nextRows.push(...unsavedRows);
    return nextRows;
  }

  function reconcileUiStateWithDraftConfig() {
    const nextState = createEmptyUiState();

    for (const definition of SECTION_DEFINITIONS) {
      nextState[definition.sectionKey] = reconcileUiRows(uiState[definition.sectionKey], definition);
    }

    for (const patternKey of SYLLABLE_PATTERN_KEYS) {
      nextState.syllablePatterns[patternKey] = reconcileUiRows(uiState.syllablePatterns[patternKey], {
        kind: ROW_KINDS.PATTERN,
        sectionKey: PATTERN_SECTION_KEY,
        patternKey
      });
    }

    uiState = nextState;
  }

  function resetUiStateFromDraftConfig() {
    uiState = createUiStateFromDraftConfig();
    pendingFocusRowId = "";
    pendingFocusFieldName = "";
  }

  function findUiRow(rowId) {
    const normalizedRowId = trimOrEmpty(rowId);
    if (!normalizedRowId) {
      return null;
    }

    for (const definition of SECTION_DEFINITIONS) {
      const rows = uiState[definition.sectionKey];
      const rowIndex = rows.findIndex((row) => row.rowId === normalizedRowId);
      if (rowIndex >= 0) {
        return { row: rows[rowIndex], rows, rowIndex };
      }
    }

    for (const patternKey of SYLLABLE_PATTERN_KEYS) {
      const rows = uiState.syllablePatterns[patternKey];
      const rowIndex = rows.findIndex((row) => row.rowId === normalizedRowId);
      if (rowIndex >= 0) {
        return { row: rows[rowIndex], rows, rowIndex };
      }
    }

    return null;
  }

  function getEditingRowIds() {
    const rowIds = [];

    for (const definition of SECTION_DEFINITIONS) {
      rowIds.push(...uiState[definition.sectionKey].filter((row) => row.isEditing).map((row) => row.rowId));
    }

    for (const patternKey of SYLLABLE_PATTERN_KEYS) {
      rowIds.push(...uiState.syllablePatterns[patternKey].filter((row) => row.isEditing).map((row) => row.rowId));
    }

    return rowIds;
  }

  function setPendingFocusRow(rowId, fieldName = "") {
    pendingFocusRowId = trimOrEmpty(rowId);
    pendingFocusFieldName = trimOrEmpty(fieldName);
  }

  function syncPendingDeleteButtons() {
    if (!app) {
      return;
    }

    const buttons = app.querySelectorAll(".settings-delete-btn[data-delete-key]");
    for (const button of buttons) {
      const isPendingDelete = trimOrEmpty(button.dataset.deleteKey) === pendingDeleteKey;
      const label = getDeleteButtonText(isPendingDelete);
      button.classList.toggle("is-pending-delete", isPendingDelete);
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
  }

  function applyPendingFocus() {
    const rowId = trimOrEmpty(pendingFocusRowId);
    if (!rowId || !app) {
      return;
    }

    const fieldName = trimOrEmpty(pendingFocusFieldName);
    pendingFocusRowId = "";
    pendingFocusFieldName = "";
    globalScope.requestAnimationFrame(() => {
      const row = app.querySelector(`[data-row-id="${rowId}"]`);
      const focusTarget =
        row && fieldName
          ? row.querySelector(`[data-field="${fieldName}"]`)
          : row
            ? row.querySelector("input, select, textarea")
            : null;
      if (!(focusTarget instanceof HTMLElement)) {
        return;
      }

      focusTarget.focus();
      if (focusTarget instanceof HTMLInputElement || focusTarget instanceof HTMLTextAreaElement) {
        focusTarget.setSelectionRange(focusTarget.value.length, focusTarget.value.length);
      }
    });
  }

  function persistDraftState() {
    const result = applyDraftRuleConfig(draftConfig);
    draftConfig = cloneRuleConfig(result.draft);
    activeConfig = cloneRuleConfig(result.active);
    draftValidation = result.validation;
  }

  function parseBlockedSymbolInput(value) {
    const parts = String(value)
      .split(",")
      .map((part) => trimOrEmpty(part));
    return parts.length === 0 ? [""] : parts;
  }

  function createPersistedValueFromDraft(row) {
    if (row.kind === ROW_KINDS.INVENTORY) {
      return { symbol: row.draftValue.symbol || "", ipa: row.draftValue.ipa || "" };
    }

    if (row.kind === ROW_KINDS.PATTERN) {
      return typeof row.draftValue === "string" ? row.draftValue : "";
    }

    if (row.kind === ROW_KINDS.TRANSITION) {
      return {
        scope: row.draftValue.scope,
        triggerSymbol: row.draftValue.triggerSymbol,
        blockedNextSymbols: parseBlockedSymbolInput(row.draftValue.blockedNextSymbols)
      };
    }

    return row.draftValue.symbol || "";
  }

  function updateRowDraftFromField(row, fieldName, value) {
    if (!row || !row.isEditing) {
      return;
    }

    if (row.kind === ROW_KINDS.PATTERN) {
      if (fieldName === "pattern") {
        row.draftValue = value;
      }
      return;
    }

    if (!row.draftValue || typeof row.draftValue !== "object") {
      row.draftValue = createBlankDraftValue(row.kind);
    }

    row.draftValue[fieldName] = value;
  }

  function getKnownSymbols() {
    const normalizedDraft = normalizeRuleConfig(draftConfig);
    const symbols = [];
    const seen = new Set();

    for (const entry of [...normalizedDraft.vowels, ...normalizedDraft.consonants]) {
      if (!entry.symbol || seen.has(entry.symbol)) {
        continue;
      }

      seen.add(entry.symbol);
      symbols.push(entry.symbol);
    }

    return symbols.sort((a, b) => a.localeCompare(b));
  }

  function renderKnownSymbolOptions() {
    if (!knownRuleSymbols) {
      return;
    }

    knownRuleSymbols.innerHTML = getKnownSymbols()
      .map((symbol) => `<option value="${escapeHtml(symbol)}"></option>`)
      .join("");
  }

  function renderIconButton({ action, rowId, className, label }) {
    return `
      <button
        class="settings-icon-btn ${escapeHtml(className)}"
        type="button"
        data-action="${escapeHtml(action)}"
        data-row-id="${escapeHtml(rowId)}"
        aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}"
      ></button>
    `;
  }

  function renderDeleteButton(rowId) {
    const deleteKey = buildDeleteKey(rowId);
    const isPendingDelete = pendingDeleteKey === deleteKey;

    return `
      <button
        class="settings-delete-btn${isPendingDelete ? " is-pending-delete" : ""}"
        type="button"
        data-action="delete-row"
        data-row-id="${escapeHtml(rowId)}"
        data-delete-key="${escapeHtml(deleteKey)}"
        aria-label="${getDeleteButtonText(isPendingDelete)}"
        title="${getDeleteButtonText(isPendingDelete)}"
      ></button>
    `;
  }

  function renderSummarySegment(label, value, extraClassName = "") {
    return `
      <span class="settings-summary-segment">
        ${label ? `<span class="settings-summary-label">${escapeHtml(label)}</span>` : ""}
        <span class="settings-summary-value${extraClassName ? ` ${escapeHtml(extraClassName)}` : ""}">${escapeHtml(
          value
        )}</span>
      </span>
    `;
  }

  function renderDisplayRow(row, summaryHtml) {
    return `
      <div class="rule-row settings-display-row result-row" data-row-id="${escapeHtml(row.rowId)}">
        <div class="row-actions settings-display-actions">
          ${renderIconButton({
            action: "edit-row",
            rowId: row.rowId,
            className: "is-edit",
            label: `Edit ${getRowLabel(row)}`
          })}
        </div>
        <div class="row-content settings-display-content">${summaryHtml}</div>
        <div class="row-copy settings-display-delete">${renderDeleteButton(row.rowId)}</div>
      </div>
    `;
  }

  function renderEditActions(row) {
    return `
      <div class="settings-edit-actions">
        ${renderIconButton({
          action: "save-row",
          rowId: row.rowId,
          className: "is-save",
          label: `Save ${getRowLabel(row)}`
        })}
        ${renderIconButton({
          action: "cancel-row",
          rowId: row.rowId,
          className: "is-cancel",
          label: `Cancel ${getRowLabel(row)} edit`
        })}
      </div>
    `;
  }

  function renderInventoryRow(row) {
    if (row.isEditing) {
      const draftValue =
        row.draftValue && typeof row.draftValue === "object"
          ? row.draftValue
          : createBlankDraftValue(ROW_KINDS.INVENTORY);

      return `
        <div class="rule-row rule-row-symbol settings-edit-row" data-row-id="${escapeHtml(row.rowId)}">
          <label class="settings-field-group">
            <span class="settings-field-label">Symbol</span>
            <input
              class="settings-field"
              type="text"
              value="${escapeHtml(draftValue.symbol || "")}"
              data-field="symbol"
              autocomplete="off"
            >
          </label>
          <label class="settings-field-group">
            <span class="settings-field-label">IPA</span>
            <input
              class="settings-field"
              type="text"
              value="${escapeHtml(draftValue.ipa || "")}"
              data-field="ipa"
              autocomplete="off"
            >
          </label>
          ${renderEditActions(row)}
        </div>
      `;
    }

    const entry = getPersistedValueForRow(row) || {};
    return renderDisplayRow(
      row,
      `
        ${renderSummarySegment("", getDisplayValue(entry.symbol))}
        ${renderSummarySegment("", `/${getDisplayValue(entry.ipa)}/`, "ipa")}
      `
    );
  }

  function renderPatternRow(row) {
    if (row.isEditing) {
      const draftValue = typeof row.draftValue === "string" ? row.draftValue : "";

      return `
        <div class="rule-row settings-edit-row" data-row-id="${escapeHtml(row.rowId)}">
          <label class="settings-field-group">
            <span class="settings-field-label">Pattern</span>
            <input
              class="settings-field"
              type="text"
              value="${escapeHtml(draftValue)}"
              data-field="pattern"
              autocomplete="off"
              spellcheck="false"
            >
          </label>
          ${renderEditActions(row)}
        </div>
      `;
    }

    return renderDisplayRow(
      row,
      renderSummarySegment("", getDisplayValue(getPersistedValueForRow(row)))
    );
  }

  function renderTransitionRow(row) {
    if (row.isEditing) {
      const draftValue =
        row.draftValue && typeof row.draftValue === "object"
          ? row.draftValue
          : createBlankDraftValue(ROW_KINDS.TRANSITION);

      return `
        <div class="rule-row rule-row-transition settings-edit-row" data-row-id="${escapeHtml(row.rowId)}">
          <label class="settings-field-group">
            <span class="settings-field-label">Scope</span>
            <select class="settings-field" data-field="scope">
              ${TRANSITION_SCOPES.map(
                (scope) => `
                  <option value="${scope}"${draftValue.scope === scope ? " selected" : ""}>${escapeHtml(
                    capitalizeLabel(scope)
                  )}</option>
                `
              ).join("")}
            </select>
          </label>
          <label class="settings-field-group">
            <span class="settings-field-label">Trigger</span>
            <input
              class="settings-field"
              type="text"
              value="${escapeHtml(draftValue.triggerSymbol || "")}"
              data-field="triggerSymbol"
              list="knownRuleSymbols"
              autocomplete="off"
            >
          </label>
          <label class="settings-field-group settings-field-group-wide">
            <span class="settings-field-label">Blocked next symbols</span>
            <input
              class="settings-field"
              type="text"
              value="${escapeHtml(draftValue.blockedNextSymbols || "")}"
              data-field="blockedNextSymbols"
              list="knownRuleSymbols"
              autocomplete="off"
            >
          </label>
          ${renderEditActions(row)}
        </div>
      `;
    }

    const persistedRule = getPersistedValueForRow(row) || {};
    const blockedValue = Array.isArray(persistedRule.blockedNextSymbols)
      ? persistedRule.blockedNextSymbols.filter(Boolean).join(", ")
      : "";

    return renderDisplayRow(
      row,
      `
        ${renderSummarySegment("", getDisplayValue(capitalizeLabel(persistedRule.scope || "")))}
        <span class="settings-summary-separator">|</span>
        ${renderSummarySegment("Trigger:", getDisplayValue(persistedRule.triggerSymbol))}
        <span class="settings-summary-separator">|</span>
        ${renderSummarySegment("Blocked:", getDisplayValue(blockedValue))}
      `
    );
  }

  function renderBanRow(row) {
    if (row.isEditing) {
      const draftValue =
        row.draftValue && typeof row.draftValue === "object"
          ? row.draftValue
          : createBlankDraftValue(ROW_KINDS.BAN);

      return `
        <div class="rule-row rule-row-ban settings-edit-row" data-row-id="${escapeHtml(row.rowId)}">
          <label class="settings-field-group settings-field-group-wide">
            <span class="settings-field-label">Symbol</span>
            <input
              class="settings-field"
              type="text"
              value="${escapeHtml(draftValue.symbol || "")}"
              data-field="symbol"
              list="knownRuleSymbols"
              autocomplete="off"
            >
          </label>
          ${renderEditActions(row)}
        </div>
      `;
    }

    return renderDisplayRow(
      row,
      renderSummarySegment("", getDisplayValue(getPersistedValueForRow(row)))
    );
  }

  function renderInventoryList(sectionKey, container) {
    const rows = getUiRows(sectionKey);
    if (!container) {
      return;
    }

    if (rows.length === 0) {
      container.innerHTML = `<p class="settings-empty">${escapeHtml(getEmptyMessage(sectionKey))}</p>`;
      return;
    }

    container.innerHTML = rows.map((row) => renderInventoryRow(row)).join("");
  }

  function renderPatternGrid() {
    if (!syllablePatternsGrid) {
      return;
    }

    syllablePatternsGrid.innerHTML = SYLLABLE_PATTERN_KEYS.map((patternKey) => {
      const rows = getUiRows(PATTERN_SECTION_KEY, patternKey);
      const rowsHtml =
        rows.length === 0
          ? `<p class="settings-empty">${escapeHtml(getPatternEmptyMessage(patternKey))}</p>`
          : rows.map((row) => renderPatternRow(row)).join("");

      return `
        <div class="settings-pattern-card">
          <div class="settings-subsection-header">
            <h3>${escapeHtml(getPatternLabel(patternKey))}</h3>
          </div>
          <p class="settings-pattern-help">Use only C and V tokens.</p>
          <div class="rule-list">${rowsHtml}</div>
          <div class="settings-list-footer">
            <button class="settings-link-btn" type="button" data-action="add-pattern" data-pattern-key="${patternKey}">Add pattern</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderTransitionRules() {
    const rows = getUiRows("transitionRules");
    if (!transitionRulesList) {
      return;
    }

    if (rows.length === 0) {
      transitionRulesList.innerHTML = `<p class="settings-empty">${escapeHtml(getEmptyMessage("transitionRules"))}</p>`;
      return;
    }

    transitionRulesList.innerHTML = rows.map((row) => renderTransitionRow(row)).join("");
  }

  function renderBanList(sectionKey, container) {
    const rows = getUiRows(sectionKey);
    if (!container) {
      return;
    }

    if (rows.length === 0) {
      container.innerHTML = `<p class="settings-empty">${escapeHtml(getEmptyMessage(sectionKey))}</p>`;
      return;
    }

    container.innerHTML = rows.map((row) => renderBanRow(row)).join("");
  }

  function renderStatus() {
    if (applyStatus) {
      applyStatus.textContent = draftValidation.isValid
        ? "Draft applied locally. Future generations will use these rules."
        : "Draft saved locally but not applied. The generator is still using the last valid rules.";
      applyStatus.classList.toggle("is-error", !draftValidation.isValid);
      applyStatus.classList.toggle("is-success", draftValidation.isValid);
    }

    if (errorList) {
      errorList.innerHTML = draftValidation.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("");
      errorList.classList.toggle("is-hidden", draftValidation.errors.length === 0);
    }

    if (importStatus) {
      importStatus.textContent = importFeedbackMessage;
      importStatus.classList.toggle("is-hidden", !hasVisibleText(importFeedbackMessage));
      importStatus.classList.toggle("is-error", importFeedbackIsError);
      importStatus.classList.toggle("is-success", hasVisibleText(importFeedbackMessage) && !importFeedbackIsError);
    }
  }

  function renderAll() {
    renderInventoryList("vowels", vowelsList);
    renderInventoryList("consonants", consonantsList);
    renderPatternGrid();
    renderTransitionRules();
    renderBanList("syllableEndBans", syllableEndBansList);
    renderBanList("wordEndBans", wordEndBansList);
    renderKnownSymbolOptions();
    renderStatus();
    syncPendingDeleteButtons();
    applyPendingFocus();
  }

  function openRowEditor(rowId) {
    const match = findUiRow(rowId);
    if (!match) {
      return;
    }

    const { row } = match;
    if (!row.isEditing) {
      row.isEditing = true;
      row.draftValue = row.isNew
        ? row.draftValue || createBlankDraftValue(row.kind)
        : createDraftValueFromPersisted(row.kind, getPersistedValueForRow(row));
    }

    setPendingFocusRow(row.rowId);
    renderAll();
  }

  function addRowForSection(sectionKey) {
    const definition = SECTION_DEFINITIONS.find((item) => item.sectionKey === sectionKey);
    if (!definition) {
      return;
    }

    clearPendingDeleteState();
    const row = createNewRow(definition.kind, { sectionKey });
    getUiRows(sectionKey).push(row);
    setPendingFocusRow(row.rowId);
    renderAll();
  }

  function addPatternRow(patternKey) {
    clearPendingDeleteState();
    const row = createNewRow(ROW_KINDS.PATTERN, { sectionKey: PATTERN_SECTION_KEY, patternKey });
    getUiRows(PATTERN_SECTION_KEY, patternKey).push(row);
    setPendingFocusRow(row.rowId);
    renderAll();
  }

  function cancelRow(rowId) {
    const match = findUiRow(rowId);
    if (!match || !match.row.isEditing) {
      return;
    }

    clearPendingDeleteState();

    if (match.row.isNew) {
      match.rows.splice(match.rowIndex, 1);
    } else {
      match.row.isEditing = false;
      match.row.draftValue = null;
    }

    renderAll();
  }

  function saveRow(rowId, options = {}) {
    const match = findUiRow(rowId);
    if (!match || !match.row.isEditing) {
      return false;
    }

    const { row } = match;
    const list = getPersistedList(row.sectionKey, row.patternKey);
    const nextValue = createPersistedValueFromDraft(row);

    clearPendingDeleteState();

    if (row.isNew) {
      row.sourceIndex = list.length;
      row.isNew = false;
      list.push(nextValue);
    } else if (row.sourceIndex >= 0 && row.sourceIndex < list.length) {
      list[row.sourceIndex] = nextValue;
    } else {
      return false;
    }

    row.isEditing = false;
    row.draftValue = null;

    persistDraftState();
    reconcileUiStateWithDraftConfig();

    if (options.clearFeedback !== false) {
      importFeedbackMessage = "";
      importFeedbackIsError = false;
    }

    if (options.render !== false) {
      renderAll();
    }

    return true;
  }

  function saveAllEditingRows(options = {}) {
    const rowIds = getEditingRowIds();
    if (rowIds.length === 0) {
      return false;
    }

    for (const rowId of rowIds) {
      saveRow(rowId, { render: false, clearFeedback: false });
    }

    if (options.render !== false) {
      renderAll();
    }

    return true;
  }

  function saveEditingRowsOutsideTarget(target, options = {}) {
    const targetElement = target instanceof Element ? target : null;
    const activeEditRow = targetElement ? targetElement.closest(".settings-edit-row[data-row-id]") : null;
    const activeRowId = activeEditRow ? trimOrEmpty(activeEditRow.dataset.rowId) : "";
    const activeField = targetElement ? targetElement.closest("[data-field]") : null;
    const activeFieldName = activeField ? trimOrEmpty(activeField.dataset.field) : "";
    const rowIdsToSave = getEditingRowIds().filter((rowId) => rowId !== activeRowId);

    if (rowIdsToSave.length === 0) {
      return false;
    }

    for (const rowId of rowIdsToSave) {
      saveRow(rowId, { render: false, clearFeedback: false });
    }

    if (activeRowId && options.preserveActiveFocus !== false) {
      setPendingFocusRow(activeRowId, activeFieldName);
    }

    if (options.render !== false) {
      renderAll();
    }

    return true;
  }

  function deleteRowById(rowId) {
    const match = findUiRow(rowId);
    if (!match || match.row.isNew || match.row.isEditing) {
      return;
    }

    const list = getPersistedList(match.row.sectionKey, match.row.patternKey);
    if (match.row.sourceIndex < 0 || match.row.sourceIndex >= list.length) {
      return;
    }

    list.splice(match.row.sourceIndex, 1);
    match.rows.splice(match.rowIndex, 1);
    pendingDeleteKey = "";
    importFeedbackMessage = "";
    importFeedbackIsError = false;
    persistDraftState();
    reconcileUiStateWithDraftConfig();
    renderAll();
  }

  async function handleImportRules() {
    if (!importRulesInput) {
      return;
    }

    const file = importRulesInput.files && importRulesInput.files[0];
    if (!file) {
      return;
    }

    try {
      const fileText = await file.text();
      const importedConfig = normalizeRuleConfig(JSON.parse(fileText));
      const result = applyDraftRuleConfig(importedConfig);
      draftConfig = cloneRuleConfig(result.draft);
      activeConfig = cloneRuleConfig(result.active);
      draftValidation = result.validation;
      resetUiStateFromDraftConfig();
      clearPendingDeleteState();
      importFeedbackIsError = !result.applied;
      importFeedbackMessage = result.applied
        ? `Imported rules from ${file.name}.`
        : `Imported rules from ${file.name}, but the draft has validation errors and was not applied.`;
      renderAll();
    } catch (error) {
      importFeedbackIsError = true;
      importFeedbackMessage = `Could not import rules from ${file.name}.`;
      renderStatus();
      console.error("Failed to import rule config.", error);
    } finally {
      importRulesInput.value = "";
    }
  }

  function handleExportRules() {
    clearPendingDeleteState();
    saveAllEditingRows({ render: false });

    const configToExport = normalizeRuleConfig(draftConfig);
    const json = JSON.stringify(configToExport, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "xo-generator-rules.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);

    importFeedbackIsError = false;
    importFeedbackMessage = "Exported the current draft rules.";
    renderAll();
  }

  function handleBlankSlate() {
    clearPendingDeleteState();
    draftConfig = createBlankRuleConfig();
    persistDraftState();
    resetUiStateFromDraftConfig();
    importFeedbackIsError = false;
    importFeedbackMessage = "Saved a blank draft. Add valid rules to apply it.";
    renderAll();
  }

  function handleRestoreDefaults() {
    clearPendingDeleteState();
    const restoredConfig = restoreDefaultRuleConfig();
    draftConfig = cloneRuleConfig(restoredConfig);
    activeConfig = cloneRuleConfig(restoredConfig);
    draftValidation = validateRuleConfig(draftConfig);
    resetUiStateFromDraftConfig();
    importFeedbackIsError = false;
    importFeedbackMessage = "Restored the default generator rules.";
    renderAll();
  }

  function handleClick(event) {
    event.__settingsHandledInApp = true;
    const savedAnyRows = saveEditingRowsOutsideTarget(event.target, { render: false });

    const deleteButton = event.target.closest(".settings-delete-btn[data-action='delete-row']");
    if (deleteButton) {
      const deleteKey = buildDeleteKey(deleteButton.dataset.rowId || deleteButton.dataset.deleteKey);
      if (!deleteKey) {
        return;
      }

      if (pendingDeleteKey === deleteKey) {
        deleteRowById(trimOrEmpty(deleteButton.dataset.rowId));
        return;
      }

      pendingDeleteKey = deleteKey;
      syncPendingDeleteButtons();
      return;
    }

    if (pendingDeleteKey) {
      clearPendingDeleteState();
      if (savedAnyRows) {
        renderAll();
      }
      return;
    }

    const actionButton = event.target.closest("[data-action], [data-add-section]");
    if (!actionButton) {
      if (savedAnyRows) {
        renderAll();
      }
      return;
    }

    const action = trimOrEmpty(actionButton.dataset.action);
    const addSection = trimOrEmpty(actionButton.dataset.addSection);
    const rowId = trimOrEmpty(actionButton.dataset.rowId);

    if (addSection) {
      addRowForSection(addSection);
      return;
    }

    if (action === "add-pattern") {
      addPatternRow(trimOrEmpty(actionButton.dataset.patternKey));
      return;
    }

    if (action === "edit-row") {
      openRowEditor(rowId);
      return;
    }

    if (action === "save-row") {
      saveRow(rowId);
      return;
    }

    if (action === "cancel-row") {
      cancelRow(rowId);
      return;
    }

    if (savedAnyRows) {
      renderAll();
    }
  }

  function handleInput(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.matches("button")) {
      return;
    }

    const field = target.closest("[data-field]");
    const rowElement = target.closest("[data-row-id]");
    if (!field || !rowElement) {
      return;
    }

    const match = findUiRow(trimOrEmpty(rowElement.dataset.rowId));
    if (!match || !match.row.isEditing) {
      return;
    }

    clearPendingDeleteState();
    updateRowDraftFromField(match.row, trimOrEmpty(field.dataset.field), target.value);
  }

  function handleFocusIn(event) {
    if (!pendingDeleteKey) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      clearPendingDeleteState();
      return;
    }

    if (!target.closest(".settings-delete-btn[data-action='delete-row']")) {
      clearPendingDeleteState();
    }
  }

  function handleDocumentClick(event) {
    if (event.__settingsHandledInApp) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      if (saveEditingRowsOutsideTarget(null)) {
        return;
      }
      if (!pendingDeleteKey) {
        return;
      }
      clearPendingDeleteState();
      return;
    }

    if (app && app.contains(target)) {
      return;
    }

    const savedAnyRows = saveEditingRowsOutsideTarget(target, { render: false });
    if (savedAnyRows) {
      renderAll();
    }

    if (!pendingDeleteKey) {
      return;
    }

    if (!app || !app.contains(target)) {
      clearPendingDeleteState();
    }
  }

  function handleStorageSync(event) {
    if (!event || (event.key !== draftStorageKey && event.key !== activeStorageKey)) {
      return;
    }

    draftConfig = cloneRuleConfig(loadDraftRuleConfig());
    activeConfig = cloneRuleConfig(loadActiveRuleConfig());
    draftValidation = validateRuleConfig(draftConfig);
    resetUiStateFromDraftConfig();
    clearPendingDeleteState();
    importFeedbackMessage = "Rules updated in another tab.";
    importFeedbackIsError = false;
    renderAll();
  }

  if (app) {
    app.addEventListener("click", handleClick);
    app.addEventListener("input", handleInput);
    app.addEventListener("change", handleInput);
    app.addEventListener("focusin", handleFocusIn);
  }

  if (importRulesBtn && importRulesInput) {
    importRulesBtn.addEventListener("click", () => {
      importRulesInput.click();
    });
    importRulesInput.addEventListener("change", () => {
      void handleImportRules();
    });
  }

  if (exportRulesBtn) {
    exportRulesBtn.addEventListener("click", handleExportRules);
  }

  if (blankSlateBtn) {
    blankSlateBtn.addEventListener("click", handleBlankSlate);
  }

  if (restoreDefaultsBtn) {
    restoreDefaultsBtn.addEventListener("click", handleRestoreDefaults);
  }

  globalScope.addEventListener("storage", handleStorageSync);
  document.addEventListener("click", handleDocumentClick);
  renderAll();
})(window);
