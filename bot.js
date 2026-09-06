// bot.js
// Bot Telegram "TMDB" — exécuté par GitHub Actions, déclenché par Cron-Job.org
// Aucune dépendance externe : utilise fetch natif (Node 18+)

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TMDB_KEY = process.env.TMDB_API_KEY;

if (!TELEGRAM_TOKEN || !TMDB_KEY) {
  console.error("Variables d'environnement manquantes (TELEGRAM_BOT_TOKEN / TMDB_API_KEY).");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TMDB_LINK_REGEX = /themoviedb\.org\/(movie|tv)\/(\d+)/i;

async function telegramCall(method, params) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
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

async function fetchTMDB(type, id) {
  const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=fr-FR`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
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
    return;
  }

  const isMovie = type === "movie";
  const typeEmoji = isMovie ? "🎬" : "📺";
  const title = escapeHtml(isMovie ? details.title : details.name);
  const years = isMovie
    ? formatYearsMovie(details.release_date)
    : formatYearsTv(details.first_air_date, details.last_air_date, details.status);
  const duration = isMovie
    ? formatDurationMovie(details.runtime)
    : formatDurationTv(details.number_of_seasons, details.number_of_episodes);
  const overview = escapeHtml(details.overview) || "Aucun résumé disponible.";
  const posterPath = details.poster_path;
  // Le lien TMDB pointe toujours vers la version française de la fiche.
  const tmdbUrl = `https://www.themoviedb.org/${type}/${id}?language=fr-FR`;

  const infoText =
    `${typeEmoji} • <b>${title}</b>\n\n` +
    `🗓️ • ${years}\n\n` +
    `🕒 • ${duration}\n\n` +
    `📜 • Résumé\n<i>${overview}</i>\n\n` +
    `🔗 • <a href="${tmdbUrl}">TMDB</a>`;

  if (posterPath) {
    const posterUrl = `https://image.tmdb.org/t/p/w500${posterPath}`;
    // Photo envoyée seule (sans caption), le texte complet suit dans un message séparé
    // pour ne pas être limité par les 1024 caractères du caption Telegram.
    await sendPhoto(chatId, posterUrl, undefined);
  }
  await sendMessage(chatId, infoText);
}

async function main() {
  // Récupère tous les messages en attente depuis la dernière confirmation.
  const updates = await getUpdates();

  if (updates.length === 0) {
    console.log("Aucun nouveau message.");
    return;
  }

  for (const update of updates) {
    const message = update.message;
    if (!message || !message.text) continue;

    const chatId = message.chat.id;
    const match = message.text.match(TMDB_LINK_REGEX);

    if (match) {
      const [, type, id] = match;
      console.log(`Lien TMDB détecté: ${type}/${id} (chat ${chatId})`);
      try {
        await handleTmdbLink(chatId, type, id);
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
}

main().catch((err) => {
  console.error("Erreur fatale:", err);
  process.exit(1);
});
