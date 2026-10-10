// Scene Up Next: on a scene page the sidebar becomes a list of similar
// scripted scenes (same performers first, then studio, then shared tags), so
// the next one can be picked without backing out. Stash's own tabs are one
// click away under "Details".
(function () {
    'use strict';

    const COUNT = 12;
    const SHOW_DETAILS = 'sceneUpNext.details';

    async function gql(query, variables) {
        const r = await fetch('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
        const j = await r.json();
        if (j.errors) throw new Error(j.errors[0].message);
        return j.data;
    }

    const FIELDS = 'id title files { basename duration } paths { screenshot interactive_heatmap } performers { id name } tags { id } studio { id }';

    async function similar(sceneId) {
        const cur = (await gql(`query($id:ID!){ findScene(id:$id){ ${FIELDS} } }`, { id: sceneId })).findScene;
        if (!cur) return [];
        const perf = cur.performers.map(p => p.id);
        const tags = cur.tags.map(t => t.id);
        const pools = [];
        if (perf.length) pools.push(gql(`query($v:[ID!]){ findScenes(scene_filter:{ interactive:true, performers:{ value:$v, modifier:INCLUDES } }, filter:{ per_page:40, sort:"random" }){ scenes { ${FIELDS} } } }`, { v: perf }));
        if (cur.studio) pools.push(gql(`query($v:[ID!]){ findScenes(scene_filter:{ interactive:true, studios:{ value:$v, modifier:INCLUDES } }, filter:{ per_page:30, sort:"random" }){ scenes { ${FIELDS} } } }`, { v: [cur.studio.id] }));
        if (tags.length) pools.push(gql(`query($v:[ID!]){ findScenes(scene_filter:{ interactive:true, tags:{ value:$v, modifier:INCLUDES } }, filter:{ per_page:80, sort:"random" }){ scenes { ${FIELDS} } } }`, { v: tags }));
        const seen = new Map();
        for (const res of await Promise.allSettled(pools)) {
            if (res.status !== 'fulfilled') continue;
            for (const s of res.value.findScenes.scenes) if (s.id !== cur.id) seen.set(s.id, s);
        }
        const score = (s) =>
            4 * s.performers.filter(p => perf.includes(p.id)).length +
            2 * (cur.studio && s.studio?.id === cur.studio.id ? 1 : 0) +
            s.tags.filter(t => tags.includes(t.id)).length +
            Math.random() * 1.5;
        return [...seen.values()].map(s => ({ s, k: score(s) })).sort((a, b) => b.k - a.k).slice(0, COUNT).map(x => x.s);
    }

    const fmt = (sec) => {
        if (!Number.isFinite(sec)) return '';
        const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    };

    // Stash is a single-page app: moving there through the history API keeps
    // the page (and the Handy connection) alive.
    function go(id) {
        history.pushState({}, '', `/scenes/${id}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }

    let shownFor = null;
    let loading = false;

    function panel(tabs) {
        let box = tabs.querySelector(':scope > .upnext');
        if (box) return box;
        box = document.createElement('div');
        box.className = 'upnext';
        box.innerHTML = '<div class="upnext-head"><b>Up next</b><span class="upnext-actions"><button type="button" class="btn btn-secondary btn-sm upnext-shuffle" title="Different suggestions">Shuffle</button><button type="button" class="btn btn-secondary btn-sm upnext-details" title="Stash\'s scene tabs">Details</button></span></div><div class="upnext-list"></div>';
        box.querySelector('.upnext-shuffle').addEventListener('click', () => { shownFor = null; refresh(true); });
        box.querySelector('.upnext-details').addEventListener('click', () => {
            const on = !tabs.classList.contains('upnext-show-details');
            tabs.classList.toggle('upnext-show-details', on);
            localStorage.setItem(SHOW_DETAILS, on ? 'on' : 'off');
        });
        tabs.prepend(box);
        tabs.classList.toggle('upnext-show-details', localStorage.getItem(SHOW_DETAILS) === 'on');
        return box;
    }

    function render(box, scenes) {
        const list = box.querySelector('.upnext-list');
        if (!scenes.length) { list.innerHTML = '<p class="upnext-empty">No similar scripted scenes found.</p>'; return; }
        list.replaceChildren(...scenes.map(s => {
            const a = document.createElement('a');
            a.className = 'upnext-item';
            a.href = `/scenes/${s.id}`;
            a.addEventListener('click', (e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); go(s.id); } });
            const img = document.createElement('div');
            img.className = 'upnext-thumb';
            img.style.backgroundImage = `url("${s.paths.screenshot}")`;
            const dur = document.createElement('span');
            dur.className = 'upnext-dur';
            dur.textContent = fmt(s.files?.[0]?.duration);
            img.append(dur);
            const heat = document.createElement('img');
            heat.className = 'upnext-heat';
            heat.loading = 'lazy';
            heat.alt = '';
            if (s.paths.interactive_heatmap) heat.src = s.paths.interactive_heatmap;
            const title = document.createElement('div');
            title.className = 'upnext-title';
            title.textContent = s.title || s.files?.[0]?.basename || `Scene ${s.id}`;
            const who = document.createElement('div');
            who.className = 'upnext-who';
            who.textContent = s.performers.map(p => p.name).slice(0, 3).join(', ');
            a.append(img, heat, title, who);
            return a;
        }));
    }

    async function refresh(force) {
        const m = location.pathname.match(/^\/scenes\/(\d+)/);
        const tabs = document.querySelector('.scene-tabs');
        if (!m || !tabs) return;
        const box = panel(tabs);
        if ((shownFor === m[1] && !force) || loading) return;
        loading = true;
        shownFor = m[1];
        box.querySelector('.upnext-list').innerHTML = '<p class="upnext-empty">Finding similar scenes…</p>';
        try { render(box, await similar(m[1])); } catch (e) { box.querySelector('.upnext-list').innerHTML = `<p class="upnext-empty">Could not load suggestions: ${e.message}</p>`; }
        loading = false;
        box.querySelector('.upnext-list').scrollTop = 0;
    }

    setInterval(() => { refresh(false).catch(() => {}); }, 1000);
})();
