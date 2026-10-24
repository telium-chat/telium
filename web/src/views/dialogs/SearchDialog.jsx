import { useStore } from '../../hooks/useStore.jsx';
import { SearchBody, SearchField, useGuildSearch } from '../search.jsx';
import {
  Button, EmptyState, ModalShell, SearchIcon,
} from '../../components/index.js';

export function SearchDialog({ guildId, close }) {
  const store = useStore();
  const search = useGuildSearch(guildId);
  const name = store.guilds.get(guildId)?.name;
  const placeholder = name ? `Search ${name}...` : 'Search this server...';

  return (
    <ModalShell title="Search" footer={<Button variant="ghost" onClick={close}>Close</Button>}>
      <SearchField autoFocus wide search={search} placeholder={placeholder} label="Search" />
      <SearchBody
        guildId={guildId}
        search={search}
        onPick={close}
        idle={(
          <EmptyState icon={SearchIcon} title="Search this server">
            {'One request to one server, because that server is the only place these '
              + 'messages exist. Covers every channel you can see, including messages '
              + 'that have aged out into cold storage.'}
          </EmptyState>
        )}
      />
    </ModalShell>
  );
}
