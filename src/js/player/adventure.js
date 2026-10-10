// Choose your own adventure: after each chapter the player offers a few cards
// and plays the one picked. Cards come from scene tags (through the tag map)
// and performer profiles; the story moves from tease to build to peak, and
// Finish turns the cards toward how scenes end. Heart rate still caps the
// intensity of whatever is picked, and picks for you if you do not.
// Pure: no DOM, timers or fetches.

import { categorize } from '../library/tag-map.js';
import { chooseWindow, windowIndexAt } from './director.js';

export const CHAPTER_MS = { min: 150000, max: 240000 };  // 2.5-4 minutes
export const CARD_COUNT = 3;

// What each stage of the story leans toward.
export const STAGES = {
    warm: { acts: ['Tease', 'Handjob', 'Oral', 'Footjob'], maxLevel: 2, label: 'Warming up' },
    build: { acts: ['Oral', 'Handjob', 'Titjob', 'Sex', 'Licking'], maxLevel: 4, label: 'Building' },
    peak: { acts: ['Sex', 'Oral', 'Threesome'], maxLevel: 5, label: 'Peak' },
    finish: { acts: [], maxLevel: 5, label: 'Finish' }
};

export function stageFor(chapter, finishing) {
    if (finishing) return 'finish';
    if (chapter < 2) return 'warm';
    if (chapter < 5) return 'build';
    return 'peak';
}

// Scene profiles are worked out once per library load.
// Stash markers (timestamps) add what each part of a scene shows, so a card
// can start right at that part.
export function profileScenes(scenes) {
    for (const s of scenes) {
        if (s.profile) continue;
        s.profile = categorize(s.tags || []);
        s.parts = (s.markers || []).map(m => ({ startMs: Math.round(m.s * 1000), c: categorize(m.tags) }));
        for (const p of s.parts) for (const g of ['act', 'position', 'finish']) for (const l of p.c[g]) s.profile[g].add(l);
    }
    return scenes;
}

// The marked part of a scene that shows `label` (latest first when finishing).
function partFor(scene, label, finishing) {
    if (!label || !scene.parts?.length) return null;
    const hits = scene.parts.filter(p => p.c.act.has(label) || p.c.position.has(label) || p.c.finish.has(label));
    if (!hits.length) return null;
    return finishing ? hits[hits.length - 1] : hits[0];
}

function shuffle(list, rand) {
    return list
        .map(s => ({ s, key: Math.pow(Math.max(rand(), 1e-9), 1 / Math.max(0.01, s.weight ?? 1)) }))
        .sort((a, b) => b.key - a.key)
        .map(x => x.s);
}

const HAIR = { Blonde: 'Blonde', Brunette: 'Brunette', Black: 'Dark-haired', Red: 'Redhead', Auburn: 'Auburn', Various: 'Colourful hair' };

export function describePerformer(p) {
    if (!p) return '';
    const bits = [];
    if (p.hair && HAIR[p.hair]) bits.push(HAIR[p.hair]);
    if (p.ethnicity && !/other|mixed/i.test(p.ethnicity)) bits.push(p.ethnicity);
    if (Number.isFinite(p.heightCm)) {
        const inches = Math.round(p.heightCm / 2.54);
        bits.push(`${Math.floor(inches / 12)}'${inches % 12}"`);
    }
    if (p.natural === true) bits.push('natural');
    return bits.join(' · ');
}

function lead(scene, performers) {
    for (const id of scene.performers || []) {
        const p = performers[id];
        if (p && p.gender !== 'MALE') return p;
    }
    return null;
}

function mainLabel(scene, group) {
    return [...(scene.profile?.[group] || [])][0] || null;
}

// A starting section for a picked scene: near the target, capped by the
// stage, in the last 30% when finishing.
export function sectionFor(scene, { target, maxLevel, finishing, rand }) {
    const levels = scene.levelArray || [];
    const minIndex = finishing ? Math.floor(levels.length * 0.7) : 0;
    const want = Math.min(target, maxLevel);
    return chooseWindow(levels, want, { rand, maxLevel: Math.max(maxLevel, want), minIndex })
        ?? chooseWindow(levels, want, { rand, maxLevel: 5, minIndex })
        ?? (finishing ? Math.min(minIndex, Math.max(0, levels.length - 2)) : null);
}

// Build the cards. `current` is the scene playing now (or null at the start).
export function buildCards({ scenes, performers = {}, current = null, chapter = 0, finishing = false, target = 2, recent = [], rand = Math.random }) {
    const stage = stageFor(chapter, finishing);
    const rule = STAGES[stage];
    const used = new Set(current ? [current.id] : []);
    const fresh = (s) => !used.has(s.id) && !recent.includes(s.id);
    const pool = scenes.filter(s => s.pool === 'regular' && s.levelArray?.length);
    const cards = [];

    const make = (kind, scene, title, hint, want = null) => {
        const part = partFor(scene, want, finishing);
        const index = part ? windowIndexAt(part.startMs) : sectionFor(scene, { target, maxLevel: rule.maxLevel, finishing, rand });
        if (index === null || index === undefined) return false;
        const p = lead(scene, performers);
        used.add(scene.id);
        cards.push({
            kind, title, hint, sceneId: scene.id, index,
            fromMs: part ? Math.max(0, part.startMs - 1000) : null,
            level: scene.levelArray[index],
            performerId: p?.id ?? null,
            performerName: p?.name ?? null,
            labels: [mainLabel(scene, 'finish') && finishing ? mainLabel(scene, 'finish') : null, mainLabel(scene, 'position'), mainLabel(scene, 'act'), scene.profile?.pov ? 'POV' : null]
                .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3)
        });
        return true;
    };

    const first = (list, fn) => { for (const s of list) if (fn(s)) return true; return false; };
    const ordered = shuffle(pool, rand);

    // 1. Stay with her: another scene with the performer playing now.
    const her = current ? lead(current, performers) : null;
    if (her) {
        const more = ordered.filter(s => fresh(s) && (s.performers || []).includes(her.id));
        first(more, s => make('stay', s, `Stay with ${her.name}`, labelHint(s, finishing)));
    }

    // 2. The story's next step: an act (or a finish) this stage wants.
    const wantActs = finishing ? null : rule.acts.filter(a => !current?.profile?.act.has(a) || chapter === 0);
    const stepList = ordered.filter(s => fresh(s) && (finishing ? s.profile.finish.size > 0 : [...s.profile.act].some(a => wantActs.includes(a))));
    const stepTitle = (s) => {
        if (finishing) return `Finish: ${mainLabel(s, 'finish')}`;
        const act = [...s.profile.act].find(a => wantActs.includes(a) && a !== 'Sex');
        if (stage === 'peak' || !act) return mainLabel(s, 'position') || act || mainLabel(s, 'act') || 'Something new';
        return act;
    };
    // Scenes with a marked part showing what is wanted usually come first
    // (not always, so the ~190 marked scenes do not crowd out the rest).
    const stepWant = (s) => finishing ? mainLabel(s, 'finish') : stepTitle(s);
    const marked = stepList.filter(s => partFor(s, stepWant(s), finishing));
    const markedFirst = rand() < 0.6;
    first(markedFirst ? [...marked, ...stepList.filter(s => !marked.includes(s))] : stepList, s => make('step', s, stepTitle(s), [describePerformer(lead(s, performers)), partFor(s, stepWant(s), finishing) ? 'starts at that part' : null].filter(Boolean).join(' · '), stepWant(s)));

    // 3. Someone new, described by her profile.
    const newcomers = ordered.filter(s => fresh(s) && lead(s, performers) && lead(s, performers).id !== her?.id && (!finishing || s.profile.finish.size > 0));
    first(newcomers, s => make('someone', s, 'Someone new', describePerformer(lead(s, performers)) || labelHint(s, finishing)));

    // 4. Mystery door: only a vibe word to go on. Fills any gap.
    while (cards.length < CARD_COUNT) {
        const mystery = ordered.filter(s => fresh(s) && (!finishing || s.profile.finish.size > 0));
        const ok = first(mystery, s => make('mystery', s, 'Mystery door', mainLabel(s, 'vibe') || mainLabel(s, 'setting') || 'Anything goes'));
        if (!ok) break;
    }
    return { stage, label: rule.label, cards: cards.slice(0, CARD_COUNT) };
}

function labelHint(s, finishing) {
    return [finishing ? mainLabel(s, 'finish') : null, mainLabel(s, 'position'), mainLabel(s, 'act')].filter(Boolean).slice(0, 2).join(' · ');
}

// No pick in time: the card whose section sits closest to what the pulse
// allows; ties go to the first card.
export function autoPick(cards, target) {
    let best = 0;
    let bestD = Infinity;
    cards.forEach((c, i) => {
        const d = Math.abs((c.level ?? target) - target);
        if (d < bestD) { bestD = d; best = i; }
    });
    return cards.length ? best : -1;
}

export function chapterLength(rand = Math.random) {
    return CHAPTER_MS.min + rand() * (CHAPTER_MS.max - CHAPTER_MS.min);
}
