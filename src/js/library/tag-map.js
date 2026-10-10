// Stash tags as the adventure mode understands them. The library's tags grew
// by hand and by scraper (BJ / Blowjob / Blowjob - POV are the same act), so
// this map folds them into a few clean groups without touching Stash:
//   act       what is happening       (oral, handjob, sex, ...)
//   position  how                     (cowgirl, doggy, ...)
//   finish    how it ends             (facial, creampie, ...)
//   vibe      the feel of the scene   (amateur, rough, taboo, ...)
//   setting   where                   (bedroom, outdoors, ...)
//   outfit    what she wears          (lingerie, cosplay, ...)
// plus a POV flag. Anything unmatched is simply not used for choices.

const RULES = [
    ['act', 'Oral', /^(bj|blowjob|blowjob - pov|blowjob only|deepthroat|sloppy blowjob|face fuck|double blowjob.*|oral sex|ball (sucking|licking).*|cock worship|gagging)$/i],
    ['act', 'Handjob', /^(handjob|handjob - pov|handjob to completion|dick play)$/i],
    ['act', 'Titjob', /^(titjob|titty fuck)$/i],
    ['act', 'Footjob', /^(footjob|foot fetish)$/i],
    ['act', 'Sex', /^(vaginal sex|all vaginal|hardcore|clothed sex)$/i],
    ['act', 'Anal', /^(anal sex|anal)$/i],
    ['act', 'Tease', /^(tease|joi|edging|masturbation|striptease|dirty talk)$/i],
    ['act', 'Threesome', /^(threesome.*|double blowjob \(2 mouths\))$/i],
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
    ['setting', 'Bathroom', /^(bathroom|shower)$/i],
    ['setting', 'Kitchen', /^kitchen$/i],

    ['outfit', 'Lingerie', /^(lingerie|stockings|bra|panties|thong)$/i],
    ['outfit', 'Cosplay', /^(cosplay|schoolgirl|costume)$/i],
    ['outfit', 'Glasses', /^glasses$/i]
];

export const GROUPS = ['act', 'position', 'finish', 'vibe', 'setting', 'outfit'];

export function categorize(tagNames = []) {
    const out = { act: new Set(), position: new Set(), finish: new Set(), vibe: new Set(), setting: new Set(), outfit: new Set(), pov: false };
    for (const raw of tagNames) {
        const name = String(raw).trim();
        if (/ - pov$|^male - pov$|^pov$/i.test(name)) out.pov = true;
        for (const [group, label, re] of RULES) if (re.test(name)) out[group].add(label);
    }
    // A position means sex even when the scene was not tagged with the act.
    if (out.position.size) out.act.add('Sex');
    return out;
}

// Plain arrays, for storing on a scene.
export function tagProfile(tagNames) {
    const c = categorize(tagNames);
    return Object.fromEntries([...GROUPS.map(g => [g, [...c[g]]]), ['pov', c.pov]]);
}

// ---- funscript chapters -------------------------------------------------------
// Script authors name chapters freely ("BJ / HJ", "RV CG", "Doggy", "Fin").
// Each part is folded to one clean label; axis labels from multi-axis
// scripts ("Up / Down", "Diagonal", single letters) mean nothing here.

const CHAPTER_WORDS = [
    [/^(bj\d*|blow ?job|oral|deepthroat|sucking)$/i, 'Oral'],
    [/^(hj|hand ?job)$/i, 'Handjob'],
    [/^(tj|tit ?job|titty ?fuck)$/i, 'Titjob'],
    [/^(foot ?job|feet)$/i, 'Footjob'],
    [/^(rv ?cg|rcg|reverse ?cowgirl|reverse)$/i, 'Reverse cowgirl'],
    [/^(cg|cowgirl|riding)$/i, 'Cowgirl'],
    [/^(doggy|doggy ?style|standing doggy)$/i, 'Doggy'],
    [/^(missionary|mish)$/i, 'Missionary'],
    [/^(spoon|spooning|side)$/i, 'Spooning'],
    [/^(sex|fuck|fucking)$/i, 'Sex'],
    [/^(pussy ?licking|licking|eating)$/i, 'Licking'],
    [/^(tease|teasing|joi)$/i, 'Tease'],
    [/^(fin|finish|finale|cum|cumshot|nut|end|climax)$/i, 'Finish'],
    [/^(intro|outro|narration|break|filler|posing|nr|stop|solo|intro .*)$/i, 'Break']
];

export function chapterLabels(name) {
    const parts = String(name || '').split(/\s*(?:\/|\+|&|,| and )\s*/i).map(s => s.trim()).filter(Boolean);
    const labels = [];
    for (const part of parts) {
        const hit = CHAPTER_WORDS.find(([re]) => re.test(part));
        let label = hit?.[1];
        // "Cowgirl Handjob Finish" style names: try each word.
        if (!label) for (const w of part.split(/\s+/)) { const h = CHAPTER_WORDS.find(([re]) => re.test(w)); if (h) { label = h[1]; if (!labels.includes(label)) labels.push(label); } }
        else if (!labels.includes(label)) labels.push(label);
    }
    return labels;
}

function secondsOf(t) {
    if (typeof t === 'number') return t;
    const parts = String(t || '').split(':').map(Number);
    if (parts.some(n => !Number.isFinite(n))) return null;
    return parts.reduce((s, n) => s * 60 + n, 0);
}

// Clean chapters from a funscript's metadata: [{ start, end, name, labels }],
// action chapters only (breaks and axis labels dropped), in time order.
export function scriptChapters(metadataChapters) {
    if (!Array.isArray(metadataChapters)) return [];
    return metadataChapters
        .map(c => ({ name: String(c?.name || '').trim(), start: secondsOf(c?.startTime), end: secondsOf(c?.endTime), labels: chapterLabels(c?.name) }))
        .filter(c => c.start !== null && c.labels.length && !(c.labels.length === 1 && c.labels[0] === 'Break'))
        .map(c => ({ ...c, labels: c.labels.filter(l => l !== 'Break') }))
        .sort((a, b) => a.start - b.start);
}
