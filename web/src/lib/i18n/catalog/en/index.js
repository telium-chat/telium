// The English catalogue: every string this client can say, in one object.
//
// English is not "the default language" here. It is the *manifest*. A key
// exists exactly when it is written into one of the files assembled below, and
// every other language is measured against this object -- `completeness()` in
// `../index.js` computes what a translator has left to do by diffing their
// catalogue against this one, and `t()` falls back through this one when a
// locale is missing a key. Which makes a gap here a different kind of bug from
// a gap anywhere else: a missing German string is a sentence in English, and a
// missing English string is a screen with a word-shaped placeholder where a
// heading should be.
//
// ------------------------------------------------------- one file per namespace
//
// The split is by namespace and the namespace is the first segment of the key.
// That is not for tidiness. It is because this is the one catalogue that gets
// *edited*, by every branch that adds a screen, and a single file holding
// fifteen hundred strings is a single file that every branch conflicts in.
// Splitting it means a branch that touches the login screen and a branch that
// touches notification settings merge without a human reading a diff.
//
// The flip side is that the split has to be by namespace and nothing else. A
// file called `misc.js` or `screens-added-in-march.js` would put two keys that
// belong together in different files and break the only rule that makes the
// split navigable: the key tells you the file. `auth.login.title` is in
// `auth.js`, always, without looking.
//
// ------------------------------------------------------------ the assembly
//
// Spread rather than `Object.assign` into an accumulator, so the result is a
// plain object literal the bundler can see through and freeze. The duplicate
// check below runs in development only and is the thing that catches the
// mistake this shape makes possible: two namespaces both claiming
// `common.close` because somebody moved a key and did not delete the original.
// A silent overwrite there means the string you are reading in this directory
// is not the string on the screen, which is the worst kind of wrong -- it is
// wrong in a way that reading the code does not reveal.

import { format } from './format.js';
import { common } from './common.js';
import { app } from './app.js';
import { perms } from './perms.js';
import { errors } from './errors.js';
import { auth } from './auth.js';
import { onboarding } from './onboarding.js';
import { migration } from './migration.js';
import { security } from './security.js';
import { notifications } from './notifications.js';
import { privacy } from './privacy.js';
import { settings } from './settings.js';
import { updates } from './updates.js';
import { shell } from './shell.js';
import { chat } from './chat.js';
import { guild } from './guild.js';
import { roles } from './roles.js';
import { channel } from './channel.js';
import { bots } from './bots.js';
import { voice } from './voice.js';

const NAMESPACES = {
  format, common, app, perms, errors,
  auth, onboarding, migration, security, notifications, privacy, settings, shell, updates,
  chat, guild, roles, channel, bots, voice,
};

export const EN = Object.assign(Object.create(null), ...Object.values(NAMESPACES));

if (import.meta.env?.DEV) {
  // Two namespaces claiming the same key. See the note above on why this is
  // worth a module-evaluation cost in development: the failure is invisible in
  // review, because both files read correctly on their own.
  const seen = new Map();
  for (const [name, table] of Object.entries(NAMESPACES)) {
    for (const key of Object.keys(table)) {
      const first = seen.get(key);
      if (first) throw new Error(`i18n: "${key}" is defined in both ${first}.js and ${name}.js`);
      seen.set(key, name);
    }
  }
  // A key whose first segment is not the file it lives in. Cheap to check and
  // it is the rule the whole split rests on, so it is checked rather than
  // hoped for.
  for (const [name, table] of Object.entries(NAMESPACES)) {
    for (const key of Object.keys(table)) {
      if (key.split('.')[0] !== name) {
        throw new Error(`i18n: "${key}" lives in ${name}.js but belongs to the ${key.split('.')[0]} namespace`);
      }
    }
  }
}
