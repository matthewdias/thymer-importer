// Soft line breaks: a hard-wrapped Markdown paragraph / list item / quote is one line in Thymer (plan.options.unwrapSoftBreaks,
// set by Tolaria, not by Notion). Synthetic text only.
//
// The first two tests are the regression tests for the bug as it was seen live: insertFromMarkdown() made every continuation
// line its own text item. They fail on the code before the fix (PLUGIN_JS=<older plugin.js> npm test); the rest pin each rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPlugin } from './lib/load-plugin.mjs';
import { FakeDateTime, FakeRecord } from './lib/fake-thymer.mjs';
import { engine, fast, memoryFiles, note, runTolaria, STEM } from './lib/round3.mjs';

const p = newPlugin({ DateTime: FakeDateTime });
const un = (text) => p._planUnwrapSoftBreaks(text);
const lines = (...l) => l.join('\n');

/** Records what insertFromMarkdown() is given while `fn` runs. */
async function captureMarkdown(fn) {
    const seen = [];
    const original = FakeRecord.prototype.insertFromMarkdown;
    FakeRecord.prototype.insertFromMarkdown = function (markdown, ...rest) { seen.push(markdown); return original.call(this, markdown, ...rest); };
    try { await fn(); } finally { FakeRecord.prototype.insertFromMarkdown = original; }
    return seen;
}
const typeDoc = { 'v/note.md': '---\ntype: Type\n---\n# Note\n' };
const body = (...l) => `---\ntype: Note\n---\n# Wrapped\n\n${l.join('\n')}\n`;

// ---- regression: the bug as seen in Thymer ---------------------------------------------------------------

test('regression: a list item with indented continuations and a paragraph wrapped without indent import as one line each', async () => {
    const ctx = engine();
    await runTolaria(ctx, {
        ...typeDoc,
        'v/wrapped.md': body(
            '1. **Licensing (first).** Never redistribute the example vendor\'s code. The widget ships only our',
            '   own code and loads the already-installed modules at runtime. The published repo',
            '   must exclude all of their `.bin` files.',
            '2. Second item, short.',
            '',
            'A paragraph that was wrapped at about eighty columns by the editor that wrote it, so it',
            'continues here without any indent and then',
            'once more.'
        )
    });
    const record = ctx.thymer.recordByTitle('Notes', 'Wrapped');
    const items = await record.getLineItems(false);
    assert.deepEqual(items.map(i => i.type), ['olist', 'olist', 'text'], 'no sibling text item per continuation line');
    assert.equal(items[0].text, '**Licensing (first).** Never redistribute the example vendor\'s code. The widget ships only our own code and loads the already-installed modules at runtime. The published repo must exclude all of their `.bin` files.');
    assert.equal(items[2].text, 'A paragraph that was wrapped at about eighty columns by the editor that wrote it, so it continues here without any indent and then once more.');
});

test('regression: the same text is handed to insertFromMarkdown joined', async () => {
    const ctx = engine();
    const seen = await captureMarkdown(() => runTolaria(ctx, { ...typeDoc, 'v/wrapped.md': body('- one two', '  three four', '', 'five', 'six') }));
    assert.deepEqual(seen, ['- one two three four\n\nfive six']);
});

// ---- the rules -------------------------------------------------------------------------------------------

test('joins with a single space and drops the continuation indentation, whatever it was', () => {
    assert.equal(un(lines('one', 'two', '   three', '\tfour', 'five')), 'one two three four five');
    assert.equal(un(lines('trailing space ', 'next')), 'trailing space next', 'one trailing space is not kept next to the join space');
    assert.equal(un(lines('- item', '    deeply indented continuation')), '- item deeply indented continuation');
});

test('paragraphs stay apart: a blank line is never joined across', () => {
    assert.equal(un(lines('a', 'b', '', 'c', 'd', '', '', 'e')), lines('a b', '', 'c d', '', '', 'e'));
});

test('the previous line is not paragraph or list text: heading, fence, table, thematic break, html, placeholder-only', () => {
    assert.equal(un(lines('# Heading', 'text after')), lines('# Heading', 'text after'));
    assert.equal(un(lines('```', 'x', '```', 'text after')), lines('```', 'x', '```', 'text after'));
    assert.equal(un(lines('| a | b |', '| - | - |', '| 1 | 2 |', 'after')), lines('| a | b |', '| - | - |', '| 1 | 2 |', 'after'));
    assert.equal(un(lines('---', 'text after')), lines('---', 'text after'));
    assert.equal(un(lines('<div>', 'text', '</div>')), lines('<div>', 'text', '</div>'));
    assert.equal(un(lines('⟦asset:A1⟧', 'caption')), lines('⟦asset:A1⟧', 'caption'));
    assert.equal(un(lines('⟦link:L1⟧', 'caption')), lines('⟦link:L1⟧', 'caption'));
    assert.equal(un(lines('- ⟦asset:A1⟧', '  caption')), lines('- ⟦asset:A1⟧', '  caption'), 'a list item that is only a placeholder');
    assert.equal(un(lines('- [ ] ⟦link:L1⟧', '  caption')), lines('- [ ] ⟦link:L1⟧', '  caption'));
});

test('the current line starts a block: nothing is joined onto the line before it', () => {
    const cases = {
        'ATX heading': '## Heading',
        'bullet -': '- item', 'bullet *': '* item', 'bullet +': '+ item',
        'ordered 1.': '1. item', 'ordered 3)': '3) item',
        'nested bullet': '    - nested', 'indented ordered': '   2. nested',
        'task': '- [ ] todo',
        'quote': '> quoted',
        'backtick fence': '```js', 'tilde fence': '~~~',
        'table row': '| a | b |',
        'thematic -': '---', 'thematic *': '* * *', 'thematic _': '___',
        'html': '<details>',
        'asset placeholder': '⟦asset:A1⟧', 'link placeholder': '⟦link:L3⟧', 'two placeholders': '⟦asset:A1⟧ ⟦asset:A2⟧'
    };
    for (const [name, start] of Object.entries(cases)) {
        const out = un(lines('text line', start));
        assert.ok(out.startsWith('text line\n'), `${name}: "${start}" stays on its own line (got ${JSON.stringify(out)})`);
    }
    // a setext underline is not folded into the paragraph it underlines
    assert.equal(un(lines('Title', 'wraps', '===')), lines('Title wraps', '==='));
    assert.equal(un(lines('Title', 'wraps', '---')), lines('Title wraps', '---'));
    // a table without a leading pipe: its header row is not joined onto the paragraph before it
    assert.equal(un(lines('prose', 'a | b', '- | -', '1 | 2')), lines('prose', 'a | b', '- | -', '1 | 2'));
});

test('a line that merely looks like a block start is plain text: #tag, **bold**, 2.5, a url', () => {
    assert.equal(un(lines('see', '#tag here', '**bold** and', '2.5 million', 'https://example.invalid/x')), 'see #tag here **bold** and 2.5 million https://example.invalid/x');
    assert.equal(un(lines('a', '-not a list', '+1 maybe')), 'a -not a list +1 maybe');
});

test('hard breaks: two spaces or a backslash keep the newline and lose the marker; the line after it can join further lines', () => {
    assert.equal(un(lines('first  ', 'second', 'third')), lines('first', 'second third'));
    assert.equal(un(lines('first\\', 'second', 'third')), lines('first', 'second third'));
    assert.equal(un(lines('first     ', '  second')), lines('first', 'second'), 'the continuation after a hard break loses its indentation too');
    assert.equal(un(lines('ends in an escaped backslash\\\\', 'joins')), 'ends in an escaped backslash\\\\ joins', 'an even run of backslashes is not a hard break');
    assert.equal(un(lines('- one  ', '  two', '- three')), lines('- one', 'two', '- three'));
    // trailing spaces that are not followed by a continuation are not touched
    assert.equal(un(lines('para  ', '', 'next')), lines('para  ', '', 'next'));
    assert.equal(un(lines('para  ', '# h')), lines('para  ', '# h'));
});

test('blockquotes: quote lines join each other, never across a quote / non-quote boundary', () => {
    assert.equal(un(lines('> foo', '> bar', '> baz')), '> foo bar baz');
    assert.equal(un(lines('>foo', '>bar')), '>foo bar');
    assert.equal(un(lines('> a', '>', '> b', '> c')), lines('> a', '>', '> b c'));
    assert.equal(un(lines('text', '> quote', '> more', 'after')), lines('text', '> quote more', 'after'));
    assert.equal(un(lines('> quote', 'lazy continuation')), lines('> quote', 'lazy continuation'));
    assert.equal(un(lines('plain', '> quote')), lines('plain', '> quote'));
    assert.equal(un(lines('> outer', '> > inner', '> > inner two', '> outer two')), lines('> outer', '> > inner inner two', '> outer two'));
    assert.equal(un(lines('> - item', '>   wraps', '> - next')), lines('> - item wraps', '> - next'));
    assert.equal(un(lines('> [!note] Title', '> body one', '> body two')), lines('> [!note] Title', '> body one body two'), 'a callout header keeps its own line');
});

// ---- left untouched --------------------------------------------------------------------------------------

test('fenced code blocks are left untouched: backticks, tildes, longer fences, inside a list item, with a language', () => {
    const fenced = lines('```js', 'const a = 1', '  continued', '', 'const b = 2', '```');
    assert.equal(un(lines('intro', 'more', fenced, 'outro', 'more')), lines('intro more', fenced, 'outro more'));
    const tilde = lines('~~~', 'a', 'b', '~~~');
    assert.equal(un(tilde), tilde);
    assert.equal(un(lines('````', 'a', '```', 'b', '````', 'c', 'd')), lines('````', 'a', '```', 'b', '````', 'c d'), 'a shorter fence inside does not close it');
    const inItem = lines('1. step one', '   wraps', '', '   ```sh', '   ls', '   cd', '   ```', '2. step two');
    assert.equal(un(inItem), lines('1. step one wraps', '', '   ```sh', '   ls', '   cd', '   ```', '2. step two'));
    const directly = lines('1. step', '   ```sh', '   ls', '   cd', '   ```');
    assert.equal(un(directly), directly, 'a fence right under a list item, no blank line');
    assert.equal(un(lines('a', '```not a fence```', 'b')), 'a ```not a fence``` b', 'inline code with three backticks is not a fence');
    assert.equal(un(lines('```', 'unclosed', 'fence')), lines('```', 'unclosed', 'fence'));
});

test('indented code is left untouched, but 4 spaces inside a list item are a continuation', () => {
    const code = lines('para', '', '    code one', '    code two', '', '    code three', 'after code', 'wrapped');
    assert.equal(un(code), lines('para', '', '    code one', '    code two', '', '    code three', 'after code wrapped'));
    assert.equal(un(lines('- item', '', '    four spaces in the item', '    wraps')), lines('- item', '', '    four spaces in the item wraps'));
    assert.equal(un(lines('1. item', '', '       code in the item', '       more code', '   text')), lines('1. item', '', '       code in the item', '       more code', '   text'));
    assert.equal(un(lines('a paragraph', '    keeps going')), 'a paragraph keeps going', 'indented code cannot interrupt a paragraph');
    assert.equal(un(lines('    ```', '    not a fence', '    ```', 'text', 'wraps')), lines('    ```', '    not a fence', '    ```', 'text wraps'));
});

test('tables are left untouched, with or without leading pipes', () => {
    const table = lines('| h1 | h2 |', '|----|----|', '| a  | b  |', '| c  | d  |');
    assert.equal(un(lines('intro', 'wrapped', '', table, '', 'outro', 'wrapped')), lines('intro wrapped', '', table, '', 'outro wrapped'));
    const bare = lines('h1 | h2', '--- | ---', 'a | b', 'c | d');
    assert.equal(un(bare), bare);
});

test('html blocks, comments, <pre> and $$ blocks are left untouched', () => {
    const html = lines('<div class="x">', 'inner text', 'more text', '</div>', '', 'after', 'wraps');
    assert.equal(un(html), lines('<div class="x">', 'inner text', 'more text', '</div>', '', 'after wraps'));
    const comment = lines('<!--', 'a', 'b', '', 'c', '-->', 'text', 'wraps');
    assert.equal(un(comment), lines('<!--', 'a', 'b', '', 'c', '-->', 'text wraps'));
    const pre = lines('<pre>', 'a', '', 'b', '</pre>', 'x');
    assert.equal(un(pre), pre);
    const math = lines('$$', 'a = b', '  + c', '$$', 'text', 'wraps');
    assert.equal(un(math), lines('$$', 'a = b', '  + c', '$$', 'text wraps'));
    assert.equal(un(lines('<!-- one line -->', 'text', 'wraps')), lines('<!-- one line -->', 'text wraps'));
});

test('list nesting is kept: a nested marker stays on its own line with its indentation', () => {
    const nested = lines('1. first item that', '   wraps', '   - nested bullet that', '     wraps', '     twice', '   - second nested', '2. second', '   wraps', '', '   second paragraph', '   wraps');
    assert.equal(un(nested), lines('1. first item that wraps', '   - nested bullet that wraps twice', '   - second nested', '2. second wraps', '', '   second paragraph wraps'));
    assert.equal(un(lines('- a', '  - b', '    - c', '      c2', '  - b2', '- a2')), lines('- a', '  - b', '    - c c2', '  - b2', '- a2'));
});

test('a single line, CRLF, the empty string and non-strings', () => {
    assert.equal(un('single line'), 'single line');
    assert.equal(un(''), '');
    assert.equal(un('a\nb\n'), 'a b\n', 'the trailing newline stays');
    assert.equal(un('a\r\nb\r\n\r\nc'), 'a b\n\nc');
    assert.equal(un(null), null);
    assert.equal(un(undefined), undefined);
});

test('joining twice changes nothing more (hard breaks aside: the first pass drops their marker, and the engine runs once per body)', () => {
    const text = lines('1. a', '   b', '   - c', '     d', '', '> q', '> r', '', '```', 'x', 'y', '```', '', '| a | b |', '| - | - |', 'p', 'q', 'r');
    assert.equal(un(un(text)), un(text));
});

test('stats.joined counts the lines that were joined, not hard-break or block lines', () => {
    const stats = {};
    p._planUnwrapSoftBreaks(lines('a', 'b', 'c', '', '- d', '  e', '', 'f  ', 'g', '# h'), stats);
    assert.equal(stats.joined, 3);
});

// ---- placeholders ----------------------------------------------------------------------------------------

test('inline placeholders inside a joined line survive untouched', () => {
    assert.equal(un(lines('See ⟦link:L1⟧ and', 'also ⟦link:L2⟧, or', 'maybe ⟦link:L3⟧ at the end')), 'See ⟦link:L1⟧ and also ⟦link:L2⟧, or maybe ⟦link:L3⟧ at the end');
    assert.equal(un(lines('text before', 'a ⟦asset:A1⟧ b')), 'text before a ⟦asset:A1⟧ b');
    assert.equal(un(lines('ends with ⟦link:L1⟧', 'next')), 'ends with ⟦link:L1⟧ next');
});

test('every placeholder of a body is still there, once each, after joining', () => {
    const text = lines('Intro ⟦link:L1⟧ wraps', 'onto ⟦asset:A1⟧ here ⟦link:L2⟧', '', '- item ⟦link:L3⟧', '  and ⟦asset:A2⟧ more', '', '⟦asset:A3⟧');
    const ids = (s) => (s.match(/⟦(?:asset|link):[A-Za-z0-9_-]+⟧/g) || []).sort();
    assert.deepEqual(ids(un(text)), ids(text));
});

test('engine: links and an image that end up mid-paragraph after joining still resolve and are placed', async () => {
    const ctx = engine();
    const files = {
        ...typeDoc,
        'v/target.md': note('type: Note', 'Target'),
        'v/attachments/pic.png': 'PNG',
        'v/wrapped.md': body(
            'This paragraph links to [[target]] near the end of one line and',
            'carries an image ![diagram](attachments/pic.png) in the middle of the next,',
            'then ends with [[target|a label]].',
            '',
            '![diagram](attachments/pic.png)',
            'A caption line right after a lone image.'
        )
    };
    const { report } = await runTolaria(ctx, files);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings.filter(w => /placeholder/.test(w.code)), [], 'no placeholder was left behind');
    assert.equal(report.counts.assetsFailed, 0);
    const items = await ctx.thymer.recordByTitle('Notes', 'Wrapped').getLineItems(false);
    const refs = items.flatMap(i => i.segments).filter(s => s.type === 'ref');
    assert.equal(refs.length, 2, 'both links became references');
    assert.ok(items.every(i => !i.segments.some(s => typeof s.text === 'string' && s.text.includes('⟦'))), 'no placeholder text is left');
    // the inline image goes after the one joined paragraph; the lone image keeps its caption line after it
    assert.deepEqual(items.map(i => i.type), ['text', 'image', 'image', 'text']);
    assert.equal(items[0].text.includes('\n'), false);
    assert.ok(items[0].text.startsWith('This paragraph links to ') && items[0].text.includes('carries an image  in the middle of the next, then ends with '), items[0].text);
});

// ---- the opt-in: only the plan or source that asks ---------------------------------------------------------

test('Tolaria opts in; Notion does not', async () => {
    const ctx = engine();
    const tolaria = await ctx.p.parseTolariaVault(memoryFiles({ ...typeDoc, 'v/a.md': body('x', 'y') }));
    assert.deepEqual(tolaria.options, { unwrapSoftBreaks: true });
    const notion = ctx.p._notionBuildPlan({ files: new Map(), texts: new Map([[`${STEM}.csv`, 'Name\nDrill\n']]) });
    assert.equal(notion.options, undefined, 'the Notion plan has no options at all');
    assert.equal(ctx.p.createImportPlan('x').options, undefined);
    assert.deepEqual(ctx.p.createImportPlan('x', { unwrapSoftBreaks: true }).options, { unwrapSoftBreaks: true });
});

test('Notion: a Shift+Enter line break (a plain newline in the export) reaches insertFromMarkdown unchanged', async () => {
    const ctx = engine();
    const wrapped = lines('# Drill', '', 'first line of the block', 'second line of the same block', '', '- item', '  continuation', '', '> quote', '> more');
    const plan = ctx.p._notionBuildPlan({
        files: new Map(),
        texts: new Map([[`${STEM}.csv`, 'Name\nDrill\n'], [`${STEM.replace(/ [0-9a-f]{32}$/, '')}/Drill 0123456789abcdef0123456789abcdef.md`, wrapped]])
    });
    const record = plan.records.find(r => r.title === 'Drill');
    assert.ok(record && /first line of the block\nsecond line/.test(record.body), `the row body is in the plan with its newlines: ${JSON.stringify(record)}`);
    const seen = await captureMarkdown(() => ctx.p.applyImportPlan(plan, fast));
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes('first line of the block\nsecond line of the same block'));
    assert.ok(seen[0].includes('- item\n  continuation'));
    assert.ok(seen[0].includes('> quote\n> more'));
});

test('a plan without the option leaves every body as it is, journal entries too; with it, journal entries are joined', async () => {
    const run = async (options) => {
        const ctx = engine();
        ctx.thymer.addJournal();
        const plan = ctx.p.createImportPlan('t', options);
        plan.collections.push({ key: 'c', name: 'Things', fields: [] });
        plan.records.push({ key: 'r', collection: 'c', title: 'Thing', sourcePath: 'thing.md', values: {}, body: 'one\ntwo\n\n- a\n  b' });
        plan.journal.push({ date: '2026-03-01', markdown: 'day one\nwraps\n\n1. a\n   b' });
        return captureMarkdown(() => ctx.p.applyImportPlan(plan, fast));
    };
    const untouched = ['one\ntwo\n\n- a\n  b', 'day one\nwraps\n\n1. a\n   b'];
    assert.deepEqual(await run(undefined), untouched);
    assert.deepEqual(await run({}), untouched);
    assert.deepEqual(await run({ unwrapSoftBreaks: false }), untouched);
    assert.deepEqual(await run({ unwrapSoftBreaks: true }), ['one two\n\n- a b', 'day one wraps\n\n1. a b']);
});

test('the existing Markdown flows are not changed: prepareMarkdownForThymerImport does not join lines', () => {
    assert.equal(p.prepareMarkdownForThymerImport('a\nb\n\n- c\n  d'), 'a\nb\n\n- c\n  d');
});
