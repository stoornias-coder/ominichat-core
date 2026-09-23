const SESSIONS_PAGE_SIZE = 5;
const HISTORY_PAGE_SIZE = 10;

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: 'Nouvelle conversation', callback_data: 'menu:new' }],
      [{ text: 'Mes conversations', callback_data: 'menu:sessions' }],
      [{ text: 'Personnages', callback_data: 'menu:characters' }],
    ],
  };
}

function newSessionChoiceKeyboard(characters) {
  const rows = [[{ text: 'Discussion générale', callback_data: 'newsession:general' }]];
  for (const c of characters) {
    rows.push([{ text: c.name, callback_data: `newsession:char:${c.id}` }]);
  }
  rows.push([{ text: 'Retour', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

// sessions : liste paginée
function sessionsListKeyboard(sessions, page, total, pageSize = SESSIONS_PAGE_SIZE) {
  const rows = sessions.map((s) => {
    const label = s.characters?.name ? `${s.title} (${s.characters.name})` : s.title;
    return [{ text: label, callback_data: `session:view:${s.id}` }];
  });

  const navRow = [];
  if (page > 0) navRow.push({ text: 'Précédent', callback_data: `sessions:page:${page - 1}` });
  if ((page + 1) * pageSize < total) navRow.push({ text: 'Suivant', callback_data: `sessions:page:${page + 1}` });
  if (navRow.length > 0) rows.push(navRow);

  rows.push([{ text: 'Nouvelle conversation', callback_data: 'menu:new' }]);
  rows.push([{ text: 'Retour', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

// détail d'une session : reprendre / voir plus d'historique / retour
function sessionDetailKeyboard(sessionId, { hasMore = false, moreOffset = 0 } = {}) {
  const rows = [[{ text: 'Reprendre cette conversation', callback_data: `session:resume:${sessionId}` }]];
  if (hasMore) {
    rows.push([{ text: 'Voir plus', callback_data: `session:more:${sessionId}:${moreOffset}` }]);
  }
  rows.push([{ text: 'Retour aux conversations', callback_data: 'menu:sessions' }]);
  return { inline_keyboard: rows };
}

// personnages : liste, avec accès direct pour parler / modifier / archiver
function charactersListKeyboard(characters) {
  const rows = [];
  for (const c of characters) {
    rows.push([{ text: c.name, callback_data: `char:view:${c.id}` }]);
    rows.push([
      { text: 'Parler avec', callback_data: `char:talk:${c.id}` },
      { text: 'Modifier', callback_data: `char:view:${c.id}` },
      { text: 'Archiver', callback_data: `char:archive:${c.id}` },
    ]);
  }
  rows.push([{ text: 'Créer un personnage', callback_data: 'char:create' }]);
  rows.push([{ text: 'Retour', callback_data: 'menu:main' }]);
  return { inline_keyboard: rows };
}

// fiche d'un personnage : parler avec / modifier chaque champ / archiver / retour
function characterDetailKeyboard(character) {
  return {
    inline_keyboard: [
      [{ text: `Parler avec ${character.name}`, callback_data: `char:talk:${character.id}` }],
      [{ text: 'Modifier la description', callback_data: `char:edit:description:${character.id}` }],
      [{ text: 'Modifier le rôle', callback_data: `char:edit:role:${character.id}` }],
      [{ text: 'Modifier la personnalité', callback_data: `char:edit:personality:${character.id}` }],
      [{ text: 'Modifier le comportement attendu', callback_data: `char:edit:behavior:${character.id}` }],
      [{ text: "Modifier l'histoire", callback_data: `char:edit:backstory:${character.id}` }],
      [{ text: 'Modifier la façon de parler', callback_data: `char:edit:speaking_style:${character.id}` }],
      [{ text: 'Modifier la situation de départ', callback_data: `char:edit:initial_situation:${character.id}` }],
      [{ text: 'Modifier les règles', callback_data: `char:edit:rules:${character.id}` }],
      [{ text: 'Archiver ce personnage', callback_data: `char:archive:${character.id}` }],
      [{ text: 'Retour aux personnages', callback_data: 'menu:characters' }],
    ],
  };
}

module.exports = {
  SESSIONS_PAGE_SIZE,
  HISTORY_PAGE_SIZE,
  mainMenuKeyboard,
  newSessionChoiceKeyboard,
  sessionsListKeyboard,
  sessionDetailKeyboard,
  charactersListKeyboard,
  characterDetailKeyboard,
};
