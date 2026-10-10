// Stash Adventure: choose-your-own-adventure viewing in the normal Stash
// player, from Stash's own data (tags, performers, markers), without a heart
// rate. Two modes, picked from the Adventure menu in the top bar:
//
//  Chapters     After each chapter (2.5-4 min), when a scene ends, or on Next,
//               three cards are offered over the playing video: stay with her,
//               the story's next step, someone new, or a mystery door. No pick
//               in 20 s plays the highlighted card. Picks jump to a marked part.
//  Full videos  Scenes play whole. The left sidebar lists the story's next
//               picks; click one when you are ready to move on. PMV, CH and JOI
//               can be switched on as breaks (and JOI as warm-up teases).
//
// The story moves from warming up to building to peak; Finish turns it toward
// how scenes end. Stash's own Handy support follows the player as usual.
(function () {
    'use strict';

    const CHAPTER_MS = [150000, 240000];
    const PICK_SECONDS = 20;
    const RECENT = 40;

    // ---- tag map (same as EdgeLoop's src/js/library/tag-map.js) ---------------

    const RULES = [
        ['act', 'Oral', /^(bj|blowjob|blowjob - pov|blowjob only|deepthroat|sloppy blowjob|face fuck|double blowjob.*|oral sex|ball (sucking|licking).*|cock worship|gagging)$/i],
        ['act', 'Handjob', /^(handjob|handjob - pov|handjob to completion|dick play)$/i],
        ['act', 'Titjob', /^(titjob|titty fuck)$/i],
        ['act', 'Footjob', /^(footjob|foot fetish)$/i],
        ['act', 'Sex', /^(vaginal sex|all vaginal|hardcore|clothed sex)$/i],
        ['act', 'Anal', /^(anal sex|anal)$/i],
        ['act', 'Tease', /^(tease|joi|edging|masturbation|striptease|dirty talk)$/i],
        ['act', 'Threesome', /^(threesome.*)$/i],
        ['act', 'Licking', /^(pussy licking|rimming|facesitting|69)$/i],
        ['position', 'Cowgirl', /^(cowgirl|cowgirl - pov|riding)$/i],
        ['position', 'Reverse cowgirl', /^reverse cowgirl( - pov)?$/i],
        ['position', 'Doggy', /^(doggy style|doggy style - pov|standing doggy style)$/i],
        ['position', 'Missionary', /^missionary( - pov)?$/i],
        ['position', 'Spooning', /^(side fuck|spooning)$/i],
        ['finish', 'Facial', /^(facial|facial - pov|open mouth facial)$/i],
        ['finish', 'In her mouth', /^(cum in mouth|mouth creampie|cum swallowing)$/i],
        ['finish', 'Creampie', /^(creampie|vaginal creampie|cum drip)$/i],
        ['finish', 'On her body', /^(cum on (tits|stomach|pussy|ass|body))$/i],
        ['finish', 'By hand', /^(handjob to completion|girls finishing the job)$/i],
        ['finish', 'Cumshot', /^cumshot$/i],
        ['vibe', 'Amateur', /^(amateur|homemade|reality porn)$/i],
        ['vibe', 'Rough', /^(rough|spanking|spitting|wild)$/i],
        ['vibe', 'Passionate', /^(passion|kissing|eye contact|girlfriend|romantic)$/i],
        ['vibe', 'Taboo', /^(taboo|family roleplay|step (sister|brother|dad|daughter|mom)|cheating|older \/ younger)$/i],
        ['vibe', 'Story', /^(narrative|3rd person narrative|cosplay)$/i],
        ['setting', 'Bedroom', /^(bed|bedroom)$/i],
        ['setting', 'Couch', /^(couch|living room)$/i],
        ['setting', 'Outdoors', /^outdoors$/i],
        ['setting', 'Bathroom', /^(bathroom|shower)$/i]
    ];

    function categorize(names) {
        const out = { act: new Set(), position: new Set(), finish: new Set(), vibe: new Set(), setting: new Set(), pov: false };
        for (const raw of names) {
            const name = String(raw).trim();
            if (/ - pov$|^male - pov$|^pov$/i.test(name)) out.pov = true;
            for (const [g, label, re] of RULES) if (re.test(name)) out[g].add(label);
        }
        if (out.position.size) out.act.add('Sex');
        return out;
    }

    // ---- library -------------------------------------------------------------

    async function gql(query, variables) {
        const r = await fetch('/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
        const j = await r.json();
        if (j.errors) throw new Error(j.errors[0].message);
        return j.data;
    }

    // The library folder a scene sits in (the first folder under one of
    // Stash's library paths), lower case: e.g. pmv, ch, joi.
    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
    function folderOf(path, roots) {
        const p = norm(path);
        const root = roots.filter(r => p.toLowerCase().startsWith(r.toLowerCase() + '/')).sort((a, b) => b.length - a.length)[0];
        if (!root) return '';
        const rest = p.slice(root.length + 1).split('/');
        return (rest.length > 1 ? rest[0] : '').toLowerCase();
    }

    let library = null;
    async function loadLibrary() {
        if (library) return library;
        const d = await gql(`{ findScenes(scene_filter:{ interactive:true }, filter:{ per_page:-1 }) { scenes {
            id title files { duration path basename } paths { screenshot interactive_heatmap } tags { name }
            performers { id name gender hair_color ethnicity height_cm fake_tits image_path }
            scene_markers { seconds primary_tag { name } tags { name } } } } }`);
        let roots = [];
        try { roots = ((await gql('{ configuration { general { stashes { path } } } }')).configuration.general.stashes || []).map(x => norm(x.path)); } catch { /* no folders */ }
        library = d.findScenes.scenes.map(s => {
            const folder = folderOf(s.files?.[0]?.path, roots);
            const profile = categorize(s.tags.map(t => t.name));
            if (folder === 'joi') profile.act.add('Tease');
            const parts = (s.scene_markers || []).map(m => ({ at: m.seconds, c: categorize([m.primary_tag?.name, ...(m.tags || []).map(t => t.name)].filter(Boolean)) }))
                .sort((a, b) => a.at - b.at);
            for (const p of parts) for (const g of ['act', 'position', 'finish']) for (const l of p.c[g]) profile[g].add(l);
            return { ...s, folder, profile, parts, duration: s.files?.[0]?.duration || 0 };
        });
        return library;
    }

    // Which scenes the story picks from. Chapters: everything but PMV and CH
    // (compilations hold too many people). Full videos: the main folders, plus
    // JOI while warming up when that option is on.
    function storyPool(stage) {
        if (state.mode === 'chapters') return library.filter(s => s.folder !== 'pmv' && s.folder !== 'ch');
        return library.filter(s => s.folder !== 'pmv' && s.folder !== 'ch' && (s.folder !== 'joi' || (opts.joi && stage === 'warm')));
    }

    // ---- cards (same shape as EdgeLoop's adventure.js) --------------------------

    const STAGES = {
        warm: { acts: ['Tease', 'Handjob', 'Oral', 'Footjob'], label: 'Warming up' },
        build: { acts: ['Oral', 'Handjob', 'Titjob', 'Sex', 'Licking'], label: 'Building' },
        peak: { acts: ['Sex', 'Oral', 'Threesome'], label: 'Peak' },
        finish: { acts: [], label: 'Finish' }
    };
    const POSITIONS = ['Cowgirl', 'Reverse cowgirl', 'Doggy', 'Missionary', 'Spooning'];
    const FINISHES = ['Facial', 'In her mouth', 'Creampie', 'On her body', 'Cumshot', 'By hand'];
    const stageFor = (chapter, finishing) => finishing ? 'finish' : chapter < 2 ? 'warm' : chapter < 5 ? 'build' : 'peak';

    const HAIR = { Blonde: 'Blonde', Brunette: 'Brunette', Black: 'Dark-haired', Red: 'Redhead', Auburn: 'Auburn', Various: 'Colourful hair' };
    function describe(p) {
        if (!p) return '';
        const bits = [];
        if (HAIR[p.hair_color]) bits.push(HAIR[p.hair_color]);
        if (p.ethnicity && !/other|mixed/i.test(p.ethnicity)) bits.push(p.ethnicity);
        if (Number.isFinite(p.height_cm)) { const i = Math.round(p.height_cm / 2.54); bits.push(`${Math.floor(i / 12)}'${i % 12}"`); }
        if (p.fake_tits && /natural|^no$/i.test(p.fake_tits)) bits.push('natural');
        return bits.join(' · ');
    }
    const lead = (s) => (s.performers || []).find(p => p.gender !== 'MALE') || null;
    const first = (set) => [...(set || [])][0] || null;
    const shuffle = (list) => list.map(s => ({ s, k: Math.random() })).sort((a, b) => a.k - b.k).map(x => x.s);

    // Where a picked scene starts. Full videos: from the beginning (the end
    // part when finishing). Chapters: the marked part that shows what the card
    // promised, else the beginning.
    function startFor(scene, want, finishing) {
        const hits = want ? scene.parts.filter(p => p.c.act.has(want) || p.c.position.has(want) || p.c.finish.has(want)) : [];
        if (state.mode === 'full') return { at: 0, marked: hits.length > 0 };
        if (hits.length) return { at: Math.max(0, (finishing ? hits[hits.length - 1] : hits[0]).at - 1), marked: true };
        if (finishing && scene.duration) return { at: Math.floor(scene.duration * 0.7), marked: false };
        return { at: 0, marked: false };
    }

    function buildCards({ current, chapter, finishing, recent, count = 3 }) {
        const stage = stageFor(chapter, finishing);
        const rule = STAGES[stage];
        const used = new Set(current ? [current.id] : []);
        const fresh = (s) => !used.has(s.id) && !recent.includes(s.id);
        // Scenes shown in the last few lists go to the back of the queue, so
        // the same ones do not keep coming up.
        const seen = new Set(state.seen);
        const shuffled = shuffle(storyPool(stage));
        const pool = [...shuffled.filter(s => !seen.has(s.id)), ...shuffled.filter(s => seen.has(s.id))];
        const cards = [];
        const make = (kind, s, title, hint, want) => {
            const start = startFor(s, want, finishing);
            const p = lead(s);
            used.add(s.id);
            const markNote = start.marked ? (state.mode === 'full' ? 'has that part' : 'starts at that part') : null;
            cards.push({
                kind, title, hint: [hint, markNote].filter(Boolean).join(' · '), scene: s,
                sceneId: s.id, at: start.at, image: p?.image_path || s.paths.screenshot, name: p?.name || null,
                labels: [finishing ? first(s.profile.finish) : null, first(s.profile.position), first(s.profile.act), s.profile.pov ? 'POV' : null]
                    .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3)
            });
            return true;
        };
        const pick = (list, fn) => { for (const s of list) if (fn(s)) return true; return false; };

        const her = current ? lead(current) : null;
        if (her) pick(pool.filter(s => fresh(s) && (s.performers || []).some(p => p.id === her.id)), s => make('stay', s, `Stay with ${her.name}`, first(s.profile.position) || first(s.profile.act) || '', null));

        // The story's next step: first an act (or position, or finish) picked at
        // random from what this stage offers, then a scene that has it. Picking
        // the scene first made one common act (oral) win almost every time.
        const targets = shuffle(finishing ? FINISHES : stage === 'peak' ? [...POSITIONS, 'Oral'] : rule.acts)
            .filter(t => finishing || chapter === 0 || !(current?.profile.act.has(t) || current?.profile.position.has(t)) || Math.random() < 0.3);
        const has = (s, t) => s.profile.act.has(t) || s.profile.position.has(t) || s.profile.finish.has(t);
        const stepFor = (t) => {
            const list = pool.filter(s => fresh(s) && has(s, t));
            const marked = list.filter(s => startFor(s, t, finishing).marked);
            return (Math.random() < 0.6 && marked.length ? marked : list)[0] || null;
        };
        let tried = 0;
        const nextStep = () => {
            while (tried < targets.length) {
                const t = targets[tried++];
                const s = stepFor(t);
                if (s) return make('step', s, finishing ? `Finish: ${t}` : t, describe(lead(s)), t);
            }
            return false;
        };
        nextStep();

        pick(pool.filter(s => fresh(s) && lead(s) && lead(s).id !== her?.id && (!finishing || s.profile.finish.size)), s => make('someone', s, 'Someone new', describe(lead(s)), finishing ? first(s.profile.finish) : null));

        // A fourth slot (the sidebar) is a second step with a different act.
        if (count > 3) nextStep();

        while (cards.length < count) {
            const ok = pick(pool.filter(s => fresh(s) && (!finishing || s.profile.finish.size)), s => make('mystery', s, 'Mystery door', first(s.profile.vibe) || first(s.profile.setting) || 'Anything goes', finishing ? first(s.profile.finish) : null));
            if (!ok) break;
        }
        return { label: rule.label, cards: cards.slice(0, count) };
    }

    // Full videos: breaks between story picks, one of each kind switched on.
    function buildBreaks(current, recent) {
        const out = [];
        const fresh = (s) => s.id !== current?.id && !recent.includes(s.id);
        const one = (folder, kind, title, hint) => {
            const s = shuffle(library.filter(x => x.folder === folder && fresh(x)))[0];
            if (s) out.push({ kind, title, hint, scene: s, sceneId: s.id, at: 0, image: s.paths.screenshot });
        };
        if (opts.pmv) one('pmv', 'pmv', 'PMV break', 'a track to ride or reset to');
        if (opts.ch) one('ch', 'ch', 'Compilation', 'many clips, one stretch');
        if (opts.joi) one('joi', 'joi', 'JOI', 'she sets the pace');
        return out;
    }

    // ---- state ------------------------------------------------------------------

    // The mode lives only as long as you are in it: it is started from the
    // menu each time and ends on Off, a reload, or leaving the scene pages, so
    // it never lingers over normal viewing. (Older builds saved it; that is
    // cleared here.)
    const OPTS_KEY = 'stashAdventure.options';
    localStorage.removeItem('stashAdventure.mode');
    localStorage.removeItem('stashAdventure.on');
    const state = { mode: 'off', chapter: 0, finishing: false, endsAt: Infinity, cards: null, deadline: 0, suggested: 0, recent: [], seen: [], pending: null, lastScene: null };
    let opts = { pmv: false, ch: false, joi: false };
    try { opts = { ...opts, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { /* defaults */ }

    const sceneId = () => (location.pathname.match(/^\/scenes\/(\d+)/) || [])[1] || null;
    const player = () => document.querySelector('.video-js video.vjs-tech') || document.querySelector('.video-js video');

    function go(id) {
        history.pushState({}, '', `/scenes/${id}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }

    // ---- top bar ------------------------------------------------------------------

    function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    const MODE_NAMES = { off: 'Off', chapters: 'Chapters', full: 'Full videos' };

    function addControls() {
        const bar = document.querySelector('.navbar-buttons');
        if (!bar || document.getElementById('adv-controls')) return;
        const wrap = el('span', 'adv-controls');
        wrap.id = 'adv-controls';
        const toggle = el('button', 'btn btn-secondary adv-toggle');
        toggle.type = 'button';
        const menu = el('div', 'adv-menu adv-hidden');
        for (const m of ['off', 'chapters', 'full']) {
            const b = el('button', 'adv-menu-item', MODE_NAMES[m]);
            b.type = 'button';
            b.dataset.mode = m;
            b.addEventListener('click', () => { menu.classList.add('adv-hidden'); setMode(m); });
            menu.append(b);
        }
        toggle.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('adv-hidden'); renderControls(); });
        document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) menu.classList.add('adv-hidden'); });
        const next = el('button', 'btn btn-secondary adv-next', 'Next');
        next.type = 'button';
        next.title = 'Show the cards now';
        next.addEventListener('click', () => showCards('What next?').catch(() => {}));
        const fin = el('button', 'btn btn-secondary adv-finish', 'Finish');
        fin.type = 'button';
        fin.title = 'Turn the story toward how scenes end';
        fin.addEventListener('click', () => {
            state.finishing = !state.finishing || state.mode === 'chapters';
            renderControls();
            if (state.mode === 'chapters') showCards('Finish: how does it end?').catch(() => {});
            else renderSidebar(true);
        });
        const anchor = el('span', 'adv-anchor');
        anchor.append(toggle, menu);
        wrap.append(anchor, next, fin);
        bar.prepend(wrap);
        renderControls();
    }

    function renderControls() {
        const t = document.querySelector('.adv-toggle');
        if (!t) return;
        const on = state.mode !== 'off';
        t.textContent = on ? `Adventure: ${MODE_NAMES[state.mode]} · ${STAGES[stageFor(state.chapter, state.finishing)].label}` : 'Adventure';
        t.classList.toggle('on', on);
        t.title = 'Choose your own adventure';
        document.querySelectorAll('.adv-menu-item').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
        document.querySelector('.adv-next')?.classList.toggle('adv-hidden', state.mode !== 'chapters');
        document.querySelector('.adv-finish')?.classList.toggle('adv-hidden', !on);
        document.querySelector('.adv-finish')?.classList.toggle('on', state.finishing);
        document.body.classList.toggle('adv-full', state.mode === 'full');
    }

    function setMode(mode) {
        state.mode = mode;
        Object.assign(state, { chapter: 0, finishing: false, endsAt: Infinity, cards: null, pending: null, recent: [], seen: [], lastScene: sceneId() });
        hideCards();
        // A fresh start: no list left over from an earlier run.
        document.querySelectorAll('.adv-side').forEach(b => b.remove());
        sidebarFor = null;
        renderControls();
        if (mode === 'off') return;
        if (sceneId()) {
            if (mode === 'chapters') state.endsAt = Date.now() + chapterLength();
            else renderSidebar(true);
        } else {
            showCards('How do you want to start?').catch(() => {});
        }
    }

    const chapterLength = () => CHAPTER_MS[0] + Math.random() * (CHAPTER_MS[1] - CHAPTER_MS[0]);

    // ---- chapter cards (overlay) ------------------------------------------------

    let overlay = null;
    let timer = 0;

    async function showCards(heading) {
        if (state.mode === 'off') return;
        await loadLibrary();
        const id = sceneId();
        const current = id ? library.find(s => s.id === id) : null;
        const offer = buildCards({ current, chapter: state.chapter, finishing: state.finishing, recent: state.recent });
        if (!offer.cards.length) return;
        state.cards = offer.cards;
        remember(offer.cards);
        state.suggested = Math.floor(Math.random() * offer.cards.length);
        state.deadline = Date.now() + PICK_SECONDS * 1000;
        state.endsAt = Infinity;
        if (!overlay) { overlay = el('div', 'adv-overlay'); document.body.append(overlay); }
        overlay.replaceChildren();
        const head = el('div', 'adv-head');
        head.append(el('b', null, `${heading} · ${offer.label}`), el('span', 'adv-timer'));
        const close = el('button', 'btn btn-sm btn-secondary', 'Keep watching');
        close.type = 'button';
        close.addEventListener('click', () => { hideCards(); if (state.mode === 'chapters') state.endsAt = Date.now() + chapterLength(); });
        head.append(close);
        const row = el('div', 'adv-row');
        offer.cards.forEach((c, i) => {
            const card = el('button', `adv-card adv-${c.kind}` + (i === state.suggested ? ' adv-suggested' : ''));
            card.type = 'button';
            const img = el('div', 'adv-img');
            img.style.backgroundImage = `url("${c.image}")`;
            const body = el('div', 'adv-body');
            body.append(el('div', 'adv-title', c.title));
            body.append(el('div', 'adv-hint', c.kind === 'mystery' ? c.hint : [c.kind === 'stay' ? null : c.name, c.hint].filter(Boolean).join(' · ')));
            const tags = el('div', 'adv-tags');
            if (c.kind !== 'mystery') for (const l of c.labels) tags.append(el('span', null, l));
            body.append(tags);
            card.append(img, body);
            card.addEventListener('click', () => pickCard(c));
            row.append(card);
        });
        overlay.append(head, row);
        overlay.classList.remove('adv-hidden');
        clearInterval(timer);
        timer = setInterval(tickCards, 250);
        tickCards();
    }

    function tickCards() {
        if (!state.cards || !overlay) return;
        // Full videos never picks for you: the first scene waits for a click.
        if (state.mode === 'full') { const t = overlay.querySelector('.adv-timer'); if (t) t.textContent = ''; return; }
        const left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
        const t = overlay.querySelector('.adv-timer');
        if (t) t.textContent = `${left}s, then the highlighted card plays`;
        if (left <= 0) pickCard(state.cards[state.suggested]);
    }

    function hideCards() {
        clearInterval(timer);
        state.cards = null;
        overlay?.classList.add('adv-hidden');
    }

    function pickCard(c) {
        if (!c) return;
        hideCards();
        state.chapter++;
        state.recent.push(c.sceneId);
        while (state.recent.length > RECENT) state.recent.shift();
        state.pending = { id: c.sceneId, at: c.at, since: Date.now() };
        state.lastScene = c.sceneId;
        state.endsAt = state.mode === 'chapters' ? Date.now() + chapterLength() : Infinity;
        renderControls();
        if (sceneId() === c.sceneId) startPending();
        else go(c.sceneId);
        if (state.mode === 'full') setTimeout(() => renderSidebar(true), 600);
    }

    // After switching scenes: once Stash's player has the new video, play it
    // (Stash does not preload) and jump to the chosen part once it can.
    function startPending() {
        const p = state.pending;
        if (!p) return;
        if (Date.now() - p.since > 20000) { state.pending = null; return; }
        const v = player();
        if (sceneId() !== p.id || !v || !(v.currentSrc || v.src || '').includes(`/scene/${p.id}/`)) return;
        state.pending = null;
        const jump = () => { try { if (p.at > 0 && Math.abs(v.currentTime - p.at) > 2) v.currentTime = p.at; } catch { /* not seekable */ } };
        if (v.readyState >= 1) jump();
        else v.addEventListener('loadedmetadata', jump, { once: true });
        v.play().catch(() => {});
    }

    // ---- full videos: the sidebar -------------------------------------------------

    let sidebarFor = null;

    function sideItem(c) {
        const a = el('a', `upnext-item adv-item adv-${c.kind}`);
        a.href = `/scenes/${c.sceneId}`;
        a.addEventListener('click', (e) => { if (e.button === 0 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); pickCard(c); } });
        // One compact row: picture (with length and heatmap) | kind, title, who.
        const pic = el('div', 'adv-pic');
        const thumb = el('div', 'adv-thumb');
        thumb.style.backgroundImage = `url("${c.scene.paths.screenshot}")`;
        const m = Math.floor((c.scene.duration || 0) / 60);
        const sec = Math.floor((c.scene.duration || 0) % 60);
        if (c.scene.duration) thumb.append(el('span', 'adv-dur', `${m}:${String(sec).padStart(2, '0')}`));
        const heat = el('img', 'adv-heat');
        heat.loading = 'lazy';
        heat.alt = '';
        if (c.scene.paths.interactive_heatmap) heat.src = c.scene.paths.interactive_heatmap;
        pic.append(thumb, heat);
        const text = el('div', 'adv-text');
        text.append(el('div', 'adv-kind', c.title));
        const title = c.kind === 'mystery' ? (c.hint || '') : (c.scene.title || c.scene.files?.[0]?.basename || `Scene ${c.sceneId}`);
        text.append(el('div', 'adv-line adv-name', title));
        const who = c.kind === 'mystery' ? '' : [c.kind === 'stay' ? null : c.name, c.kind === 'stay' ? c.hint : null].filter(Boolean).join(' · ');
        if (who) text.append(el('div', 'adv-line adv-who', who));
        a.title = [c.title, c.kind === 'mystery' ? null : title, c.name, c.hint].filter(Boolean).join('\n');
        a.append(pic, text);
        return a;
    }

    async function renderSidebar(force) {
        if (state.mode !== 'full') return;
        const id = sceneId();
        const tabs = document.querySelector('.scene-tabs');
        if (!id || !tabs) return;
        let box = tabs.querySelector(':scope > .adv-side');
        if (!box) {
            box = el('div', 'upnext adv-side');
            const head = el('div', 'upnext-head');
            head.append(el('b', 'adv-side-title'), el('span', 'upnext-actions'));
            const actions = head.querySelector('.upnext-actions');
            const shuffleBtn = el('button', 'btn btn-secondary btn-sm', 'Shuffle');
            shuffleBtn.type = 'button';
            shuffleBtn.addEventListener('click', () => renderSidebar(true));
            const details = el('button', 'btn btn-secondary btn-sm', 'Details');
            details.type = 'button';
            details.addEventListener('click', () => tabs.classList.toggle('upnext-show-details'));
            actions.append(shuffleBtn, details);
            const list = el('div', 'upnext-list');
            const optRow = el('div', 'adv-opts');
            for (const [k, label] of [['pmv', 'PMV'], ['ch', 'CH'], ['joi', 'JOI']]) {
                const lab = el('label', 'adv-opt');
                const cb = el('input');
                cb.type = 'checkbox';
                cb.checked = Boolean(opts[k]);
                // Only the Breaks rows change; the story picks stay where they are.
                cb.addEventListener('change', () => { opts[k] = cb.checked; localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); renderBreaks(); fitSidebar(); });
                lab.append(cb, document.createTextNode(' ' + label));
                optRow.append(lab);
            }
            box.append(head, optRow, list);
            tabs.prepend(box);
        }
        if (!force && sidebarFor === id) return;
        sidebarFor = id;
        await loadLibrary();
        const current = library.find(s => s.id === id) || null;
        // A scene reached some other way (Stash's own links) still moves the story on.
        if (state.lastScene && state.lastScene !== id && !force) state.chapter++;
        state.lastScene = id;
        renderControls();
        const offer = buildCards({ current, chapter: state.chapter, finishing: state.finishing, recent: state.recent, count: 4 });
        box.querySelector('.adv-side-title').textContent = `Next · ${offer.label}`;
        const list = box.querySelector('.upnext-list');
        list.replaceChildren(...offer.cards.map(sideItem));
        remember(offer.cards);
        renderBreaks();
        list.scrollTop = 0;
        fitSidebar();
    }

    // The Breaks rows (PMV, CH, JOI), rebuilt on their own when a box is ticked.
    function renderBreaks() {
        const list = document.querySelector('.adv-side .upnext-list');
        if (!list || !library) return;
        list.querySelectorAll('.adv-section, .adv-pmv, .adv-ch, .adv-joi').forEach(e => e.remove());
        const current = library.find(s => s.id === sceneId()) || null;
        const breaks = state.finishing ? [] : buildBreaks(current, state.recent);
        if (!breaks.length) return;
        list.append(el('div', 'adv-section', 'Breaks'));
        for (const b of breaks) list.append(sideItem(b));
        remember(breaks);
    }

    function remember(cards) {
        for (const c of cards) state.seen.push(c.sceneId);
        if (state.seen.length > 40) state.seen.splice(0, state.seen.length - 40);
    }

    // Rows share the sidebar's full height. Short rows are side by side
    // (picture | text); tall ones stack (picture over text) so the pictures
    // use the width as well.
    function fitSidebar() {
        const box = document.querySelector('.adv-side');
        const list = box?.querySelector('.upnext-list');
        if (!list || state.mode !== 'full') return;
        const items = list.querySelectorAll('.adv-item').length;
        if (!items) return;
        const sections = list.querySelectorAll('.adv-section').length;
        const gap = 6;
        const free = window.innerHeight - list.getBoundingClientRect().top - 10 - sections * 20 - (items + sections) * gap;
        const row = Math.max(44, Math.floor(free / items));
        // The slim 280px column: each pick is a picture tile filling its share
        // of the height, with the text over its lower edge.
        const side = 280;
        box.classList.remove('adv-stacked');
        box.classList.add('adv-tiles');
        box.style.setProperty('--row', `${row}px`);
        box.style.setProperty('--text', `${Math.max(12, Math.min(16, Math.round(row * 0.08)))}px`);
        document.body.style.setProperty('--adv-side', `${side}px`);
    }
    window.addEventListener('resize', fitSidebar);

    // ---- loop ---------------------------------------------------------------------

    let watched = null;
    function watchPlayer() {
        const v = player();
        if (v === watched) return;
        watched = v;
        if (v) v.addEventListener('ended', () => {
            if (state.mode === 'chapters' && !state.cards) showCards('Scene over: what next?').catch(() => {});
            if (state.mode === 'full') document.querySelector('.adv-side')?.classList.add('adv-ready');
        });
        if (v) v.addEventListener('play', () => document.querySelector('.adv-side')?.classList.remove('adv-ready'));
    }

    setInterval(() => {
        addControls();
        renderControls();
        if (state.mode === 'off') return;
        // Leaving the scene pages ends the adventure (not while the first cards
        // are up, or while a picked scene is loading).
        if (!sceneId() && !state.cards && !state.pending) { setMode('off'); return; }
        watchPlayer();
        startPending();
        if (state.mode === 'full') { renderSidebar(false).then(fitSidebar).catch(() => {}); return; }
        const v = player();
        if (!state.cards && sceneId() && v && !v.paused && Date.now() >= state.endsAt) showCards('Chapter over').catch(() => {});
        if (!state.cards && sceneId() && state.endsAt === Infinity) state.endsAt = Date.now() + chapterLength();
    }, 1000);

    new MutationObserver(addControls).observe(document.body, { childList: true, subtree: true });
    window.__stashAdventure = { get state() { return { ...state, cards: state.cards?.length || 0, library: library?.length ?? null, opts }; } };
})();
