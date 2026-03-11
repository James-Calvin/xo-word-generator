const vowels = [
  { symbol: "a", ipa: "æ" },
  { symbol: "ee", ipa: "i" },
  { symbol: "ai", ipa: "eɪ" },
  { symbol: "i", ipa: "ɪ" },
  { symbol: "u", ipa: "ə" },
  { symbol: "au", ipa: "a" },
  { symbol: "o", ipa: "o" },
  { symbol: "oo", ipa: "u" }
];

const consonants = [
  { symbol: "g", ipa: "g" },
  { symbol: "b", ipa: "b" },
  { symbol: "r", ipa: "r" },
  { symbol: "l", ipa: "l" },
  { symbol: "j", ipa: "d͡ʒ" },
  { symbol: "m", ipa: "m" },
  { symbol: "z", ipa: "z" },
  { symbol: "d", ipa: "d" },
  { symbol: "s", ipa: "s" },
  { symbol: "n", ipa: "n" },
  { symbol: "ch", ipa: "t͡ʃ" },
  { symbol: "x", ipa: "ʃ" },
  { symbol: "ñ", ipa: "ɲ" },
  { symbol: "y", ipa: "j" },
  { symbol: "t", ipa: "t" }
];

const MAX_RESULTS = 50;
const RETRY_LIMIT = 100;
const DEFAULT_VOICE_ID = "Joanna";
const DEFAULT_ENGINE = "neural";
const DEFAULT_OUTPUT_FORMAT = "mp3";
const DEFAULT_HEARTS_WORD_TIMESTAMP_INDEX = "word-timestamp-index";
const COPY_FEEDBACK_MS = 1200;

const SLOT_TYPES = {
  CONSONANT: "C",
  VOWEL: "V"
};

const RELATIONS = {
  SAME_SYLLABLE: "sameSyllable",
  BOUNDARY: "boundary",
  NONE: "none"
};

const minInput = document.getElementById("minSyllables");
const maxInput = document.getElementById("maxSyllables");
const generateBtn = document.getElementById("generateBtn");
const resultsList = document.getElementById("results");

const generatedWords = new Set();
const rowStateById = new Map();
const audioCache = new Map();
const copyFeedbackTimers = new Map();
const sharedAudio = new Audio();

let selectedRowId = null;
let playingRowId = null;
let awsInitPromise = null;

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function trimOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createRowId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `row-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAwsConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};

  const region = typeof source.region === "string" ? source.region.trim() : "";
  const identityPoolId = typeof source.identityPoolId === "string" ? source.identityPoolId.trim() : "";
  const heartsTableName =
    typeof source.heartsTableName === "string" ? source.heartsTableName.trim() : "";
  const heartsWordTimestampIndexName =
    typeof source.heartsWordTimestampIndexName === "string" && source.heartsWordTimestampIndexName.trim()
      ? source.heartsWordTimestampIndexName.trim()
      : DEFAULT_HEARTS_WORD_TIMESTAMP_INDEX;

  const voiceId =
    typeof source.voiceId === "string" && source.voiceId.trim()
      ? source.voiceId.trim()
      : DEFAULT_VOICE_ID;
  const engine =
    typeof source.engine === "string" && source.engine.trim()
      ? source.engine.trim()
      : DEFAULT_ENGINE;
  const outputFormat =
    typeof source.outputFormat === "string" && source.outputFormat.trim()
      ? source.outputFormat.trim()
      : DEFAULT_OUTPUT_FORMAT;

  return {
    region,
    identityPoolId,
    heartsTableName,
    heartsWordTimestampIndexName,
    voiceId,
    engine,
    outputFormat
  };
}

function getAudioMimeType(outputFormat) {
  if (outputFormat === "ogg_vorbis") {
    return "audio/ogg";
  }

  if (outputFormat === "pcm") {
    return "audio/wav";
  }

  return "audio/mpeg";
}

function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeBase64(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toAudioBlob(audioStream, outputFormat) {
  const mimeType = getAudioMimeType(outputFormat);

  if (audioStream instanceof ArrayBuffer) {
    return new Blob([audioStream], { type: mimeType });
  }

  if (ArrayBuffer.isView(audioStream)) {
    return new Blob(
      [new Uint8Array(audioStream.buffer, audioStream.byteOffset, audioStream.byteLength)],
      { type: mimeType }
    );
  }

  if (typeof audioStream === "string") {
    return new Blob([decodeBase64(audioStream)], { type: mimeType });
  }

  return null;
}

class RuleEngine {
  constructor() {
    this.transitionRules = [];
    this.wordEndBans = new Set();
    this.syllableEndBans = new Set();
  }

  addWordRule(triggerSymbol, blockedNextSymbols) {
    this.addTransitionRule("word", triggerSymbol, blockedNextSymbols);
  }

  addSyllableRule(triggerSymbol, blockedNextSymbols) {
    this.addTransitionRule("syllable", triggerSymbol, blockedNextSymbols);
  }

  addBoundaryRule(triggerSymbol, blockedNextSymbols) {
    this.addTransitionRule("boundary", triggerSymbol, blockedNextSymbols);
  }

  addWordEndBan(symbol) {
    this.wordEndBans.add(symbol);
  }

  addSyllableEndBan(symbol) {
    this.syllableEndBans.add(symbol);
  }

  addTransitionRule(scope, triggerSymbol, blockedNextSymbols) {
    const blocked = Array.isArray(blockedNextSymbols) ? blockedNextSymbols : [blockedNextSymbols];
    this.transitionRules.push({
      scope,
      triggerSymbol,
      blockedNextSymbols: [...new Set(blocked)]
    });
  }

  resolveBlockedNextSymbols(triggerSymbol, relationToNext) {
    const blocked = [];

    for (const rule of this.transitionRules) {
      if (rule.triggerSymbol !== triggerSymbol) {
        continue;
      }

      if (!this.matchesScope(rule.scope, relationToNext)) {
        continue;
      }

      blocked.push(...rule.blockedNextSymbols);
    }

    return [...new Set(blocked)];
  }

  matchesScope(scope, relationToNext) {
    if (relationToNext === RELATIONS.NONE) {
      return false;
    }

    if (scope === "word") {
      return relationToNext === RELATIONS.SAME_SYLLABLE || relationToNext === RELATIONS.BOUNDARY;
    }

    if (scope === "syllable") {
      return relationToNext === RELATIONS.SAME_SYLLABLE;
    }

    if (scope === "boundary") {
      return relationToNext === RELATIONS.BOUNDARY;
    }

    return false;
  }

  isWordEndBanned(symbol) {
    return this.wordEndBans.has(symbol);
  }

  isSyllableEndBanned(symbol) {
    return this.syllableEndBans.has(symbol);
  }
}

class PoolManager {
  constructor(vowelSymbols, consonantSymbols) {
    this.basePools = {
      [SLOT_TYPES.VOWEL]: vowelSymbols.map((symbol) => symbol.symbol),
      [SLOT_TYPES.CONSONANT]: consonantSymbols.map((symbol) => symbol.symbol)
    };

    this.symbolByType = {
      [SLOT_TYPES.VOWEL]: new Map(vowelSymbols.map((entry) => [entry.symbol, entry])),
      [SLOT_TYPES.CONSONANT]: new Map(consonantSymbols.map((entry) => [entry.symbol, entry]))
    };

    this.workingPools = {
      [SLOT_TYPES.VOWEL]: new Set(this.basePools[SLOT_TYPES.VOWEL]),
      [SLOT_TYPES.CONSONANT]: new Set(this.basePools[SLOT_TYPES.CONSONANT])
    };

    this.activeEvents = [];
    this.eventLog = [];
  }

  resetWordAttempt() {
    this.workingPools[SLOT_TYPES.VOWEL] = new Set(this.basePools[SLOT_TYPES.VOWEL]);
    this.workingPools[SLOT_TYPES.CONSONANT] = new Set(this.basePools[SLOT_TYPES.CONSONANT]);
    this.activeEvents = [];
    this.eventLog = [];
  }

  getCandidates(slotType) {
    const entries = this.symbolByType[slotType];
    const symbols = this.workingPools[slotType];
    return [...symbols].map((symbol) => entries.get(symbol));
  }

  applyNextPickRestrictions(slotType, blockedSymbols) {
    if (!blockedSymbols || blockedSymbols.length === 0) {
      return;
    }

    const removedSymbols = [];
    for (const symbol of blockedSymbols) {
      if (this.workingPools[slotType].has(symbol)) {
        this.workingPools[slotType].delete(symbol);
        removedSymbols.push(symbol);
      }
    }

    if (removedSymbols.length === 0) {
      return;
    }

    const event = { slotType, removedSymbols };
    this.activeEvents.push(event);
    this.eventLog.push(event);
  }

  restorePendingRestrictions() {
    for (const event of this.activeEvents) {
      for (const symbol of event.removedSymbols) {
        this.workingPools[event.slotType].add(symbol);
      }
    }

    this.activeEvents = [];
  }
}

function buildSyllablePattern(position, total) {
  if (total === 1) {
    return randomFrom(["CV", "V", "CVC"]);
  }

  if (position === 0) {
    return randomFrom(["CV", "V"]);
  }

  if (position === total - 1) {
    return randomFrom(["CV", "CVC"]);
  }

  return "CV";
}

function buildWordSlots(syllablePatterns) {
  const slots = [];

  for (let syllableIndex = 0; syllableIndex < syllablePatterns.length; syllableIndex += 1) {
    const pattern = syllablePatterns[syllableIndex];
    for (const token of pattern) {
      slots.push({
        type: token,
        syllableIndex,
        relationToNext: RELATIONS.NONE
      });
    }
  }

  for (let i = 0; i < slots.length - 1; i += 1) {
    if (slots[i].syllableIndex === slots[i + 1].syllableIndex) {
      slots[i].relationToNext = RELATIONS.SAME_SYLLABLE;
    } else {
      slots[i].relationToNext = RELATIONS.BOUNDARY;
    }
  }

  return slots;
}

function clampSyllables() {
  let min = Number(minInput.value);
  let max = Number(maxInput.value);

  if (!Number.isInteger(min)) {
    min = 1;
  }
  if (!Number.isInteger(max)) {
    max = min;
  }

  min = Math.max(1, Math.min(12, min));
  max = Math.max(1, Math.min(12, max));

  if (min > max) {
    [min, max] = [max, min];
  }

  minInput.value = String(min);
  maxInput.value = String(max);
  return { min, max };
}

const awsConfig = normalizeAwsConfig(window.LOVE_LANGUAGE_AWS_CONFIG);
const hasAwsSdk =
  typeof window.AWS !== "undefined" &&
  typeof window.AWS.Polly !== "undefined" &&
  typeof window.AWS.CognitoIdentityCredentials !== "undefined";

const isPlaybackConfigured = Boolean(hasAwsSdk && awsConfig.region && awsConfig.identityPoolId);
const hasDocumentClient = Boolean(
  hasAwsSdk &&
    typeof window.AWS.DynamoDB !== "undefined" &&
    typeof window.AWS.DynamoDB.DocumentClient !== "undefined"
);
const isHeartsConfigured = Boolean(isPlaybackConfigured && hasDocumentClient && awsConfig.heartsTableName);

let pollyClient = null;
let heartsTableClient = null;

function getPollyClient() {
  if (!isPlaybackConfigured) {
    return null;
  }

  if (!pollyClient) {
    pollyClient = new window.AWS.Polly({ apiVersion: "2016-06-10", region: awsConfig.region });
  }

  return pollyClient;
}

function getHeartsTableClient() {
  if (!isHeartsConfigured) {
    return null;
  }

  if (!heartsTableClient) {
    heartsTableClient = new window.AWS.DynamoDB.DocumentClient({ region: awsConfig.region });
  }

  return heartsTableClient;
}

function refreshAwsCredentials() {
  return new Promise((resolve, reject) => {
    if (!window.AWS.config.credentials) {
      reject(new Error("Missing AWS credentials configuration."));
      return;
    }

    window.AWS.config.credentials.get((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function ensureAwsCredentials() {
  if (!isPlaybackConfigured) {
    return Promise.resolve(false);
  }

  if (!awsInitPromise) {
    awsInitPromise = (async () => {
      window.AWS.config.update({
        region: awsConfig.region,
        credentials: new window.AWS.CognitoIdentityCredentials({
          IdentityPoolId: awsConfig.identityPoolId
        })
      });

      await refreshAwsCredentials();
      const credentials = window.AWS.config.credentials;

      const currentPollyClient = getPollyClient();
      if (currentPollyClient && credentials) {
        currentPollyClient.config.update({
          region: awsConfig.region,
          credentials
        });
      }

      const currentHeartsClient = getHeartsTableClient();
      if (currentHeartsClient && currentHeartsClient.service && credentials) {
        currentHeartsClient.service.config.update({
          region: awsConfig.region,
          credentials
        });
      }

      return true;
    })().catch((error) => {
      console.error("Failed to initialize AWS credentials.", error);
      awsInitPromise = null;
      return false;
    });
  }

  return awsInitPromise;
}

async function getIdentityId() {
  const ready = await ensureAwsCredentials();
  if (!ready) {
    throw new Error("AWS guest credentials are unavailable.");
  }

  const credentials = window.AWS.config.credentials;
  if (!credentials) {
    throw new Error("Missing AWS credentials object.");
  }

  if (!credentials.identityId || credentials.expired) {
    await refreshAwsCredentials();
  }

  if (!credentials.identityId) {
    throw new Error("Could not resolve Cognito identity ID.");
  }

  return credentials.identityId;
}

function hasMeaningText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function toEpochMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortMatchesByTimestampDesc(items) {
  return [...items].sort((a, b) => toEpochMs(b.timestamp) - toEpochMs(a.timestamp));
}

function findNewestNonEmptyMeaningMatch(items) {
  const sorted = sortMatchesByTimestampDesc(items);
  return sorted.find((item) => hasMeaningText(item.meaning)) || null;
}

function logMeaningMatchesFromFullRead(word, matches) {
  const flattened = sortMatchesByTimestampDesc(matches).map((item) => ({
    rowId: item.rowId,
    timestamp: item.timestamp,
    meaning: item.meaning ?? null
  }));

  console.log("Definition lookup used full table read for word.", {
    word,
    matches: flattened
  });
}

async function queryWordMatchesByIndex(word) {
  const currentHeartsTableClient = getHeartsTableClient();
  if (!currentHeartsTableClient) {
    return [];
  }

  const matches = [];
  let lastEvaluatedKey = undefined;

  do {
    const response = await currentHeartsTableClient
      .query({
        TableName: awsConfig.heartsTableName,
        IndexName: awsConfig.heartsWordTimestampIndexName,
        KeyConditionExpression: "#word = :word",
        ExpressionAttributeNames: {
          "#word": "word"
        },
        ExpressionAttributeValues: {
          ":word": word
        },
        ScanIndexForward: false,
        ExclusiveStartKey: lastEvaluatedKey
      })
      .promise();

    if (Array.isArray(response.Items) && response.Items.length > 0) {
      matches.push(...response.Items);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return matches;
}

async function scanWordMatches(word) {
  const currentHeartsTableClient = getHeartsTableClient();
  if (!currentHeartsTableClient) {
    return [];
  }

  const matches = [];
  let lastEvaluatedKey = undefined;

  do {
    const response = await currentHeartsTableClient
      .scan({
        TableName: awsConfig.heartsTableName,
        FilterExpression: "#word = :word",
        ExpressionAttributeNames: {
          "#word": "word",
          "#timestamp": "timestamp"
        },
        ExpressionAttributeValues: {
          ":word": word
        },
        ProjectionExpression: "rowId, #word, #timestamp, meaning",
        ExclusiveStartKey: lastEvaluatedKey
      })
      .promise();

    if (Array.isArray(response.Items) && response.Items.length > 0) {
      matches.push(...response.Items);
    }

    lastEvaluatedKey = response.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return matches;
}

async function lookupLatestDefinitionForWord(word) {
  if (!isHeartsConfigured) {
    return null;
  }

  const ready = await ensureAwsCredentials();
  if (!ready) {
    return null;
  }

  try {
    const indexedMatches = await queryWordMatchesByIndex(word);
    const indexedMatch = findNewestNonEmptyMeaningMatch(indexedMatches);
    const missingMeaningProjection =
      indexedMatches.length > 0 &&
      indexedMatches.some((item) => !Object.prototype.hasOwnProperty.call(item, "meaning"));

    if (missingMeaningProjection) {
      const fallbackMatches = await scanWordMatches(word);
      logMeaningMatchesFromFullRead(word, fallbackMatches);
      return {
        match: findNewestNonEmptyMeaningMatch(fallbackMatches),
        usedFullRead: true,
        matches: fallbackMatches
      };
    }

    return {
      match: indexedMatch,
      usedFullRead: false,
      matches: indexedMatches
    };
  } catch (queryError) {
    console.warn("Word definition index lookup failed; using full table read fallback.", queryError);
    const fallbackMatches = await scanWordMatches(word);
    logMeaningMatchesFromFullRead(word, fallbackMatches);

    return {
      match: findNewestNonEmptyMeaningMatch(fallbackMatches),
      usedFullRead: true,
      matches: fallbackMatches,
      queryError
    };
  }
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

async function createHeartRecord(state) {
  const currentHeartsTableClient = getHeartsTableClient();
  if (!isHeartsConfigured || !currentHeartsTableClient) {
    throw new Error("Hearts persistence is not configured.");
  }

  const now = Date.now();
  state.timestamp = now;
  state.user = state.user || (await getIdentityId());
  state.updatedTimestamp = now;
  state.unheartedTimestamp = null;
  state.hearted = true;

  await currentHeartsTableClient
    .put({
      TableName: awsConfig.heartsTableName,
      Item: buildHeartTableItem(state)
    })
    .promise();

  state.hasPersistedRecord = true;
}

async function updateHeartRecord(state, hearted) {
  const currentHeartsTableClient = getHeartsTableClient();
  if (!isHeartsConfigured || !currentHeartsTableClient) {
    throw new Error("Hearts persistence is not configured.");
  }

  const now = Date.now();
  const unheartedTimestamp = hearted ? null : now;
  state.user = state.user || (await getIdentityId());
  state.hearted = hearted;
  state.updatedTimestamp = now;
  state.unheartedTimestamp = unheartedTimestamp;

  await currentHeartsTableClient
    .put({
      TableName: awsConfig.heartsTableName,
      Item: buildHeartTableItem(state)
    })
    .promise();
}

async function updateMeaningRecord(state, meaning) {
  const currentHeartsTableClient = getHeartsTableClient();
  if (!isHeartsConfigured || !currentHeartsTableClient) {
    throw new Error("Hearts persistence is not configured.");
  }

  state.user = state.user || (await getIdentityId());
  state.meaning = meaning;
  state.updatedTimestamp = Date.now();

  await currentHeartsTableClient
    .put({
      TableName: awsConfig.heartsTableName,
      Item: buildHeartTableItem(state)
    })
    .promise();
}

async function persistHeartedState(state, hearted) {
  if (!state.hasPersistedRecord) {
    if (hearted) {
      await createHeartRecord(state);
    }
    return;
  }

  await updateHeartRecord(state, hearted);
}

function clearSelection() {
  if (!selectedRowId) {
    return;
  }

  const previous = selectedRowId;
  selectedRowId = null;
  renderRow(previous);
}

function buildHeartTableItem(state) {
  return {
    rowId: state.rowId,
    timestamp: state.timestamp,
    user: state.user || null,
    word: state.word,
    pronunciation: state.ipa,
    meaning: state.meaning || null,
    hearted: Boolean(state.hearted),
    updatedTimestamp: state.updatedTimestamp,
    unheartedTimestamp: state.unheartedTimestamp ?? null
  };
}

function stopAudio() {
  sharedAudio.pause();
  sharedAudio.currentTime = 0;
  clearPlayState();
}

function setSelectedRow(rowId) {
  if (!rowId || selectedRowId === rowId) {
    return;
  }

  const previous = selectedRowId;
  selectedRowId = rowId;

  if (playingRowId && playingRowId !== rowId) {
    stopAudio();
  }

  if (previous) {
    renderRow(previous);
  }

  renderRow(rowId);
}

function clearPlayState() {
  if (!playingRowId) {
    return;
  }

  const previous = playingRowId;
  playingRowId = null;
  renderRow(previous);
}

function createActionButton(className, icon, label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-btn ${className}`;
  button.dataset.icon = icon;
  button.dataset.action = action;
  button.textContent = icon;
  button.setAttribute("aria-label", label);
  return button;
}

function createRowState(generated) {
  return {
    rowId: generated.rowId,
    timestamp: generated.timestamp,
    updatedTimestamp: generated.timestamp,
    unheartedTimestamp: null,
    user: "",
    word: generated.word,
    ipa: generated.ipa,
    hearted: false,
    meaning: null,
    draftMeaning: "",
    hasDraftCache: false,
    isEditing: false,
    saveStatus: "idle",
    copyFlash: false,
    hasPersistedRecord: false,
    hasImportedMeaning: false,
    importedSourceRowId: "",
    importedSourceTimestamp: null
  };
}

function createResultRow(state) {
  const item = document.createElement("li");
  item.className = "result-row";
  item.dataset.rowId = state.rowId;
  item.dataset.word = state.word;
  item.dataset.ipa = state.ipa;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const heartButton = createActionButton("heart-btn", "♡", "Save word", "toggle-heart");
  if (!isHeartsConfigured) {
    heartButton.classList.add("is-hidden");
  }

  const copyButton = createActionButton("copy-btn", "⧉", "Copy word details", "copy-word");

  const playButton = createActionButton("play-btn", "▶", "Play pronunciation", "play-pronunciation");
  if (!isPlaybackConfigured) {
    playButton.classList.add("is-hidden");
  }

  actions.append(playButton, heartButton);

  const content = document.createElement("div");
  content.className = "row-content";

  const wordSpan = document.createElement("span");
  wordSpan.className = "word";
  wordSpan.textContent = state.word;

  const ipaSpan = document.createElement("span");
  ipaSpan.className = "ipa";
  ipaSpan.textContent = `/${state.ipa}/`;

  content.append(wordSpan, ipaSpan);

  const meaning = document.createElement("div");
  meaning.className = "row-meaning";

  const copySlot = document.createElement("div");
  copySlot.className = "row-copy";
  copySlot.append(copyButton);

  item.append(actions, content, meaning, copySlot);
  return item;
}

async function hydrateImportedDefinition(rowId) {
  if (!isHeartsConfigured) {
    return;
  }

  const initialState = rowStateById.get(rowId);
  if (!initialState) {
    return;
  }

  try {
    const lookup = await lookupLatestDefinitionForWord(initialState.word);
    if (!lookup || !lookup.match || !hasMeaningText(lookup.match.meaning)) {
      return;
    }

    const currentState = rowStateById.get(rowId);
    if (!currentState) {
      return;
    }

    if (
      currentState.hasPersistedRecord ||
      currentState.hearted ||
      currentState.isEditing ||
      currentState.saveStatus !== "idle" ||
      hasMeaningText(currentState.meaning)
    ) {
      return;
    }

    currentState.meaning = trimOrEmpty(lookup.match.meaning);
    currentState.hasImportedMeaning = true;
    currentState.importedSourceRowId =
      typeof lookup.match.rowId === "string" ? lookup.match.rowId : "";
    currentState.importedSourceTimestamp =
      typeof lookup.match.timestamp !== "undefined" ? lookup.match.timestamp : null;
    currentState.hasDraftCache = false;
    renderRow(rowId);
  } catch (error) {
    console.error("Failed to load imported definition.", error);
  }
}

function renderMeaning(row, state) {
  const container = row.querySelector(".row-meaning");
  if (!container) {
    return;
  }

  container.textContent = "";
  const isSelected = selectedRowId === state.rowId;
  const isSaving = state.saveStatus !== "idle";

  if (state.meaning) {
    const definition = document.createElement("span");
    definition.className = "meaning-definition";
    definition.textContent = `Definition: ${state.meaning}`;
    container.appendChild(definition);
  }

  const canEditMeaning = isHeartsConfigured && (state.hearted || state.hasImportedMeaning);
  if (!canEditMeaning) {
    return;
  }

  if (state.isEditing && isSelected) {
    const editor = document.createElement("div");
    editor.className = "meaning-editor";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "meaning-input";
    input.placeholder = "What does this word mean?";
    input.value = state.draftMeaning;

    const saveButton = createActionButton("meaning-action is-save", "✓", "Save meaning", "save-meaning");
    const cancelButton = createActionButton(
      "meaning-action",
      "✕",
      "Cancel meaning edit",
      "cancel-meaning"
    );

    if (isSaving) {
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

  if (!isSelected) {
    return;
  }

  const link = document.createElement("button");
  link.type = "button";
  link.className = "meaning-link";
  link.dataset.action = "open-meaning-editor";
  link.textContent = state.meaning ? "Edit" : "Add a meaning";
  link.disabled = isSaving;
  container.appendChild(link);
}

function renderRow(rowId) {
  const state = rowStateById.get(rowId);
  const row = resultsList.querySelector(`.result-row[data-row-id="${rowId}"]`);
  if (!state || !row) {
    return;
  }

  row.classList.toggle("is-selected", selectedRowId === rowId);

  const heartButton = row.querySelector(".heart-btn");
  if (heartButton) {
    heartButton.classList.toggle("is-hearted", state.hearted);
    heartButton.textContent = state.hearted ? "❤" : "♡";
    heartButton.setAttribute("aria-label", state.hearted ? "Remove saved word" : "Save word");
    heartButton.disabled = state.saveStatus !== "idle";
  }

  const copyButton = row.querySelector(".copy-btn");
  if (copyButton) {
    copyButton.classList.toggle("is-success", state.copyFlash);
    copyButton.textContent = state.copyFlash ? "✓" : copyButton.dataset.icon;
  }

  const playButton = row.querySelector(".play-btn");
  if (playButton) {
    const isPlaying = playingRowId === rowId;
    playButton.classList.toggle("is-playing", isPlaying);
    playButton.classList.remove("is-loading");
    playButton.textContent = isPlaying ? "■" : playButton.dataset.icon;
  }

  renderMeaning(row, state);
}
function buildCopyPayload(state) {
  if (!state) {
    return "";
  }

  const base = `${state.word} /${state.ipa}/`;
  const meaning = trimOrEmpty(state.meaning);
  return meaning ? `${base} : ${meaning}` : base;
}


function clearCopyFeedback(rowId) {
  const timer = copyFeedbackTimers.get(rowId);
  if (timer) {
    clearTimeout(timer);
    copyFeedbackTimers.delete(rowId);
  }
}

function showCopySuccess(rowId) {
  const state = rowStateById.get(rowId);
  if (!state) {
    return;
  }

  clearCopyFeedback(rowId);
  state.copyFlash = true;
  renderRow(rowId);

  const timer = window.setTimeout(() => {
    const current = rowStateById.get(rowId);
    if (!current) {
      return;
    }

    current.copyFlash = false;
    renderRow(rowId);
    copyFeedbackTimers.delete(rowId);
  }, COPY_FEEDBACK_MS);

  copyFeedbackTimers.set(rowId, timer);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }

  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.top = "-9999px";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  document.body.removeChild(helper);
}

async function playPronunciation(rowId) {
  if (!isPlaybackConfigured) {
    return;
  }

  const state = rowStateById.get(rowId);
  const row = resultsList.querySelector(`.result-row[data-row-id="${rowId}"]`);
  if (!state || !row) {
    return;
  }

  const button = row.querySelector(".play-btn");
  if (!button || button.classList.contains("is-hidden")) {
    return;
  }

  if (playingRowId === rowId && !sharedAudio.paused) {
    stopAudio();
    return;
  }

  if (playingRowId && playingRowId !== rowId) {
    stopAudio();
  }

  button.classList.add("is-loading");
  button.textContent = "…";

  try {
    const audioUrl = await synthesize(state.word, state.ipa);
    if (!audioUrl) {
      button.classList.remove("is-loading");
      button.textContent = button.dataset.icon;
      return;
    }

    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    sharedAudio.src = audioUrl;

    await sharedAudio.play();

    playingRowId = rowId;
    renderRow(rowId);
  } catch (error) {
    button.classList.remove("is-loading");
    button.textContent = button.dataset.icon;
    console.error("Failed to synthesize or play pronunciation.", error);
  }
}

async function handleToggleHeart(rowId) {
  const state = rowStateById.get(rowId);
  if (!state || !isHeartsConfigured) {
    return;
  }

  const previousHearted = state.hearted;
  const previousEditing = state.isEditing;

  if (state.hearted) {
    state.hearted = false;
  } else {
    state.hearted = true;
  }
  const turnedOn = !previousHearted && state.hearted;

  state.isEditing = false;
  state.saveStatus = "saving-heart";
  renderRow(rowId);

  try {
    await persistHeartedState(state, state.hearted);
    if (turnedOn && state.hasImportedMeaning) {
      state.hasImportedMeaning = false;
      state.importedSourceRowId = "";
      state.importedSourceTimestamp = null;
    }
  } catch (error) {
    state.hearted = previousHearted;
    state.isEditing = previousEditing;
    console.error("Failed to persist heart state.", error);
  } finally {
    state.saveStatus = "idle";
    renderRow(rowId);
  }
}

function openMeaningEditor(rowId) {
  const state = rowStateById.get(rowId);
  if (!state || !isHeartsConfigured || (!state.hearted && !state.hasImportedMeaning)) {
    return;
  }

  if (!state.hasDraftCache) {
    state.draftMeaning = state.meaning || "";
    state.hasDraftCache = true;
  }

  state.isEditing = true;
  renderRow(rowId);
}

function closeMeaningEditor(rowId) {
  const state = rowStateById.get(rowId);
  if (!state) {
    return;
  }

  state.isEditing = false;
  renderRow(rowId);
}

async function handleSaveMeaning(rowId) {
  const state = rowStateById.get(rowId);
  if (!state || !isHeartsConfigured || (!state.hearted && !state.hasImportedMeaning)) {
    return;
  }

  const trimmedMeaning = trimOrEmpty(state.draftMeaning);
  if (!trimmedMeaning) {
    closeMeaningEditor(rowId);
    return;
  }

  const previousMeaning = state.meaning;
  const previousEditing = state.isEditing;
  const previousHearted = state.hearted;
  const previousImportedMeaning = state.hasImportedMeaning;
  const previousImportedSourceRowId = state.importedSourceRowId;
  const previousImportedSourceTimestamp = state.importedSourceTimestamp;

  const importedMeaningSave = state.hasImportedMeaning && !state.hasPersistedRecord;
  state.meaning = trimmedMeaning;
  state.draftMeaning = trimmedMeaning;
  state.hasDraftCache = true;
  state.isEditing = false;
  if (importedMeaningSave) {
    state.hearted = true;
  }
  state.saveStatus = "saving-meaning";
  renderRow(rowId);

  try {
    let createdNewRecord = false;
    if (!state.hasPersistedRecord) {
      await persistHeartedState(state, true);
      createdNewRecord = true;
    }

    if (!createdNewRecord) {
      await updateMeaningRecord(state, trimmedMeaning);
    }

    if (importedMeaningSave) {
      state.hasImportedMeaning = false;
      state.importedSourceRowId = "";
      state.importedSourceTimestamp = null;
    }
  } catch (error) {
    state.meaning = previousMeaning;
    state.isEditing = previousEditing;
    state.hearted = previousHearted;
    state.hasImportedMeaning = previousImportedMeaning;
    state.importedSourceRowId = previousImportedSourceRowId;
    state.importedSourceTimestamp = previousImportedSourceTimestamp;
    console.error("Failed to save meaning.", error);
  } finally {
    state.saveStatus = "idle";
    renderRow(rowId);
  }
}

function handleMeaningInput(event) {
  const input = event.target.closest(".meaning-input");
  if (!input) {
    return;
  }

  const row = input.closest(".result-row");
  if (!row) {
    return;
  }

  const state = rowStateById.get(row.dataset.rowId);
  if (!state) {
    return;
  }

  state.draftMeaning = input.value;
  state.hasDraftCache = true;
}

function handleMeaningInputKeydown(event) {
  const input = event.target.closest(".meaning-input");
  if (!input) {
    return;
  }

  const row = input.closest(".result-row");
  if (!row) {
    return;
  }

  const rowId = row.dataset.rowId;
  if (!rowId) {
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    void handleSaveMeaning(rowId);
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeMeaningEditor(rowId);
  }
}

const ruleEngine = new RuleEngine();
const poolManager = new PoolManager(vowels, consonants);

function addWordRule(triggerSymbol, blockedNextSymbols) {
  ruleEngine.addWordRule(triggerSymbol, blockedNextSymbols);
}

function addSyllableRule(triggerSymbol, blockedNextSymbols) {
  ruleEngine.addSyllableRule(triggerSymbol, blockedNextSymbols);
}

function addBoundaryRule(triggerSymbol, blockedNextSymbols) {
  ruleEngine.addBoundaryRule(triggerSymbol, blockedNextSymbols);
}

function addWordEndBan(symbol) {
  ruleEngine.addWordEndBan(symbol);
}

function addSyllableEndBan(symbol) {
  ruleEngine.addSyllableEndBan(symbol);
}

addSyllableEndBan("y");
addSyllableEndBan("ñ");
addSyllableEndBan("j");

function buildWord(min, max) {
  const syllableCount = Math.floor(Math.random() * (max - min + 1)) + min;
  const syllablePatterns = [];
  for (let i = 0; i < syllableCount; i += 1) {
    syllablePatterns.push(buildSyllablePattern(i, syllableCount));
  }

  const slots = buildWordSlots(syllablePatterns);
  const symbolsBySyllable = Array.from({ length: syllableCount }, () => []);
  const ipaBySyllable = Array.from({ length: syllableCount }, () => []);
  const symbols = [];

  poolManager.resetWordAttempt();

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    let candidates = poolManager.getCandidates(slot.type);
    const slotEndsSyllable =
      slot.relationToNext === RELATIONS.BOUNDARY || slot.relationToNext === RELATIONS.NONE;

    if (slotEndsSyllable) {
      candidates = candidates.filter((candidate) => !ruleEngine.isSyllableEndBanned(candidate.symbol));
    }

    if (candidates.length === 0) {
      poolManager.resetWordAttempt();
      return null;
    }

    const selected = randomFrom(candidates);
    symbols.push(selected.symbol);
    symbolsBySyllable[slot.syllableIndex].push(selected.symbol);
    ipaBySyllable[slot.syllableIndex].push(selected.ipa);

    poolManager.restorePendingRestrictions();

    const nextSlot = slots[i + 1];
    if (nextSlot) {
      const blockedSymbols = ruleEngine.resolveBlockedNextSymbols(selected.symbol, slot.relationToNext);
      poolManager.applyNextPickRestrictions(nextSlot.type, blockedSymbols);
    }
  }

  poolManager.resetWordAttempt();

  const lastSymbol = symbols[symbols.length - 1];
  if (ruleEngine.isWordEndBanned(lastSymbol)) {
    return null;
  }

  return {
    rowId: createRowId(),
    timestamp: Date.now(),
    word: symbolsBySyllable.map((syllable) => syllable.join("")).join(""),
    ipa: ipaBySyllable.map((syllable) => syllable.join("")).join("."),
    symbols,
    syllables: symbolsBySyllable.map((syllable) => [...syllable])
  };
}

function generateUniqueWord(min, max) {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    const candidate = buildWord(min, max);
    if (candidate && !generatedWords.has(candidate.word)) {
      return candidate;
    }
  }

  return null;
}

function removeOldestRowsIfNeeded() {
  while (resultsList.children.length > MAX_RESULTS) {
    const oldest = resultsList.lastElementChild;
    if (!oldest) {
      break;
    }

    const oldestWord = oldest.dataset.word;
    const oldestRowId = oldest.dataset.rowId;

    if (oldestWord) {
      generatedWords.delete(oldestWord);
    }

    if (oldestRowId) {
      if (selectedRowId === oldestRowId) {
        selectedRowId = null;
      }

      if (playingRowId === oldestRowId) {
        stopAudio();
      }

      clearCopyFeedback(oldestRowId);
      rowStateById.delete(oldestRowId);
    }

    oldest.remove();
  }
}

function addResult() {
  const { min, max } = clampSyllables();
  const generated = generateUniqueWord(min, max);

  if (!generated) {
    return;
  }

  const state = createRowState(generated);
  rowStateById.set(state.rowId, state);

  const row = createResultRow(state);
  resultsList.prepend(row);
  generatedWords.add(generated.word);
  renderRow(state.rowId);
  void hydrateImportedDefinition(state.rowId);

  removeOldestRowsIfNeeded();
}

async function handleResultListClick(event) {
  const row = event.target.closest(".result-row");
  if (!row || !resultsList.contains(row)) {
    return;
  }

  const rowId = row.dataset.rowId;
  if (!rowId || !rowStateById.has(rowId)) {
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    event.preventDefault();
    event.stopPropagation();
  }

  setSelectedRow(rowId);

  if (!actionButton) {
    return;
  }

  const action = actionButton.dataset.action;

  if (action === "toggle-heart") {
    await handleToggleHeart(rowId);
    return;
  }

  if (action === "copy-word") {
    try {
      const state = rowStateById.get(rowId);
      const fallbackWord = row.dataset.word || "";
      const fallbackIpa = row.dataset.ipa || "";
      const text = state
        ? buildCopyPayload(state)
        : fallbackWord && fallbackIpa
          ? `${fallbackWord} /${fallbackIpa}/`
          : fallbackWord;
      await copyTextToClipboard(text);
      showCopySuccess(rowId);
    } catch (error) {
      console.error("Copy failed.", error);
    }
    return;
  }

  if (action === "play-pronunciation") {
    await playPronunciation(rowId);
    return;
  }

  if (action === "open-meaning-editor") {
    openMeaningEditor(rowId);
    return;
  }

  if (action === "save-meaning") {
    await handleSaveMeaning(rowId);
    return;
  }

  if (action === "cancel-meaning") {
    closeMeaningEditor(rowId);
  }
}

sharedAudio.addEventListener("ended", () => clearPlayState());
sharedAudio.addEventListener("error", () => clearPlayState());

resultsList.addEventListener("click", (event) => {
  void handleResultListClick(event);
});

resultsList.addEventListener("input", handleMeaningInput);
resultsList.addEventListener("keydown", handleMeaningInputKeydown);

document.addEventListener("click", (event) => {
  if (event.target.closest(".result-row")) {
    return;
  }

  clearSelection();
});

minInput.addEventListener("change", clampSyllables);
maxInput.addEventListener("change", clampSyllables);
generateBtn.addEventListener("click", addResult);
