const db = require('../../core/database/supabase');
const sessionManager = require('../../core/session/sessionManager');
const characterManager = require('../../core/character/characterManager');
const conversationState = require('./conversationState');
const {
  HISTORY_PAGE_SIZE,
  mainMenuKeyboard,
  newSessionChoiceKeyboard,
  sessionsListKeyboard,
  sessionDetailKeyboard,
  charactersListKeyboard,
  characterDetailKeyboard,
} = require('./keyboards');

// ============================================================
// Menu principal / commandes de base
// ============================================================

async function handleStart(bot, chatId, user) {
  await bot.sendMessage(chatId, 'Salut ! Voici ce que tu peux faire :', {
    reply_markup: mainMenuKeyboard(),
  });
}

async function handleNewCommand(bot, chatId, user) {
  const characters = await characterManager.listUserCharacters(user);
  await bot.sendMessage(chatId, 'Nouvelle conversation — avec qui ?', {
    reply_markup: newSessionChoiceKeyboard(characters),
  });
}

// ============================================================
// Mes conversations : liste paginée, consultation, reprise
// ============================================================

async function handleSessionsCommand(bot, chatId, user, page = 0) {
  const { sessions, total, pageSize } = await sessionManager.listUserSessionsPage(user, page);
  if (total === 0) {
    await bot.sendMessage(chatId, "Tu n'as pas encore de conversation. Utilise \"Nouvelle conversation\" pour en créer une.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }
  await bot.sendMessage(chatId, 'Tes conversations :', {
    reply_markup: sessionsListKeyboard(sessions, page, total, pageSize),
  });
}

function formatMessagesBlock(messages, characterName) {
  if (messages.length === 0) return '(Aucun message dans cette conversation)';
  return messages
    .map((m) => `${m.role === 'user' ? 'Toi' : characterName || 'Assistant'} : ${m.content}`)
    .join('\n\n');
}

// Affiche les derniers messages d'une session + boutons (reprendre / voir plus)
async function handleSessionView(bot, chatId, user, sessionId) {
  const session = await sessionManager.getSessionDetails(sessionId);
  if (!session || session.user_id !== user.id) {
    await bot.sendMessage(chatId, "Cette conversation n'existe plus.");
    return;
  }

  const characterName = session.characters?.name || null;
  const total = await db.getMessagesCount(sessionId);
  const offset = Math.max(0, total - HISTORY_PAGE_SIZE);
  const messages = await db.getMessagesPage(sessionId, { limit: HISTORY_PAGE_SIZE, offset });

  const header = characterName ? `Conversation : ${session.title} (${characterName})` : `Conversation : ${session.title}`;
  const body = formatMessagesBlock(messages, characterName);

  await bot.sendMessage(chatId, `${header}\n\n${body}`, {
    reply_markup: sessionDetailKeyboard(sessionId, { hasMore: offset > 0, moreOffset: offset }),
  });
}

// Charge un bloc plus ancien de l'historique ("Voir plus")
async function handleSessionMore(bot, chatId, sessionId, offsetEndStr) {
  const offsetEnd = parseInt(offsetEndStr, 10) || 0;
  const newOffset = Math.max(0, offsetEnd - HISTORY_PAGE_SIZE);
  const limit = offsetEnd - newOffset;
  if (limit <= 0) return;

  const session = await db.getSessionWithCharacter(sessionId);
  const characterName = session?.characters?.name || null;
  const messages = await db.getMessagesPage(sessionId, { limit, offset: newOffset });

  await bot.sendMessage(chatId, formatMessagesBlock(messages, characterName), {
    reply_markup: sessionDetailKeyboard(sessionId, { hasMore: newOffset > 0, moreOffset: newOffset }),
  });
}

// Réactive une session existante comme session active (ne crée rien de nouveau)
async function handleSessionResume(bot, chatId, user, sessionId) {
  const session = await sessionManager.switchToSession(user, sessionId);
  if (!session) {
    await bot.sendMessage(chatId, "Cette conversation n'existe plus.");
    return;
  }
  await bot.sendMessage(chatId, `Conversation "${session.title}" reprise. Tu peux continuer à écrire.`);
}

// ============================================================
// Personnages : liste, fiche, création guidée, édition, archivage
// ============================================================

async function handleCharactersCommand(bot, chatId, user) {
  const characters = await characterManager.listUserCharacters(user);
  await bot.sendMessage(
    chatId,
    characters.length > 0 ? 'Tes personnages :' : "Tu n'as pas encore de personnage.",
    { reply_markup: charactersListKeyboard(characters) }
  );
}

async function sendCharacterCard(bot, chatId, character) {
  const lines = [
    `Nom : ${character.name}`,
    `Description : ${character.description || '(vide)'}`,
    `Rôle : ${character.role || '(vide)'}`,
    `Personnalité : ${character.personality || '(vide)'}`,
    `Comportement attendu : ${character.behavior || '(vide)'}`,
    `Histoire : ${character.backstory || '(vide)'}`,
    `Façon de parler : ${character.speaking_style || '(vide)'}`,
    `Situation de départ : ${character.initial_situation || '(vide)'}`,
    `Règles : ${character.rules || '(vide)'}`,
  ];
  await bot.sendMessage(chatId, lines.join('\n'), {
    reply_markup: characterDetailKeyboard(character),
  });
}

async function handleCharacterView(bot, chatId, characterId) {
  const character = await db.getCharacter(characterId);
  if (!character) {
    await bot.sendMessage(chatId, "Ce personnage n'existe plus.");
    return;
  }
  await sendCharacterCard(bot, chatId, character);
}

// ---- Création guidée, champ par champ ----
const CREATE_FIELD_ORDER = [
  'description',
  'role',
  'personality',
  'behavior',
  'backstory',
  'speaking_style',
  'initial_situation',
  'rules',
];
const FIELD_LABELS = {
  description: 'description',
  role: 'rôle',
  personality: 'personnalité',
  behavior: 'comportement attendu',
  backstory: 'histoire',
  speaking_style: 'façon de parler',
  initial_situation: 'situation de départ',
  rules: 'règles',
};

async function handleCharacterCreateStart(bot, chatId) {
  conversationState.setState(chatId, { type: 'create_character', step: 'name', data: {} });
  await bot.sendMessage(
    chatId,
    'Créons un personnage. Quel est son nom ?\n\n(Tape "annuler" à tout moment pour arrêter.)'
  );
}

async function handleCharacterCreateInput(bot, chatId, user, text, state) {
  if (text.toLowerCase() === 'annuler') {
    conversationState.clearState(chatId);
    await bot.sendMessage(chatId, 'Création annulée.', { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (state.step === 'name') {
    state.data.name = text;
    state.step = CREATE_FIELD_ORDER[0];
    conversationState.setState(chatId, state);
    await bot.sendMessage(chatId, `Décris ${state.data.name} en quelques mots (ou envoie "-" pour passer).`);
    return;
  }

  state.data[state.step] = text === '-' ? '' : text;
  const nextIndex = CREATE_FIELD_ORDER.indexOf(state.step) + 1;

  if (nextIndex < CREATE_FIELD_ORDER.length) {
    state.step = CREATE_FIELD_ORDER[nextIndex];
    conversationState.setState(chatId, state);
    await bot.sendMessage(chatId, `Et sa ${FIELD_LABELS[state.step]} ? (ou "-" pour passer)`);
    return;
  }

  conversationState.clearState(chatId);
  const character = await characterManager.createCharacter(user, state.data);
  await bot.sendMessage(chatId, `Personnage "${character.name}" créé.`);
  await sendCharacterCard(bot, chatId, character);
}

// ---- Édition d'un seul champ ----
async function handleCharacterEditStart(bot, chatId, field, characterId) {
  conversationState.setState(chatId, { type: 'edit_character', characterId, field });
  await bot.sendMessage(
    chatId,
    `Nouvelle valeur pour "${FIELD_LABELS[field] || field}" :\n\n(Tape "annuler" pour arrêter.)`
  );
}

async function handleCharacterEditInput(bot, chatId, user, text, state) {
  if (text.toLowerCase() === 'annuler') {
    conversationState.clearState(chatId);
    await bot.sendMessage(chatId, 'Modification annulée.');
    return;
  }

  conversationState.clearState(chatId);
  const character = await characterManager.updateCharacter(state.characterId, { [state.field]: text });
  await bot.sendMessage(chatId, 'Personnage mis à jour.');
  await sendCharacterCard(bot, chatId, character);
}

async function handleCharacterArchive(bot, chatId, user, characterId) {
  await characterManager.archiveCharacter(characterId);
  await bot.sendMessage(chatId, 'Personnage archivé.');
  await handleCharactersCommand(bot, chatId, user);
}

// "Parler avec X" : réactive/crée une session avec character_id = X.id
// et la rend active. Aucune étape de création/édition n'est déclenchée ici.
async function handleCharacterTalk(bot, chatId, user, characterId) {
  const character = await db.getCharacter(characterId);
  if (!character) {
    await bot.sendMessage(chatId, "Ce personnage n'existe plus.");
    return;
  }
  const session = await sessionManager.startOrResumeCharacterSession(user, characterId);
  await bot.sendMessage(
    chatId,
    `Conversation avec ${character.name} activée ("${session.title}"). Écris-lui, il te répondra directement dans son rôle.`
  );
}

// ============================================================
// Callbacks des boutons inline
// ============================================================

async function handleCallbackQuery(bot, query, user) {
  const chatId = query.message.chat.id;
  const data = query.data || '';
  const parts = data.split(':');

  bot.answerCallbackQuery(query.id).catch(() => {});

  // Cliquer sur N'IMPORTE QUEL bouton annule tout formulaire en cours
  // (création/édition de personnage). Un clic n'est jamais une réponse
  // à une question de formulaire : seul un message texte l'est.
  conversationState.clearState(chatId);

  // ---- menu principal ----
  if (data === 'menu:main') return handleStart(bot, chatId, user);
  if (data === 'menu:new') return handleNewCommand(bot, chatId, user);
  if (data === 'menu:sessions') return handleSessionsCommand(bot, chatId, user, 0);
  if (data === 'menu:characters') return handleCharactersCommand(bot, chatId, user);

  // ---- nouvelle conversation ----
  if (data === 'newsession:general') {
    const session = await sessionManager.startNewSession(user, { title: 'Discussion générale' });
    await bot.sendMessage(chatId, `Nouvelle conversation "${session.title}" démarrée. Écris-moi !`);
    return;
  }
  if (data.startsWith('newsession:char:')) {
    const characterId = data.replace('newsession:char:', '');
    const character = await db.getCharacter(characterId);
    const session = await sessionManager.startNewSession(user, {
      characterId,
      title: character ? character.name : 'RP',
    });
    await bot.sendMessage(chatId, `Nouvelle conversation avec ${character?.name || 'ce personnage'} démarrée !`);
    return;
  }

  // ---- pagination "Mes conversations" ----
  if (parts[0] === 'sessions' && parts[1] === 'page') {
    return handleSessionsCommand(bot, chatId, user, parseInt(parts[2], 10) || 0);
  }

  // ---- détail / reprise / historique d'une session ----
  if (parts[0] === 'session' && parts[1] === 'view') {
    return handleSessionView(bot, chatId, user, parts[2]);
  }
  if (parts[0] === 'session' && parts[1] === 'more') {
    return handleSessionMore(bot, chatId, parts[2], parts[3]);
  }
  if (parts[0] === 'session' && parts[1] === 'resume') {
    return handleSessionResume(bot, chatId, user, parts[2]);
  }

  // ---- personnages ----
  if (data === 'char:create') return handleCharacterCreateStart(bot, chatId);
  if (parts[0] === 'char' && parts[1] === 'view') return handleCharacterView(bot, chatId, parts[2]);
  if (parts[0] === 'char' && parts[1] === 'talk') return handleCharacterTalk(bot, chatId, user, parts[2]);
  if (parts[0] === 'char' && parts[1] === 'edit') return handleCharacterEditStart(bot, chatId, parts[2], parts[3]);
  if (parts[0] === 'char' && parts[1] === 'archive') return handleCharacterArchive(bot, chatId, user, parts[2]);
}

module.exports = {
  handleStart,
  handleNewCommand,
  handleSessionsCommand,
  handleCharactersCommand,
  handleCallbackQuery,
  handleCharacterCreateInput,
  handleCharacterEditInput,
};
