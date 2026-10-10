// Local setup. Everything here is optional: with no loop.config.json the app
// works with a Stash library of any shape, reading the library folders from
// Stash itself. loop.config.json is gitignored; loop.config.example.json
// shows every field.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
    stashUrl: 'http://localhost:9999',
    // Override the library folders Stash reports (Settings > Library).
    libraryRoots: null,
    // Folder name (first folder under a library root, any case) -> pool:
    // "regular", "pmv" or "skip". Folders not listed use otherFolders.
    folders: {},
    otherFolders: 'regular',
    // A scene with one of these tags (or in a folder named like "PMV") is a
    // PMV track unless its folder is listed above.
    pmvTags: ['PMV'],
    // Folders the face-match tools leave alone (compilations hold too many people).
    faceMatchSkipFolders: ['pmv', 'compilations']
};

export function loadConfig(root) {
    let file = {};
    try { file = JSON.parse(fs.readFileSync(path.join(root, 'loop.config.json'), 'utf8')); } catch { /* none: defaults */ }
    const cfg = { ...DEFAULTS, ...file };
    cfg.stashUrl = String(process.env.STASH_URL || cfg.stashUrl).replace(/\/$/, '');
    cfg.folders = Object.fromEntries(Object.entries(cfg.folders || {}).map(([k, v]) => [k.toLowerCase(), v]));
    cfg.faceMatchSkipFolders = (cfg.faceMatchSkipFolders || []).map(f => String(f).toLowerCase());
    return cfg;
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

// The library folders: from the config if set, else from Stash. `gql` is
// (query) => data.
export async function libraryRoots(cfg, gql) {
    if (Array.isArray(cfg.libraryRoots) && cfg.libraryRoots.length) return cfg.libraryRoots.map(norm);
    try {
        const d = await gql('{ configuration { general { stashes { path } } } }');
        return (d.configuration.general.stashes || []).map(s => norm(s.path)).filter(Boolean);
    } catch { return []; }
}

// The first folder under the library root a file sits in, as written on disk;
// '' for a file straight in the root. Outside every root: the file's own folder.
export function folderFor(filePath, roots = []) {
    const p = norm(filePath);
    const lower = p.toLowerCase();
    const root = roots
        .filter(r => lower.startsWith(r.toLowerCase() + '/'))
        .sort((a, b) => b.length - a.length)[0];
    if (root) {
        const rest = p.slice(root.length + 1).split('/');
        return rest.length > 1 ? rest[0] : '';
    }
    const parts = p.split('/');
    return parts.length > 1 ? parts[parts.length - 2] : '';
}

// Which pool a scene plays in: 'regular', 'pmv', or null (left out).
export function poolFor(folder, tags = [], cfg = DEFAULTS) {
    const f = String(folder || '').toLowerCase();
    const rule = cfg.folders?.[f] ?? (/\bpmv\b/i.test(f) || hasTag(tags, cfg.pmvTags) ? 'pmv' : cfg.otherFolders);
    return rule === 'regular' || rule === 'pmv' ? rule : null;
}

function hasTag(tags, wanted = []) {
    const w = new Set(wanted.map(t => String(t).toLowerCase()));
    return tags.some(t => w.has(String(t).toLowerCase()));
}
