import { useStore } from '../hooks/useStore.jsx';
import { useT } from '../lib/i18n/react.jsx';
import { useModal } from '../hooks/useModal.jsx';
import { useDialogs } from '../components/index.js';
import { category, channel, guild } from './menus/guild.jsx';
import {
  conversationMessage, message, post, thread,
} from './menus/messages.jsx';
import {
  account, conversation, friend, member, voice,
} from './menus/people.jsx';

export function useMenus() {
  const env = {
    store: useStore(),
    t: useT(),
    modal: useModal(),
    dialogs: useDialogs(),
  };
  const bound = (build) => (...args) => build(env, ...args);

  return {
    guild: bound(guild),
    channel: bound(channel),
    category: bound(category),
    post: bound(post),
    thread: bound(thread),
    message: bound(message),
    conversationMessage: bound(conversationMessage),
    member: bound(member),
    friend: bound(friend),
    voice: bound(voice),
    conversation: bound(conversation),
    account: bound(account),
  };
}
