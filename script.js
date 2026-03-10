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
  { symbol: "ch", ipa: "tʃ" },
  { symbol: "x", ipa: "ʃ" },
  { symbol: "ñ", ipa: "ɲ" },
  { symbol: "y", ipa: "j" },
  { symbol: "t", ipa: "t͡s" }
];

const MAX_RESULTS = 50;
const RETRY_LIMIT = 100;

const minInput = document.getElementById("minSyllables");
const maxInput = document.getElementById("maxSyllables");
const generateBtn = document.getElementById("generateBtn");
const resultsList = document.getElementById("results");
const generatedWords = new Set();

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function buildSyllable(type) {
  const v = randomFrom(vowels);
  const c1 = randomFrom(consonants);
  const c2 = randomFrom(consonants);

  if (type === "V") {
    return { text: v.symbol, ipa: v.ipa };
  }

  if (type === "CV") {
    return { text: c1.symbol + v.symbol, ipa: c1.ipa + v.ipa };
  }

  return { text: c1.symbol + v.symbol + c2.symbol, ipa: c1.ipa + v.ipa + c2.ipa };
}

function chooseSyllableType(position, total) {
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

function generateWord(min, max) {
  const syllableCount = Math.floor(Math.random() * (max - min + 1)) + min;
  const syllables = [];

  for (let i = 0; i < syllableCount; i += 1) {
    const type = chooseSyllableType(i, syllableCount);
    syllables.push(buildSyllable(type));
  }

  return {
    word: syllables.map((s) => s.text).join(""),
    ipa: syllables.map((s) => s.ipa).join(".")
  };
}

function endsWithForbiddenFinalSymbol(word) {
  return word.endsWith("y") || word.endsWith("ñ");
}

function generateUniqueWord(min, max) {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
    const candidate = generateWord(min, max);
    if (!generatedWords.has(candidate.word) && !endsWithForbiddenFinalSymbol(candidate.word)) {
      return candidate;
    }
  }

  return null;
}

function addResult() {
  const { min, max } = clampSyllables();
  const generated = generateUniqueWord(min, max);

  if (!generated) {
    return;
  }

  const item = document.createElement("li");
  const wordSpan = document.createElement("span");
  const ipaSpan = document.createElement("span");

  item.dataset.word = generated.word;

  wordSpan.className = "word";
  wordSpan.textContent = generated.word;

  ipaSpan.className = "ipa";
  ipaSpan.textContent = `/${generated.ipa}/`;

  item.appendChild(wordSpan);
  item.appendChild(ipaSpan);
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

    oldest.remove();
  }
}

minInput.addEventListener("change", clampSyllables);
maxInput.addEventListener("change", clampSyllables);
generateBtn.addEventListener("click", addResult);
