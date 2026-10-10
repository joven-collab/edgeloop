import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCards, profileScenes, autoPick, stageFor, describePerformer } from './adventure.js';
import { categorize } from '../library/tag-map.js';

const lv = (n, l) => Array.from({ length: n }, () => l);
const scene = (id, tags, performers = [], level = 2) => ({ id, pool: 'regular', tags, performers, levelArray: lv(12, level) });
const performers = {
    p1: { id: 'p1', name: 'Ann', gender: 'FEMALE', hair: 'Blonde', ethnicity: 'Caucasian', heightCm: 160, natural: true },
    p2: { id: 'p2', name: 'Bea', gender: 'FEMALE', hair: 'Red', heightCm: 170 }
};
const lib = () => profileScenes([
    scene('1', ['BJ', 'Male - POV'], ['p1']),
    scene('2', ['Cowgirl', 'Facial'], ['p1']),
    scene('3', ['Handjob'], ['p2']),
    scene('4', ['Doggy Style', 'Creampie', 'Amateur'], ['p2']),
    scene('5', ['Tease', 'Lingerie'], []),
    { ...scene('6', ['Blowjob']), pool: 'pmv' }
]);

describe('tag map', () => {
    it('folds duplicates into one clean label', () => {
        const c = categorize(['BJ', 'Blowjob - POV', 'Reverse Cowgirl - POV', 'Open Mouth Facial']);
        assert.deepEqual([...c.act].sort(), ['Oral', 'Sex']);
        assert.deepEqual([...c.position], ['Reverse cowgirl']);
        assert.deepEqual([...c.finish], ['Facial']);
        assert.equal(c.pov, true);
    });
});

describe('adventure cards', () => {
    it('offers distinct scenes from the regular pool only', () => {
        const { cards } = buildCards({ scenes: lib(), performers, rand: () => 0.5 });
        assert.ok(cards.length >= 2);
        assert.equal(new Set(cards.map(c => c.sceneId)).size, cards.length);
        assert.ok(cards.every(c => c.sceneId !== '6'));
    });

    it('offers to stay with the performer playing now', () => {
        const scenes = lib();
        const { cards } = buildCards({ scenes, performers, current: scenes[0], chapter: 2, rand: () => 0.5 });
        const stay = cards.find(c => c.kind === 'stay');
        assert.ok(stay, 'a stay card');
        assert.equal(stay.sceneId, '2');
        assert.equal(stay.title, 'Stay with Ann');
    });

    it('finishing offers scenes that end somewhere, from their last part', () => {
        const { cards, stage } = buildCards({ scenes: lib(), performers, finishing: true, chapter: 6, rand: () => 0.5 });
        assert.equal(stage, 'finish');
        for (const c of cards) {
            assert.ok(['2', '4'].includes(c.sceneId), c.sceneId);
            assert.ok(c.index >= 8, 'last 30%');
        }
    });

    it('moves from tease to build to peak', () => {
        assert.equal(stageFor(0, false), 'warm');
        assert.equal(stageFor(3, false), 'build');
        assert.equal(stageFor(9, false), 'peak');
        assert.equal(stageFor(1, true), 'finish');
    });

    it('heart rate picks the card nearest what it allows', () => {
        assert.equal(autoPick([{ level: 4 }, { level: 1 }, { level: 2 }], 2), 2);
        assert.equal(autoPick([], 2), -1);
    });

    it('describes a performer without naming her', () => {
        assert.equal(describePerformer(performers.p1), 'Blonde · Caucasian · 5\'3" · natural');
    });
});

import { chapterLabels, scriptChapters } from '../library/tag-map.js';

describe('funscript chapters', () => {
    it('reads the shorthand script authors use', () => {
        assert.deepEqual(chapterLabels('BJ / HJ'), ['Oral', 'Handjob']);
        assert.deepEqual(chapterLabels('RV CG'), ['Reverse cowgirl']);
        assert.deepEqual(chapterLabels('Cowgirl + Handjob Finish'), ['Cowgirl', 'Handjob', 'Finish']);
        assert.deepEqual(chapterLabels('Up / Down'), []);
        assert.deepEqual(chapterLabels('Intro'), ['Break']);
    });

    it('keeps action chapters with their times', () => {
        const ch = scriptChapters([
            { name: 'Intro', startTime: '00:00:00.000', endTime: '00:00:30.000' },
            { name: 'Doggy', startTime: '00:02:00.500', endTime: '00:04:00.000' },
            { name: 'Up / Down', startTime: '00:04:00.000', endTime: '00:05:00.000' }
        ]);
        assert.equal(ch.length, 1);
        assert.deepEqual({ start: ch[0].start, end: ch[0].end, labels: ch[0].labels }, { start: 120.5, end: 240, labels: ['Doggy'] });
    });
});

describe('marked parts', () => {
    it('a step card starts at the marked part it promises', () => {
        const scenes = profileScenes([
            { ...scene('7', ['Handjob'], ['p2']), markers: [{ s: 60, tags: ['Handjob'] }, { s: 95, tags: ['Cowgirl'] }] },
            scene('8', ['Tease'])
        ]);
        const { cards } = buildCards({ scenes, performers, chapter: 6, rand: () => 0.5 });
        const step = cards.find(c => c.kind === 'step');
        assert.equal(step.sceneId, '7');
        assert.equal(step.title, 'Cowgirl');
        assert.equal(step.fromMs, 94000);
        assert.match(step.hint, /starts at that part/);
    });
});
