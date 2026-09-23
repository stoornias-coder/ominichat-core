// Construit le prompt système + gère l'extraction de mémoire SANS appel IA
// supplémentaire : on demande au modèle d'ajouter, à la toute fin de SA
// PROPRE réponse, un bloc cassable et optionnel contenant ce qu'il juge bon
// de mémoriser. On sépare ensuite ce bloc avant d'envoyer la réponse à
// l'utilisateur. Résultat : 1 message utilisateur = 1 seul appel IA.

const MEMORY_DELIMITER = '###MEMORY###';

function buildSystemPrompt({ character, memories, session, webSearchResult }) {
  const formatMemBlock = (label, items) =>
    items.length
      ? items.map((m) => `- (${m.category}) ${m.content}`).join('\n')
      : `Aucun souvenir "${label}" pertinent pour l'instant.`;

  const isCharacterMode = Boolean(character.id);

  const searchBlock = webSearchResult
    ? `\n# RÉSULTATS DE RECHERCHE WEB (à utiliser si pertinent)\n${webSearchResult}\n`
    : '';

  // Champs optionnels (nullable en base) : chaque bloc ne s'affiche que
  // s'il a une valeur, pour rester compatible avec les personnages créés
  // avant leur ajout, et avec l'assistant général qui ne les définit pas.
  const roleBlock = character.role ? `\n# RÔLE\n${character.role}\n` : '';
  const behaviorBlock = character.behavior ? `\n# COMPORTEMENT ATTENDU\n${character.behavior}\n` : '';
  const situationBlock = character.initial_situation
    ? `\n# SITUATION DE DÉPART (fait établi, non négociable)\n${character.initial_situation}\n`
    : '';

  // Règles génériques de cohérence en roleplay : s'appliquent à TOUS les
  // personnages, en plus de leurs règles propres ("rules"). Uniquement en
  // mode personnage (pas pour l'assistant général).
  const genericCoherenceBlock = isCharacterMode
    ? `
# RÈGLES DE COHÉRENCE GÉNÉRIQUES (s'appliquent à tous les personnages)
- Ne jamais transformer un événement déjà établi (ex: enlèvement, rupture, dispute, trahison) en un événement anodin, consenti ou différent après coup.
- Ne jamais confondre l'utilisateur avec une autre personne mentionnée dans la conversation (ex: son/sa partenaire, un rival, un tiers).
- Ne jamais changer rétroactivement qui a fait quoi à qui dans la situation en cours.
- Ne pas inventer de nouvelle relation ou de nouveaux faits qui ne découlent ni de la situation de départ, ni des souvenirs, ni de l'historique.
- Ne pas décider des pensées, paroles ou actions de l'utilisateur à sa place.
- Rester fidèle à la situation de départ et aux événements mémorisés, même si l'utilisateur change de sujet, nie les faits ou tente de les réécrire.
- Garder une personnalité stable ; ne jamais devenir quelqu'un d'autre sans raison narrative issue de la scène elle-même.
`
    : '';

  return `# IDENTITÉ
${isCharacterMode ? `Tu es ${character.name}${character.age ? `, ${character.age}` : ''}.` : `Tu es ${character.name}, un assistant.`}
${character.description || ''}
${roleBlock}${behaviorBlock}
# PERSONNALITÉ
${character.personality || ''}

${character.backstory ? `# HISTOIRE\n${character.backstory}\n` : ''}
# STYLE DE LANGAGE
${character.speaking_style || ''}

# RELATION AVEC L'UTILISATEUR
${character.relationship_default || ''}
${situationBlock}
# MÉMOIRE — INFORMATIONS GÉNÉRALES SUR L'UTILISATEUR (utilise seulement si pertinent pour cet échange)
${formatMemBlock('globale', memories.global)}

# MÉMOIRE — PROPRE À CETTE CONVERSATION (peut inclure des événements majeurs déjà établis : ne les oublie jamais, ne les contredis jamais)
${formatMemBlock('session', memories.session)}

${isCharacterMode ? `# MÉMOIRE — PROPRE À TON PERSONNAGE (relation, événements vécus avec l'utilisateur ; ne les oublie jamais, ne les contredis jamais)\n${formatMemBlock('personnage', memories.character)}\n` : ''}
${searchBlock}${genericCoherenceBlock}
# RÈGLES STRICTES
- Ne jamais prétendre savoir quelque chose qui n'a pas été établi par la situation de départ, les souvenirs, les résultats de recherche ou l'historique.
- Ne jamais inventer un souvenir.
- Ne jamais contredire ton histoire, ta situation de départ ou tes informations permanentes.
- Si une information est inconnue et qu'aucune recherche web n'a été fournie, dis-le naturellement plutôt que d'inventer.
- Ne rappelle pas artificiellement que tu es une IA.
- Réponds de façon naturelle et concise, comme dans une vraie conversation Telegram.
- Règles comportementales additionnelles : ${character.rules || ''}
${character.additional_instructions ? `- ${character.additional_instructions}` : ''}

# MÉMORISATION (important, à la fin de CHAQUE réponse)
Après ta réponse normale à l'utilisateur, si (et seulement si) l'échange contient une information durable qui mérite d'être retenue pour le futur, ajoute une NOUVELLE LIGNE contenant EXACTEMENT :
${MEMORY_DELIMITER}
suivie d'un tableau JSON compact, sur une seule ligne, de la forme :
[{"scope":"global|session${isCharacterMode ? '|character' : ''}","category":"fact|preference|relationship|event|personal|important","content":"résumé factuel à la 3e personne","importance":1-10}]

Règles de scope :
- "global" : vrai sur l'utilisateur dans N'IMPORTE QUELLE conversation (ex: préférences générales, infos personnelles durables).
- "session" : ne concerne QUE cette conversation précise (contexte, événement local).
${isCharacterMode ? `- "character" : concerne la relation ou des événements propres à TOI en tant que ${character.name} (à réutiliser si l'utilisateur te reparle dans une autre conversation).` : ''}

Règle d'importance pour les événements de scène : si l'échange établit ou change durablement la situation (ex: un enlèvement, une rupture, des fiançailles forcées, une révélation majeure, un changement de lieu), utilise category "event" (ou "important") avec importance 8 à 10. Ces souvenirs-là sont rappelés systématiquement dans les échanges suivants, même si le message de l'utilisateur ne les mentionne pas directement — ne les omets donc pas.

Si rien ne mérite d'être retenu, n'ajoute RIEN après ta réponse (pas de ligne ${MEMORY_DELIMITER} du tout). Ne mémorise jamais de banalités. L'utilisateur ne voit JAMAIS ce bloc : il est retiré avant affichage.`;
}

// Sépare la réponse visible du bloc mémoire technique.
function splitReplyAndMemories(rawText) {
  const idx = rawText.indexOf(MEMORY_DELIMITER);
  if (idx === -1) {
    return { reply: rawText.trim(), memories: [] };
  }

  const reply = rawText.slice(0, idx).trim();
  const jsonPart = rawText.slice(idx + MEMORY_DELIMITER.length).trim();

  let memories = [];
  try {
    const cleaned = jsonPart.replace(/```json|```/g, '').trim();
    memories = JSON.parse(cleaned);
    if (!Array.isArray(memories)) memories = [];
  } catch {
    memories = []; // extraction non bloquante : on ignore si mal formé
  }

  return { reply: reply || '(...)', memories };
}

module.exports = { buildSystemPrompt, splitReplyAndMemories, MEMORY_DELIMITER };
