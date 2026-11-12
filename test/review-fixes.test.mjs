// Regression tests for the six findings of the automated review of upstream PR #3.
// Every test here failed before its fix. Fixtures are synthetic (test/fixtures/notion-id-folders).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPlugin } from './lib/load-plugin.mjs';
import { dirHandle } from './lib/fs-handle.mjs';
import { FakeThymer, FakeDateTime } from './lib/fake-thymer.mjs';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fast = { sleep: async () => {} };
const plugin = newPlugin({ DateTime: FakeDateTime });

// ---------------------------------------------------------------------------------------------
// Finding 1 (P1): a Notion rows folder named with the database id ("Tasks <id>/" next to "Tasks <id>.csv")
// ---------------------------------------------------------------------------------------------

const TASKS_ID = '35033016139844f5dc950ed83f95f548';
const WRITE_ID = 'b8d14f4f3ebc709057423aa5891dfcc0';

/** Builds the parse input of a tiny export from { path: text }; assets are not needed. */
function inMemory(entries) {
    return { files: new Map(), texts: new Map(Object.entries(entries)) };
}

const TASKS_CSV = 'Name,Status\nWrite report,Open\nShip release,Done\n';
const page = (title, body = 'Body.') => `# ${title}\n\nStatus: Open\n\n${body}\n`;

test('finding 1: a rows folder named with the database id is claimed (fixture)', async () => {
    const plan = await plugin.parseNotionExport(dirHandle(path.join(FIXTURES, 'notion-id-folders')));
    assert.deepEqual(plan.collections.map(c => c.name), ['Tasks'], 'no "Notion Pages" collection: every page belongs to a row');
    const write = plan.records.find(r => r.title === 'Write report');
    assert.ok(write.sourcePath.endsWith(`Tasks ${TASKS_ID}/Write report ${WRITE_ID}.md`), write.sourcePath);
    assert.match(write.body, /Draft the quarterly summary\./);
    assert.doesNotMatch(write.body, /Status: Open/, 'the property block is stripped');
    const db = plan.parseReport.databases[0];
    assert.equal(db.matched, 2);
    assert.deepEqual(db.pagesWithoutRow, []);
    assert.equal(plan.parseReport.standalonePages, 0);
});

test('finding 1: the full csv stem wins over a plain-name folder; id-only and sanitised-name folders are claimed too', async () => {
    const stem = `Tasks ${TASKS_ID}`;
    const base = 'x_ExportBlock-1';
    const claimedTitles = (plan) => plan.records.filter(r => r.collection === 'notion-db:' + TASKS_ID).map(r => r.sourcePath);

    // full stem first, even when a plain "Tasks/" folder with other pages sits beside it
    let plan = plugin._notionBuildPlan(inMemory({
        [`${base}/${stem}.csv`]: TASKS_CSV,
        [`${base}/${stem}/Write report aaaa1111aaaa1111aaaa1111aaaa1111.md`]: page('Write report', 'From the id folder.'),
        [`${base}/Tasks/Ship release bbbb2222bbbb2222bbbb2222bbbb2222.md`]: page('Ship release', 'From the plain folder.')
    }));
    assert.match(plan.records.find(r => r.title === 'Write report').body, /From the id folder\./);
    assert.equal(plan.records.find(r => r.title === 'Write report').sourcePath.includes(`${stem}/`), true);
    const plainPage = plan.records.find(r => r.sourcePath.includes('/Tasks/Ship release ') && r.sourcePath.endsWith('.md'));
    assert.equal(plainPage.collection, 'notion-pages', 'the plain folder is not a rows folder when the id folder exists');

    // the id folder was renamed, but it still ends with the database id
    plan = plugin._notionBuildPlan(inMemory({
        [`${base}/${stem}.csv`]: TASKS_CSV,
        [`${base}/Old Tasks ${TASKS_ID}/Write report aaaa1111aaaa1111aaaa1111aaaa1111.md`]: page('Write report'),
        [`${base}/Old Tasks ${TASKS_ID}/Ship release bbbb2222bbbb2222bbbb2222bbbb2222.md`]: page('Ship release')
    }));
    assert.equal(claimedTitles(plan).length, 2);
    assert.ok(plan.records.every(r => r.collection === 'notion-db:' + TASKS_ID));

    // name with the id stripped (the form the existing fixtures use)
    plan = plugin._notionBuildPlan(inMemory({
        [`${base}/${stem}.csv`]: TASKS_CSV,
        [`${base}/Tasks/Write report aaaa1111aaaa1111aaaa1111aaaa1111.md`]: page('Write report'),
        [`${base}/Tasks/Ship release bbbb2222bbbb2222bbbb2222bbbb2222.md`]: page('Ship release')
    }));
    assert.equal(plan.parseReport.databases[0].matched, 2);

    // Notion sanitised a character in the folder name differently from the csv's
    plan = plugin._notionBuildPlan(inMemory({
        [`${base}/Tasks: 2024 ${TASKS_ID}.csv`]: TASKS_CSV,
        [`${base}/Tasks 2024/Write report aaaa1111aaaa1111aaaa1111aaaa1111.md`]: page('Write report'),
        [`${base}/Tasks 2024/Ship release bbbb2222bbbb2222bbbb2222bbbb2222.md`]: page('Ship release')
    }));
    assert.equal(plan.parseReport.databases[0].matched, 2);
});

test('finding 1: re-importing the id-folder export updates the same records', async () => {
    const plan = await plugin.parseNotionExport(dirHandle(path.join(FIXTURES, 'notion-id-folders')));
    const thymer = new FakeThymer();
    plugin.data = thymer.data;
    await plugin.applyImportPlan(plan, fast);
    const second = await plugin.applyImportPlan(plan, fast);
    assert.equal(second.counts.recordsCreated, 0);
    assert.equal(second.counts.recordsUpdated, plan.records.length);
    assert.equal(thymer.collection('Notion Pages'), null);
});

// ---------------------------------------------------------------------------------------------
// Finding 2 (P1): CSV rows without a page that share a title must not share a dedupe path
// ---------------------------------------------------------------------------------------------

test('finding 2: page-less rows with the same title get distinct, stable, id-free source paths', async () => {
    const plan = await plugin.parseNotionExport(dirHandle(path.join(FIXTURES, 'notion-id-folders')));
    const pageless = plan.records.filter(r => !r.sourcePath.endsWith('.md'));
    const paths = pageless.map(r => r.sourcePath.split('/').slice(-2).join('/'));
    assert.deepEqual(paths, ['Tasks/Call plumber', 'Tasks/Call plumber#2', 'Tasks/Untitled', 'Tasks/Untitled#2'],
        'first occurrence keeps the old path (existing imports still dedupe), later ones get #n in csv order');
    assert.equal(new Set(plan.records.map(r => r.sourcePath.toLowerCase())).size, plan.records.length, 'every record has its own source path');
    assert.ok(pageless.every(r => !r.sourcePath.includes(TASKS_ID)), 'paths stay id-free');
    // both rows keep their own values
    assert.deepEqual(pageless.slice(0, 2).map(r => r.values.status), ['Open', 'Done']);
});

test('finding 2: the paths do not move when unrelated rows or pages are added to a later export', () => {
    const stem = 'e_ExportBlock-1/Tasks ' + TASKS_ID;
    const rows = 'Name,Status\nCall plumber,Open\nCall plumber,Done\n';
    const before = plugin._notionBuildPlan(inMemory({ [`${stem}.csv`]: rows }));
    const after = plugin._notionBuildPlan(inMemory({
        [`${stem}.csv`]: 'Name,Status\nWrite report,Open\n' + rows.split('\n').slice(1).join('\n'),
        [`${stem}/Write report aaaa1111aaaa1111aaaa1111aaaa1111.md`]: page('Write report')
    }));
    const plumber = (plan) => plan.records.filter(r => r.title === 'Call plumber').map(r => r.sourcePath);
    assert.deepEqual(plumber(after), plumber(before));
});

test('finding 2: the report names the colliding titles', async () => {
    const plan = await plugin.parseNotionExport(dirHandle(path.join(FIXTURES, 'notion-id-folders')));
    const db = plan.parseReport.databases[0];
    assert.deepEqual(db.duplicateRowsWithoutPage.map(d => [d.title, d.count]), [['Call plumber', 2], ['Untitled', 2]]);
    const summary = plugin._notionSummarize(plan, { counts: {}, errors: [], warnings: [], unresolvedLinks: [] });
    const section = summary.sections.find(s => /share a title/i.test(s.title));
    assert.ok(section, 'the summary has a section for it');
    assert.ok(section.items.some(i => i.includes('Call plumber') && i.includes('#2')), section.items.join(' | '));
});

test('finding 2: both rows become records, and re-import neither duplicates nor merges them', async () => {
    const plan = await plugin.parseNotionExport(dirHandle(path.join(FIXTURES, 'notion-id-folders')));
    const thymer = new FakeThymer();
    plugin.data = thymer.data;
    const first = await plugin.applyImportPlan(plan, fast);
    assert.equal(first.counts.recordsCreated, 6);
    const records = await thymer.collection('Tasks').getAllRecords();
    assert.equal(records.length, 6);
    assert.deepEqual(records.filter(r => r.getName() === 'Call plumber').map(r => r.prop('status').choiceLabel()).sort(), ['Done', 'Open']);
    const second = await plugin.applyImportPlan(plan, fast);
    assert.equal(second.counts.recordsCreated, 0);
    assert.equal((await thymer.collection('Tasks').getAllRecords()).length, 6);
});

// ---------------------------------------------------------------------------------------------
// Finding 5 (P2): Tolaria field ids must not collide ("cost ($)" and "cost (%)" both slugify to "cost")
// ---------------------------------------------------------------------------------------------

/** A webkitdirectory-style file list from { 'vault/note.md': text }. */
function memoryVault(entries) {
    const files = Object.entries(entries).map(([rel, text]) => {
        const file = new File([text], rel.split('/').pop());
        Object.defineProperty(file, 'webkitRelativePath', { value: rel });
        return file;
    });
    return { kind: 'filelist', files };
}
const note = (frontmatter, title) => `---\n${frontmatter}\n---\n# ${title}\n\nText.\n`;

test('finding 5: distinct keys that slugify alike get distinct field ids and keep their own values', async () => {
    const plan = await plugin.parseTolariaVault(memoryVault({
        'vault/a.md': note('cost ($): 10\nStatus: open', 'A'),
        'vault/b.md': note('cost (%): 5\nstatus: closed', 'B')
    }));
    const fields = plan.collections[0].fields;
    assert.deepEqual(fields.map(f => f.id).sort(), ['cost', 'cost_2', 'status'], 'two cost fields; Status/status still share one');
    const idOf = (label) => fields.find(f => f.label === label).id;
    const a = plan.records.find(r => r.title === 'A');
    const b = plan.records.find(r => r.title === 'B');
    assert.equal(a.values[idOf('Cost ($)')], 10);
    assert.equal(b.values[idOf('Cost (%)')], 5);
    assert.equal(a.values[idOf('Cost (%)')], undefined);
    assert.equal(Object.keys(a.values).length, 2);
    assert.deepEqual(plugin.validateImportPlan(plan), []);
});

test('finding 5: ids are allocated in sorted key order, so they do not depend on which note comes first', async () => {
    const one = await plugin.parseTolariaVault(memoryVault({
        'vault/a.md': note('cost ($): 10', 'First'),
        'vault/b.md': note('cost (%): 5', 'Second')
    }));
    const two = await plugin.parseTolariaVault(memoryVault({
        'vault/a.md': note('cost (%): 5', 'Second'),
        'vault/b.md': note('cost ($): 10', 'First')
    }));
    const map = (plan) => Object.fromEntries(plan.collections[0].fields.map(f => [f.label, f.id]));
    assert.deepEqual(map(one), map(two));
    assert.deepEqual(map(one), { 'Cost ($)': 'cost', 'Cost (%)': 'cost_2' });   // "cost ($)" sorts before "cost (%)"
});

test('finding 5: a key that slugifies to an already allocated "name_2" does not take it over', async () => {
    const plan = await plugin.parseTolariaVault(memoryVault({
        'vault/a.md': note('cost ($): 1\ncost (%): 2\ncost_2: 3', 'A')
    }));
    const ids = plan.collections[0].fields.map(f => f.id);
    assert.equal(new Set(ids).size, 3, ids.join(','));
    const a = plan.records[0];
    assert.deepEqual(Object.values(a.values).sort(), [1, 2, 3]);
});

test('finding 5 (Notion): column ids were already collision-free, including the "(text)" companion', async () => {
    const stem = `e_ExportBlock-1/Gear ${TASKS_ID}`;
    const plan = plugin._notionBuildPlan(inMemory({
        [`${stem}.csv`]: 'Name,Cost ($),Cost (%),Cost\nDrill,10,5,high\n'
    }));
    const ids = plan.collections[0].fields.map(f => f.id);
    assert.deepEqual(ids, ['cost', 'cost_2', 'cost_3']);
    const drill = plan.records[0];
    assert.deepEqual(drill.values, { cost: 10, cost_2: 5, cost_3: 'high' });
});
