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
  { symbol: "r", ipa: "ɾ" },
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
  { symbol: "t", ipa: "t͡s" }
];

const MAX_RESULTS = 50;
const RETRY_LIMIT = 100;
const DEFAULT_VOICE_ID = "Joanna";
const DEFAULT_ENGINE = "neural";
const DEFAULT_OUTPUT_FORMAT = "mp3";
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

const audioCache = new Map();
const sharedAudio = new Audio();
const copyFeedbackTimers = new WeakMap();

let selectedRow = null;
let activePlayButton = null;

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

class RuleEngine {
  constructor() {
    this.transitionRules = [];
    this.wordEndBans = new Set();
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

function normalizeAwsConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object") {
    return null;
  }

  const region = typeof rawConfig.region === "string" ? rawConfig.region.trim() : "";
  const identityPoolId =
    typeof rawConfig.identityPoolId === "string" ? rawConfig.identityPoolId.trim() : "";

  if (!region || !identityPoolId) {
    return null;
  }

  const voiceId =
    typeof rawConfig.voiceId === "string" && rawConfig.voiceId.trim()
      ? rawConfig.voiceId.trim()
      : DEFAULT_VOICE_ID;
  const engine =
    typeof rawConfig.engine === "string" && rawConfig.engine.trim()
      ? rawConfig.engine.trim()
      : DEFAULT_ENGINE;
  const outputFormat =
    typeof rawConfig.outputFormat === "string" && rawConfig.outputFormat.trim()
      ? rawConfig.outputFormat.trim()
      : DEFAULT_OUTPUT_FORMAT;

  return { region, identityPoolId, voiceId, engine, outputFormat };
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

function createPollyService() {
  const awsConfig = normalizeAwsConfig(window.LOVE_LANGUAGE_AWS_CONFIG);
  const hasAwsSdk =
    typeof window.AWS !== "undefined" &&
    typeof window.AWS.Polly !== "undefined" &&
    typeof window.AWS.CognitoIdentityCredentials !== "undefined";

  if (!awsConfig || !hasAwsSdk) {
    return {
      enabled: false,
      synthesize: async () => null
    };
  }

  window.AWS.config.update({ region: awsConfig.region });
  window.AWS.config.credentials = new window.AWS.CognitoIdentityCredentials({
    IdentityPoolId: awsConfig.identityPoolId
  });

  const polly = new window.AWS.Polly({
    apiVersion: "2016-06-10",
    region: awsConfig.region
  });

  async function synthesize(word, ipa) {
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

    const params = {
      OutputFormat: awsConfig.outputFormat,
      TextType: "ssml",
      Text: ssml,
      VoiceId: awsConfig.voiceId,
      Engine: awsConfig.engine
    };

    const data = await polly.synthesizeSpeech(params).promise();
    const audioBlob = toAudioBlob(data.AudioStream, awsConfig.outputFormat);
    if (!audioBlob) {
      throw new Error("Polly returned an unsupported audio stream payload.");
    }

    const objectUrl = URL.createObjectURL(audioBlob);
    audioCache.set(cacheKey, objectUrl);
    return objectUrl;
  }

  return {
    enabled: true,
    synthesize
  };
}

function clearSelection() {
  if (selectedRow) {
    selectedRow.classList.remove("is-selected");
    selectedRow = null;
  }
}

function selectRow(row) {
  if (selectedRow === row) {
    return;
  }

  clearSelection();
  selectedRow = row;
  selectedRow.classList.add("is-selected");
}

function resetButtonIcon(button) {
  if (button && button.dataset.icon) {
    button.textContent = button.dataset.icon;
  }
}

function clearPlayState(button = activePlayButton) {
  if (!button) {
    return;
  }

  button.classList.remove("is-loading", "is-playing");
  resetButtonIcon(button);

  if (button === activePlayButton) {
    activePlayButton = null;
  }
}

function createActionButton(className, icon, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-btn ${className}`;
  button.dataset.icon = icon;
  button.textContent = icon;
  button.setAttribute("aria-label", label);
  return button;
}

function createResultRow(generated, playbackEnabled) {
  const item = document.createElement("li");
  item.className = "result-row";
  item.dataset.word = generated.word;
  item.dataset.ipa = generated.ipa;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const copyButton = createActionButton("copy-btn", "⧉", "Copy symbols");
  const playButton = createActionButton("play-btn", "▶", "Play pronunciation");
  if (!playbackEnabled) {
    playButton.classList.add("is-hidden");
  }

  actions.append(copyButton, playButton);

  const content = document.createElement("div");
  content.className = "row-content";

  const wordSpan = document.createElement("span");
  wordSpan.className = "word";
  wordSpan.textContent = generated.word;

  const ipaSpan = document.createElement("span");
  ipaSpan.className = "ipa";
  ipaSpan.textContent = `/${generated.ipa}/`;

  content.append(wordSpan, ipaSpan);
  item.append(actions, content);
  return item;
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

function showCopySuccess(button) {
  const priorTimer = copyFeedbackTimers.get(button);
  if (priorTimer) {
    clearTimeout(priorTimer);
  }

  button.classList.add("is-success");
  button.textContent = "✓";

  const timer = window.setTimeout(() => {
    button.classList.remove("is-success");
    resetButtonIcon(button);
    copyFeedbackTimers.delete(button);
  }, COPY_FEEDBACK_MS);

  copyFeedbackTimers.set(button, timer);
}

const ruleEngine = new RuleEngine();
const poolManager = new PoolManager(vowels, consonants);
const pollyService = createPollyService();

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

addWordEndBan("y");
addWordEndBan("ñ");
addSyllableRule("o", ["r"]);

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
    const candidates = poolManager.getCandidates(slot.type);
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

async function playPronunciation(row, button) {
  if (!pollyService.enabled || button.classList.contains("is-hidden")) {
    return;
  }

  if (activePlayButton === button && !sharedAudio.paused) {
    sharedAudio.pause();
    sharedAudio.currentTime = 0;
    clearPlayState(button);
    return;
  }

  if (activePlayButton && activePlayButton !== button) {
    clearPlayState(activePlayButton);
  }

  sharedAudio.pause();
  sharedAudio.currentTime = 0;

  button.classList.add("is-loading");
  button.textContent = "…";

  try {
    const word = row.dataset.word || "";
    const ipa = row.dataset.ipa || "";
    const audioUrl = await pollyService.synthesize(word, ipa);
    if (!audioUrl) {
      clearPlayState(button);
      return;
    }

    sharedAudio.src = audioUrl;
    await sharedAudio.play();

    button.classList.remove("is-loading");
    button.classList.add("is-playing");
    button.textContent = "■";
    activePlayButton = button;
  } catch (error) {
    clearPlayState(button);
    console.error("Failed to synthesize or play pronunciation.", error);
  }
}

async function handleResultListClick(event) {
  const row = event.target.closest(".result-row");
  if (!row || !resultsList.contains(row)) {
    return;
  }

  selectRow(row);

  const actionButton = event.target.closest(".action-btn");
  if (!actionButton) {
    return;
  }

  if (actionButton.classList.contains("copy-btn")) {
    try {
      await copyTextToClipboard(row.dataset.word || "");
      showCopySuccess(actionButton);
    } catch (error) {
      console.error("Copy failed.", error);
    }
    return;
  }

  if (actionButton.classList.contains("play-btn")) {
    await playPronunciation(row, actionButton);
  }
}

function addResult() {
  const { min, max } = clampSyllables();
  const generated = generateUniqueWord(min, max);

  if (!generated) {
    return;
  }

  const item = createResultRow(generated, pollyService.enabled);
  resultsList.prepend(item);
  generatedWords.add(generated.word);

  while (resultsList.children.length > MAX_RESULTS) {
    const oldest = resultsList.lastElementChild;
    if (!oldest) {
      break;
    }

    const oldestWord = oldest.dataset.word;
    if (oldestWord) {
      generatedWords.delete(oldestWord);
    }

    if (selectedRow === oldest) {
      clearSelection();
    }

    if (activePlayButton && oldest.contains(activePlayButton)) {
      sharedAudio.pause();
      sharedAudio.currentTime = 0;
      clearPlayState(activePlayButton);
    }

    oldest.remove();
  }
}

sharedAudio.addEventListener("ended", () => clearPlayState());
sharedAudio.addEventListener("error", () => clearPlayState());

resultsList.addEventListener("click", (event) => {
  void handleResultListClick(event);
});

document.addEventListener("click", (event) => {
  if (resultsList.contains(event.target)) {
    return;
  }

  clearSelection();
});

minInput.addEventListener("change", clampSyllables);
maxInput.addEventListener("change", clampSyllables);
generateBtn.addEventListener("click", addResult);
