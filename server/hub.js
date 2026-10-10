// The hub's view of the library: every scripted scene in Stash with what the
// browser and the watch page show (titles, performers, tags, markers, sizes),
// pictures pointed at this server's relays so the page never talks to Stash.
// Kept in memory and refreshed on request or after a minute.
import { gql } from './library.js';
import { libraryRoots, folderFor } from './config.js';

const QUERY = `{ findScenes(scene_filter:{ interactive:true }, filter:{ per_page:-1 }) { scenes {
    id title date created_at updated_at play_count o_counter rating100 interactive_speed
    files { duration basename path width height }
    studio { id name }
    tags { id name }
    performers { id name gender updated_at }
    scene_markers { seconds title primary_tag { name } }
} } }`;

const TTL_MS = 60000;
let cache = null;

export async function hubScenes(stash, { refresh = false } = {}) {
    if (!refresh && cache && Date.now() - cache.at < TTL_MS) return cache.data;
    const d = await gql(stash, QUERY);
    const roots = await libraryRoots(stash.cfg, q => gql(stash, q));
    const scenes = d.findScenes.scenes.map(s => {
        const f = s.files?.[0] || {};
        return {
            id: s.id,
            title: s.title || f.basename || `Scene ${s.id}`,
            date: s.date || null,
            added: s.created_at,
            v: s.updated_at ? String(Date.parse(s.updated_at) || '') : '',
            plays: s.play_count || 0,
            o: s.o_counter || 0,
            rating: s.rating100 ?? null,
            speed: s.interactive_speed ?? null,
            duration: f.duration || 0,
            height: f.height || null,
            folder: folderFor(f.path, roots),
            studio: s.studio?.name || null,
            tags: s.tags.map(t => t.name),
            performers: s.performers.map(p => ({ id: p.id, name: p.name, gender: p.gender, v: p.updated_at ? String(Date.parse(p.updated_at) || '') : '' })),
            markers: (s.scene_markers || []).map(m => ({ at: m.seconds, name: m.primary_tag?.name || m.title || '', title: m.title || '' })).sort((a, b) => a.at - b.at)
        };
    });
    cache = { at: Date.now(), data: { syncedAt: new Date().toISOString(), scenes } };
    return cache.data;
}
