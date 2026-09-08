// bot.js
// Bot Telegram "TMDB" — exécuté par GitHub Actions, déclenché par Cron-Job.org
// Aucune dépendance externe : utilise fetch natif (Node 18+)

import fs from "fs";
import { execSync } from "child_process";

const HISTORIQUE_PATH = "historique.csv";
const HISTORIQUE_HEADER = "Titre,Type,Lien TMDB (FR),Date et heure";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TMDB_KEY = process.env.TMDB_API_KEY;

if (!TELEGRAM_TOKEN || !TMDB_KEY) {
  console.error("Variables d'environnement manquantes (TELEGRAM_BOT_TOKEN / TMDB_API_KEY).");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TMDB_LINK_REGEX = /themoviedb\.org\/(movie|tv)\/(\d+)/i;

async function fetchWithRetry(url, options, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`Tentative ${attempt}/${retries} échouée (${err.message}), nouvel essai dans ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function telegramCall(method, params) {
  const res = await fetchWithRetry(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Erreur Telegram (${method}):`, data.description);
  }
  return data;
}

async function getUpdates(offset) {
  const params = { timeout: 0 };
  if (offset !== undefined) params.offset = offset;
  const data = await telegramCall("getUpdates", params);
  return data.result || [];
}

async function sendMessage(chatId, text) {
  return telegramCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

async function sendPhoto(chatId, photoUrl, caption) {
  return telegramCall("sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "HTML",
  });
}

async function deleteMessage(chatId, messageId) {
  return telegramCall("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
}

async function fetchTMDB(type, id) {
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=fr-FR&append_to_response=translations`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  return res.json();
}

// Choisit le titre : français si dispo, sinon anglais, sinon titre original (VO).
function pickTitle(details, isMovie) {
  const field = isMovie ? "title" : "name";
  const translations = details.translations?.translations || [];

  const frTranslation = translations.find((t) => t.iso_639_1 === "fr" && t.data?.[field]);
  if (frTranslation) return frTranslation.data[field];

  const enTranslation = translations.find((t) => t.iso_639_1 === "en" && t.data?.[field]);
  if (enTranslation) return enTranslation.data[field];

  return isMovie ? details.original_title : details.original_name;
}

function yearFromDate(dateStr) {
  if (!dateStr) return null;
  return dateStr.split("-")[0];
}

function formatYearsMovie(releaseDate) {
  return yearFromDate(releaseDate) || "Année inconnue";
}

function formatYearsTv(firstAirDate, lastAirDate, status) {
  const startYear = yearFromDate(firstAirDate);
  if (!startYear) return "Année inconnue";

  if (status === "Ended" || status === "Canceled") {
    const endYear = yearFromDate(lastAirDate);
    return endYear ? `${startYear} - ${endYear}` : startYear;
  }
  if (status === "Returning Series") {
    return `${startYear} - en cours`;
  }
  // Statut incertain (En production, Prévue, Pilote...) : on affiche juste l'année de début.
  return startYear;
}

function formatDurationMovie(minutes) {
  if (!minutes && minutes !== 0) return "Durée inconnue";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${String(m).padStart(2, "0")}`;
}

function formatDurationTv(seasons, episodes) {
  const s = seasons ? `${seasons} saison${seasons > 1 ? "s" : ""}` : "saisons inconnues";
  const e = episodes ? `${episodes} épisode${episodes > 1 ? "s" : ""}` : "épisodes inconnus";
  return `${s}/${e}`;
}

function formatGenres(genres) {
  if (!genres || genres.length === 0) return null;
  const names = genres.slice(0, 2).map((g) => g.name);
  if (names.length === 1) return names[0];
  return `${names[0]} et ${names[1]}`;
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatNowFr() {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function appendHistorique(title, typeLabel, tmdbUrl) {
  if (!fs.existsSync(HISTORIQUE_PATH)) {
    fs.writeFileSync(HISTORIQUE_PATH, HISTORIQUE_HEADER + "\n");
  }
  const row = [csvEscape(title), csvEscape(typeLabel), csvEscape(tmdbUrl), csvEscape(formatNowFr())].join(",");
  fs.appendFileSync(HISTORIQUE_PATH, row + "\n");
}

function commitHistorique() {
  try {
    execSync('git config user.name "TMDB Bot"');
    execSync('git config user.email "actions@users.noreply.github.com"');
    execSync(`git add ${HISTORIQUE_PATH}`);
    execSync('git commit -m "Mise a jour historique TMDB"');
    execSync("git push");
    console.log("Historique mis à jour et poussé sur GitHub.");
  } catch (err) {
    console.error("Impossible de committer l'historique:", err.message);
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function handleTmdbLink(chatId, type, id) {
  const details = await fetchTMDB(type, id);
  if (!details || details.success === false) {
    await sendMessage(chatId, "❌ Impossible de récupérer cette fiche TMDB (lien invalide ou ID introuvable).");
    return false;
  }

  const isMovie = type === "movie";
  const typeEmoji = isMovie ? "🎬" : "📺";
  const rawTitle = pickTitle(details, isMovie);
  const title = escapeHtml(rawTitle);
  const years = isMovie
    ? formatYearsMovie(details.release_date)
    : formatYearsTv(details.first_air_date, details.last_air_date, details.status);
  const duration = isMovie
    ? formatDurationMovie(details.runtime)
    : formatDurationTv(details.number_of_seasons, details.number_of_episodes);
  const genres = formatGenres(details.genres);
  const overview = escapeHtml(details.overview) || "Aucun résumé disponible.";
  const posterPath = details.poster_path;
  // Le lien TMDB pointe toujours vers la version française de la fiche.
  const tmdbUrl = `https://www.themoviedb.org/${type}/${id}?language=fr-FR`;

  const infoText =
    `${typeEmoji} • <b>${title}</b>\n\n` +
    `🗓️ • ${years}\n\n` +
    (genres ? `🎭 • ${escapeHtml(genres)}\n\n` : "") +
    `🕒 • ${duration}\n\n` +
    `📜 • Résumé\n<tg-spoiler><i>${overview}</i></tg-spoiler>\n\n` +
    `🔗 • <a href="${tmdbUrl}">TMDB</a>`;

  if (posterPath) {
    const posterUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
    // Photo envoyée seule (sans caption), le texte complet suit dans un message séparé
    // pour ne pas être limité par les 1024 caractères du caption Telegram.
    await sendPhoto(chatId, posterUrl, undefined);
  }
  await sendMessage(chatId, infoText);

  appendHistorique(rawTitle, isMovie ? "Film" : "Série", tmdbUrl);
  return true;
}

async function main() {
  // Récupère tous les messages en attente depuis la dernière confirmation.
  const updates = await getUpdates();

  if (updates.length === 0) {
    console.log("Aucun nouveau message.");
    return;
  }

  let historyUpdated = false;

  for (const update of updates) {
    const message = update.message;
    if (!message || !message.text) continue;

    const chatId = message.chat.id;
    const match = message.text.match(TMDB_LINK_REGEX);

    if (match) {
      const [, type, id] = match;
      console.log(`Lien TMDB détecté: ${type}/${id} (chat ${chatId})`);
      try {
        const success = await handleTmdbLink(chatId, type, id);
        if (success) {
          historyUpdated = true;
          await deleteMessage(chatId, message.message_id);
        }
      } catch (err) {
        console.error("Erreur lors du traitement du lien:", err);
        await sendMessage(chatId, "❌ Une erreur est survenue lors de la récupération des informations.");
      }
    }
  }

  // Confirme tous les updates traités pour que Telegram ne les renvoie plus.
  const lastUpdateId = updates[updates.length - 1].update_id;
  await getUpdates(lastUpdateId + 1);
  console.log(`${updates.length} message(s) traité(s).`);

  if (historyUpdated) {
    commitHistorique();
  }
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
