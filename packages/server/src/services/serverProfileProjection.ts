import { isStoredServerScopedAvatarUrl } from "./avatarService";

export interface ServerPublicProfileSource {
  id: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
}

export function projectServerPublicProfile(server: ServerPublicProfileSource) {
  return {
    id: server.id,
    name: server.name,
    slug: server.slug,
    avatarUrl: isStoredServerScopedAvatarUrl(server.avatarUrl, `server-${server.id}`)
      ? server.avatarUrl
      : null,
  };
}
