import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderFor, poolFor, libraryRoots } from '../../../server/config.js';

const cfg = (over = {}) => ({ folders: {}, otherFolders: 'regular', pmvTags: ['PMV'], ...over });

test('folderFor takes the first folder under the longest matching library root', () => {
    const roots = ['D:/Media', 'D:/Media/Scripted'];
    assert.equal(folderFor(String.raw`D:\Media\Scripted\Full\a.mp4`, roots), 'Full');
    assert.equal(folderFor(String.raw`D:\Media\pmv\b\c.mp4`, roots), 'pmv');
    assert.equal(folderFor('d:/media/x.mp4', roots), '');
});

test('folderFor outside every root falls back to the file\'s own folder', () => {
    assert.equal(folderFor('/srv/videos/PMV/a.mp4', ['/other']), 'PMV');
    assert.equal(folderFor('a.mp4', []), '');
});

test('poolFor: one big folder plays everything as regular, PMV by tag or folder name', () => {
    assert.equal(poolFor('', [], cfg()), 'regular');
    assert.equal(poolFor('', ['pmv'], cfg()), 'pmv');
    assert.equal(poolFor('My PMV Mixes', [], cfg()), 'pmv');
    assert.equal(poolFor('pmvault', [], cfg()), 'regular');
});

test('poolFor: listed folders win, and otherFolders "skip" leaves the rest out', () => {
    const c = cfg({ folders: { bj: 'regular', pmv: 'pmv', vr: 'skip' }, otherFolders: 'skip', pmvTags: [] });
    assert.equal(poolFor('BJ', ['PMV'], c), 'regular');
    assert.equal(poolFor('pmv', [], c), 'pmv');
    assert.equal(poolFor('vr', [], c), null);
    assert.equal(poolFor('ch', ['PMV'], c), null);
});

test('libraryRoots prefers the config, else asks Stash, else none', async () => {
    assert.deepEqual(await libraryRoots({ libraryRoots: ['E:\\Lib\\'] }, null), ['E:/Lib']);
    const gql = async () => ({ configuration: { general: { stashes: [{ path: String.raw`C:\A` },{ path: '/b/' }] } } });
    assert.deepEqual(await libraryRoots({}, gql), ['C:/A', '/b']);
    assert.deepEqual(await libraryRoots({}, async () => { throw new Error('down'); }), []);
});
