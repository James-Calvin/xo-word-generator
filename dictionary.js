const COPY_FEEDBACK_MS = 1200;
const DICTIONARY_BATCH_SIZE = 30;

const FILTERS = {
  DEFINED: "defined",
  UNDEFINED: "undefined",
  ALL: "all"
};

const GROUP_CLASSIFICATIONS = {
  DEFINED: "defined",
  UNDEFINED: "undefined"
};

const EMPTY_STATUS_BY_FILTER = {
  [FILTERS.DEFINED]: "No defined words yet.",
  [FILTERS.UNDEFINED]: "No undefined saved words yet.",
  [FILTERS.ALL]: "No saved words yet."
};

const dictionaryFilters = document.getElementById("dictionaryFilters");
const myHeartsToggle = document.getElementById("dictionaryMyHeartsToggle");
const dictionaryList = document.getElementById("dictionaryList");
const dictionaryStatus = document.getElementById("dictionaryStatus");
const dictionarySentinel = document.getElementById("dictionarySentinel");
const filterButtons = dictionaryFilters
  ? Array.from(dictionaryFilters.querySelectorAll(".dictionary-filter-btn[data-filter]"))
  : [];

const recordsById = new Map();
const audioCache = new Map();
const copyFeedbackTimers = new Map();
const sharedAudio = new Audio();

let groups = [];
let visibleGroups = [];
let activeFilter = FILTERS.DEFINED;
let currentUserId = "";
let showOnlyMyHearts = false;
let selectedWord = "";
let playingRecordId = "";
let renderedGroupCount = 0;
let observer = null;

const sharedApi = window.LOVE_LANGUAGE_SHARED || {};
const sharedUtils = sharedApi.utils || {};
const sharedUi = sharedApi.ui || {};
const awsHelpers = window.LOVE_LANGUAGE_AWS || {};

const trimOrEmpty =
  typeof sharedUtils.trimOrEmpty === "function"
    ? sharedUtils.trimOrEmpty
    : (value) => (typeof value === "string" ? value.trim() : "");
const hasMeaningText =
  typeof sharedUtils.hasMeaningText === "function"
    ? sharedUtils.hasMeaningText
    : (value) => typeof value === "string" && value.trim().length > 0;
const toEpochMs =
  typeof sharedUtils.toEpochMs === "function"
    ? sharedUtils.toEpochMs
    : (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };
const escapeXml =
  typeof sharedUtils.escapeXml === "function"
    ? sharedUtils.escapeXml
    : (text) =>
        String(text)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&apos;");
const toAudioBlob =
  typeof sharedUtils.toAudioBlob === "function"
    ? sharedUtils.toAudioBlob
    : () => null;
const createActionButton =
  typeof sharedUi.createActionButton === "function"
    ? sharedUi.createActionButton
    : (className, icon, label, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `action-btn ${className}`;
        button.dataset.icon = icon;
        button.dataset.action = action;
        button.textContent = icon;
        button.setAttribute("aria-label", label);
        return button;
      };
const copyTextToClipboard =
  typeof sharedUi.copyTextToClipboard === "function"
    ? sharedUi.copyTextToClipboard
    : async () => {};
const buildCopyPayload =
  typeof sharedUi.buildCopyPayload === "function"
    ? sharedUi.buildCopyPayload
    : ({ word, pronunciation, ipa, meaning }) => {
        const normalizedWord = trimOrEmpty(word);
        const normalizedPronunciation = trimOrEmpty(pronunciation) || trimOrEmpty(ipa);
        const normalizedMeaning = trimOrEmpty(meaning);
        const base = `${normalizedWord} /${normalizedPronunciation}/`;
        return normalizedMeaning ? `${base} : ${normalizedMeaning}` : base;
      };

function getActivityTimestamp(record) {
  return Math.max(toEpochMs(record && record.updatedTimestamp), toEpochMs(record && record.timestamp));
}

function buildCanonicalRecordRowId(userId, word) {
  return `${encodeURIComponent(trimOrEmpty(userId))}::${encodeURIComponent(trimOrEmpty(word))}`;
}

function buildEntryId(rowId, timestamp) {
  return `${rowId}|${timestamp}`;
}

function hasDefinedMeaning(record) {
  return hasMeaningText(record && record.meaning);
}

function matchesCurrentUserRecord(record) {
  return Boolean(currentUserId) && Boolean(record) && trimOrEmpty(record.user) === currentUserId;
}

function sortRecordsByActivityDesc(records) {
  return [...records].sort((left, right) => getActivityTimestamp(right) - getActivityTimestamp(left));
}

function isValidFilter(filter) {
  return filter === FILTERS.DEFINED || filter === FILTERS.UNDEFINED || filter === FILTERS.ALL;
}

function getEmptyStatusMessage(filter = activeFilter) {
  return EMPTY_STATUS_BY_FILTER[filter] || EMPTY_STATUS_BY_FILTER[FILTERS.DEFINED];
}

function getGroupStatusLabel(classification) {
  return classification === GROUP_CLASSIFICATIONS.UNDEFINED ? "Undefined" : "Defined";
}

const normalizedAwsConfig =
  typeof awsHelpers.normalizeConfig === "function"
    ? awsHelpers.normalizeConfig(window.LOVE_LANGUAGE_AWS_CONFIG)
    : window.LOVE_LANGUAGE_AWS_CONFIG;
const awsRuntime =
  typeof sharedApi.createAwsRuntime === "function"
    ? sharedApi.createAwsRuntime({ awsConfig: normalizedAwsConfig })
    : null;

const awsConfig = (awsRuntime && awsRuntime.awsConfig) || normalizedAwsConfig || {};
const isPlaybackConfigured = Boolean(awsRuntime && awsRuntime.isPlaybackConfigured);
const isDictionaryConfigured = Boolean(awsRuntime && awsRuntime.isHeartsConfigured);

const getPollyClient =
  (awsRuntime && awsRuntime.getPollyClient) ||
  (() => null);
const getHeartsTableClient =
  (awsRuntime && awsRuntime.getHeartsTableClient) ||
  (() => null);
const ensureAwsCredentials =
  (awsRuntime && awsRuntime.ensureAwsCredentials) ||
  (() => Promise.resolve(false));
const getIdentityId =
  (awsRuntime && awsRuntime.getIdentityId) ||
  (async () => {
    throw new Error("AWS runtime is unavailable.");
  });

async function ensureCurrentUserIdentity() {
  if (currentUserId) {
    return currentUserId;
  }

  const resolvedIdentity = trimOrEmpty(await getIdentityId());
  if (!resolvedIdentity) {
    throw new Error("Could not resolve the current AWS identity.");
  }

  currentUserId = resolvedIdentity;
  return currentUserId;
}

function setStatus(message, type = "info") {
  if (!dictionaryStatus) {
    return;
  }

  const normalized = trimOrEmpty(message);
  dictionaryStatus.classList.remove("is-hidden", "is-error");

  if (!normalized) {
    dictionaryStatus.textContent = "";
    dictionaryStatus.classList.add("is-hidden");
    return;
  }

  dictionaryStatus.textContent = normalized;
  if (type === "error") {
    dictionaryStatus.classList.add("is-error");
  }
}

function normalizeDictionaryEntry(rawItem) {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    return null;
  }

  const rowId = trimOrEmpty(rawItem.rowId);
  const word = trimOrEmpty(rawItem.word);
  const pronunciation = trimOrEmpty(rawItem.pronunciation || rawItem.ipa);
  if (!rowId || !word || !pronunciation) {
    return null;
  }

  const timestamp = toEpochMs(rawItem.timestamp) || Date.now();
  const updatedTimestamp = toEpochMs(rawItem.updatedTimestamp) || timestamp;
  const rawUnheartedTimestamp = toEpochMs(rawItem.unheartedTimestamp);

  return {
    id: buildEntryId(rowId, timestamp),
    rowId,
    timestamp,
    updatedTimestamp,
    unheartedTimestamp: rawUnheartedTimestamp > 0 ? rawUnheartedTimestamp : null,
    user: trimOrEmpty(rawItem.user),
    word,
    pronunciation,
    meaning: hasMeaningText(rawItem.meaning) ? trimOrEmpty(rawItem.meaning) : null,
    hearted: Boolean(rawItem.hearted),
    copyFlash: false
  };
}

function buildDictionaryTableItem(record) {
  return {
    rowId: record.rowId,
    timestamp: record.timestamp,
    user: record.user || null,
    word: record.word,
    pronunciation: record.pronunciation,
    meaning: record.meaning || null,
    hearted: Boolean(record.hearted),
    updatedTimestamp: record.updatedTimestamp,
    unheartedTimestamp: record.unheartedTimestamp ?? null
  };
}

async function scanDictionaryEntries() {
  const currentHeartsClient = getHeartsTableClient();
  if (!currentHeartsClient) {
    return [];
  }

  const items = [];
  let lastEvaluatedKey = undefined;

  do {
    const response = await currentHeartsClient
      .scan({
        TableName: awsConfig.heartsTableName,
        ExpressionAttributeNames: {
          "#rowId": "rowId",
          "#word": "word",
          "#pronunciation": "pronunciation",
          "#meaning": "meaning",
          "#hearted": "hearted",
          "#timestamp": "timestamp",
          "#updatedTimestamp": "updatedTimestamp",
          "#user": "user",
          "#unheartedTimestamp": "unheartedTimestamp"
        },
        ProjectionExpression:
          "#rowId, #word, #pronunciation, #meaning, #hearted, #timestamp, #updatedTimestamp, #user, #unheartedTimestamp",
        ExclusiveStartKey: lastEvaluatedKey
      })
      .promise();

    if (Array.isArray(response.Items) && response.Items.length > 0) {
      items.push(...response.Items);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

function getGroupByWord(word) {
  return groups.find((group) => group.word === word) || null;
}

function isGroupVisible(group) {
  if (!group || !group.isDictionaryVisible) {
    return false;
  }

  if (showOnlyMyHearts && !group.hasCurrentUserHeart) {
    return false;
  }

  if (activeFilter === FILTERS.UNDEFINED) {
    return group.classification === GROUP_CLASSIFICATIONS.UNDEFINED;
  }

  if (activeFilter === FILTERS.ALL) {
    return true;
  }

  return group.classification === GROUP_CLASSIFICATIONS.DEFINED;
}

function rebuildGroupsFromEntries() {
  const previousGroupsByWord = new Map(groups.map((group) => [group.word, group]));
  const recordsByWord = new Map();

  for (const record of recordsById.values()) {
    if (!recordsByWord.has(record.word)) {
      recordsByWord.set(record.word, []);
    }

    recordsByWord.get(record.word).push(record);
  }

  const nextGroups = [];
  for (const [word, wordRecords] of recordsByWord.entries()) {
    const sortedRecords = sortRecordsByActivityDesc(wordRecords);
    const definitionHistory = sortedRecords.filter((record) => hasDefinedMeaning(record));
    const currentUserRecord = sortedRecords.find((record) => matchesCurrentUserRecord(record)) || null;
    const hasAnyHeart = sortedRecords.some((record) => record.hearted);
    const isDictionaryVisible = hasAnyHeart || definitionHistory.length > 0;

    if (!isDictionaryVisible) {
      continue;
    }

    const displayRecord = definitionHistory[0] || sortedRecords[0] || null;
    const previousGroup = previousGroupsByWord.get(word);
    const currentUserMeaning = currentUserRecord && hasDefinedMeaning(currentUserRecord)
      ? currentUserRecord.meaning
      : "";
    const draftMeaning =
      previousGroup && previousGroup.hasDraftCache
        ? previousGroup.draftMeaning
        : currentUserMeaning;

    nextGroups.push({
      word,
      pronunciation: trimOrEmpty(
        (displayRecord && displayRecord.pronunciation) ||
          (currentUserRecord && currentUserRecord.pronunciation) ||
          (sortedRecords[0] && sortedRecords[0].pronunciation)
      ),
      records: sortedRecords,
      displayRecord,
      definitionHistory,
      currentUserRecord,
      hasCurrentUserHeart: Boolean(currentUserRecord && currentUserRecord.hearted),
      isDictionaryVisible,
      classification:
        definitionHistory.length > 0
          ? GROUP_CLASSIFICATIONS.DEFINED
          : GROUP_CLASSIFICATIONS.UNDEFINED,
      expanded: Boolean(previousGroup && previousGroup.expanded),
      draftMeaning,
      hasDraftCache:
        (previousGroup && previousGroup.hasDraftCache) ||
        hasMeaningText(draftMeaning),
      isEditing: Boolean(previousGroup && previousGroup.isEditing),
      saveStatus: previousGroup ? previousGroup.saveStatus : "idle",
      latestActivityTimestamp: sortedRecords.reduce(
        (maxTimestamp, record) => Math.max(maxTimestamp, getActivityTimestamp(record)),
        0
      )
    });
  }

  nextGroups.sort((left, right) => {
    const timestampDiff = right.latestActivityTimestamp - left.latestActivityTimestamp;
    if (timestampDiff !== 0) {
      return timestampDiff;
    }

    return left.word.localeCompare(right.word);
  });

  groups = nextGroups;
}

function rebuildVisibleGroups() {
  visibleGroups = groups.filter((group) => isGroupVisible(group));
  updateFilterControls();
}

function getFilterCounts() {
  const sourceGroups = showOnlyMyHearts ? groups.filter((group) => group.hasCurrentUserHeart) : groups;
  let definedCount = 0;
  let undefinedCount = 0;

  for (const group of sourceGroups) {
    if (!group.isDictionaryVisible) {
      continue;
    }

    if (group.classification === GROUP_CLASSIFICATIONS.UNDEFINED) {
      undefinedCount += 1;
    } else {
      definedCount += 1;
    }
  }

  return {
    [FILTERS.DEFINED]: definedCount,
    [FILTERS.UNDEFINED]: undefinedCount,
    [FILTERS.ALL]: definedCount + undefinedCount
  };
}

function updateFilterControls() {
  const counts = getFilterCounts();

  for (const button of filterButtons) {
    const filter = button.dataset.filter;
    const isActive = filter === activeFilter;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");

    const count = button.querySelector(".dictionary-filter-count");
    if (count) {
      count.textContent = String(counts[filter] || 0);
    }
  }

  if (myHeartsToggle) {
    myHeartsToggle.classList.toggle("is-active", showOnlyMyHearts);
    myHeartsToggle.setAttribute("aria-pressed", showOnlyMyHearts ? "true" : "false");
  }
}

function updateSentinelVisibility() {
  if (!dictionarySentinel) {
    return;
  }

  const hide = visibleGroups.length === 0 || renderedGroupCount >= visibleGroups.length;
  dictionarySentinel.classList.toggle("is-hidden", hide);
}

function getHistoryEntriesForGroup(group) {
  if (!group || group.definitionHistory.length <= 1) {
    return [];
  }

  return group.definitionHistory.slice(1);
}

function getGroupCopyPayload(group, record) {
  return buildCopyPayload({
    word: group.word,
    pronunciation: record.pronunciation,
    ipa: record.pronunciation,
    meaning: hasDefinedMeaning(record) ? record.meaning : ""
  });
}

function renderRecordMeaning(row, group, record, isHistoryEntry) {
  const container = row.querySelector(".row-meaning");
  if (!container) {
    return;
  }

  container.textContent = "";
  if (hasDefinedMeaning(record)) {
    const definition = document.createElement("span");
    definition.className = "meaning-definition";
    definition.textContent = `— ${record.meaning}`;
    container.appendChild(definition);
  }

  if (isHistoryEntry) {
    return;
  }

  if (selectedWord !== group.word) {
    return;
  }

  if (group.isEditing) {
    const editor = document.createElement("div");
    editor.className = "meaning-editor";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "meaning-input";
    input.placeholder = "What does this word mean?";
    input.value = group.draftMeaning;

    const saveButton = createActionButton("meaning-action is-save", "✓", "Save my meaning", "save-meaning");
    const cancelButton = createActionButton(
      "meaning-action",
      "✕",
      "Cancel meaning edit",
      "cancel-meaning"
    );

    if (group.saveStatus !== "idle") {
      input.disabled = true;
      saveButton.disabled = true;
      cancelButton.disabled = true;
    }

    editor.append(input, saveButton, cancelButton);
    container.appendChild(editor);

    window.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return;
  }

  const link = document.createElement("button");
  link.type = "button";
  link.className = "meaning-link";
  link.dataset.action = "open-meaning-editor";
  link.textContent =
    group.currentUserRecord && hasDefinedMeaning(group.currentUserRecord)
      ? "Edit my meaning"
      : hasMeaningText(group.draftMeaning)
        ? "Edit my meaning"
        : "Add my meaning";
  link.disabled = group.saveStatus !== "idle";
  container.appendChild(link);
}

function applyRecordRowState(row, group, record, isHistoryEntry) {
  row.classList.toggle("is-selected", !isHistoryEntry && selectedWord === group.word);

  const heartButton = row.querySelector(".heart-btn");
  if (heartButton) {
    heartButton.classList.toggle("is-hidden", isHistoryEntry);
    heartButton.classList.toggle("is-hearted", group.hasCurrentUserHeart);
    heartButton.textContent = group.hasCurrentUserHeart ? "❤" : "♡";
    heartButton.setAttribute("aria-label", group.hasCurrentUserHeart ? "Remove saved word" : "Save word");
    heartButton.disabled = isHistoryEntry || group.saveStatus !== "idle";
  }

  const copyButton = row.querySelector(".copy-btn");
  if (copyButton) {
    copyButton.classList.toggle("is-success", Boolean(record.copyFlash));
    copyButton.textContent = record.copyFlash ? "✓" : copyButton.dataset.icon;
  }

  const playButton = row.querySelector(".play-btn");
  if (playButton) {
    const isPlaying = playingRecordId === record.id;
    playButton.classList.toggle("is-playing", isPlaying);
    playButton.classList.remove("is-loading");
    playButton.textContent = isPlaying ? "■" : playButton.dataset.icon;
  }

  renderRecordMeaning(row, group, record, isHistoryEntry);
}

function createRecordRowElement(group, record, isHistoryEntry) {
  const row = document.createElement("div");
  row.className = "result-row dictionary-entry";
  if (isHistoryEntry) {
    row.classList.add("dictionary-history-entry");
  }

  row.dataset.word = group.word;
  row.dataset.recordId = record.id;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const playButton = createActionButton("play-btn", "▶", "Play pronunciation", "play-pronunciation");
  if (!isPlaybackConfigured) {
    playButton.classList.add("is-hidden");
  }

  const heartButton = createActionButton("heart-btn", "♡", "Save word", "toggle-heart");
  const copyButton = createActionButton("copy-btn", "⧉", "Copy word details", "copy-word");

  actions.append(playButton, heartButton);

  const content = document.createElement("div");
  content.className = "row-content";

  const wordSpan = document.createElement("span");
  wordSpan.className = "word";
  wordSpan.textContent = group.word;

  const ipaSpan = document.createElement("span");
  ipaSpan.className = "ipa";
  ipaSpan.textContent = `/${record.pronunciation}/`;

  content.append(wordSpan, ipaSpan);

  const meaning = document.createElement("div");
  meaning.className = "row-meaning";

  const copySlot = document.createElement("div");
  copySlot.className = "row-copy";
  copySlot.append(copyButton);

  row.append(actions, content, meaning, copySlot);
  applyRecordRowState(row, group, record, isHistoryEntry);
  return row;
}

function createGroupCard(group) {
  const displayRecord = group.displayRecord;
  if (!displayRecord) {
    return null;
  }

  const historyEntries = getHistoryEntriesForGroup(group);
  const card = document.createElement("li");
  card.className = "dictionary-card";
  card.dataset.word = group.word;

  const header = document.createElement("div");
  header.className = "dictionary-card-header";

  const wordMeta = document.createElement("div");
  wordMeta.className = "dictionary-word-meta";

  const title = document.createElement("span");
  title.className = "dictionary-word-title";
  title.textContent = group.word;

  const badge = document.createElement("span");
  badge.className = `dictionary-status-badge is-${group.classification}`;
  badge.textContent = getGroupStatusLabel(group.classification);

  wordMeta.append(title, badge);
  header.appendChild(wordMeta);

  if (historyEntries.length > 0) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "dictionary-history-toggle";
    toggle.dataset.action = "toggle-history";
    toggle.dataset.word = group.word;
    toggle.textContent = group.expanded ? "Hide definitions" : `See more (${historyEntries.length})`;
    header.appendChild(toggle);
  }

  const main = document.createElement("div");
  main.className = "dictionary-main";
  main.appendChild(createRecordRowElement(group, displayRecord, false));

  card.append(header, main);

  if (historyEntries.length > 0) {
    const history = document.createElement("div");
    history.className = "dictionary-history";
    history.hidden = !group.expanded;

    for (const historyRecord of historyEntries) {
      history.appendChild(createRecordRowElement(group, historyRecord, true));
    }

    card.appendChild(history);
  }

  return card;
}

function appendGroupCards(targetCount) {
  if (!dictionaryList) {
    return;
  }

  while (renderedGroupCount < targetCount && renderedGroupCount < visibleGroups.length) {
    const group = visibleGroups[renderedGroupCount];
    const card = createGroupCard(group);
    if (card) {
      dictionaryList.appendChild(card);
    }
    renderedGroupCount += 1;
  }

  updateSentinelVisibility();
}

function renderDictionary(preserveCount = 0) {
  if (!dictionaryList) {
    return;
  }

  dictionaryList.textContent = "";
  renderedGroupCount = 0;

  if (visibleGroups.length === 0) {
    updateSentinelVisibility();
    return;
  }

  const initialCount =
    preserveCount > 0
      ? Math.min(visibleGroups.length, Math.max(DICTIONARY_BATCH_SIZE, preserveCount))
      : Math.min(visibleGroups.length, DICTIONARY_BATCH_SIZE);

  appendGroupCards(initialCount);
}

function renderNextGroupBatch() {
  if (renderedGroupCount >= visibleGroups.length) {
    updateSentinelVisibility();
    return;
  }

  const nextCount = Math.min(visibleGroups.length, renderedGroupCount + DICTIONARY_BATCH_SIZE);
  appendGroupCards(nextCount);
}

function setupObserver() {
  if (!dictionarySentinel) {
    return;
  }

  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (visibleGroups.length === 0) {
    updateSentinelVisibility();
    return;
  }

  if (typeof window.IntersectionObserver !== "function") {
    appendGroupCards(visibleGroups.length);
    return;
  }

  observer = new window.IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      renderNextGroupBatch();
    },
    {
      root: null,
      rootMargin: "240px 0px"
    }
  );

  observer.observe(dictionarySentinel);
}

function clearCopyFeedback(recordId) {
  const timer = copyFeedbackTimers.get(recordId);
  if (!timer) {
    return;
  }

  window.clearTimeout(timer);
  copyFeedbackTimers.delete(recordId);
}

function isWordVisible(word) {
  return visibleGroups.some((group) => group.word === word);
}

function getVisibleRecordIds() {
  const visibleIds = new Set();

  for (const group of visibleGroups) {
    if (group.displayRecord) {
      visibleIds.add(group.displayRecord.id);
    }

    if (group.expanded) {
      for (const historyRecord of getHistoryEntriesForGroup(group)) {
        visibleIds.add(historyRecord.id);
      }
    }
  }

  return visibleIds;
}

function syncVisibleState(preferredWord = "") {
  if (preferredWord && isWordVisible(preferredWord)) {
    selectedWord = preferredWord;
  } else if (selectedWord && !isWordVisible(selectedWord)) {
    selectedWord = "";
  }

  if (playingRecordId) {
    const visibleIds = getVisibleRecordIds();
    if (!visibleIds.has(playingRecordId)) {
      sharedAudio.pause();
      sharedAudio.currentTime = 0;
      playingRecordId = "";
    }
  }
}

function refreshDictionaryView(options = {}) {
  const preserveCount = Number(options.preserveCount) > 0 ? Number(options.preserveCount) : 0;
  const preferredWord = trimOrEmpty(options.preferredWord);

  rebuildVisibleGroups();

  if (!dictionaryList) {
    updateSentinelVisibility();
    return;
  }

  if (visibleGroups.length === 0) {
    dictionaryList.textContent = "";
    renderedGroupCount = 0;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    updateSentinelVisibility();
    setStatus(getEmptyStatusMessage());
    syncVisibleState();
    return;
  }

  setStatus("");
  renderDictionary(preserveCount);
  setupObserver();
  syncVisibleState(preferredWord);
}

async function synthesize(word, ipa) {
  const currentPollyClient = getPollyClient();
  if (!isPlaybackConfigured || !currentPollyClient) {
    return null;
  }

  const ready = await ensureAwsCredentials();
  if (!ready) {
    return null;
  }

  const cacheKey = [
    word,
    ipa,
    awsConfig.region,
    awsConfig.voiceId,
    awsConfig.engine,
    awsConfig.outputFormat
  ].join("|");

  if (audioCache.has(cacheKey)) {
    return audioCache.get(cacheKey);
  }

  const ssml = `<speak><phoneme alphabet="ipa" ph="${escapeXml(ipa)}">${escapeXml(
    word
  )}</phoneme></speak>`;

  const data = await currentPollyClient
    .synthesizeSpeech({
      OutputFormat: awsConfig.outputFormat,
      TextType: "ssml",
      Text: ssml,
      VoiceId: awsConfig.voiceId,
      Engine: awsConfig.engine
    })
    .promise();

  const audioBlob = toAudioBlob(data.AudioStream, awsConfig.outputFormat);
  if (!audioBlob) {
    throw new Error("Polly returned an unsupported audio stream payload.");
  }

  const objectUrl = URL.createObjectURL(audioBlob);
  audioCache.set(cacheKey, objectUrl);
  return objectUrl;
}

async function playPronunciation(recordId) {
  if (!isPlaybackConfigured) {
    return;
  }

  const record = recordsById.get(recordId);
  if (!record) {
    return;
  }

  if (playingRecordId === recordId && !sharedAudio.paused) {
    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    playingRecordId = "";
    refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });
    return;
  }

  const previousPlayingRecordId = playingRecordId;

  try {
    const audioUrl = await synthesize(record.word, record.pronunciation);
    if (!audioUrl) {
      return;
    }

    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    sharedAudio.src = audioUrl;
    await sharedAudio.play();

    playingRecordId = recordId;
    refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });
  } catch (error) {
    playingRecordId = previousPlayingRecordId;
    console.error("Failed to synthesize or play pronunciation.", error);
  }
}

function showCopySuccess(recordId) {
  const record = recordsById.get(recordId);
  if (!record) {
    return;
  }

  clearCopyFeedback(recordId);
  record.copyFlash = true;
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });

  const timer = window.setTimeout(() => {
    const current = recordsById.get(recordId);
    if (!current) {
      return;
    }

    current.copyFlash = false;
    copyFeedbackTimers.delete(recordId);
    refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });
  }, COPY_FEEDBACK_MS);

  copyFeedbackTimers.set(recordId, timer);
}

function toggleHistory(word) {
  const group = getGroupByWord(word);
  if (!group || getHistoryEntriesForGroup(group).length === 0) {
    return;
  }

  group.expanded = !group.expanded;
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: word || selectedWord });
}

function openMeaningEditor(word) {
  const group = getGroupByWord(word);
  if (!group) {
    return;
  }

  if (!group.hasDraftCache) {
    group.draftMeaning =
      group.currentUserRecord && hasDefinedMeaning(group.currentUserRecord)
        ? group.currentUserRecord.meaning
        : "";
    group.hasDraftCache = true;
  }

  group.isEditing = true;
  selectedWord = word;
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: word });
}

function closeMeaningEditor(word) {
  const group = getGroupByWord(word);
  if (!group) {
    return;
  }

  group.isEditing = false;
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: word });
}

async function putDictionaryRecord(record) {
  const currentHeartsClient = getHeartsTableClient();
  if (!isDictionaryConfigured || !currentHeartsClient) {
    throw new Error("Dictionary persistence is not configured.");
  }

  await currentHeartsClient
    .put({
      TableName: awsConfig.heartsTableName,
      Item: buildDictionaryTableItem(record)
    })
    .promise();
}

async function ensureEditableCurrentUserRecord(group) {
  const identityId = await ensureCurrentUserIdentity();
  if (group.currentUserRecord) {
    group.currentUserRecord.user = identityId;
    return {
      record: group.currentUserRecord,
      created: false
    };
  }

  const now = Date.now();
  const rowId = buildCanonicalRecordRowId(identityId, group.word);
  const record = {
    id: buildEntryId(rowId, now),
    rowId,
    timestamp: now,
    updatedTimestamp: now,
    unheartedTimestamp: null,
    user: identityId,
    word: group.word,
    pronunciation: group.pronunciation,
    meaning: null,
    hearted: false,
    copyFlash: false
  };

  recordsById.set(record.id, record);
  return {
    record,
    created: true
  };
}

async function handleToggleHeart(word) {
  const group = getGroupByWord(word);
  if (!group || !isDictionaryConfigured) {
    return;
  }

  const previousCount = renderedGroupCount;
  const previousSaveStatus = group.saveStatus;
  group.saveStatus = "saving-heart";
  refreshDictionaryView({ preserveCount: previousCount, preferredWord: word });

  let createdRecordId = "";
  let snapshot = null;

  try {
    const ensured = await ensureEditableCurrentUserRecord(group);
    const record = ensured.record;
    createdRecordId = ensured.created ? record.id : "";
    snapshot = {
      hearted: record.hearted,
      updatedTimestamp: record.updatedTimestamp,
      unheartedTimestamp: record.unheartedTimestamp,
      user: record.user
    };

    const now = Date.now();
    record.user = currentUserId;
    record.hearted = !group.hasCurrentUserHeart;
    record.updatedTimestamp = now;
    record.unheartedTimestamp = record.hearted ? null : now;

    await putDictionaryRecord(record);

    rebuildGroupsFromEntries();
    const nextGroup = getGroupByWord(word);
    if (nextGroup) {
      nextGroup.saveStatus = "idle";
    }
    refreshDictionaryView({ preserveCount: previousCount, preferredWord: word });
  } catch (error) {
    if (createdRecordId) {
      clearCopyFeedback(createdRecordId);
      recordsById.delete(createdRecordId);
    } else if (snapshot) {
      const record = group.currentUserRecord;
      if (record) {
        record.hearted = snapshot.hearted;
        record.updatedTimestamp = snapshot.updatedTimestamp;
        record.unheartedTimestamp = snapshot.unheartedTimestamp;
        record.user = snapshot.user;
      }
    }

    group.saveStatus = previousSaveStatus;
    refreshDictionaryView({ preserveCount: previousCount, preferredWord: word });
    console.error("Failed to toggle dictionary heart.", error);
  }
}

async function handleSaveMeaning(word) {
  const group = getGroupByWord(word);
  if (!group || !isDictionaryConfigured) {
    return;
  }

  const trimmedMeaning = trimOrEmpty(group.draftMeaning);
  if (!trimmedMeaning) {
    closeMeaningEditor(word);
    return;
  }

  const previousCount = renderedGroupCount;
  const previousSaveStatus = group.saveStatus;
  group.saveStatus = "saving-meaning";
  group.isEditing = false;
  refreshDictionaryView({ preserveCount: previousCount, preferredWord: word });

  let createdRecordId = "";
  let snapshot = null;

  try {
    const ensured = await ensureEditableCurrentUserRecord(group);
    const record = ensured.record;
    createdRecordId = ensured.created ? record.id : "";
    snapshot = {
      meaning: record.meaning,
      updatedTimestamp: record.updatedTimestamp,
      user: record.user,
      hearted: record.hearted,
      unheartedTimestamp: record.unheartedTimestamp
    };

    record.user = currentUserId;
    record.meaning = trimmedMeaning;
    record.updatedTimestamp = Date.now();

    await putDictionaryRecord(record);

    rebuildGroupsFromEntries();
    const nextGroup = getGroupByWord(word);
    if (nextGroup) {
      nextGroup.draftMeaning = trimmedMeaning;
      nextGroup.hasDraftCache = true;
      nextGroup.isEditing = false;
      nextGroup.saveStatus = "idle";
    }
    refreshDictionaryView({ preserveCount: previousCount, preferredWord: word });
  } catch (error) {
    if (createdRecordId) {
      clearCopyFeedback(createdRecordId);
      recordsById.delete(createdRecordId);
    } else if (snapshot) {
      const record = group.currentUserRecord;
      if (record) {
        record.meaning = snapshot.meaning;
        record.updatedTimestamp = snapshot.updatedTimestamp;
        record.user = snapshot.user;
        record.hearted = snapshot.hearted;
        record.unheartedTimestamp = snapshot.unheartedTimestamp;
      }
    }

    group.saveStatus = previousSaveStatus;
    group.isEditing = true;
    refreshDictionaryView({ preserveCount: previousCount, preferredWord: word });
    console.error("Failed to save dictionary meaning.", error);
  }
}

function handleMeaningInput(event) {
  const input = event.target.closest(".meaning-input");
  if (!input) {
    return;
  }

  const card = input.closest(".dictionary-card");
  if (!card) {
    return;
  }

  const group = getGroupByWord(card.dataset.word || "");
  if (!group) {
    return;
  }

  group.draftMeaning = input.value;
  group.hasDraftCache = true;
}

function handleMeaningInputKeydown(event) {
  const input = event.target.closest(".meaning-input");
  if (!input) {
    return;
  }

  const card = input.closest(".dictionary-card");
  if (!card) {
    return;
  }

  const word = trimOrEmpty(card.dataset.word);
  if (!word) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    void handleSaveMeaning(word);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeMeaningEditor(word);
  }
}

async function handleDictionaryListClick(event) {
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (actionButton && actionButton.dataset.action === "toggle-history") {
    toggleHistory(actionButton.dataset.word || "");
    return;
  }

  const row = event.target.closest(".dictionary-entry");
  if (!row || !dictionaryList || !dictionaryList.contains(row)) {
    return;
  }

  const card = row.closest(".dictionary-card");
  const word = trimOrEmpty((card && card.dataset.word) || row.dataset.word);
  if (!word) {
    return;
  }

  if (!actionButton) {
    selectedWord = word;
    refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: word });
    return;
  }

  if (actionButton.dataset.action !== "copy-word" && actionButton.dataset.action !== "play-pronunciation") {
    selectedWord = word;
  }

  const recordId = trimOrEmpty(row.dataset.recordId);
  const record = recordId ? recordsById.get(recordId) : null;

  if (actionButton.dataset.action === "toggle-heart") {
    await handleToggleHeart(word);
    return;
  }

  if (actionButton.dataset.action === "copy-word") {
    if (!record) {
      return;
    }

    try {
      const group = getGroupByWord(word);
      if (!group) {
        return;
      }

      await copyTextToClipboard(getGroupCopyPayload(group, record));
      showCopySuccess(record.id);
    } catch (error) {
      console.error("Copy failed.", error);
    }
    return;
  }

  if (actionButton.dataset.action === "play-pronunciation") {
    if (!record) {
      return;
    }

    await playPronunciation(record.id);
    return;
  }

  if (actionButton.dataset.action === "open-meaning-editor") {
    openMeaningEditor(word);
    return;
  }

  if (actionButton.dataset.action === "save-meaning") {
    await handleSaveMeaning(word);
    return;
  }

  if (actionButton.dataset.action === "cancel-meaning") {
    closeMeaningEditor(word);
  }
}

function handleFilterClick(event) {
  const button = event.target.closest(".dictionary-filter-btn[data-filter]");
  if (!button) {
    return;
  }

  const nextFilter = trimOrEmpty(button.dataset.filter);
  if (!isValidFilter(nextFilter) || nextFilter === activeFilter) {
    return;
  }

  activeFilter = nextFilter;
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });
}

function handleMyHeartsToggleClick() {
  showOnlyMyHearts = !showOnlyMyHearts;
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });
}

async function loadDictionary() {
  if (!dictionaryList || !dictionaryStatus) {
    return;
  }

  if (!isDictionaryConfigured) {
    setStatus("Dictionary is unavailable. Configure AWS guest access to load saved words.", "error");
    updateFilterControls();
    updateSentinelVisibility();
    return;
  }

  setStatus("Loading dictionary...");

  const ready = await ensureAwsCredentials();
  if (!ready) {
    setStatus("Could not initialize AWS guest credentials.", "error");
    updateFilterControls();
    updateSentinelVisibility();
    return;
  }

  try {
    await ensureCurrentUserIdentity();
    const rawItems = await scanDictionaryEntries();

    recordsById.clear();
    for (const rawItem of rawItems) {
      const record = normalizeDictionaryEntry(rawItem);
      if (!record) {
        continue;
      }

      recordsById.set(record.id, record);
    }

    rebuildGroupsFromEntries();
    refreshDictionaryView();
  } catch (error) {
    console.error("Failed to load dictionary entries.", error);
    setStatus("Failed to load dictionary entries.", "error");
    updateFilterControls();
    updateSentinelVisibility();
  }
}

updateFilterControls();

sharedAudio.addEventListener("ended", () => {
  playingRecordId = "";
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });
});
sharedAudio.addEventListener("error", () => {
  playingRecordId = "";
  refreshDictionaryView({ preserveCount: renderedGroupCount, preferredWord: selectedWord });
});

if (dictionaryFilters) {
  dictionaryFilters.addEventListener("click", handleFilterClick);
}

if (myHeartsToggle) {
  myHeartsToggle.addEventListener("click", handleMyHeartsToggleClick);
}

if (dictionaryList) {
  dictionaryList.addEventListener("click", (event) => {
    void handleDictionaryListClick(event);
  });

  dictionaryList.addEventListener("input", handleMeaningInput);
  dictionaryList.addEventListener("keydown", handleMeaningInputKeydown);
}

document.addEventListener("click", (event) => {
  if (
    event.target.closest(".dictionary-entry") ||
    event.target.closest(".dictionary-history-toggle") ||
    event.target.closest(".dictionary-filter-btn") ||
    event.target.closest(".dictionary-toggle-btn")
  ) {
    return;
  }

  selectedWord = "";
  refreshDictionaryView({ preserveCount: renderedGroupCount });
});

window.addEventListener("beforeunload", () => {
  sharedAudio.pause();
  sharedAudio.currentTime = 0;

  for (const url of audioCache.values()) {
    URL.revokeObjectURL(url);
  }

  for (const recordId of copyFeedbackTimers.keys()) {
    clearCopyFeedback(recordId);
  }
});

void loadDictionary();
