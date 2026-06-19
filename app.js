const YGOPRODECK_API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const CACHE_KEY = "ydke-web-konami-cache-v1";
const REQUEST_DELAY_MS = 120;
const MAX_RETRIES = 3;
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

const state = {
  lastJson: "",
  lastDeckName: "My Deck",
  cache: loadCache(),
};

const els = {
  form: $("#converterForm"),
  deckName: $("#deckName"),
  deckInput: $("#deckInput"),
  ydkFile: $("#ydkFile"),
  dropZone: $("#dropZone"),
  indent: $("#indent"),
  output: $("#output"),
  log: $("#log"),
  summary: $("#summary"),
  statusPill: $("#statusPill"),
  convertBtn: $("#convertBtn"),
  clearBtn: $("#clearBtn"),
  copyBtn: $("#copyBtn"),
  downloadBtn: $("#downloadBtn"),
  clearCacheBtn: $("#clearCacheBtn"),
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
    log(`⚠ Não foi possível salvar o cache local: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  const now = new Date().toLocaleTimeString("pt-BR", { hour12: false });
  els.log.textContent += `[${now}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(message, mode = "ready") {
  els.statusPill.textContent = message;
  els.statusPill.classList.toggle("busy", mode === "busy");
  els.statusPill.classList.toggle("error", mode === "error");
}

function setSummary(message, mode = "ready") {
  els.summary.textContent = message;
  els.summary.classList.toggle("error", mode === "error");
  els.summary.classList.toggle("warn", mode === "warn");
}

function setBusy(isBusy) {
  els.convertBtn.disabled = isBusy;
  els.convertBtn.textContent = isBusy ? "Convertendo..." : "Converter deck";
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
    throw new Error("O código YDKE precisa começar com ydke://");
  }

  const payload = trimmed.slice("ydke://".length);
  const parts = payload.split("!");
  while (parts.length < 3) parts.push("");

  const sectionNames = ["main", "extra", "side"];
  const sections = { main: [], extra: [], side: [] };

  sectionNames.forEach((name, index) => {
    const segment = parts[index] || "";
    if (!segment) return;

    const binary = atob(normalizeBase64(segment));
    if (binary.length % 4 !== 0) {
      throw new Error(`Seção ${name} do YDKE está inválida: bytes não múltiplos de 4.`);
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

function detectAndParse(input) {
  const text = input.trim();
  if (!text) throw new Error("Cole um código YDKE ou importe/cole um arquivo .ydk.");
  return text.startsWith("ydke://") ? decodeYdke(text) : parseYdk(text);
}

function getSelectedSections() {
  const values = Array.from(document.querySelectorAll('input[name="section"]:checked')).map((input) => input.value);
  return values.length ? values : ["main"];
}

function getFormat() {
  return document.querySelector('input[name="format"]:checked')?.value || "dracotail";
}

function getAllIds(sections, includeSections) {
  return includeSections.flatMap((section) => sections[section] || []);
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

    log(`YGOPRODECK: ${chunk.length} carta(s) [${start + 1}-${start + chunk.length} de ${ids.length}]`);

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url.toString(), { headers: { Accept: "application/json" } });
        if (response.status === 404) {
          log("⚠ A API não encontrou uma ou mais cartas deste lote.");
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
          throw new Error(`Erro ao consultar YGOPRODECK: ${error.message}. Se estiver no GitHub Pages, verifique também bloqueio de internet/CORS no navegador.`);
        }
        log(`Tentativa ${attempt} falhou. Tentando novamente...`);
        await sleep(800);
      }
    }

    if (!success) log("⚠ Lote ignorado por falha na API.");
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
    log(`Cache local: ${uniqueIds.length} carta(s) já resolvidas.`);
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

function requireKonamiId(info, passcode) {
  if (info.konami_id === null || info.konami_id === undefined) {
    const name = info.name || `Unknown(${passcode})`;
    throw new Error(
      `YGOPRODECK não retornou konami_id para '${name}' (passcode/YDK: ${passcode}). ` +
      "CardDatabaseId precisa usar o konami_id exato da Konami. Limpe o cache e tente novamente se a carta já estiver cadastrada na base oficial."
    );
  }
  return Number(info.konami_id);
}

async function buildSimpleJson(sections, includeSections) {
  const allIds = getAllIds(sections, includeSections);
  const cards = await resolveBulk(allIds);
  return { card: cards.map((card) => card.name) };
}

async function buildDracotailJson(sections, includeSections, deckName) {
  const allIds = getAllIds(sections, includeSections);
  await resolveBulk(allIds);

  const counts = new Map();
  for (const ydkeSection of includeSections) {
    for (const passcode of sections[ydkeSection] || []) {
      const info = resolve(passcode);
      const label = cardSection(info.card_type, ydkeSection);
      const key = `${label}:${passcode}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const result = {
    Name: deckName || "My Deck",
    Monsters: [],
    Spells: [],
    Traps: [],
    Side: [],
    Extra: [],
  };

  const seen = new Set();
  for (const ydkeSection of includeSections) {
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

function summarize(result, format) {
  if (format === "simple") {
    return `✔ ${result.card?.length || 0} cartas convertidas.`;
  }

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
  els.log.textContent = "";
  setBusy(true);
  setStatus("Convertendo", "busy");
  setSummary("Consultando cartas e montando JSON...", "warn");

  try {
    const input = els.deckInput.value;
    const sections = detectAndParse(input);
    const includeSections = getSelectedSections();
    const format = getFormat();
    const deckName = els.deckName.value.trim() || "My Deck";
    const totalCards = getAllIds(sections, includeSections).length;

    if (!totalCards) {
      throw new Error("Nenhuma carta encontrada nas seções selecionadas.");
    }

    log(`Seções selecionadas: ${includeSections.join(", ")}`);
    log(`Total bruto: ${totalCards} carta(s).`);

    const result = format === "dracotail"
      ? await buildDracotailJson(sections, includeSections, deckName)
      : await buildSimpleJson(sections, includeSections);

    const indent = Number(els.indent.value);
    state.lastJson = JSON.stringify(result, null, indent > 0 ? indent : 0);
    state.lastDeckName = deckName;
    els.output.textContent = state.lastJson;

    setSummary(summarize(result, format));
    setStatus("Concluído");
    log("Conversão concluída.");
  } catch (error) {
    state.lastJson = "";
    els.output.textContent = `Erro:\n\n${error.message}`;
    setSummary(error.message, "error");
    setStatus("Erro", "error");
    log(`✗ ${error.message}`);
  } finally {
    setBusy(false);
  }
}

async function readFile(file) {
  const text = await file.text();
  els.deckInput.value = text;
  const stem = file.name.replace(/\.[^.]+$/, "");
  if (stem) els.deckName.value = stem;
  setSummary(`Arquivo '${file.name}' carregado. Clique em converter.`, "warn");
}

els.form.addEventListener("submit", runConversion);

els.ydkFile.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) await readFile(file);
});

["dragenter", "dragover"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragover");
  });
});

els.dropZone.addEventListener("drop", async (event) => {
  const file = event.dataTransfer.files?.[0];
  if (file) await readFile(file);
});

els.clearBtn.addEventListener("click", () => {
  els.deckInput.value = "";
  els.output.textContent = "";
  els.log.textContent = "";
  state.lastJson = "";
  setSummary("Cole um deck e clique em converter.");
  setStatus("Pronto");
});

els.clearCacheBtn.addEventListener("click", () => {
  state.cache = {};
  localStorage.removeItem(CACHE_KEY);
  setSummary("Cache local limpo.", "warn");
  log("Cache local limpo.");
});

els.copyBtn.addEventListener("click", async () => {
  if (!state.lastJson) return setSummary("Nenhum JSON gerado para copiar.", "warn");
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
  setSummary("JSON copiado para a área de transferência.");
});

els.downloadBtn.addEventListener("click", () => {
  if (!state.lastJson) return setSummary("Nenhum JSON gerado para baixar.", "warn");
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
