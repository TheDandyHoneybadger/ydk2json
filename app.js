const YGOPRODECK_API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const CACHE_KEY = "ydke-web-konami-cache-v2";
const NAME_DB_CACHE_KEY = "ydke-web-name-db-v1";
const NAME_DB_VERSION = 1;
const NAME_DB_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;
const REQUEST_DELAY_MS = 120;
const MAX_RETRIES = 3;
const ALWAYS_INCLUDED_SECTIONS = ["main", "extra", "side"];
const NAME_DB_LANGUAGES = [
  { code: "en", label: "English", apiCode: null },
  { code: "pt", label: "Portuguese", apiCode: "pt" },
];

const EXTRA_TYPES = new Set([
  "fusion monster",
  "synchro monster",
  "xyz monster",
  "link monster",
  "synchro tuner monster",
  "synchro pendulum effect monster",
  "xyz pendulum effect monster",
  "fusion pendulum effect monster",
]);

const $ = (selector) => document.querySelector(selector);
const on = (element, eventName, handler) => {
  if (element) element.addEventListener(eventName, handler);
};
const valueOf = (element, fallback = "") => {
  if (!element || !("value" in element)) return fallback;
  return element.value;
};
const setValue = (element, value) => {
  if (element && "value" in element) element.value = value;
};
const setText = (element, value) => {
  if (element) element.textContent = value;
};

const state = {
  lastJson: "",
  lastDeckName: "My Deck",
  cache: loadCache(),
  nameDb: loadNameDbCache(),
  nameIndex: null,
  nameCandidates: null,
  englishByPasscode: null,
};

const els = {
  form: $("#converterForm"),
  deckName: $("#deckName"),
  deckInput: $("#deckInput"),
  ydkFile: $("#ydkFile"),
  imageFile: $("#imageFile"),
  dropZone: $("#dropZone"),
  imageDropZone: $("#imageDropZone"),
  output: $("#output"),
  log: $("#log"),
  summary: $("#summary"),
  statusPill: $("#statusPill"),
  convertBtn: $("#convertBtn"),
  clearBtn: $("#clearBtn"),
  copyBtn: $("#copyBtn"),
  downloadBtn: $("#downloadBtn"),
};

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state.cache));
  } catch (error) {
    log(`⚠ Could not save the local cache: ${error.message}`);
  }
}

function loadNameDbCache() {
  try {
    const raw = localStorage.getItem(NAME_DB_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.version !== NAME_DB_VERSION || !parsed.langs) return { version: NAME_DB_VERSION, langs: {} };
    return parsed;
  } catch {
    return { version: NAME_DB_VERSION, langs: {} };
  }
}

function saveNameDbCache() {
  try {
    localStorage.setItem(NAME_DB_CACHE_KEY, JSON.stringify(state.nameDb));
  } catch (error) {
    log(`⚠ Could not save the card-name database locally: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  const now = new Date().toLocaleTimeString("en-US", { hour12: false });
  if (!els.log) return;
  els.log.textContent += `[${now}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(message, mode = "ready") {
  setText(els.statusPill, message);
  els.statusPill?.classList.toggle("busy", mode === "busy");
  els.statusPill?.classList.toggle("error", mode === "error");
}

function setSummary(message, mode = "ready") {
  setText(els.summary, message);
  els.summary?.classList.toggle("error", mode === "error");
  els.summary?.classList.toggle("warn", mode === "warn");
}

function setBusy(isBusy, label = "Converting...") {
  if (!els.convertBtn) return;
  els.convertBtn.disabled = isBusy;
  els.convertBtn.textContent = isBusy ? label : "Convert deck";
}

function safeDecodeURIComponent(text) {
  try {
    return text.includes("%") ? decodeURIComponent(text) : text;
  } catch {
    return text;
  }
}

function normalizeBase64(text) {
  let clean = safeDecodeURIComponent(text.trim()).replace(/-/g, "+").replace(/_/g, "/");
  while (clean.length % 4 !== 0) clean += "=";
  return clean;
}

function decodeYdke(url) {
  const trimmed = url.trim();
  if (!trimmed.startsWith("ydke://")) {
    throw new Error("The YDKE code must start with ydke://");
  }

  const payload = trimmed.slice("ydke://".length);
  const parts = payload.split("!");
  while (parts.length < 3) parts.push("");

  const sections = { main: [], extra: [], side: [] };

  ALWAYS_INCLUDED_SECTIONS.forEach((name, index) => {
    const segment = parts[index] || "";
    if (!segment) return;

    const binary = atob(normalizeBase64(segment));
    if (binary.length % 4 !== 0) {
      throw new Error(`The ${name} YDKE section is invalid: byte length is not a multiple of 4.`);
    }

    for (let i = 0; i < binary.length; i += 4) {
      const value =
        binary.charCodeAt(i) |
        (binary.charCodeAt(i + 1) << 8) |
        (binary.charCodeAt(i + 2) << 16) |
        (binary.charCodeAt(i + 3) << 24);
      sections[name].push(value >>> 0);
    }
  });

  return sections;
}

function parseYdk(text) {
  const sections = { main: [], extra: [], side: [] };
  let current = "main";

  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.toLowerCase().startsWith("created by")) return;

    const low = line.toLowerCase();
    if (low === "#main" || low === "#deck") current = "main";
    else if (low === "#extra") current = "extra";
    else if (low === "!side" || low === "#side") current = "side";
    else if (line.startsWith("#")) return;
    else if (/^\d+$/.test(line)) sections[current].push(Number(line));
  });

  return sections;
}

function normalizeCardName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[’‘`´]/g, "'")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCardNameText(name) {
  return String(name || "")
    .replace(/[“”]/g, '"')
    .replace(/[’‘`´]/g, "'")
    .replace(/\s*<<<.*$/i, "")
    .replace(/\s*>>>.*$/i, "")
    .replace(/[|¦]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-–—:]+\s*/, "")
    .replace(/\s*[-–—:]+$/, "")
    .trim();
}

function ignoreDeckListLine(line) {
  const low = normalizeCardName(line);
  if (!low) return true;
  return [
    "please write",
    "please include",
    "full name",
    "konami player",
    "judge use",
    "judge initial",
    "infraction",
    "description",
    "date",
    "event",
    "deck list checked",
    "last initial",
    "main deck total",
    "total no",
    "total in",
    "cards de monstros",
    "cards de magia",
    "cards de armadilha",
    "cards de monstruos",
    "deck adicional",
    "deck auxiliar",
    "monster cards",
    "spell cards",
    "trap cards",
    "extra deck",
    "side deck",
  ].some((needle) => low.includes(needle));
}

function sectionHeaderForLine(line) {
  const clean = normalizeCardName(line.replace(/^#+|^!+/, ""));
  if (!clean) return undefined;
  if (["monsters", "monster", "monster cards", "cards de monstros", "cards de monstruos"].includes(clean)) return "Monsters";
  if (["spells", "spell", "spell cards", "cards de magia"].includes(clean)) return "Spells";
  if (["traps", "trap", "trap cards", "cards de armadilha"].includes(clean)) return "Traps";
  if (["extra", "extra deck", "deck adicional", "additional deck"].includes(clean)) return "Extra";
  if (["side", "side deck", "deck auxiliar", "auxiliary deck"].includes(clean)) return "Side";
  if (["main", "main deck", "deck"].includes(clean)) return null;
  return undefined;
}

function parseQtyToken(token) {
  const clean = String(token || "").trim().replace(/[|Il]/g, "1").replace(/[oO]/g, "0");
  if (!/^[1-3]$/.test(clean)) return null;
  return Number(clean);
}

function parseCountedItemLine(rawLine) {
  const line = String(rawLine || "").replace(/\t/g, " ").replace(/\s+/g, " ").trim();
  if (!line || ignoreDeckListLine(line)) return null;

  const match = line.match(/^([1-3]|[|Il])\s+(.+)$/);
  if (!match) return null;

  const quantity = parseQtyToken(match[1]);
  const name = cleanCardNameText(match[2]);
  if (!quantity || !name || name.length < 3 || ignoreDeckListLine(name)) return null;
  return { quantity, name };
}

function parseNamedDeckList(text) {
  const entries = [];
  let currentTarget = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = sectionHeaderForLine(line);
    if (header !== undefined) {
      currentTarget = header;
      continue;
    }

    const item = parseCountedItemLine(line);
    if (!item) continue;
    entries.push({
      quantity: item.quantity,
      rawName: item.name,
      target: currentTarget,
    });
  }

  return entries;
}

function detectAndParse(input) {
  const text = input.trim();
  if (!text) throw new Error("Paste a YDKE code, import a .ydk file, paste a deck list, or read a deck list image first.");

  if (text.startsWith("ydke://")) {
    return { kind: "ids", sections: decodeYdke(text) };
  }

  const ydkeOrYdkSections = parseYdk(text);
  const idTotal = getAllIds(ydkeOrYdkSections).length;
  const namedEntries = parseNamedDeckList(text);

  if (namedEntries.length > 0 && idTotal === 0) {
    return { kind: "names", entries: namedEntries };
  }

  if (idTotal > 0) {
    return { kind: "ids", sections: ydkeOrYdkSections };
  }

  if (namedEntries.length > 0) {
    return { kind: "names", entries: namedEntries };
  }

  throw new Error("No valid cards were found. Use YDKE, .ydk passcodes, or lines like '3 Card Name'.");
}

function getAllIds(sections) {
  return ALWAYS_INCLUDED_SECTIONS.flatMap((section) => sections[section] || []);
}

async function fetchJsonWithRetries(url, errorPrefix) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`${errorPrefix}: ${error.message}`);
      }
      log(`Attempt ${attempt} failed. Retrying...`);
      await sleep(800);
    }
  }
}

async function fetchBatch(ids) {
  const found = {};
  const chunkSize = 100;

  for (let start = 0; start < ids.length; start += chunkSize) {
    const chunk = ids.slice(start, start + chunkSize);
    const url = new URL(YGOPRODECK_API);
    url.searchParams.set("id", chunk.join(","));
    url.searchParams.set("misc", "yes");
    url.searchParams.set("includeAliased", "yes");

    log(`YGOPRODECK: ${chunk.length} card(s) [${start + 1}-${start + chunk.length} of ${ids.length}]`);

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        if (response.status === 404) {
          log("⚠ The API did not find one or more cards in this batch.");
          success = true;
          break;
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        for (const card of payload.data || []) {
          const misc = Array.isArray(card.misc_info) ? card.misc_info[0] : null;
          found[card.id] = {
            name: card.name,
            card_type: String(card.type || "monster").toLowerCase(),
            konami_id: misc?.konami_id ?? null,
          };
        }
        success = true;
        break;
      } catch (error) {
        if (attempt === MAX_RETRIES) {
          throw new Error(
            `Could not reach YGOPRODECK: ${error.message}. If this is running on GitHub Pages, also check your connection, ad blocker, or browser CORS/network restrictions.`
          );
        }
        log(`Attempt ${attempt} failed. Retrying...`);
        await sleep(800);
      }
    }

    if (!success) log("⚠ Batch skipped because the API failed.");
    await sleep(REQUEST_DELAY_MS);
  }

  return found;
}

async function resolveBulk(ids) {
  const uniqueIds = Array.from(new Set(ids));
  const missing = [];

  for (const id of uniqueIds) {
    const cached = state.cache[String(id)];
    if (!cached || cached.konami_id === undefined || cached.konami_id === null) missing.push(id);
  }

  if (missing.length) {
    const fetched = await fetchBatch(missing);
    for (const id of missing) {
      if (fetched[id]) {
        state.cache[String(id)] = fetched[id];
      } else {
        state.cache[String(id)] = {
          name: `Unknown(${id})`,
          card_type: "monster",
          konami_id: null,
        };
      }
    }
    saveCache();
  } else {
    log(`Local cache: ${uniqueIds.length} card(s) already resolved.`);
  }

  return ids.map((id) => state.cache[String(id)]);
}

function resolve(id) {
  return state.cache[String(id)] || { name: `Unknown(${id})`, card_type: "monster", konami_id: null };
}

function cardSection(cardType, ydkeSection) {
  const type = String(cardType || "").toLowerCase();
  if (ydkeSection === "side") return "Side";
  if (ydkeSection === "extra" || EXTRA_TYPES.has(type)) return "Extra";
  if (type.includes("spell")) return "Spells";
  if (type.includes("trap")) return "Traps";
  return "Monsters";
}

function requireKonamiId(info, passcodeOrName) {
  if (info.konami_id === null || info.konami_id === undefined) {
    const name = info.name || String(passcodeOrName);
    throw new Error(
      `YGOPRODECK did not return a konami_id for '${name}' (${passcodeOrName}). ` +
      "CardDatabaseId must use the exact Konami ID. Try again later if this card already exists in the official database."
    );
  }
  return Number(info.konami_id);
}

async function buildDracotailJson(sections, deckName) {
  const allIds = getAllIds(sections);
  await resolveBulk(allIds);

  const counts = new Map();
  for (const ydkeSection of ALWAYS_INCLUDED_SECTIONS) {
    for (const passcode of sections[ydkeSection] || []) {
      const info = resolve(passcode);
      const label = cardSection(info.card_type, ydkeSection);
      const key = `${label}:${passcode}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const result = emptyResult(deckName);
  const seen = new Set();

  for (const ydkeSection of ALWAYS_INCLUDED_SECTIONS) {
    for (const passcode of sections[ydkeSection] || []) {
      const info = resolve(passcode);
      const label = cardSection(info.card_type, ydkeSection);
      const key = `${label}:${passcode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result[label].push({
        CardDatabaseId: requireKonamiId(info, passcode),
        Quantity: counts.get(key),
      });
    }
  }

  return result;
}

function emptyResult(deckName) {
  return {
    Name: deckName || "My Deck",
    Monsters: [],
    Spells: [],
    Traps: [],
    Side: [],
    Extra: [],
  };
}

function isNameDbFresh(langData) {
  return langData?.cards?.length && langData.fetchedAt && Date.now() - langData.fetchedAt < NAME_DB_MAX_AGE_MS;
}

async function fetchLanguageDatabase(lang) {
  const url = new URL(YGOPRODECK_API);
  url.searchParams.set("misc", "yes");
  url.searchParams.set("includeAliased", "yes");
  if (lang.apiCode) url.searchParams.set("language", lang.apiCode);

  log(`Loading ${lang.label} card-name database from YGOPRODECK...`);
  const payload = await fetchJsonWithRetries(url, `Could not load ${lang.label} card-name database`);
  const cards = (payload.data || []).map((card) => {
    const misc = Array.isArray(card.misc_info) ? card.misc_info[0] : null;
    return {
      id: Number(card.id),
      name: card.name,
      type: String(card.type || "monster").toLowerCase(),
      konami_id: misc?.konami_id ?? null,
    };
  }).filter((card) => card.id && card.name);

  state.nameDb.langs[lang.code] = {
    fetchedAt: Date.now(),
    cards,
  };
  saveNameDbCache();
  log(`${lang.label} database loaded: ${cards.length} card name(s).`);
  await sleep(REQUEST_DELAY_MS);
}

async function ensureNameDatabase() {
  for (const lang of NAME_DB_LANGUAGES) {
    if (!isNameDbFresh(state.nameDb.langs[lang.code])) {
      await fetchLanguageDatabase(lang);
    } else {
      log(`${lang.label} card-name database loaded from local cache.`);
    }
  }

  if (!state.nameIndex) buildNameIndexes();
}

function buildNameIndexes() {
  const index = new Map();
  const candidates = [];
  const englishByPasscode = new Map();

  for (const card of state.nameDb.langs.en?.cards || []) {
    englishByPasscode.set(Number(card.id), card);
  }

  for (const lang of NAME_DB_LANGUAGES) {
    for (const localizedCard of state.nameDb.langs[lang.code]?.cards || []) {
      const englishCard = englishByPasscode.get(Number(localizedCard.id));
      const source = englishCard || localizedCard;
      const info = {
        passcode: Number(localizedCard.id),
        name: englishCard?.name || localizedCard.name,
        localizedName: localizedCard.name,
        language: lang.code,
        card_type: source.type,
        konami_id: localizedCard.konami_id ?? englishCard?.konami_id ?? null,
      };
      const normalized = normalizeCardName(localizedCard.name);
      if (!normalized) continue;
      if (!index.has(normalized)) index.set(normalized, info);
      candidates.push({ normalized, displayName: localizedCard.name, info });
    }
  }

  state.nameIndex = index;
  state.nameCandidates = candidates;
  state.englishByPasscode = englishByPasscode;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function tokenOverlapScore(a, b) {
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function similarity(a, b) {
  const edit = 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
  const tokens = tokenOverlapScore(a, b);
  return Math.max(edit, tokens * 0.92 + edit * 0.08);
}

function matchCardName(rawName) {
  const normalized = normalizeCardName(rawName);
  if (!normalized) return { match: null, suggestion: null };

  const exact = state.nameIndex.get(normalized);
  if (exact) return { match: exact, score: 1, matchedName: exact.localizedName || exact.name, fuzzy: false };

  let best = null;
  let secondBestScore = 0;
  const rawTokens = normalized.split(" ").filter(Boolean);
  const firstUsefulToken = rawTokens.find((token) => token.length >= 4) || rawTokens[0] || "";

  for (const candidate of state.nameCandidates || []) {
    const lengthGap = Math.abs(candidate.normalized.length - normalized.length);
    const overlap = tokenOverlapScore(normalized, candidate.normalized);
    if (lengthGap > Math.max(12, normalized.length * 0.45) && overlap < 0.25) continue;
    if (firstUsefulToken && !candidate.normalized.includes(firstUsefulToken) && overlap < 0.34) continue;

    const score = similarity(normalized, candidate.normalized);
    if (!best || score > best.score) {
      secondBestScore = best?.score || 0;
      best = { ...candidate, score };
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }

  if (best && best.score >= 0.88 && best.score - secondBestScore >= 0.015) {
    return { match: best.info, score: best.score, matchedName: best.displayName, fuzzy: true };
  }

  return { match: null, suggestion: best ? { name: best.displayName, score: best.score } : null };
}

function labelFromNamedEntry(entry, info) {
  if (["Monsters", "Spells", "Traps", "Extra", "Side"].includes(entry.target)) return entry.target;
  return cardSection(info.card_type, "main");
}

async function buildDracotailJsonFromNames(entries, deckName) {
  await ensureNameDatabase();

  const resolved = [];
  const notFound = [];

  for (const entry of entries) {
    const result = matchCardName(entry.rawName);
    if (!result.match) {
      notFound.push({ rawName: entry.rawName, suggestion: result.suggestion });
      continue;
    }

    if (result.fuzzy) {
      log(`⚠ Fuzzy match: '${entry.rawName}' → '${result.matchedName}' (${Math.round(result.score * 100)}%).`);
    }

    resolved.push({
      ...entry,
      info: result.match,
      label: labelFromNamedEntry(entry, result.match),
    });
  }

  if (notFound.length) {
    const details = notFound.slice(0, 12).map((item) => {
      const suffix = item.suggestion ? ` (closest: ${item.suggestion.name}, ${Math.round(item.suggestion.score * 100)}%)` : "";
      return `- ${item.rawName}${suffix}`;
    }).join("\n");
    throw new Error(`Could not match ${notFound.length} card name(s). Review the OCR text and card language, then try again.\n${details}`);
  }

  const result = emptyResult(deckName);
  const counts = new Map();
  const ordered = [];

  for (const entry of resolved) {
    const konamiId = requireKonamiId(entry.info, entry.rawName);
    const key = `${entry.label}:${konamiId}`;
    if (!counts.has(key)) ordered.push({ key, label: entry.label, konamiId });
    counts.set(key, (counts.get(key) || 0) + entry.quantity);
  }

  for (const item of ordered) {
    result[item.label].push({
      CardDatabaseId: item.konamiId,
      Quantity: counts.get(item.key),
    });
  }

  return result;
}

function summarize(result) {
  const total = (section) => (result[section] || []).reduce((sum, card) => sum + card.Quantity, 0);
  const main = total("Monsters") + total("Spells") + total("Traps");
  return `✔ Main: ${main}  |  Extra: ${total("Extra")}  |  Side: ${total("Side")}`;
}

function sanitizeFilename(name) {
  return (name || "deck")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "deck";
}

async function runConversion(event) {
  event?.preventDefault();
  setText(els.log, "");
  setBusy(true, "Converting...");
  setStatus("Converting", "busy");
  setSummary("Resolving cards and building compact JSON...", "warn");

  try {
    const input = valueOf(els.deckInput);
    const parsed = detectAndParse(input);
    const deckName = valueOf(els.deckName, "My Deck").trim() || "My Deck";

    let result;
    if (parsed.kind === "ids") {
      const totalCards = getAllIds(parsed.sections).length;
      if (!totalCards) throw new Error("No cards were found in Main, Extra, or Side.");
      log(`Raw total: ${totalCards} card(s).`);
      result = await buildDracotailJson(parsed.sections, deckName);
    } else {
      const totalCards = parsed.entries.reduce((sum, entry) => sum + entry.quantity, 0);
      if (!totalCards) throw new Error("No named cards were found.");
      log(`Named deck list total: ${totalCards} card(s).`);
      result = await buildDracotailJsonFromNames(parsed.entries, deckName);
    }

    state.lastJson = JSON.stringify(result);
    state.lastDeckName = deckName;
    setText(els.output, state.lastJson);

    setSummary(summarize(result));
    setStatus("Done");
    log("Conversion completed.");
  } catch (error) {
    state.lastJson = "";
    setText(els.output, `Error:\n\n${error.message}`);
    setSummary(error.message.split("\n")[0], "error");
    setStatus("Error", "error");
    log(`✗ ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function readFile(file) {
  if (file.type && file.type.startsWith("image/")) {
    await readImageFile(file);
    return;
  }

  const text = await file.text();
  setValue(els.deckInput, text);
  const stem = file.name.replace(/\.[^.]+$/, "");
  if (stem) setValue(els.deckName, stem);
  setSummary(`File '${file.name}' loaded. Click convert.`, "warn");
}

function getWordBox(word) {
  const box = word?.bbox || word;
  if (!box) return null;
  const x0 = Number(box.x0 ?? box.left ?? 0);
  const y0 = Number(box.y0 ?? box.top ?? 0);
  const x1 = Number(box.x1 ?? (box.left + box.width) ?? 0);
  const y1 = Number(box.y1 ?? (box.top + box.height) ?? 0);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  return { x0, y0, x1, y1 };
}

function wordCenter(word) {
  const box = getWordBox(word);
  if (!box) return null;
  return {
    x: (box.x0 + box.x1) / 2,
    y: (box.y0 + box.y1) / 2,
    h: Math.max(1, box.y1 - box.y0),
    box,
  };
}

function groupWordsIntoRows(words, maxY) {
  const sorted = words
    .map((word) => ({ word, center: wordCenter(word) }))
    .filter((item) => item.center)
    .sort((a, b) => a.center.y - b.center.y || a.center.x - b.center.x);

  const averageHeight = sorted.reduce((sum, item) => sum + item.center.h, 0) / Math.max(sorted.length, 1);
  const tolerance = Math.max(averageHeight * 0.62, maxY * 0.006, 7);
  const rows = [];

  for (const item of sorted) {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.center.y) <= tolerance);
    if (!row) {
      row = { y: item.center.y, words: [] };
      rows.push(row);
    }
    row.words.push(item.word);
    row.y = (row.y * (row.words.length - 1) + item.center.y) / row.words.length;
  }

  return rows.map((row) => row.words.sort((a, b) => wordCenter(a).x - wordCenter(b).x));
}

function cleanOcrWord(text) {
  return String(text || "")
    .replace(/[”“]/g, '"')
    .replace(/[’‘`´]/g, "'")
    .replace(/[\[\]{}]/g, "")
    .replace(/^[|¦]+|[|¦]+$/g, "")
    .trim();
}

function parseCountedItemWords(rowWords) {
  const words = rowWords
    .map((word) => ({ text: cleanOcrWord(word.text), center: wordCenter(word) }))
    .filter((item) => item.text && item.center);

  if (!words.length) return null;

  let qtyIndex = -1;
  let quantity = null;
  for (let i = 0; i < Math.min(3, words.length); i += 1) {
    quantity = parseQtyToken(words[i].text);
    if (quantity) {
      qtyIndex = i;
      break;
    }
  }

  if (qtyIndex < 0 || !quantity) return null;

  const name = cleanCardNameText(words.slice(qtyIndex + 1).map((item) => item.text).join(" "));
  if (!name || name.length < 3 || ignoreDeckListLine(name)) return null;
  return { quantity, name };
}

function extractZoneEntries(words, zone, maxX, maxY) {
  const zoneWords = words.filter((word) => {
    const center = wordCenter(word);
    if (!center) return false;
    const x = center.x / maxX;
    const y = center.y / maxY;
    return x >= zone.x0 && x <= zone.x1 && y >= zone.y0 && y <= zone.y1;
  });

  const rows = groupWordsIntoRows(zoneWords, maxY);
  const entries = [];
  for (const row of rows) {
    const item = parseCountedItemWords(row);
    if (item) entries.push(item);
  }
  return entries;
}

function extractOfficialFormTextFromOcr(data) {
  const rawWords = Array.isArray(data?.words) ? data.words : [];
  const words = rawWords.filter((word) => {
    const text = cleanOcrWord(word.text);
    const box = getWordBox(word);
    return text && box && (word.confidence === undefined || word.confidence >= 18);
  });

  if (!words.length) return "";

  const maxX = Math.max(...words.map((word) => getWordBox(word).x1));
  const maxY = Math.max(...words.map((word) => getWordBox(word).y1));
  if (!maxX || !maxY) return "";

  const zones = [
    { marker: "#monsters", target: "Monsters", x0: 0.09, x1: 0.405, y0: 0.13, y1: 0.665 },
    { marker: "#spells", target: "Spells", x0: 0.405, x1: 0.705, y0: 0.13, y1: 0.665 },
    { marker: "#traps", target: "Traps", x0: 0.705, x1: 0.985, y0: 0.13, y1: 0.665 },
    { marker: "#extra", target: "Extra", x0: 0.09, x1: 0.405, y0: 0.67, y1: 0.985 },
    { marker: "!side", target: "Side", x0: 0.405, x1: 0.705, y0: 0.67, y1: 0.985 },
  ];

  const sections = zones.map((zone) => ({
    ...zone,
    entries: extractZoneEntries(words, zone, maxX, maxY),
  }));

  const totalEntries = sections.reduce((sum, section) => sum + section.entries.length, 0);
  if (totalEntries < 5) return "";

  const lines = [];
  for (const section of sections) {
    if (!section.entries.length) continue;
    lines.push(section.marker);
    for (const entry of section.entries) {
      lines.push(`${entry.quantity} ${entry.name}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function fallbackTextFromOcr(data) {
  const text = String(data?.text || "").replace(/\r/g, "").trim();
  if (!text) return "";

  const entries = parseNamedDeckList(text);
  if (entries.length >= 5) return text;
  return text;
}

async function readImageFile(file) {
  if (!window.Tesseract) {
    throw new Error("OCR engine could not be loaded. Check your internet connection or browser content blocker.");
  }

  setText(els.log, "");
  setBusy(true, "Reading image...");
  setStatus("Reading image", "busy");
  setSummary("Reading the image locally in your browser. This may take a moment...", "warn");
  log(`OCR started: ${file.name}`);

  try {
    const result = await window.Tesseract.recognize(file, "eng+por", {
      logger: (message) => {
        if (!message?.status) return;
        const progress = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : "";
        setStatus(`OCR${progress}`, "busy");
      },
    });

    const formatted = extractOfficialFormTextFromOcr(result.data) || fallbackTextFromOcr(result.data);
    if (!formatted) throw new Error("OCR did not return readable text. Try a clearer image or higher resolution scan.");

    setValue(els.deckInput, formatted);
    const stem = file.name.replace(/\.[^.]+$/, "");
    if (stem) setValue(els.deckName, stem);

    const parsed = parseNamedDeckList(formatted);
    log(`OCR completed. ${parsed.reduce((sum, entry) => sum + entry.quantity, 0)} card(s) detected in editable text.`);
    setSummary("Image text extracted. Review the text, fix any OCR mistakes, then click Convert deck.", "warn");
    setStatus("OCR done");
  } catch (error) {
    setSummary(error.message, "error");
    setStatus("OCR error", "error");
    log(`✗ ${error.message}`);
  } finally {
    setBusy(false);
  }
}

on(els.form, "submit", runConversion);

on(els.ydkFile, "change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await readFile(file);
});

on(els.imageFile, "change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await readImageFile(file);
});

function enableDropZone(zone, fileHandler) {
  ["dragenter", "dragover"].forEach((eventName) => {
    on(zone, eventName, (event) => {
      event.preventDefault();
      zone?.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    on(zone, eventName, (event) => {
      event.preventDefault();
      zone?.classList.remove("dragover");
    });
  });

  on(zone, "drop", async (event) => {
    const file = event.dataTransfer.files?.[0];
    if (file) await fileHandler(file);
  });
}

if (els.dropZone) enableDropZone(els.dropZone, readFile);
if (els.imageDropZone) enableDropZone(els.imageDropZone, readImageFile);

on(els.clearBtn, "click", () => {
  setValue(els.deckInput, "");
  setText(els.output, "");
  setText(els.log, "");
  state.lastJson = "";
  setSummary("Paste a deck and click convert.");
  setStatus("Ready");
});

on(els.copyBtn, "click", async () => {
  if (!state.lastJson) return setSummary("No generated JSON to copy.", "warn");
  try {
    await navigator.clipboard.writeText(state.lastJson);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = state.lastJson;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  setSummary("JSON copied to clipboard.");
});

on(els.downloadBtn, "click", () => {
  if (!state.lastJson) return setSummary("No generated JSON to download.", "warn");
  const blob = new Blob([state.lastJson], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(state.lastDeckName)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});
