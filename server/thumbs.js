// Small pictures for the hub's grids. Stash's scene screenshots can be full
// 4K stills (up to ~500 KB each) and it has no smaller size, so each picture
// is shrunk once to a WebP of the width asked for, kept in data/thumbs, and
// served from there with a long browser cache. A background pass builds the
// whole library's set after start-up, so scrolling never waits for it.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const THUMB_WIDTHS = [320, 480, 640];

export function createThumbs({ root, stashUrl, headers }) {
    const dir = path.join(root, 'data', 'thumbs');
    fs.mkdirSync(dir, { recursive: true });
    const inFlight = new Map();
    const genFile = path.join(dir, 'generation.txt');
    // Bumped on every rebuild; the hub puts it in picture links so the
    // browser's long cache never shows an old copy.
    let generation = Number(fs.existsSync(genFile) ? fs.readFileSync(genFile, 'utf8') : 0) || 0;
    const progress = { running: false, done: 0, total: 0 };

    const base = () => (typeof stashUrl === 'function' ? stashUrl() : stashUrl);
    const source = (kind, id) => kind === 'performer' ? `${base()}/performer/${id}/image` : `${base()}/scene/${id}/screenshot`;
    // One file per picture and width. Stash screenshots rarely change; to
    // rebuild them all, empty data/thumbs.
    const fileFor = (kind, id, width) => path.join(dir, `${kind}-${id}-${width}.webp`);

    async function build(kind, id, width, file) {
        const r = await fetch(source(kind, id), { headers: headers() });
        if (!r.ok) throw new Error(`Stash ${r.status}`);
        const input = Buffer.from(await r.arrayBuffer());
        const tmp = file + '.tmp';
        await sharp(input).resize({ width, withoutEnlargement: true }).webp({ quality: 72 }).toFile(tmp);
        fs.renameSync(tmp, file);
        return file;
    }

    // Path of the small picture, made now if it does not exist yet.
    async function get(kind, id, width, v = '') {
        const w = THUMB_WIDTHS.includes(width) ? width : 480;
        const file = fileFor(kind, id, w, v);
        if (fs.existsSync(file)) return file;
        if (inFlight.has(file)) return inFlight.get(file);
        const p = build(kind, id, w, file).finally(() => inFlight.delete(file));
        inFlight.set(file, p);
        return p;
    }

    // Build missing pictures a few at a time, quietly.
    async function warm(items, concurrency = 2) {
        let next = 0, made = 0;
        Object.assign(progress, { running: true, done: 0, total: items.length });
        const worker = async () => {
            while (next < items.length) {
                const it = items[next++];
                progress.done++;
                if (fs.existsSync(fileFor(it.kind, it.id, it.width, it.v))) continue;
                try { await get(it.kind, it.id, it.width, it.v); made++; } catch { /* skip this one */ }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, worker));
        progress.running = false;
        return made;
    }

    function status() {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.webp'));
        const bytes = files.reduce((n, f) => { try { return n + fs.statSync(path.join(dir, f)).size; } catch { return n; } }, 0);
        return { generation, files: files.length, bytes, ...progress };
    }

    // Throw away every small picture so the next pass makes them fresh.
    function clear() {
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.webp') || f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
        generation++;
        fs.writeFileSync(genFile, String(generation));
    }

    return { get, warm, status, clear, generation: () => generation };
}
