'use strict';
// Lancer : node --test "core/**/*.test.js"
// Mocke core/database/supabase (aucun appel réseau réel) : on vérifie ici
// uniquement que characterManager transmet correctement les nouveaux champs
// (fandom, character_type, opening — migration v7), pas le comportement de
// Supabase lui-même.

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../database/supabase');
const characterManager = require('./characterManager');

test('createCharacter transmet fandom/character_type/opening tels quels à la db', async (t) => {
  let received;
  t.mock.method(db, 'createCharacter', async (userId, fields) => {
    received = { userId, fields };
    return { id: 'char_1', user_id: userId, ...fields };
  });

  const user = { id: 'user_1' };
  const fields = {
    name: 'Hermione',
    fandom: 'Harry Potter',
    character_type: 'fanfic',
    opening: 'Elle referme son livre et lève les yeux vers toi.',
  };

  const result = await characterManager.createCharacter(user, fields);

  assert.equal(received.userId, 'user_1');
  assert.deepEqual(received.fields, fields);
  assert.equal(result.fandom, 'Harry Potter');
  assert.equal(result.character_type, 'fanfic');
  assert.equal(result.opening, fields.opening);
});

test('updateCharacter transmet une mise à jour partielle des nouveaux champs', async (t) => {
  let received;
  t.mock.method(db, 'updateCharacter', async (characterId, fields) => {
    received = { characterId, fields };
    return { id: characterId, ...fields };
  });

  const result = await characterManager.updateCharacter('char_1', { opening: 'Nouveau message.' });

  assert.equal(received.characterId, 'char_1');
  assert.deepEqual(received.fields, { opening: 'Nouveau message.' });
  assert.equal(result.opening, 'Nouveau message.');
});

test('resolveCharacterForSession ne dépend pas des nouveaux champs (non-régression)', async (t) => {
  t.mock.method(db, 'getCharacter', async () => ({
    id: 'char_1',
    name: 'Hermione',
    fandom: 'Harry Potter',
    character_type: 'fanfic',
    opening: 'Salut.',
    initial_situation: 'Bibliothèque de Poudlard, le soir.',
  }));

  const character = await characterManager.resolveCharacterForSession({ character_id: 'char_1' });

  // opening ne doit jamais se substituer à initial_situation : les deux
  // coexistent sur l'objet personnage, promptBuilder.js décide seul quoi
  // injecter dans le prompt (voir migration_v7.sql).
  assert.equal(character.initial_situation, 'Bibliothèque de Poudlard, le soir.');
  assert.equal(character.opening, 'Salut.');
});

test('GENERAL_ASSISTANT reste inchangé (pas de régression sur le mode assistant général)', () => {
  assert.equal(characterManager.GENERAL_ASSISTANT.id, null);
  assert.equal(characterManager.GENERAL_ASSISTANT.name, 'Assistant');
});
