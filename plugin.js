const VERSION = 'v0.0.12';
/**
 * Unified Import Plugin for Thymer
 * Supports CSV, Obsidian Markdown, Joplin (YAML frontmatter), and Logseq imports with UI
 * 
 * v0.0.12 - Create New Collection: frontmatter keys tag / tags get property type hashtag (many: true when values are YAML lists)
 * v0.0.11 - Markdown folder picker: use pickFolder() like journal import (showDirectoryPicker without startIn + webkitdirectory fallback for Safari/macOS); scanVaultFiles supports file-list result
 * v0.0.10 - Optional plugin.json custom.markdown_import_hashtag_escape (default true): set false to disable v0.0.9 hashtag-like token escaping
 * v0.0.9 - Markdown import inserts U+200C after # before numeric tokens and 6-digit hex colors (outside headings / code) so Thymer does not treat those as hashtags; #word tags still import as hashtags; insertFromMarkdown has no escape flag in the SDK
 * v0.0.8 - Joplin (YAML) source: CRLF-safe frontmatter, ISO datetimes via setFromDate, multi-value fields (tags) using prop.set / setChoice when many: true; Joplin key aliases updated_at / created_at; new collections infer many: true for YAML arrays
 * v0.0.7 - Added an option to autodetect (or select folder) for journal entries in import and automatically import them into your Thymer Journal collection
 * v0.0.6 - Added "Import Daily Notes to Journal" command
 * v0.0.5 - Added "Fix broken [[wikilinks]]" command
 * v0.0.4 - Merged version combining:
 * - CSV import with full UI (from v0.0.3)
 * - Obsidian markdown support (from v0.0.3)  
 * - Logseq support (from v0.0.2 fork)
 * - Unified import dialog and theme support
 */

// =============================================================================
// LINK INDEX (shared by the ImportPlan engine; pure, no Thymer APIs)
// =============================================================================

/**
 * Maps every alias of an imported record to its stable source key, and (once the
 * record exists in Thymer) to its record GUID.
 *
 * Alias kinds, tried in this order when a link target does not name a kind:
 *   key        exact source key
 *   path       source_path, lowercased, without .md; relative links resolve against the linking record's folder
 *   notion_id  32-hex Notion page id (from the last path segment, or an explicit alias)
 *   slug       filename without extension, case-folded   ([[home-assistant]] -> home-assistant.md)
 *   title      case-folded, whitespace-collapsed title
 *
 * resolve() never throws. It returns one of
 *   { status: 'resolved',   ref, key, guid|null, via }   (guid is null until bind() is called)
 *   { status: 'ambiguous',  ref, via, candidates: [key] }
 *   { status: 'unresolved', ref, reason: 'not-found' | 'empty' | 'error' }
 */
class LinkIndex {
    static get KINDS() { return ['key', 'path', 'notion_id', 'slug', 'title']; }

    constructor() {
        this.records = new Map();   // key -> { key, collection, sourcePath, title }
        this.guids = new Map();     // key -> Thymer record guid
        this.aliases = new Map();   // kind -> Map(normalized alias -> Set(key))
        for (const kind of LinkIndex.KINDS) this.aliases.set(kind, new Map());
    }

    static fromPlan(plan) {
        const index = new LinkIndex();
        for (const rec of (plan && plan.records) || []) {
            index.addRecord({
                key: rec.key,
                collection: rec.collection,
                sourcePath: rec.sourcePath,
                title: rec.title,
                aliases: rec.aliases
            });
        }
        return index;
    }

    // ---- normalisation ------------------------------------------------------

    static normalizePath(value) {
        const parts = [];
        for (const seg of String(value == null ? '' : value).replace(/\\/g, '/').normalize('NFC').split('/')) {
            if (!seg || seg === '.') continue;
            if (seg === '..') { parts.pop(); continue; }
            parts.push(seg);
        }
        return parts.join('/').toLowerCase().replace(/\.(md|markdown)$/, '');
    }

    static slugOf(value) {
        const p = LinkIndex.normalizePath(value);
        return p.slice(p.lastIndexOf('/') + 1);
    }

    static normalizeTitle(value) {
        return String(value == null ? '' : value).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
    }

    /** Last 32-hex id (or dashed UUID) found in the string, lowercased and undashed; null if none. */
    static extractNotionId(value) {
        const s = String(value == null ? '' : value)
            .replace(/([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/gi, '$1$2$3$4$5');
        const all = s.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi);
        return all ? all[all.length - 1].toLowerCase() : null;
    }

    static normalize(kind, value) {
        if (value == null || String(value).trim() === '') return null;
        let out;
        switch (kind) {
            case 'key': out = String(value).trim(); break;
            case 'path': out = LinkIndex.normalizePath(value); break;
            case 'slug': out = LinkIndex.slugOf(value); break;
            case 'notion_id': out = LinkIndex.extractNotionId(value); break;
            case 'title': out = LinkIndex.normalizeTitle(value); break;
            default: return null;
        }
        return out ? out : null;
    }

    // ---- building -----------------------------------------------------------

    addAlias(key, kind, value) {
        const map = this.aliases.get(kind);
        const norm = LinkIndex.normalize(kind, value);
        if (!map || !norm) return false;
        if (!map.has(norm)) map.set(norm, new Set());
        map.get(norm).add(key);
        return true;
    }

    /** aliases: optional [{ kind, value }] on top of the ones derived from key / sourcePath / title. */
    addRecord({ key, collection = null, sourcePath = '', title = '', aliases = [] }) {
        if (key == null || key === '') throw new Error('LinkIndex.addRecord: key is required');
        this.records.set(key, { key, collection, sourcePath: sourcePath || '', title: title || '' });
        this.addAlias(key, 'key', key);
        if (sourcePath) {
            this.addAlias(key, 'path', sourcePath);
            this.addAlias(key, 'slug', sourcePath);
            const base = String(sourcePath).replace(/\\/g, '/').split('/').pop();
            this.addAlias(key, 'notion_id', base);
        }
        if (title) this.addAlias(key, 'title', title);
        for (const a of aliases || []) {
            if (a) this.addAlias(key, a.kind, a.value);
        }
    }

    bind(key, guid) { this.guids.set(key, guid); }
    guidOf(key) { return this.guids.has(key) ? this.guids.get(key) : null; }
    has(key) { return this.records.has(key); }
    keys() { return Array.from(this.records.keys()); }

    // ---- resolving ----------------------------------------------------------

    /**
     * target: a string, or { ref, kind? } (kind restricts the lookup to one alias kind).
     * ctx.fromKey: the linking record (relative paths and same-collection tie-breaks use it).
     */
    resolve(target, ctx = {}) {
        const t = (typeof target === 'string') ? { ref: target } : (target || {});
        const ref = t.ref == null ? '' : String(t.ref).trim();
        try {
            if (!ref) return { status: 'unresolved', ref, reason: 'empty' };
            const from = ctx.fromKey != null ? (this.records.get(ctx.fromKey) || null) : null;
            const kinds = t.kind ? [t.kind] : LinkIndex.KINDS;
            for (const kind of kinds) {
                let keys = this._lookup(kind, ref, from);
                if (keys.length === 0) continue;
                if (keys.length > 1 && from && from.collection != null) {
                    const same = keys.filter(k => this.records.get(k).collection === from.collection);
                    if (same.length === 1) keys = same;
                }
                if (keys.length > 1) return { status: 'ambiguous', ref, via: kind, candidates: keys };
                return { status: 'resolved', ref, key: keys[0], guid: this.guidOf(keys[0]), via: kind };
            }
            return { status: 'unresolved', ref, reason: 'not-found' };
        } catch (error) {
            return { status: 'unresolved', ref, reason: 'error', error: String(error && error.message || error) };
        }
    }

    /** links: [{ target, from? }]. Returns { resolved: [{ link, result }], unresolved: [{ link, result }] }. */
    resolveMany(links) {
        const out = { resolved: [], unresolved: [] };
        for (const link of links || []) {
            const result = this.resolve(link.target, { fromKey: link.from });
            (result.status === 'resolved' ? out.resolved : out.unresolved).push({ link, result });
        }
        return out;
    }

    _refVariants(ref) {
        const variants = [ref];
        try { variants.push(decodeURIComponent(ref)); } catch (e) { /* not URI-encoded */ }
        for (const v of variants.slice()) variants.push(v.replace(/[#?].*$/s, ''));
        return Array.from(new Set(variants.filter(v => v !== '')));
    }

    _lookup(kind, ref, from) {
        const map = this.aliases.get(kind);
        if (!map) return [];
        const hit = (norm) => (norm && map.has(norm)) ? Array.from(map.get(norm)) : [];
        if (kind === 'key') return hit(LinkIndex.normalize('key', ref));
        if (kind === 'notion_id') return hit(LinkIndex.normalize('notion_id', ref));
        for (const v of this._refVariants(ref)) {
            if (kind === 'path') {
                if (from && from.sourcePath) {
                    const dir = String(from.sourcePath).replace(/\\/g, '/').split('/').slice(0, -1).join('/');
                    const rel = hit(LinkIndex.normalize('path', dir ? `${dir}/${v}` : v));
                    if (rel.length) return rel;
                }
            }
            const found = hit(LinkIndex.normalize(kind, v));
            if (found.length) return found;
        }
        return [];
    }

    toJSON() {
        const aliases = {};
        for (const [kind, map] of this.aliases) {
            aliases[kind] = {};
            for (const [alias, keys] of map) aliases[kind][alias] = Array.from(keys);
        }
        return { records: Array.from(this.records.values()), aliases, bound: Object.fromEntries(this.guids) };
    }
}

function omitUndefined(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
    return out;
}

class Plugin extends AppPlugin {

    onLoad() {
        try {
            console.log('[Unified Import] Plugin loaded - version', VERSION);
            
            this.ui.addCommandPaletteCommand({
                label: 'Import Data (CSV or Markdown)',
                icon: 'ti-file-import',
                onSelected: () => this.showImportTypeDialog()
            });

            this.ui.addCommandPaletteCommand({
                label: 'Import Daily Notes to Journal',
                icon: 'ti-calendar',
                onSelected: () => this.importDailyNotesToJournal()
            });

            this.ui.addCommandPaletteCommand({
                label: 'Fix broken [[wikilinks]]',
                icon: 'ti-link',
                onSelected: () => this.fixBrokenWikiLinks()
            });
        } catch (error) {
            console.error('[Unified Import] Error in onLoad:', error);
        }
    }

    // =========================================================================
    // IMPORT DAILY NOTES TO JOURNAL
    // =========================================================================

    async importDailyNotesToJournal() {
        try {
            console.log('[Journal Import] Starting daily notes import...');
            
            // Find the journal collection using getAllCollections() then isJournalPlugin()
            const collections = await this.data.getAllCollections();
            const journalCollection = collections.find(c => c.isJournalPlugin());
            
            if (!journalCollection) {
                this.showToast('Journal not found. Please enable the Journal feature first.', 5000);
                console.error('[Journal Import] No collection with isJournalPlugin() found');
                return;
            }

            console.log('[Journal Import] Found journal collection');

            // Show source selection dialog
            const source = await this.showJournalSourceDialog();
            if (!source) return;

            console.log('[Journal Import] Selected source:', source);

            // Show folder picker
            const dirHandle = await this.pickFolder();
            if (!dirHandle) return;

            this.showToast('Scanning for daily notes...', 3000);

            // Scan for daily notes based on source
            const dailyNotes = source === 'logseq'
                ? await this.scanLogseqDailyNotes(dirHandle)
                : await this.scanObsidianDailyNotes(dirHandle);

            if (dailyNotes.length === 0) {
                this.showToast('No daily notes found', 3000);
                return;
            }

            console.log(`[Journal Import] Found ${dailyNotes.length} daily notes`);

            // Show confirmation
            const confirmed = confirm(
                `Found ${dailyNotes.length} daily notes.\n\n` +
                `Import to Thymer Journal?\n\n` +
                `Note: Existing journal entries for the same dates will be updated.`
            );
            
            if (!confirmed) return;

            // Import the daily notes
            await this.importDailyNotes(journalCollection, dailyNotes, source);

        } catch (error) {
            console.error('[Journal Import] Error:', error);
            this.showToast(`Error importing daily notes: ${error.message}`, 5000);
        }
    }

    async showJournalSourceDialog() {
        const colors = this.getThemeColors();
        
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
            `;

            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: ${colors.background};
                color: ${colors.text};
                border-radius: 8px;
                padding: 32px;
                width: 90%;
                max-width: 500px;
                border: 1px solid ${colors.border};
            `;

            dialog.innerHTML = `
                <h2 style="margin: 0 0 24px 0; color: ${colors.text}; text-align: center;">Import Daily Notes</h2>
                <p style="margin: 0 0 24px 0; color: ${colors.textSecondary}; text-align: center;">
                    Select the source of your daily notes
                </p>
                <div style="display: flex; flex-direction: column; gap: 16px;">
                    <button id="obsidian-btn" style="
                        padding: 20px;
                        background: ${colors.backgroundSecondary};
                        color: ${colors.text};
                        border: 2px solid ${colors.border};
                        border-radius: 8px;
                        font-size: 16px;
                        cursor: pointer;
                        text-align: left;
                        transition: all 0.2s;
                    ">
                        <div style="font-weight: 600; margin-bottom: 4px;">📝 Obsidian Daily Notes</div>
                        <div style="font-size: 13px; color: ${colors.textSecondary};">
                            Import from Obsidian daily notes folder
                        </div>
                    </button>
                    <button id="logseq-btn" style="
                        padding: 20px;
                        background: ${colors.backgroundSecondary};
                        color: ${colors.text};
                        border: 2px solid ${colors.border};
                        border-radius: 8px;
                        font-size: 16px;
                        cursor: pointer;
                        text-align: left;
                        transition: all 0.2s;
                    ">
                        <div style="font-weight: 600; margin-bottom: 4px;">📓 Logseq Journals</div>
                        <div style="font-size: 13px; color: ${colors.textSecondary};">
                            Import from Logseq journals folder
                        </div>
                    </button>
                </div>
                <div style="margin-top: 24px; text-align: center;">
                    <button id="cancel-btn" style="
                        padding: 10px 24px;
                        background: transparent;
                        color: ${colors.text};
                        border: 1px solid ${colors.border};
                        border-radius: 6px;
                        cursor: pointer;
                    ">Cancel</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            const addHoverEffects = (btn) => {
                btn.onmouseenter = () => {
                    btn.style.borderColor = colors.primary;
                    btn.style.transform = 'translateY(-2px)';
                };
                btn.onmouseleave = () => {
                    btn.style.borderColor = colors.border;
                    btn.style.transform = 'translateY(0)';
                };
            };

            addHoverEffects(dialog.querySelector('#obsidian-btn'));
            addHoverEffects(dialog.querySelector('#logseq-btn'));

            dialog.querySelector('#obsidian-btn').onclick = () => {
                document.body.removeChild(overlay);
                resolve('obsidian');
            };

            dialog.querySelector('#logseq-btn').onclick = () => {
                document.body.removeChild(overlay);
                resolve('logseq');
            };

            dialog.querySelector('#cancel-btn').onclick = () => {
                document.body.removeChild(overlay);
                resolve(null);
            };

            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(null);
                }
            };
        });
    }

    async pickFolder() {
        try {
            if (typeof window.showDirectoryPicker === 'function') {
                try {
                    return await window.showDirectoryPicker({ mode: 'read' });
                } catch (err) {
                    if (err && err.name === 'AbortError') {
                        return null;
                    }
                    console.warn('[pickFolder] showDirectoryPicker failed, trying webkitdirectory fallback', err);
                }
            }

            const input = document.createElement('input');
            input.type = 'file';
            input.webkitdirectory = true;
            input.multiple = true;
            input.style.display = 'none';
            document.body.appendChild(input);

            return await new Promise((resolve) => {
                input.addEventListener('change', () => {
                    const files = Array.from(input.files || []);
                    document.body.removeChild(input);
                    if (files.length === 0) {
                        resolve(null);
                    } else {
                        resolve({ kind: 'filelist', files });
                    }
                }, { once: true });
                input.click();
            });
        } catch (error) {
            if (error.name === 'AbortError') return null;
            throw error;
        }
    }

    async scanObsidianDailyNotes(dirHandle) {
        const dailyNotes = [];
        
        if (dirHandle && dirHandle.kind === 'filelist') {
            // Handle file list from fallback
            for (const file of dirHandle.files) {
                const relPath = file.webkitRelativePath || file.name;
                if (!relPath.endsWith('.md')) continue;

                const filename = file.name.replace(/\.md$/, '');
                const date = this.parseObsidianDateFromFilename(filename);
                
                if (date) {
                    dailyNotes.push({
                        handle: file,
                        path: relPath,
                        filename: filename,
                        date: date
                    });
                }
            }
        } else {
            // Handle directory picker
            await this.scanObsidianDirectory(dirHandle, '', dailyNotes);
        }

        return dailyNotes.sort((a, b) => a.date.localeCompare(b.date));
    }

    async scanObsidianDirectory(dirHandle, path, dailyNotes) {
        for await (const entry of dirHandle.values()) {
            const fullPath = path ? `${path}/${entry.name}` : entry.name;

            if (entry.kind === 'directory') {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                    continue;
                }
                await this.scanObsidianDirectory(entry, fullPath, dailyNotes);
            } else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                const filename = entry.name.replace(/\.md$/, '');
                const date = this.parseObsidianDateFromFilename(filename);
                
                if (date) {
                    dailyNotes.push({
                        handle: entry,
                        path: fullPath,
                        filename: filename,
                        date: date
                    });
                }
            }
        }
    }

    parseObsidianDateFromFilename(filename) {
        // Common Obsidian daily note formats:
        // YYYY-MM-DD (most common)
        // YYYYMMDD
        // DD-MM-YYYY
        // MM-DD-YYYY
        
        // Try YYYY-MM-DD format
        let match = filename.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (match) {
            return `${match[1]}-${match[2]}-${match[3]}`;
        }
        
        // Try YYYYMMDD format
        match = filename.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (match) {
            return `${match[1]}-${match[2]}-${match[3]}`;
        }
        
        // Try DD-MM-YYYY format
        match = filename.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (match) {
            return `${match[3]}-${match[2]}-${match[1]}`;
        }
        
        // Try MM-DD-YYYY format
        match = filename.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (match) {
            // Ambiguous - could be DD-MM or MM-DD
            // Default to MM-DD (US format) if day > 12
            const first = parseInt(match[1]);
            const second = parseInt(match[2]);
            if (first > 12) {
                // Must be DD-MM
                return `${match[3]}-${match[2]}-${match[1]}`;
            }
            // Assume MM-DD
            return `${match[3]}-${match[1]}-${match[2]}`;
        }
        
        return null;
    }

    async scanLogseqDailyNotes(dirHandle) {
        const dailyNotes = [];
        
        if (dirHandle && dirHandle.kind === 'filelist') {
            // Handle file list from fallback
            for (const file of dirHandle.files) {
                const relPath = file.webkitRelativePath || file.name;
                if (!relPath.endsWith('.md')) continue;

                // Check if in journals folder
                const parts = relPath.split('/');
                if (parts.length === 0) continue;
                
                const topFolder = parts[0];
                if (topFolder !== 'journals') continue;

                const filename = file.name.replace(/\.md$/, '');
                const date = this.parseLogseqDateFromFilename(filename);
                
                if (date) {
                    dailyNotes.push({
                        handle: file,
                        path: relPath,
                        filename: filename,
                        date: date
                    });
                }
            }
        } else {
            // Handle directory picker - look for journals folder
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'directory' && entry.name === 'journals') {
                    await this.scanLogseqJournalsDirectory(entry, dailyNotes);
                    break;
                }
            }
        }

        return dailyNotes.sort((a, b) => a.date.localeCompare(b.date));
    }

    async scanLogseqJournalsDirectory(dirHandle, dailyNotes) {
        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                const filename = entry.name.replace(/\.md$/, '');
                const date = this.parseLogseqDateFromFilename(filename);
                
                if (date) {
                    dailyNotes.push({
                        handle: entry,
                        path: `journals/${entry.name}`,
                        filename: filename,
                        date: date
                    });
                }
            }
        }
    }

    parseLogseqDateFromFilename(filename) {
        // Logseq format: YYYY_MM_DD
        const match = filename.match(/^(\d{4})_(\d{2})_(\d{2})$/);
        if (match) {
            return `${match[1]}-${match[2]}-${match[3]}`;
        }
        
        return null;
    }

    async importDailyNotes(journalPlugin, dailyNotes, source) {
        let imported = 0;
        let updated = 0;
        let errors = 0;

        console.log(`[Journal Import] Importing ${dailyNotes.length} daily notes`);
        this.showToast(`Importing ${dailyNotes.length} daily notes...`, 3000);

        for (let i = 0; i < dailyNotes.length; i++) {
            const note = dailyNotes[i];

            try {
                if (i % 5 === 0) {
                    this.showToast(`Importing ${i + 1}/${dailyNotes.length}`, 500);
                }

                console.log(`[Journal Import] Processing: ${note.filename} (${note.date})`);

                // Read the file content
                const fileHandle = await this.getFileFromHandle(note.handle);
                const content = await fileHandle.text();

                // Parse the markdown
                const parsed = source === 'logseq'
                    ? this.parseLogseqFile(content)
                    : this.parseMarkdownFile(content);

                // Parse the date into components
                const [year, month, day] = note.date.split('-').map(n => parseInt(n));

                // Get the current user
                const users = this.data.getActiveUsers();
                const currentUser = users[0]; // Get the first active user (current user)
                
                if (!currentUser) {
                    console.error(`[Journal Import] No active user found`);
                    errors++;
                    continue;
                }

                // Create a DateTime object for the date (date-only, no time component)
                // month is 0-indexed in JavaScript Date
                const dateTime = DateTime.dateOnly(year, month - 1, day);

                // Get or create journal record for this date
                const journalRecord = await journalPlugin.getJournalRecord(currentUser, dateTime);
                
                if (!journalRecord) {
                    console.error(`[Journal Import] Failed to get/create journal record for ${note.date}`);
                    errors++;
                    continue;
                }

                // Important: Wait for the record to be fully initialized
                await new Promise(resolve => setTimeout(resolve, 500));

                // Check if this is a new record or existing
                const lineItems = await journalRecord.getLineItems();
                const isNew = !lineItems || lineItems.length === 0;

                if (isNew) {
                    console.log(`[Journal Import] Creating new journal entry for ${note.date}`);
                    imported++;
                } else {
                    console.log(`[Journal Import] Updating existing journal entry for ${note.date}`);
                    updated++;
                }

                // Insert the markdown content using the native API
                if (parsed.markdown) {
                    const md = this.prepareMarkdownForThymerImport(parsed.markdown);
                    console.log(`[Journal Import] Inserting ${md.length} characters of markdown`);
                    
                    try {
                        // Use the native insertFromMarkdown method
                        const success = await journalRecord.insertFromMarkdown(
                            md,
                            null,  // parentItem: null = use record as parent
                            null   // afterItem: null = insert as first child
                        );
                        
                        if (success) {
                            console.log(`[Journal Import] ✓ Successfully imported ${note.filename}`);
                        } else {
                            console.error(`[Journal Import] insertFromMarkdown returned false for ${note.filename}`);
                            errors++;
                        }
                    } catch (error) {
                        console.error(`[Journal Import] insertFromMarkdown failed for ${note.filename}:`, error);
                        errors++;
                    }
                } else {
                    console.log(`[Journal Import] No markdown content for ${note.filename}`);
                }

            } catch (error) {
                console.error(`[Journal Import] Error processing ${note.filename}:`, error);
                errors++;
            }
        }

        this.showToast(
            `Journal import complete!\n` +
            `New entries: ${imported}\n` +
            `Updated: ${updated}\n` +
            `Errors: ${errors}`,
            8000
        );

        console.log(`[Journal Import] Complete: ${imported} imported, ${updated} updated, ${errors} errors`);
    }

    // =========================================================================
    // FIX BROKEN WIKILINKS COMMAND
    // =========================================================================

    async fixBrokenWikiLinks() {
        try {
            console.log('[Fix Links] Starting wikilink repair scan...');
            this.showToast('Scanning workspace for broken wikilinks...', 3000);

            // Get all collections
            const collections = await this.data.getAllCollections();
            
            // Build a workspace-wide name→record map
            const nameToRecords = new Map(); // name → array of {record, collection}
            const guidToRecord = new Map();   // guid → {record, collection}
            
            console.log('[Fix Links] Building workspace lookup map...');
            for (const collection of collections) {
                const records = await collection.getAllRecords();
                for (const record of records) {
                    const name = record.getName();
                    if (name) {
                        const key = name.toLowerCase();
                        if (!nameToRecords.has(key)) {
                            nameToRecords.set(key, []);
                        }
                        nameToRecords.get(key).push({ record, collection });
                        guidToRecord.set(record.guid, { record, collection });
                    }
                }
            }
            
            console.log(`[Fix Links] Found ${nameToRecords.size} unique record names across ${collections.length} collections`);

            // Scan all records for broken wikilinks
            let totalLineItems = 0;
            let lineItemsWithLinks = 0;
            let brokenLinksFound = 0;
            const fixableLinks = []; // {record, collection, lineItem, lineIndex, linkText, candidates}

            for (const collection of collections) {
                const records = await collection.getAllRecords();
                
                for (const record of records) {
                    const lineItems = await record.getLineItems();
                    if (!lineItems || lineItems.length === 0) continue;

                    for (let i = 0; i < lineItems.length; i++) {
                        const lineItem = lineItems[i];
                        totalLineItems++;
                        
                        const segments = lineItem.segments || [];
                        if (segments.length === 0) continue;

                        // Check if this line contains [[...]] or ((...)) in text segments
                        // Exclude code blocks and inline code
                        let hasUnresolvedLinks = false;
                        const unresolvedLinks = [];
                        
                        for (const segment of segments) {
                            // Skip code segments (inline code)
                            if (segment.type === 'code') continue;
                            
                            // Only check text segments
                            if (segment.type === 'text' && segment.text) {
                                // Look for [[...]] or ((...)) patterns
                                const linkRegex = /(\[\[([^\]]+)\]\]|\(\(([^\)]+)\)\))/g;
                                let match;
                                
                                while ((match = linkRegex.exec(segment.text)) !== null) {
                                    hasUnresolvedLinks = true;
                                    const linkText = match[2] || match[3];
                                    unresolvedLinks.push(linkText.trim());
                                }
                            }
                        }

                        if (hasUnresolvedLinks) {
                            lineItemsWithLinks++;
                            
                            // For each unresolved link, find potential matches
                            for (const linkText of unresolvedLinks) {
                                brokenLinksFound++;
                                const key = linkText.toLowerCase();
                                const candidates = nameToRecords.get(key) || [];
                                
                                if (candidates.length > 0) {
                                    fixableLinks.push({
                                        record,
                                        collection,
                                        lineItem,
                                        lineIndex: i,
                                        linkText,
                                        candidates
                                    });
                                }
                            }
                        }
                    }
                }
            }

            console.log(`[Fix Links] Scan complete: ${totalLineItems} line items, ${lineItemsWithLinks} with wikilinks, ${brokenLinksFound} broken links found`);

            if (fixableLinks.length === 0) {
                this.showToast('No fixable broken wikilinks found!', 5000);
                return;
            }

            // Process fixable links - show dialog for each with multiple candidates
            console.log(`[Fix Links] Processing ${fixableLinks.length} fixable links...`);
            await this.processFixableLinks(fixableLinks, nameToRecords);

        } catch (error) {
            console.error('[Fix Links] Error:', error);
            this.showToast(`Error fixing wikilinks: ${error.message}`, 5000);
        }
    }

    async processFixableLinks(fixableLinks, nameToRecords) {
        let fixed = 0;
        let skipped = 0;
        
        // Group by record to batch updates
        const linksByRecord = new Map();
        for (const link of fixableLinks) {
            const recordKey = `${link.collection.getGuid()}_${link.record.guid}`;
            if (!linksByRecord.has(recordKey)) {
                linksByRecord.set(recordKey, []);
            }
            linksByRecord.get(recordKey).push(link);
        }

        console.log(`[Fix Links] Processing ${linksByRecord.size} records with broken links...`);

        for (const [recordKey, links] of linksByRecord.entries()) {
            const record = links[0].record;
            const collection = links[0].collection;
            
            console.log(`[Fix Links] Processing record: ${record.getName()} with ${links.length} broken links`);

            // Build a map of line index to link fixes
            const fixesByLine = new Map();
            
            for (const link of links) {
                if (link.candidates.length === 1) {
                    // Single match - auto-fix
                    if (!fixesByLine.has(link.lineIndex)) {
                        fixesByLine.set(link.lineIndex, []);
                    }
                    fixesByLine.get(link.lineIndex).push({
                        linkText: link.linkText,
                        targetRecord: link.candidates[0].record
                    });
                    fixed++;
                } else {
                    // Multiple matches - ask user
                    const choice = await this.showLinkChoiceDialog(
                        link.linkText,
                        link.candidates,
                        record.getName()
                    );
                    
                    if (choice) {
                        if (!fixesByLine.has(link.lineIndex)) {
                            fixesByLine.set(link.lineIndex, []);
                        }
                        fixesByLine.get(link.lineIndex).push({
                            linkText: link.linkText,
                            targetRecord: choice.record
                        });
                        fixed++;
                    } else {
                        skipped++;
                    }
                }
            }

            // Apply all fixes for this record
            if (fixesByLine.size > 0) {
                await this.applyLinkFixes(record, fixesByLine);
            }
        }

        this.showToast(`Fixed ${fixed} wikilinks, skipped ${skipped}`, 5000);
    }

    async showLinkChoiceDialog(linkText, candidates, recordName) {
        const colors = this.getThemeColors();
        
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10001;
            `;

            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: ${colors.background};
                color: ${colors.text};
                border: 1px solid ${colors.border};
                border-radius: 8px;
                padding: 24px;
                width: 90%;
                max-width: 600px;
                max-height: 80vh;
                overflow-y: auto;
            `;

            const candidateOptions = candidates.map((c, idx) => {
                const collectionName = c.collection.getName();
                return `
                    <div style="
                        padding: 12px;
                        margin: 8px 0;
                        border: 2px solid ${colors.border};
                        border-radius: 6px;
                        cursor: pointer;
                        transition: all 0.2s;
                        background: ${colors.backgroundSecondary};
                    " class="link-option" data-index="${idx}">
                        <div style="font-weight: 600; margin-bottom: 4px;">${this.escapeHtml(c.record.getName())}</div>
                        <div style="font-size: 12px; color: ${colors.textSecondary};">Collection: ${this.escapeHtml(collectionName)}</div>
                    </div>
                `;
            }).join('');

            dialog.innerHTML = `
                <h2 style="margin: 0 0 16px 0; color: ${colors.text};">Choose Link Target</h2>
                <p style="margin: 0 0 16px 0; color: ${colors.textSecondary};">
                    Multiple records found for <strong>[[${this.escapeHtml(linkText)}]]</strong> in <em>${this.escapeHtml(recordName)}</em>
                </p>
                <div id="candidate-options">
                    ${candidateOptions}
                </div>
                <div style="margin-top: 24px; display: flex; gap: 8px; justify-content: flex-end;">
                    <button id="skip-btn" style="
                        padding: 8px 16px;
                        border: 1px solid ${colors.buttonBorder};
                        background: ${colors.buttonBg};
                        color: ${colors.buttonText};
                        border-radius: 4px;
                        cursor: pointer;
                    ">Skip</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            // Add hover effects to options
            const options = dialog.querySelectorAll('.link-option');
            options.forEach(option => {
                option.addEventListener('mouseenter', () => {
                    option.style.borderColor = colors.primary;
                    option.style.transform = 'translateX(4px)';
                });
                option.addEventListener('mouseleave', () => {
                    option.style.borderColor = colors.border;
                    option.style.transform = 'translateX(0)';
                });
                option.addEventListener('click', () => {
                    const idx = parseInt(option.getAttribute('data-index'));
                    document.body.removeChild(overlay);
                    resolve(candidates[idx]);
                });
            });

            dialog.querySelector('#skip-btn').onclick = () => {
                document.body.removeChild(overlay);
                resolve(null);
            };

            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(null);
                }
            };
        });
    }

    async applyLinkFixes(record, fixesByLine) {
        const lineItems = await record.getLineItems();
        
        for (const [lineIndex, fixes] of fixesByLine.entries()) {
            const lineItem = lineItems[lineIndex];
            if (!lineItem) continue;

            const segments = lineItem.segments || [];
            if (segments.length === 0) continue;

            const newSegments = [];
            
            for (const segment of segments) {
                if (segment.type === 'text' && segment.text) {
                    // Replace [[linkText]] and ((linkText)) with refs
                    let lastIndex = 0;
                    
                    // Build a regex that matches any of the link texts
                    const linkTexts = fixes.map(f => f.linkText);
                    const escapedTexts = linkTexts.map(text => 
                        text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    );
                    const pattern = `(\\[\\[(${escapedTexts.join('|')})\\]\\]|\\(\\((${escapedTexts.join('|')})\\)\\))`;
                    const linkRegex = new RegExp(pattern, 'g');
                    
                    let match;
                    while ((match = linkRegex.exec(segment.text)) !== null) {
                        const linkText = match[2] || match[3];
                        const fix = fixes.find(f => f.linkText === linkText);
                        
                        if (fix) {
                            // Add text before the link
                            if (match.index > lastIndex) {
                                newSegments.push({
                                    type: 'text',
                                    text: segment.text.substring(lastIndex, match.index)
                                });
                            }
                            
                            // Add ref segment
                            newSegments.push({
                                type: 'ref',
                                text: fix.targetRecord.guid
                            });
                            
                            lastIndex = match.index + match[0].length;
                        }
                    }
                    
                    // Add remaining text
                    if (lastIndex < segment.text.length) {
                        newSegments.push({
                            type: 'text',
                            text: segment.text.substring(lastIndex)
                        });
                    }
                } else {
                    // Keep non-text segments as-is
                    newSegments.push(segment);
                }
            }
            
            // Update the line item with fixed segments
            try {
                await lineItem.setSegments(newSegments);
                console.log(`[Fix Links] Updated line ${lineIndex} with ${fixes.length} fixes`);
            } catch (error) {
                console.error(`[Fix Links] Error updating line ${lineIndex}:`, error);
            }
        }
    }

    // =========================================================================
    // IMPORT TYPE SELECTION DIALOG
    // =========================================================================

    showImportTypeDialog() {
        const colors = this.getThemeColors();
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: ${colors.background};
            color: ${colors.text};
            border-radius: 8px;
            padding: 32px;
            width: 90%;
            max-width: 500px;
            border: 1px solid ${colors.border};
        `;

        dialog.innerHTML = `
            <h2 style="margin: 0 0 24px 0; color: ${colors.text}; text-align: center;">Import Data</h2>
            <div style="display: flex; flex-direction: column; gap: 16px;">
                <button id="csv-import-btn" style="
                    padding: 20px;
                    background: ${colors.backgroundSecondary};
                    color: ${colors.text};
                    border: 2px solid ${colors.border};
                    border-radius: 8px;
                    font-size: 16px;
                    cursor: pointer;
                    text-align: left;
                    transition: all 0.2s;
                ">
                    <div style="font-weight: 600; margin-bottom: 4px;">📊 CSV Import</div>
                    <div style="font-size: 13px; color: ${colors.textSecondary};">
                        Import tabular data from CSV files or pasted text
                    </div>
                </button>
                <button id="markdown-import-btn" style="
                    padding: 20px;
                    background: ${colors.backgroundSecondary};
                    color: ${colors.text};
                    border: 2px solid ${colors.border};
                    border-radius: 8px;
                    font-size: 16px;
                    cursor: pointer;
                    text-align: left;
                    transition: all 0.2s;
                ">
                    <div style="font-weight: 600; margin-bottom: 4px;">📝 Markdown Import (Obsidian/Logseq)</div>
                    <div style="font-size: 13px; color: ${colors.textSecondary};">
                        Import from Obsidian or Logseq vaults
                    </div>
                </button>
            </div>
            <div style="margin-top: 24px; text-align: center;">
                <button id="cancel-btn" style="
                    padding: 10px 24px;
                    background: transparent;
                    color: ${colors.text};
                    border: 1px solid ${colors.border};
                    border-radius: 6px;
                    cursor: pointer;
                ">Cancel</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const addHoverEffects = (btn) => {
            btn.onmouseenter = () => {
                btn.style.borderColor = colors.primary;
                btn.style.transform = 'translateY(-2px)';
            };
            btn.onmouseleave = () => {
                btn.style.borderColor = colors.border;
                btn.style.transform = 'translateY(0)';
            };
        };

        addHoverEffects(dialog.querySelector('#csv-import-btn'));
        addHoverEffects(dialog.querySelector('#markdown-import-btn'));

        dialog.querySelector('#csv-import-btn').onclick = () => {
            document.body.removeChild(overlay);
            this.showCSVImportDialog();
        };

        dialog.querySelector('#markdown-import-btn').onclick = () => {
            document.body.removeChild(overlay);
            this.showMarkdownImportDialog();
        };

        dialog.querySelector('#cancel-btn').onclick = () => {
            document.body.removeChild(overlay);
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        };
    }

    // ========================================================================
    // CSV IMPORT (Complete implementation)
    // =========================================================================

    showCSVImportDialog() {
        const colors = this.getThemeColors();
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: ${colors.background};
            color: ${colors.text};
            border-radius: 8px;
            padding: 24px;
            width: 90%;
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
            border: 1px solid ${colors.border};
        `;

        dialog.innerHTML = `
            <h2 style="margin: 0 0 16px 0; color: ${colors.text};">Import CSV</h2>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 500; color: ${colors.text};">Select Collection:</label>
                <select id="csv-collection-select" style="width: 100%; padding: 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};">
                    <option value="">-- Select a collection --</option>
                    <option value="__CREATE_NEW__">✨ Create New Collection</option>
                </select>
            </div>
            <div id="new-collection-name-container" style="margin-bottom: 16px; display: none;">
                <label style="display: block; margin-bottom: 8px; font-weight: 500; color: ${colors.text};">New Collection Name:</label>
                <input 
                    type="text" 
                    id="new-collection-name" 
                    placeholder="e.g., Tasks, Contacts, Projects"
                    style="width: 100%; padding: 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};"
                >
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 500; color: ${colors.text};">CSV Source:</label>
                <div style="display: flex; gap: 8px; margin-bottom: 8px;">
                    <label style="flex: 1; text-align: center; padding: 8px; border: 2px solid ${colors.primary}; background: ${colors.backgroundSecondary}; border-radius: 4px; cursor: pointer; color: ${colors.text};">
                        <input type="radio" name="csv-source" value="paste" checked style="margin-right: 4px;">
                        Paste CSV
                    </label>
                    <label style="flex: 1; text-align: center; padding: 8px; border: 2px solid ${colors.border}; background: ${colors.backgroundSecondary}; border-radius: 4px; cursor: pointer; color: ${colors.text};">
                        <input type="radio" name="csv-source" value="upload" style="margin-right: 4px;">
                        Upload File
                    </label>
                </div>
                <div id="csv-paste-container">
                    <textarea 
                        id="csv-data-input" 
                        placeholder="Paste your CSV here (first row should be headers)"
                        style="width: 100%; height: 200px; font-family: monospace; font-size: 12px; padding: 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};"
                    ></textarea>
                </div>
                <div id="csv-upload-container" style="display: none;">
                    <input 
                        type="file" 
                        id="csv-file-input" 
                        accept=".csv,text/csv"
                        style="width: 100%; padding: 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};"
                    >
                    <div id="file-preview" style="margin-top: 8px; font-size: 12px; color: ${colors.textSecondary};"></div>
                </div>
            </div>
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button id="csv-cancel-btn" style="padding: 8px 16px; border: 1px solid ${colors.buttonBorder}; background: ${colors.buttonBg}; color: ${colors.buttonText}; border-radius: 4px; cursor: pointer;">Cancel</button>
                <button id="csv-import-btn" style="padding: 8px 16px; border: none; background: ${colors.primary}; color: #fff; border-radius: 4px; cursor: pointer;">Import</button>
            </div>
            <div id="csv-status" style="margin-top: 16px; padding: 12px; border-radius: 4px; display: none;"></div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        this.loadCollections(dialog, 'csv-collection-select');

        const collectionSelect = dialog.querySelector('#csv-collection-select');
        const newCollectionNameContainer = dialog.querySelector('#new-collection-name-container');
        collectionSelect.addEventListener('change', () => {
            if (collectionSelect.value === '__CREATE_NEW__') {
                newCollectionNameContainer.style.display = 'block';
            } else {
                newCollectionNameContainer.style.display = 'none';
            }
        });

        const pasteRadio = dialog.querySelector('input[value="paste"]');
        const uploadRadio = dialog.querySelector('input[value="upload"]');
        const pasteContainer = dialog.querySelector('#csv-paste-container');
        const uploadContainer = dialog.querySelector('#csv-upload-container');
        
        pasteRadio.addEventListener('change', () => {
            pasteContainer.style.display = 'block';
            uploadContainer.style.display = 'none';
            pasteRadio.parentElement.style.borderColor = colors.primary;
            uploadRadio.parentElement.style.borderColor = colors.border;
        });
        
        uploadRadio.addEventListener('change', () => {
            pasteContainer.style.display = 'none';
            uploadContainer.style.display = 'block';
            uploadRadio.parentElement.style.borderColor = colors.primary;
            pasteRadio.parentElement.style.borderColor = colors.border;
        });

        const fileInput = dialog.querySelector('#csv-file-input');
        const filePreview = dialog.querySelector('#file-preview');
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                filePreview.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
            } else {
                filePreview.textContent = '';
            }
        });

        dialog.querySelector('#csv-cancel-btn').onclick = () => {
            document.body.removeChild(overlay);
        };

        dialog.querySelector('#csv-import-btn').onclick = () => {
            this.performCSVImport(dialog, overlay);
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        };
    }

    async performCSVImport(dialog, overlay) {
        const select = dialog.querySelector('#csv-collection-select');
        const textarea = dialog.querySelector('#csv-data-input');
        const fileInput = dialog.querySelector('#csv-file-input');
        const statusDiv = dialog.querySelector('#csv-status');
        const importBtn = dialog.querySelector('#csv-import-btn');
        const sourceRadio = dialog.querySelector('input[name="csv-source"]:checked');
        const newCollectionNameInput = dialog.querySelector('#new-collection-name');

        const collectionGuid = select.value;
        const isCreatingNew = collectionGuid === '__CREATE_NEW__';

        let csvData = '';
        if (sourceRadio.value === 'paste') {
            csvData = textarea.value.trim();
        } else {
            const file = fileInput.files[0];
            if (!file) {
                this.showStatus(statusDiv, 'Please select a CSV file', 'error');
                return;
            }
            try {
                csvData = await this.readFileAsText(file);
            } catch (error) {
                this.showStatus(statusDiv, `Error reading file: ${error.message}`, 'error');
                return;
            }
        }

        if (!csvData) {
            this.showStatus(statusDiv, 'Please provide CSV data', 'error');
            return;
        }

        if (!isCreatingNew && !collectionGuid) {
            this.showStatus(statusDiv, 'Please select a collection', 'error');
            return;
        }

        if (isCreatingNew) {
            const newName = newCollectionNameInput.value.trim();
            if (!newName) {
                this.showStatus(statusDiv, 'Please enter a name for the new collection', 'error');
                return;
            }
        }

        importBtn.disabled = true;
        importBtn.textContent = 'Importing...';
        this.showStatus(statusDiv, 'Importing...', 'info');

        try {
            let collection;

            if (isCreatingNew) {
                const parsed = this.parseCSV(csvData);
                const headers = parsed.headers;
                let dataRows = parsed.rows;
                let typeHints = null;

                if (dataRows.length > 0 && this.isTypeHintRow(dataRows[0])) {
                    typeHints = dataRows[0];
                    dataRows = dataRows.slice(1);
                    console.log('[CSV Import] Found type hints in row 2:', typeHints);
                }

                const newName = newCollectionNameInput.value.trim();
                const propertyConfig = await this.showPropertyConfigDialog(headers, typeHints, dataRows.slice(0, 5));
                
                if (!propertyConfig) {
                    importBtn.disabled = false;
                    importBtn.textContent = 'Import';
                    statusDiv.style.display = 'none';
                    return;
                }

                console.log('[CSV Import] Analyzing choice fields...');
                const choiceOptions = this.buildChoiceOptions(headers, dataRows, propertyConfig);
                console.log('[CSV Import] Choice options:', choiceOptions);

                this.showStatus(statusDiv, `Creating collection "${newName}"...`, 'info');
                collection = await this.createCollectionWithProperties(newName, headers, propertyConfig, choiceOptions);
                
                if (!collection) {
                    throw new Error('Failed to create collection');
                }

                this.showStatus(statusDiv, `Collection created! Importing data...`, 'info');
                csvData = this.reconstructCSV(headers, dataRows);
            } else {
                const collections = await this.data.getAllCollections();
                collection = collections.find(c => c.getGuid() === collectionGuid);
                if (!collection) {
                    throw new Error('Collection not found');
                }
            }

            const result = await this.importCSV(collection, csvData);
            
            this.showStatus(statusDiv, `Import complete! Created: ${result.created}, Updated: ${result.updated}, Skipped: ${result.skipped}`, 'success');
            
            setTimeout(() => {
                document.body.removeChild(overlay);
            }, 2000);

        } catch (error) {
            console.error('[CSV Import] Error:', error);
            this.showStatus(statusDiv, `Error: ${error.message}`, 'error');
            importBtn.disabled = false;
            importBtn.textContent = 'Import';
        }
    }

    async showPropertyConfigDialog(headers, typeHints, sampleRows) {
        const colors = this.getThemeColors();
        
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10001;
            `;

            const dialog = document.createElement('div');
            dialog.style.cssText = `
                background: ${colors.background};
                color: ${colors.text};
                border: 1px solid ${colors.border};
                border-radius: 8px;
                padding: 24px;
                width: 90%;
                max-width: 800px;
                max-height: 80vh;
                overflow-y: auto;
            `;

            let propertyRows = headers.map((header, idx) => {
                const typeHint = typeHints ? typeHints[idx].toLowerCase().trim() : null;
                const sampleVals = sampleRows.map(row => row[idx]).filter(v => v).slice(0, 3);
                
                return `
                    <tr style="border-bottom: 1px solid ${colors.tableBorder};">
                        <td style="padding: 8px; color: ${colors.text};">
                            <strong>${this.escapeHtml(header)}</strong>
                            ${sampleVals.length > 0 ? `<div style="font-size: 11px; color: ${colors.textSecondary}; margin-top: 4px;">Examples: ${sampleVals.map(v => this.escapeHtml(v)).join(', ')}</div>` : ''}
                        </td>
                        <td style="padding: 8px;">
                            <select class="property-type" data-header="${this.escapeHtml(header)}" style="width: 100%; padding: 4px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};">
                                <option value="text" ${typeHint === 'text' ? 'selected' : ''}>Text</option>
                                <option value="number" ${typeHint === 'number' ? 'selected' : ''}>Number</option>
                                <option value="datetime" ${typeHint === 'datetime' || typeHint === 'date' ? 'selected' : ''}>Date/Time</option>
                                <option value="checkbox" ${typeHint === 'checkbox' ? 'selected' : ''}>Checkbox</option>
                                <option value="choice" ${typeHint === 'choice' ? 'selected' : ''}>Choice</option>
                                <option value="url" ${typeHint === 'url' ? 'selected' : ''}>URL</option>
                            </select>
                        </td>
                    </tr>
                `;
            }).join('');

            dialog.innerHTML = `
                <h2 style="margin: 0 0 16px 0; color: ${colors.text};">Configure Property Types</h2>
                <p style="margin: 0 0 16px 0; color: ${colors.textSecondary};">
                    Review the detected types for each CSV column. Change them if needed.
                </p>
                <div style="overflow-x: auto;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background: ${colors.backgroundSecondary};">
                                <th style="padding: 8px; text-align: left; color: ${colors.text}; border-bottom: 2px solid ${colors.border};">Property</th>
                                <th style="padding: 8px; text-align: left; color: ${colors.text}; border-bottom: 2px solid ${colors.border};">Type</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${propertyRows}
                        </tbody>
                    </table>
                </div>
                <div style="margin-top: 24px; display: flex; gap: 8px; justify-content: flex-end;">
                    <button id="prop-cancel-btn" style="padding: 8px 16px; border: 1px solid ${colors.buttonBorder}; background: ${colors.buttonBg}; color: ${colors.buttonText}; border-radius: 4px; cursor: pointer;">Cancel</button>
                    <button id="prop-confirm-btn" style="padding: 8px 16px; border: none; background: ${colors.primary}; color: #fff; border-radius: 4px; cursor: pointer;">Confirm</button>
                </div>
            `;

            overlay.appendChild(dialog);
            document.body.appendChild(overlay);

            dialog.querySelector('#prop-cancel-btn').onclick = () => {
                document.body.removeChild(overlay);
                resolve(null);
            };

            dialog.querySelector('#prop-confirm-btn').onclick = () => {
                const selects = dialog.querySelectorAll('.property-type');
                const config = {};
                selects.forEach(select => {
                    const header = select.getAttribute('data-header');
                    config[header] = select.value;
                });
                document.body.removeChild(overlay);
                resolve(config);
            };

            overlay.onclick = (e) => {
                if (e.target === overlay) {
                    document.body.removeChild(overlay);
                    resolve(null);
                }
            };
        });
    }

    parseCSV(csvText) {
        const rows = [];
        let currentRow = [];
        let currentField = '';
        let inQuotes = false;

        for (let i = 0; i < csvText.length; i++) {
            const char = csvText[i];
            const nextChar = csvText[i + 1];

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    currentField += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                currentRow.push(currentField.trim());
                currentField = '';
            } else if ((char === '\n' || char === '\r') && !inQuotes) {
                if (char === '\r' && nextChar === '\n') i++;
                if (currentField || currentRow.length > 0) {
                    currentRow.push(currentField.trim());
                    rows.push(currentRow);
                    currentRow = [];
                    currentField = '';
                }
            } else {
                currentField += char;
            }
        }

        if (currentField || currentRow.length > 0) {
            currentRow.push(currentField.trim());
            rows.push(currentRow);
        }

        if (rows.length < 2) {
            throw new Error('CSV must have at least a header row and one data row');
        }

        return {
            headers: rows[0],
            rows: rows.slice(1)
        };
    }

    rowToObject(headers, rowData) {
        const obj = {};
        for (let i = 0; i < headers.length; i++) {
            const value = rowData[i] || '';
            obj[headers[i]] = value === '' ? null : value;
        }
        return obj;
    }

    async importCSV(collection, csvData) {
        const { headers, rows } = this.parseCSV(csvData);
        
        const config = collection.getConfiguration();
        const mapping = this.buildFieldMapping(headers, config.fields);

        const existingRecords = await collection.getAllRecords();
        const existingByTitle = new Map();
        for (const record of existingRecords) {
            const title = record.getName();
            if (title) {
                existingByTitle.set(title.toLowerCase(), record);
            }
        }

        let created = 0;
        let updated = 0;
        let skipped = 0;

        const BATCH_SIZE = 50;
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, Math.min(i + BATCH_SIZE, rows.length));

            for (const row of batch) {
                try {
                    const rowObject = this.rowToObject(headers, row);
                    
                    const titleField = mapping['title'] || mapping['name'] || Object.values(mapping).find(m => m.matched);
                    const title = titleField 
                        ? (rowObject[Object.keys(mapping).find(k => mapping[k] === titleField)] || 'Untitled')
                        : 'Untitled';

                    const existingRecord = existingByTitle.get(title.toLowerCase());

                    if (existingRecord) {
                        this.updateCSVRecord(existingRecord, rowObject, mapping);
                        updated++;
                    } else {
                        const record = await this.createCSVRecord(collection, title, rowObject, mapping);
                        if (record) {
                            created++;
                            existingByTitle.set(title.toLowerCase(), record);
                        } else {
                            skipped++;
                        }
                    }
                } catch (error) {
                    console.error('[CSV Import] Row error:', error);
                    skipped++;
                }
            }

            if (i + BATCH_SIZE < rows.length) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }

        return { created, updated, skipped };
    }

    async createCSVRecord(collection, title, rowObject, mapping) {
        const recordGuid = collection.createRecord(title);
        if (!recordGuid) return null;

        let record = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 100 + (attempt * 50)));
            const records = await collection.getAllRecords();
            record = records.find(r => r.guid === recordGuid);
            if (record) break;
        }

        if (!record) return null;

        this.updateCSVRecord(record, rowObject, mapping);
        return record;
    }

    updateCSVRecord(record, rowObject, mapping) {
        for (const [csvHeader, value] of Object.entries(rowObject)) {
            const fieldMapping = mapping[csvHeader];
            if (!fieldMapping || !fieldMapping.matched) continue;

            const { fieldId, fieldType } = fieldMapping;
            
            try {
                const prop = record.prop(fieldId);
                if (!prop) continue;

                if (value === null || value === undefined || value === '') {
                    continue;
                }

                if (fieldType === 'datetime' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
                    try {
                        const dateOnly = value.match(/^\d{4}-\d{2}-\d{2}/)[0];
                        const [year, month, day] = dateOnly.split('-');
                        prop.set({ d: year + month + day });
                    } catch (e) {
                        prop.set(value);
                    }
                }
                else if (fieldType === 'number') {
                    const num = this.coerceNumber(value);
                    if (num !== null) {
                        prop.set(num);
                    }
                }
                else if (fieldType === 'checkbox') {
                    prop.set(this.coerceBoolean(value));
                }
                else if (fieldType === 'choice' && typeof prop.setChoice === 'function') {
                    prop.setChoice(String(value).trim());
                }
                else {
                    prop.set(value);
                }
            } catch (error) {
                console.warn(`[CSV Import] Failed to set field ${fieldId}:`, error);
            }
        }
    }

    buildFieldMapping(csvHeaders, collectionFields) {
        const mapping = {};
        
        for (const header of csvHeaders) {
            const normalized = this.normalizeFieldName(header);
            
            const matchedField = collectionFields.find(field => {
                const fieldIdNorm = this.normalizeFieldName(field.id);
                const fieldLabelNorm = this.normalizeFieldName(field.label || '');
                
                return fieldIdNorm === normalized || fieldLabelNorm === normalized;
            });

            if (matchedField) {
                mapping[header] = {
                    fieldId: matchedField.id,
                    fieldType: matchedField.type,
                    matched: true
                };
            } else {
                mapping[header] = { matched: false };
            }
        }

        return mapping;
    }

    async createCollectionWithProperties(collectionName, headers, propertyConfig, choiceOptions = {}) {
        console.log('[CSV Import] Creating collection:', collectionName);

        const newCollection = await this.data.createCollection();
        if (!newCollection) {
            throw new Error('Failed to create collection');
        }

        const config = newCollection.getConfiguration();
        const fields = headers.map((header, idx) => {
            const fieldType = propertyConfig[header] || 'text';
            const fieldId = this.normalizeFieldName(header) || `field_${idx}`;

            const field = {
                id: fieldId,
                label: header,
                type: fieldType,
                icon: this.getFieldIcon(fieldType),
                many: false,
                read_only: false,
                active: true
            };

            if (fieldType === 'choice' && choiceOptions[header]) {
                field.choices = choiceOptions[header];
            }

            return field;
        });

        config.name = collectionName;
        config.icon = 'ti-table';
        config.item_name = 'Row';
        config.description = 'Imported from CSV';
        config.fields = fields;
        config.page_field_ids = fields.map(f => f.id);
        config.sidebar_record_sort_field_id = fields[0]?.id || null;
        config.sidebar_record_sort_dir = 'asc';
        config.show_sidebar_items = true;
        config.show_cmdpal_items = true;
        
        config.views = [
            {
                id: 'table',
                label: 'All Rows',
                description: 'Table view',
                type: 'table',
                icon: '',
                shown: true,
                read_only: false,
                sort_field_id: fields[0]?.id || null,
                sort_dir: 'asc',
                group_by_field_id: null,
                field_ids: fields.map(f => f.id),
                opts: {}
            }
        ];

        const success = await newCollection.saveConfiguration(config);
        if (success === false) {
            throw new Error('Failed to save collection configuration');
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        const allCollections = await this.data.getAllCollections();
        const freshCollection = allCollections.find(c => c.getGuid() === newCollection.getGuid());
        
        if (!freshCollection) {
            throw new Error('Collection disappeared after creation');
        }

        const verifyConfig = freshCollection.getConfiguration();
        if (!verifyConfig.fields || verifyConfig.fields.length === 0) {
            throw new Error('Failed to create fields - configuration did not persist');
        }

        console.log('[CSV Import] Collection created with', verifyConfig.fields.length, 'fields');
        return freshCollection;
    }

    buildChoiceOptions(headers, rows, propertyConfig) {
        const choiceOptions = {};

        headers.forEach((header, colIndex) => {
            const fieldType = propertyConfig[header];
            
            if (fieldType !== 'choice') return;

            const values = rows
                .map(row => row[colIndex])
                .filter(val => val && val.trim())
                .map(val => val.trim());

            const uniqueValues = [...new Set(values)];

            if (uniqueValues.length > 50) {
                console.warn(`[CSV Import] Choice field "${header}" has ${uniqueValues.length} unique values - may be too many`);
            }

            choiceOptions[header] = uniqueValues.map((value, idx) => ({
                id: this.normalizeFieldName(value) || `choice_${idx}`,
                label: value,
                color: String((idx % 12) + 1),
                active: true
            }));

            console.log(`[CSV Import] Found ${uniqueValues.length} unique values for choice field "${header}"`);
        });

        return choiceOptions;
    }

    reconstructCSV(headers, dataRows) {
        const allRows = [headers, ...dataRows];
        return allRows.map(row => 
            row.map(cell => {
                if (cell.includes(',') || cell.includes('\n') || cell.includes('"')) {
                    return `"${cell.replace(/"/g, '""')}"`;
                }
                return cell;
            }).join(',')
        ).join('\n');
    }

    async readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    isTypeHintRow(row) {
        const validTypes = ['text', 'number', 'datetime', 'date', 'checkbox', 'choice', 'url'];
        let typeCount = 0;
        
        for (const cell of row) {
            const normalized = (cell || '').toLowerCase().trim();
            if (validTypes.includes(normalized)) {
                typeCount++;
            }
        }
        
        return typeCount >= row.length * 0.5;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    normalizeFieldName(name) {
        return name.toLowerCase().replace(/[\s\-_]+/g, '').trim();
    }

    coerceNumber(value) {
        if (typeof value === 'number') return value;
        if (typeof value !== 'string') return null;
        
        const trimmed = value.trim();
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
            const num = Number(trimmed);
            return isNaN(num) ? null : num;
        }
        return null;
    }

    coerceBoolean(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value !== 'string') return false;
        
        const lower = value.toLowerCase().trim();
        if (lower === 'true' || lower === 'yes' || lower === '1') return true;
        if (lower === 'false' || lower === 'no' || lower === '0') return false;
        return false;
    }

    parseDate(value) {
        if (!value) return null;
        if (value instanceof Date) return value;
        
        const date = new Date(value);
        return isNaN(date.getTime()) ? null : date;
    }

    // =========================================================================
    // MARKDOWN IMPORT DIALOG
    // =========================================================================

    showMarkdownImportDialog() {
        const colors = this.getThemeColors();
        
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: ${colors.background};
            color: ${colors.text};
            border-radius: 8px;
            padding: 24px;
            width: 90%;
            max-width: 600px;
            max-height: 80vh;
            overflow-y: auto;
            border: 1px solid ${colors.border};
        `;

        dialog.innerHTML = `
            <h2 style="margin: 0 0 16px 0; color: ${colors.text};">Import Markdown Files</h2>
            
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 500; color: ${colors.text};">Source:</label>
                <select id="md-source-select" style="width: 100%; padding: 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};">
                    <option value="obsidian">Obsidian</option>
                    <option value="joplin">Joplin (YAML)</option>
                    <option value="logseq">Logseq</option>
                    <option value="tolaria">Tolaria</option>
                </select>
            </div>

            <div id="md-collection-container" style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 500; color: ${colors.text};">Select Collection:</label>
                <select id="md-collection-select" style="width: 100%; padding: 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};">
                    <option value="">-- Select a collection --</option>
                    <option value="__CREATE_NEW__">✨ Create New Collection</option>
                </select>
            </div>
            
            <div id="new-collection-name-container" style="margin-bottom: 16px; display: none;">
                <label style="display: block; margin-bottom: 8px; font-weight: 500; color: ${colors.text};">New Collection Name:</label>
                <input 
                    type="text" 
                    id="new-collection-name" 
                    placeholder="e.g., Personal Notes, Knowledge Base"
                    style="width: 100%; padding: 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text};"
                >
            </div>
            
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px; font-weight: 500; color: ${colors.text};">Select Folder:</label>
                <button type="button" id="select-folder-btn" style="width: 100%; padding: 12px; border: 2px dashed ${colors.border}; background: ${colors.backgroundSecondary}; color: ${colors.text}; border-radius: 4px; cursor: pointer; text-align: center;">
                    📁 Click to select markdown folder
                </button>
                <div id="folder-info" style="margin-top: 8px; font-size: 12px; color: ${colors.textSecondary};"></div>
            </div>
            
            <div id="md-journal-container" style="margin-bottom: 16px; padding: 16px; background: ${colors.backgroundSecondary}; border-radius: 6px; border: 1px solid ${colors.border};">
                <label style="display: flex; align-items: center; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="import-journals-checkbox" style="margin-right: 8px; cursor: pointer;">
                    <span style="font-weight: 500; color: ${colors.text};">Import daily notes to Journal</span>
                </label>
                <div id="journal-folder-container" style="margin-top: 12px; display: none;">
                    <label style="display: block; margin-bottom: 6px; font-size: 13px; color: ${colors.textSecondary};">
                        Journal folder name (leave blank for auto-detect):
                    </label>
                    <input 
                        type="text" 
                        id="journal-folder-input" 
                        placeholder="e.g., Daily Notes, journals, Journal"
                        style="width: 100%; padding: 6px 8px; border: 1px solid ${colors.inputBorder}; border-radius: 4px; background: ${colors.input}; color: ${colors.text}; font-size: 13px;"
                    >
                    <div style="margin-top: 6px; font-size: 12px; color: ${colors.textSecondary};">
                        💡 Files in this folder will be imported to your Thymer Journal instead of the collection
                    </div>
                </div>
            </div>
            
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
                <button id="md-cancel-btn" style="padding: 8px 16px; border: 1px solid ${colors.buttonBorder}; background: ${colors.buttonBg}; color: ${colors.buttonText}; border-radius: 4px; cursor: pointer;">Cancel</button>
                <button id="md-import-btn" style="padding: 8px 16px; border: none; background: ${colors.primary}; color: #fff; border-radius: 4px; cursor: pointer;" disabled>Import</button>
            </div>
            <div id="md-status" style="margin-top: 16px; padding: 12px; border-radius: 4px; display: none;"></div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        this.loadCollections(dialog, 'md-collection-select');

        const collectionSelect = dialog.querySelector('#md-collection-select');
        const newCollectionNameContainer = dialog.querySelector('#new-collection-name-container');
        const importBtn = dialog.querySelector('#md-import-btn');
        const journalCheckbox = dialog.querySelector('#import-journals-checkbox');
        const journalFolderContainer = dialog.querySelector('#journal-folder-container');
        const sourceSelect = dialog.querySelector('#md-source-select');
        let selectedDirHandle = null;

        // Tolaria builds its collections from the vault's types, so there is no target collection to pick
        sourceSelect.addEventListener('change', () => {
            const tolaria = sourceSelect.value === 'tolaria';
            dialog.querySelector('#md-collection-container').style.display = tolaria ? 'none' : '';
            dialog.querySelector('#md-journal-container').style.display = tolaria ? 'none' : '';
            newCollectionNameContainer.style.display = !tolaria && collectionSelect.value === '__CREATE_NEW__' ? 'block' : 'none';
            this.updateImportButtonState(importBtn, collectionSelect, selectedDirHandle, tolaria);
        });

        // Toggle journal folder input visibility
        journalCheckbox.addEventListener('change', () => {
            journalFolderContainer.style.display = journalCheckbox.checked ? 'block' : 'none';
        });

        collectionSelect.addEventListener('change', () => {
            if (collectionSelect.value === '__CREATE_NEW__') {
                newCollectionNameContainer.style.display = 'block';
            } else {
                newCollectionNameContainer.style.display = 'none';
            }
            this.updateImportButtonState(importBtn, collectionSelect, selectedDirHandle, sourceSelect.value === 'tolaria');
        });

        dialog.querySelector('#select-folder-btn').onclick = async () => {
            try {
                const picked = await this.pickFolder();
                if (!picked) {
                    return;
                }
                selectedDirHandle = picked;

                const folderInfo = dialog.querySelector('#folder-info');
                if (picked.kind === 'filelist') {
                    const n = picked.files ? picked.files.length : 0;
                    folderInfo.textContent = `✓ Folder selected (${n} file(s); macOS/Safari uses file chooser)`;
                } else {
                    const label = picked.name && String(picked.name).trim()
                        ? picked.name
                        : 'Folder';
                    folderInfo.textContent = `✓ Selected: ${label}`;
                }
                folderInfo.style.color = colors.success;

                this.updateImportButtonState(importBtn, collectionSelect, selectedDirHandle, sourceSelect.value === 'tolaria');
            } catch (error) {
                if (error.name !== 'AbortError') {
                    console.error('[MD Import] Error selecting folder:', error);
                    const folderInfo = dialog.querySelector('#folder-info');
                    folderInfo.textContent = `Error: ${error.message}`;
                    folderInfo.style.color = colors.error;
                }
            }
        };

        dialog.querySelector('#md-cancel-btn').onclick = () => {
            document.body.removeChild(overlay);
        };

        dialog.querySelector('#md-import-btn').onclick = () => {
            this.performMarkdownImport(dialog, overlay, selectedDirHandle);
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        };
    }

    updateImportButtonState(importBtn, collectionSelect, selectedDirHandle, skipCollection = false) {
        const hasFolder = selectedDirHandle !== null;
        const hasCollection = skipCollection || collectionSelect.value !== '';
        
        if (hasFolder && hasCollection) {
            importBtn.disabled = false;
        } else {
            importBtn.disabled = true;
        }
    }

    async loadCollections(dialog, selectId) {
        const select = dialog.querySelector(`#${selectId}`);
        const collections = await this.data.getAllCollections();
        
        collections.forEach(collection => {
            const option = document.createElement('option');
            option.value = collection.getGuid();
            option.textContent = collection.getName();
            select.appendChild(option);
        });
    }

    async performMarkdownImport(dialog, overlay, dirHandle) {
        const select = dialog.querySelector('#md-collection-select');
        const sourceSelect = dialog.querySelector('#md-source-select');
        const statusDiv = dialog.querySelector('#md-status');
        const importBtn = dialog.querySelector('#md-import-btn');
        const newCollectionNameInput = dialog.querySelector('#new-collection-name');
        const journalCheckbox = dialog.querySelector('#import-journals-checkbox');
        const journalFolderInput = dialog.querySelector('#journal-folder-input');

        const collectionGuid = select.value;
        const source = sourceSelect.value;
        if (source === 'tolaria') {
            return this.performTolariaImport(dialog, overlay, dirHandle);
        }
        const isCreatingNew = collectionGuid === '__CREATE_NEW__';
        const importToJournal = journalCheckbox.checked;
        const journalFolderName = journalFolderInput.value.trim();

        if (isCreatingNew) {
            const newName = newCollectionNameInput.value.trim();
            if (!newName) {
                this.showStatus(statusDiv, 'Please enter a name for the new collection', 'error');
                return;
            }
        }

        importBtn.disabled = true;
        importBtn.textContent = 'Scanning...';
        this.showStatus(statusDiv, 'Scanning files...', 'info');

        try {
            if (source === 'logseq' && dirHandle && dirHandle.kind === 'filelist') {
                this.showStatus(
                    statusDiv,
                    'Logseq import needs the native folder dialog (pages/journals). Use Chrome/Edge or Thymer builds with showDirectoryPicker, or choose Obsidian/Joplin for this folder.',
                    'error'
                );
                importBtn.disabled = false;
                importBtn.textContent = 'Import';
                return;
            }

            const scanResults = source === 'logseq' 
                ? await this.scanLogseqFiles(dirHandle)
                : await this.scanVaultFiles(dirHandle);
            
            if (scanResults.files.length === 0) {
                this.showStatus(statusDiv, 'No .md files found', 'error');
                importBtn.disabled = false;
                importBtn.textContent = 'Import';
                return;
            }

            // Separate journal files from regular files if journal import is enabled
            let journalFiles = [];
            let regularFiles = scanResults.files;
            
            if (importToJournal) {
                const { journal, regular } = await this.separateJournalFiles(
                    scanResults.files, 
                    source, 
                    journalFolderName
                );
                journalFiles = journal;
                regularFiles = regular;
                
                console.log(`[MD Import] Separated: ${journalFiles.length} journal files, ${regularFiles.length} regular files`);
            }

            // Import journal files first if any
            if (journalFiles.length > 0) {
                this.showStatus(statusDiv, `Importing ${journalFiles.length} journal entries...`, 'info');
                
                const collections = await this.data.getAllCollections();
                const journalCollection = collections.find(c => c.isJournalPlugin());
                
                if (!journalCollection) {
                    this.showStatus(statusDiv, 'Journal not enabled. Enable Journal to import daily notes.', 'error');
                    importBtn.disabled = false;
                    importBtn.textContent = 'Import';
                    return;
                }
                
                await this.importDailyNotesFromFiles(journalCollection, journalFiles, source, statusDiv);
            }

            // Import regular files to collection
            let importResult = { imported: 0, updated: 0, errors: 0 };
            
            if (regularFiles.length > 0) {
                this.showStatus(statusDiv, `Analyzing ${regularFiles.length} files...`, 'info');
                
                const analysis = source === 'logseq'
                    ? await this.analyzeLogseqProperties(regularFiles)
                    : await this.analyzeFrontmatter(regularFiles);

                let collection;

                if (isCreatingNew) {
                    const newName = newCollectionNameInput.value.trim();
                    this.showStatus(statusDiv, `Creating collection "${newName}"...`, 'info');
                    
                    // Remove journal folder from topFolders if it exists
                    let topFolders = scanResults.topFolders;
                    if (importToJournal && journalFolderName) {
                        topFolders = topFolders.filter(f => 
                            f.toLowerCase() !== journalFolderName.toLowerCase()
                        );
                    }
                    
                    collection = await this.createMarkdownCollection(newName, topFolders, analysis.properties, {});
                    
                    if (!collection) {
                        throw new Error('Failed to create collection');
                    }
                } else {
                    const collections = await this.data.getAllCollections();
                    collection = collections.find(c => c.getGuid() === collectionGuid);
                    if (!collection) {
                        throw new Error('Collection not found');
                    }
                }

                this.showStatus(statusDiv, 'Importing files...', 'info');
                importResult = await this.executeImport(collection, regularFiles, source, statusDiv);

                this.showStatus(statusDiv, 'Resolving links...', 'info');
                await this.resolveWikiLinksWithSegments(collection, source, statusDiv);
            }

            // Show final summary
            const summary = [];
            if (journalFiles.length > 0) {
                summary.push(`Journal: ${journalFiles.length} entries`);
            }
            if (regularFiles.length > 0) {
                summary.push(`Collection: ${importResult.imported} imported, ${importResult.updated} updated`);
            }
            
            this.showStatus(statusDiv, `Complete! ${summary.join(' | ')}`, 'success');
            
            setTimeout(() => {
                document.body.removeChild(overlay);
            }, 2000);

        } catch (error) {
            console.error('[MD Import] Error:', error);
            this.showStatus(statusDiv, `Error: ${error.message}`, 'error');
            importBtn.disabled = false;
            importBtn.textContent = 'Import';
        }
    }

    async separateJournalFiles(files, source, journalFolderName) {
        const journal = [];
        const regular = [];
        
        // Auto-detect common journal folder names if not specified
        const commonJournalFolders = ['daily notes', 'journal', 'journals', 'dailies', 'daily'];
        const folderToCheck = journalFolderName.toLowerCase() || null;
        
        for (const file of files) {
            let isJournal = false;
            
            // Check if file is in the specified journal folder
            if (folderToCheck) {
                const pathLower = file.path.toLowerCase();
                isJournal = pathLower.includes(`/${folderToCheck}/`) || 
                           pathLower.startsWith(`${folderToCheck}/`) ||
                           file.topFolder.toLowerCase() === folderToCheck;
            } else {
                // Auto-detect based on common folder names
                const pathLower = file.path.toLowerCase();
                isJournal = commonJournalFolders.some(folder => 
                    pathLower.includes(`/${folder}/`) || 
                    pathLower.startsWith(`${folder}/`) ||
                    file.topFolder.toLowerCase() === folder
                );
            }
            
            // Also check if filename is date-formatted (even outside journal folder)
            if (!isJournal) {
                const hasDateFormat = source === 'logseq' 
                    ? this.parseLogseqDateFromFilename(file.name)
                    : this.parseObsidianDateFromFilename(file.name);
                
                if (hasDateFormat && !folderToCheck) {
                    isJournal = true;
                }
            }
            
            if (isJournal) {
                journal.push(file);
            } else {
                regular.push(file);
            }
        }
        
        return { journal, regular };
    }

    async importDailyNotesFromFiles(journalCollection, files, source, statusDiv) {
        let imported = 0;
        let updated = 0;
        let errors = 0;

        console.log(`[Journal Import] Importing ${files.length} journal files`);

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            try {
                if (i % 5 === 0) {
                    this.showStatus(statusDiv, `Importing journal ${i + 1}/${files.length}`, 'info');
                }

                console.log(`[Journal Import] Processing: ${file.name}`);

                // Parse date from filename
                const dateStr = source === 'logseq'
                    ? this.parseLogseqDateFromFilename(file.name)
                    : this.parseObsidianDateFromFilename(file.name);
                
                if (!dateStr) {
                    console.error(`[Journal Import] Could not parse date from filename: ${file.name}`);
                    errors++;
                    continue;
                }

                // Read the file content
                const fileHandle = await this.getFileFromHandle(file.handle);
                const content = await fileHandle.text();

                // Parse the markdown
                const parsed = source === 'logseq'
                    ? this.parseLogseqFile(content)
                    : this.parseMarkdownFile(content);

                // Parse date components
                const [year, month, day] = dateStr.split('-').map(n => parseInt(n));

                // Get current user
                const users = this.data.getActiveUsers();
                const currentUser = users[0];
                
                if (!currentUser) {
                    console.error(`[Journal Import] No active user found`);
                    errors++;
                    continue;
                }

                // Create DateTime object (month is 0-indexed)
                const dateTime = DateTime.dateOnly(year, month - 1, day);

                // Get or create journal record
                const journalRecord = await journalCollection.getJournalRecord(currentUser, dateTime);
                
                if (!journalRecord) {
                    console.error(`[Journal Import] Failed to get/create journal record for ${dateStr}`);
                    errors++;
                    continue;
                }

                // Wait for record to be ready
                await new Promise(resolve => setTimeout(resolve, 500));

                // Check if new or existing
                const lineItems = await journalRecord.getLineItems();
                const isNew = !lineItems || lineItems.length === 0;

                if (isNew) {
                    imported++;
                } else {
                    updated++;
                }

                // Insert markdown content
                if (parsed.markdown) {
                    const md = this.prepareMarkdownForThymerImport(parsed.markdown);
                    const success = await journalRecord.insertFromMarkdown(
                        md,
                        null,
                        null
                    );
                    
                    if (!success) {
                        console.error(`[Journal Import] insertFromMarkdown returned false for ${file.name}`);
                        errors++;
                    }
                }

            } catch (error) {
                console.error(`[Journal Import] Error processing ${file.name}:`, error);
                errors++;
            }
        }

        console.log(`[Journal Import] Complete: ${imported} imported, ${updated} updated, ${errors} errors`);
    }


    async createMarkdownCollection(collectionName, topFolders, properties, propertyConfig) {
        console.log('[MD Import] Creating collection:', collectionName);

        const newCollection = await this.data.createCollection();
        if (!newCollection) {
            throw new Error('Failed to create collection');
        }

        const config = newCollection.getConfiguration();
        const fields = [];

        if (topFolders.length > 0) {
            const folderChoices = topFolders.map((folder, i) => ({
                id: this.slugify(folder) || `folder_${i}`,
                label: folder,
                color: String(i % 10),
                active: true
            }));

            fields.push({
                id: 'folder',
                label: 'Folder',
                type: 'choice',
                icon: 'ti-folder',
                many: false,
                read_only: false,
                active: true,
                choices: folderChoices
            });
        }

        fields.push({
            id: 'source_path',
            label: 'Source Path',
            type: 'text',
            icon: 'ti-link',
            many: false,
            read_only: true,
            active: true
        });

        for (const prop of properties) {
            const fieldId = this.slugify(prop.key);
            if (!fieldId || fields.find(f => f.id === fieldId)) continue;

            fields.push({
                id: fieldId,
                label: prop.key,
                type: prop.recommendedType?.type || 'text',
                icon: this.getFieldIcon(prop.recommendedType?.type || 'text'),
                many: prop.recommendedType?.many === true,
                read_only: false,
                active: true
            });
        }

        config.name = collectionName;
        config.icon = 'ti-notebook';
        config.item_name = 'Note';
        config.description = 'Imported from Markdown';
        config.fields = fields;
        config.page_field_ids = fields.map(f => f.id);
        config.sidebar_record_sort_field_id = fields[0]?.id || 'title';
        config.sidebar_record_sort_dir = 'desc';
        config.show_sidebar_items = true;
        config.show_cmdpal_items = true;
        
        config.views = [
            {
                id: 'table',
                label: 'All Notes',
                description: 'Table view',
                type: 'table',
                icon: '',
                shown: true,
                read_only: false,
                sort_field_id: fields[0]?.id || null,
                sort_dir: 'asc',
                group_by_field_id: null,
                field_ids: fields.map(f => f.id).slice(0, 8),
                opts: {}
            }
        ];

        if (fields.find(f => f.id === 'folder')) {
            config.views.push({
                id: 'board',
                label: 'By Folder',
                description: 'Board view',
                type: 'board',
                icon: '',
                shown: true,
                read_only: false,
                sort_field_id: fields[0]?.id || null,
                sort_dir: 'asc',
                group_by_field_id: 'folder',
                field_ids: fields.map(f => f.id).slice(0, 6),
                opts: {}
            });
        }

        const success = await newCollection.saveConfiguration(config);
        if (success === false) {
            throw new Error('Failed to save collection configuration');
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        const allCollections = await this.data.getAllCollections();
        const freshCollection = allCollections.find(c => c.getGuid() === newCollection.getGuid());
        
        if (!freshCollection) {
            throw new Error('Collection disappeared after creation');
        }

        const verifyConfig = freshCollection.getConfiguration();
        if (!verifyConfig.fields || verifyConfig.fields.length === 0) {
            throw new Error('Failed to create fields - configuration did not persist');
        }

        console.log('[MD Import] Collection created with', verifyConfig.fields.length, 'fields');
        return freshCollection;
    }

    getFieldIcon(fieldType) {
        const iconMap = {
            'text': 'ti-abc',
            'number': 'ti-123',
            'datetime': 'ti-clock',
            'checkbox': 'ti-checkbox',
            'choice': 'ti-tag',
            'hashtag': 'ti-hash',
            'url': 'ti-link'
        };
        return iconMap[fieldType] || 'ti-abc';
    }

    // =========================================================================
    // THEME UTILITIES
    // =========================================================================

    isDarkMode() {
        const body = document.body;
        
        if (body.classList.contains('dark') || body.classList.contains('dark-mode')) {
            return true;
        }
        
        if (body.dataset.theme === 'dark') {
            return true;
        }
        
        const bgColor = window.getComputedStyle(body).backgroundColor;
        if (bgColor) {
            const rgb = bgColor.match(/\d+/g);
            if (rgb && rgb.length >= 3) {
                const luminance = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
                return luminance < 0.5;
            }
        }
        
        return false;
    }

    getThemeColors() {
        const isDark = this.isDarkMode();
        
        if (isDark) {
            return {
                background: '#1e1e1e',
                backgroundSecondary: '#2d2d2d',
                border: '#3d3d3d',
                text: '#e0e0e0',
                textSecondary: '#a0a0a0',
                input: '#2d2d2d',
                inputBorder: '#3d3d3d',
                buttonBg: '#fff',
                buttonText: '#000',
                buttonBorder: '#3d3d3d',
                primary: '#4a9eff',
                primaryHover: '#3a8eef',
                success: '#5cb85c',
                error: '#d9534f',
                warning: '#f0ad4e',
                info: '#5bc0de',
                tableHeader: '#2d2d2d',
                tableRow: '#1e1e1e',
                tableRowAlt: '#252525',
                tableBorder: '#3d3d3d'
            };
        } else {
            return {
                background: '#fff',
                backgroundSecondary: '#f5f5f5',
                border: '#ccc',
                text: '#000',
                textSecondary: '#666',
                input: '#fff',
                inputBorder: '#ccc',
                buttonBg: '#000',
                buttonText: '#fff',
                buttonBorder: '#000',
                primary: '#007bff',
                primaryHover: '#0056b3',
                success: '#28a745',
                error: '#dc3545',
                warning: '#ffc107',
                info: '#17a2b8',
                tableHeader: '#f5f5f5',
                tableRow: '#fff',
                tableRowAlt: '#f9f9f9',
                tableBorder: '#ddd'
            };
        }
    }

    // =========================================================================
    // VAULT SCANNING & ANALYSIS (for Obsidian/Logseq)
    // =========================================================================

    async scanVaultFiles(dirHandle) {
        if (dirHandle && dirHandle.kind === 'filelist') {
            return this.scanVaultFilesFromFileList(dirHandle);
        }

        const files = [];
        const topFolders = new Set();

        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
                topFolders.add(entry.name);
            }
        }

        await this.scanDirectory(dirHandle, '', files, null);

        return { 
            files, 
            topFolders: Array.from(topFolders).sort() 
        };
    }

    /**
     * Build vault file list from <input webkitdirectory> (File[]) when showDirectoryPicker is unavailable.
     */
    scanVaultFilesFromFileList(fileListResult) {
        const files = [];
        const topFolders = new Set();
        const list = fileListResult.files || [];

        for (const file of list) {
            if (!file || !file.name || !file.name.toLowerCase().endsWith('.md')) {
                continue;
            }
            const relPath = file.webkitRelativePath || file.name;
            const parts = relPath.split('/').filter(Boolean);
            if (parts.length === 0) {
                continue;
            }
            const baseName = parts[parts.length - 1];
            if (!baseName.toLowerCase().endsWith('.md')) {
                continue;
            }

            let topFolder = 'Root';
            if (parts.length > 1) {
                topFolder = parts[0];
                topFolders.add(parts[0]);
            }

            const fullPath = parts.join('/');
            const name = baseName.replace(/\.md$/i, '');

            files.push({
                handle: file,
                path: fullPath,
                name: name,
                topFolder: topFolder
            });
        }

        return {
            files,
            topFolders: Array.from(topFolders).sort()
        };
    }

    async scanLogseqFiles(dirHandle) {
        const files = [];
        const allowedTop = new Set(['pages', 'journals']);
        const presentTop = new Set();

        for await (const entry of dirHandle.values()) {
            if (entry.kind === 'directory' && allowedTop.has(entry.name)) {
                presentTop.add(entry.name);
                await this.scanLogseqDirectory(entry, entry.name, files, entry.name);
            }
        }

        return {
            files,
            topFolders: Array.from(presentTop).sort()
        };
    }

    async scanLogseqDirectory(dirHandle, path, files, topFolder) {
        for await (const entry of dirHandle.values()) {
            const fullPath = path ? `${path}/${entry.name}` : entry.name;

            if (entry.kind === 'directory') {
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.obsidian') {
                    continue;
                }
                await this.scanLogseqDirectory(entry, fullPath, files, topFolder);
            } else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                files.push({
                    handle: entry,
                    path: fullPath,
                    name: entry.name.replace(/\.md$/, ''),
                    topFolder: topFolder || 'pages'
                });
            }
        }
    }

    async scanDirectory(dirHandle, path, files, topFolder) {
        for await (const entry of dirHandle.values()) {
            const fullPath = path ? `${path}/${entry.name}` : entry.name;

            if (entry.kind === 'directory') {
                if (entry.name.startsWith('.') || 
                    entry.name === 'node_modules' ||
                    entry.name === '.obsidian' ||
                    entry.name === '.trash') {
                    continue;
                }
                await this.scanDirectory(entry, fullPath, files, topFolder || entry.name);

            } else if (entry.kind === 'file' && entry.name.endsWith('.md')) {
                files.push({
                    handle: entry,
                    path: fullPath,
                    name: entry.name.replace(/\.md$/, ''),
                    topFolder: topFolder || 'Root'
                });
            }
        }
    }

    async analyzeFrontmatter(files) {
        const propertyStats = new Map();
        let filesWithFrontmatter = 0;
        const sampleSize = Math.min(files.length, 500);
        const step = Math.ceil(files.length / sampleSize);

        for (let i = 0; i < files.length; i += step) {
            const file = files[i];
            try {
                const fileHandle = await this.getFileFromHandle(file.handle);
                const content = await fileHandle.text();
                const { frontmatter } = this.parseMarkdownFile(content);

                if (Object.keys(frontmatter).length > 0) {
                    filesWithFrontmatter++;

                    for (const [key, value] of Object.entries(frontmatter)) {
                        if (!propertyStats.has(key)) {
                            propertyStats.set(key, {
                                count: 0,
                                types: new Set(),
                                samples: []
                            });
                        }

                        const stat = propertyStats.get(key);
                        stat.count++;
                        stat.types.add(this.inferType(value));
                        
                        if (stat.samples.length < 5) {
                            stat.samples.push(value);
                        }
                    }
                }
            } catch (error) {
                console.error(`Error analyzing ${file.name}:`, error);
            }
        }

        const properties = Array.from(propertyStats.entries())
            .map(([key, stat]) => ({
                key,
                count: stat.count,
                percentage: Math.round((stat.count / filesWithFrontmatter) * 100),
                recommendedType: this.recommendFieldType(stat.types, stat.samples, key)
            }))
            .sort((a, b) => b.count - a.count);

        return {
            totalFiles: files.length,
            filesWithFrontmatter,
            properties
        };
    }

    async analyzeLogseqProperties(files) {
        const propertyStats = new Map();
        let filesWithProps = 0;
        const sampleSize = Math.min(files.length, 500);
        const step = Math.ceil(files.length / sampleSize);

        for (let i = 0; i < files.length; i += step) {
            const file = files[i];
            try {
                const fileHandle = await this.getFileFromHandle(file.handle);
                const content = await fileHandle.text();
                const { frontmatter } = this.parseLogseqFile(content);

                if (Object.keys(frontmatter).length > 0) {
                    filesWithProps++;

                    for (const [key, value] of Object.entries(frontmatter)) {
                        if (!propertyStats.has(key)) {
                            propertyStats.set(key, {
                                count: 0,
                                types: new Set(),
                                samples: []
                            });
                        }

                        const stat = propertyStats.get(key);
                        stat.count++;
                        stat.types.add(this.inferType(value));
                        
                        if (stat.samples.length < 5) {
                            stat.samples.push(value);
                        }
                    }
                }
            } catch (error) {
                console.error(`[Logseq Scan] Error analyzing ${file.name}:`, error);
            }
        }

        const properties = Array.from(propertyStats.entries())
            .map(([key, stat]) => ({
                key,
                count: stat.count,
                percentage: filesWithProps === 0 ? 0 : Math.round((stat.count / filesWithProps) * 100),
                recommendedType: this.recommendFieldType(stat.types, stat.samples, key)
            }))
            .sort((a, b) => b.count - a.count);

        return {
            totalFiles: files.length,
            filesWithFrontmatter: filesWithProps,
            properties
        };
    }

    inferType(value) {
        if (Array.isArray(value)) return 'array';
        if (value === null || value === undefined) return 'null';
        if (typeof value === 'boolean') return 'boolean';
        if (typeof value === 'number') return 'number';
        if (typeof value === 'string') {
            if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
            if (/^\d+$/.test(value)) return 'number_string';
            return 'string';
        }
        return 'unknown';
    }

    recommendFieldType(types, samples, key) {
        const k = String(key || '').trim().toLowerCase();
        if (k === 'tag' || k === 'tags') {
            const typeArray = Array.from(types);
            const many = typeArray.includes('array');
            return {
                type: 'hashtag',
                note: many ? 'Tags (hashtag)' : 'Tag (hashtag)',
                many: many
            };
        }

        const typeArray = Array.from(types);
        
        if (typeArray.includes('array')) {
            return { type: 'text', note: 'Multi-value list (e.g. tags)', many: true };
        }
        
        if (typeArray.includes('date')) {
            return { type: 'datetime', note: 'Date field' };
        }
        
        if (typeArray.includes('string')) {
            const dateCount = samples.filter(s => 
                typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)
            ).length;
            
            if (dateCount > samples.length * 0.5) {
                return { type: 'datetime', note: 'Date field (from samples)' };
            }
        }
        
        if (typeArray.every(t => t === 'number' || t === 'number_string')) {
            return { type: 'number', note: 'Numeric' };
        }
        
        if (typeArray.includes('boolean')) {
            return { 
                type: 'choice', 
                note: 'Boolean as choice',
                choices: ['true', 'false']
            };
        }
        
        if (typeArray.includes('string')) {
            const distinctValues = new Set(
                samples
                    .filter(s => typeof s === 'string' && s && s.trim())
                    .map(s => s.trim())
            );
            
            if (distinctValues.size >= 2 && distinctValues.size <= 10 && samples.length >= 5) {
                return { 
                    type: 'choice', 
                    note: `${distinctValues.size} options`,
                    choices: Array.from(distinctValues)
                };
            }
        }
        
        return { type: 'text', note: 'Text field' };
    }

    parseMarkdownFile(content) {
        const normalized = String(content)
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n');
        const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (frontmatterMatch) {
            return { 
                frontmatter: this.parseYAML(frontmatterMatch[1]), 
                markdown: frontmatterMatch[2].trim() 
            };
        }
        return { frontmatter: {}, markdown: normalized.trim() };
    }

    /**
     * Controlled by plugin.json `custom.markdown_import_hashtag_escape` (default true).
     * Set to false to pass markdown through unchanged for insertFromMarkdown.
     */
    isMarkdownImportHashtagEscapeEnabled() {
        try {
            const conf = this.getConfiguration();
            const v = conf && conf.custom && conf.custom.markdown_import_hashtag_escape;
            return v !== false;
        } catch (e) {
            return true;
        }
    }

    /**
     * insertFromMarkdown has no option to disable hashtag detection; the SDK stores
     * "#…" as hashtag segments. Insert U+200C after "#" only when it looks like a number
     * or 6-digit hex color, so "issue #123" and "#aabbcc" stay plain text while "#tag"
     * imports still become Thymer hashtags. Skips fenced ``` code ```, inline `code`,
     * and ATX heading lines (leading #{1,6} + space).
     */
    prepareMarkdownForThymerImport(markdown) {
        if (markdown == null || typeof markdown !== 'string' || markdown.length === 0) {
            return markdown;
        }
        if (!this.isMarkdownImportHashtagEscapeEnabled()) {
            return markdown;
        }
        const parts = markdown.split(/(```[\s\S]*?```)/g);
        return parts.map((chunk) => {
            if (chunk.startsWith('```')) {
                return chunk;
            }
            return this.escapeThymerHashtagTokensInMarkdownChunk(chunk);
        }).join('');
    }

    escapeThymerHashtagTokensInMarkdownChunk(text) {
        const lines = text.split('\n');
        return lines.map((line) => {
            const heading = line.match(/^(\s{0,3})(#{1,6})(\s)(.*)$/);
            if (heading) {
                return heading[1] + heading[2] + heading[3]
                    + this.escapeThymerHashtagRunsOutsideInlineCode(heading[4]);
            }
            return this.escapeThymerHashtagRunsOutsideInlineCode(line);
        }).join('\n');
    }

    escapeThymerHashtagRunsOutsideInlineCode(line) {
        const pieces = line.split(/(`[^`]*`)/g);
        return pieces.map((piece) => {
            if (piece.length >= 2 && piece[0] === '`' && piece[piece.length - 1] === '`') {
                return piece;
            }
            return piece
                .replace(/(?<![A-Za-z0-9_])#(?=[a-fA-F0-9]{6}\b)/gi, '#\u200c')
                .replace(/(?<![A-Za-z0-9_])#(?=\d)/g, '#\u200c');
        }).join('');
    }

    parseLogseqFile(content) {
        const lines = content.split(/\r?\n/);
        const frontmatter = {};
        const blockIds = new Set();
        const bodyLines = [];

        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            const propMatch = line.match(/^(\s*)(?:[-*]\s*)?([A-Za-z0-9_\-\/]+)::\s*(.*)$/);

            if (propMatch) {
                const indent = propMatch[1].length;
                const key = propMatch[2].trim();
                const rawValue = propMatch[3].trim();
                const parsedValue = this.parseLogseqValue(rawValue);

                if (indent <= 1 && frontmatter[key] === undefined) {
                    frontmatter[key] = parsedValue;
                }

                if (key.toLowerCase() === 'id' && rawValue) {
                    const idValue = rawValue.split(/\s+/)[0].trim();
                    if (idValue) blockIds.add(idValue);
                }
            }

            bodyLines.push(line);
        }

        // Return raw markdown - let the native insertFromMarkdown handle conversions
        const markdown = bodyLines.join('\n');
        return { frontmatter, markdown, blockIds: Array.from(blockIds) };
    }

    parseLogseqValue(value) {
        if (value === 'true') return true;
        if (value === 'false') return false;

        if (value.startsWith('[') && value.endsWith(']')) {
            return value
                .slice(1, -1)
                .split(',')
                .map(v => v.trim())
                .filter(v => v);
        }

        return value;
    }

    async getFileFromHandle(handle) {
        if (!handle) throw new Error('Missing file handle');
        if (typeof handle.getFile === 'function') {
            return await handle.getFile();
        }
        if (typeof handle.text === 'function') {
            return handle;
        }
        throw new Error('Unsupported file handle type');
    }

    parseYAML(yaml) {
        const result = {};
        const lines = yaml.split('\n');
        let currentKey = null;
        let currentArray = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('-')) {
                if (currentKey && currentArray) {
                    const item = trimmed.slice(1).trim();
                    if (item) currentArray.push(item);
                }
                continue;
            }

            const colonIndex = line.indexOf(':');
            if (colonIndex === -1) continue;

            if (currentKey && currentArray) {
                result[currentKey] = currentArray;
                currentArray = null;
            }

            const key = line.slice(0, colonIndex).trim();
            let value = line.slice(colonIndex + 1).trim();

            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }

            if (!value) {
                currentKey = key;
                currentArray = [];
                continue;
            }

            if (value.startsWith('[') && value.endsWith(']')) {
                value = value.slice(1, -1).split(',').map(s => s.trim()).filter(s => s);
            } else if (value.startsWith('-')) {
                value = [value.slice(1).trim()];
            } else if (value === 'true') {
                value = true;
            } else if (value === 'false') {
                value = false;
            }

            result[key] = value;
            currentKey = null;
        }

        if (currentKey && currentArray) {
            result[currentKey] = currentArray;
        }

        return result;
    }

    // =========================================================================
    // IMPORT EXECUTION (Markdown)
    // =========================================================================

    async executeImport(collection, files, source = 'obsidian', statusDiv = null) {
        let imported = 0;
        let updated = 0;
        let errors = 0;
        this.blockIdToRecord = new Map();

        console.log(`[Import] Processing ${files.length} files`);

        const existingRecords = await collection.getAllRecords();
        const existingByKey = new Map();
        
        for (const record of existingRecords) {
            const name = record.getName();

            const pathValue = typeof record.text === 'function' 
                ? (record.text('source_path') || record.text('path') || '')
                : '';
            const dedupKey = this.makeDedupKey(pathValue, name);
            if (dedupKey.trim() !== '||') {
                existingByKey.set(dedupKey, record);
            }
        }

        if (statusDiv) {
            this.showStatus(statusDiv, 'Phase 1: Creating records with content...', 'info');
        } else {
            this.showToast('Phase 1: Creating records with content...', 2000);
        }

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            try {
                if (i % 10 === 0) {
                    if (statusDiv) {
                        this.showStatus(statusDiv, `Creating ${i + 1}/${files.length}`, 'info');
                    } else {
                        this.showToast(`Creating ${i + 1}/${files.length}`, 500);
                    }
                }

                const fileHandle = await this.getFileFromHandle(file.handle);
                const content = await fileHandle.text();
                const parsed = source === 'logseq'
                    ? this.parseLogseqFile(content)
                    : this.parseMarkdownFile(content);

                const recordTitle = parsed.frontmatter.title || parsed.frontmatter.Title || file.name;
                const dedupKey = this.makeDedupKey(file.path, recordTitle);
                const fallbackKey = this.makeDedupKey('', recordTitle);
                const existing = existingByKey.get(dedupKey) || existingByKey.get(fallbackKey);

                if (existing) {
                    this.setFieldValue(existing, 'source_path', file.path);
                    this.setFieldValue(existing, 'folder', file.topFolder);
                    this.setFieldValue(existing, 'source', source);
                    for (const [key, value] of Object.entries(parsed.frontmatter)) {
                        if (value === null || value === undefined || value === '') continue;
                        if (Array.isArray(value) && value.length === 0) continue;
                        this.setFrontmatterField(existing, key, value);
                    }
                    if (source === 'logseq') {
                        this.rememberBlockIds(parsed.blockIds, existing);
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    if (parsed.markdown) {
                        try {
                            const textProp = existing.prop('text');
                            if (textProp) textProp.set('');
                            
                            // Use native insertFromMarkdown
                            const md = this.prepareMarkdownForThymerImport(parsed.markdown);
                            const success = await existing.insertFromMarkdown(md, null, null);
                            if (!success) {
                                console.error(`[Import] insertFromMarkdown returned false for ${existing.getName()}`);
                            }
                        } catch (error) {
                            console.error(`[Import] insertFromMarkdown failed for ${existing.getName()}:`, error);
                        }
                    }
                    updated++;

                    existingByKey.set(dedupKey, existing);
                    existingByKey.set(fallbackKey, existing);
                } else {
                    const recordGuid = collection.createRecord(recordTitle);
                    if (!recordGuid) throw new Error('Failed to create record');

                    let record = null;
                    for (let attempt = 0; attempt < 5; attempt++) {
                        await new Promise(resolve => setTimeout(resolve, 100 + (attempt * 50)));
                        const records = await collection.getAllRecords();
                        record = records.find(r => r.guid === recordGuid);
                        if (record) break;
                    }
                    
                    if (!record) {
                        console.error(`[Import] Failed to find record after creation: ${recordTitle} (${recordGuid})`);
                        throw new Error('Record not found after 5 attempts');
                    }

                    await new Promise(resolve => setTimeout(resolve, 300));

                    this.setFieldValue(record, 'source_path', file.path);
                    this.setFieldValue(record, 'folder', file.topFolder);
                    this.setFieldValue(record, 'source', source);
                    for (const [key, value] of Object.entries(parsed.frontmatter)) {
                        if (value === null || value === undefined || value === '') continue;
                        if (Array.isArray(value) && value.length === 0) continue;
                        this.setFrontmatterField(record, key, value);
                    }
                    if (source === 'logseq') {
                        this.rememberBlockIds(parsed.blockIds, record);
                    }

                    if (parsed.markdown) {
                        try {
                            // Use native insertFromMarkdown
                            const md = this.prepareMarkdownForThymerImport(parsed.markdown);
                            const success = await record.insertFromMarkdown(md, null, null);
                            if (!success) {
                                console.error(`[Import] insertFromMarkdown returned false for ${file.name}`);
                            }
                        } catch (error) {
                            console.error(`[Import] insertFromMarkdown failed for ${file.name}:`, error);
                        }
                    }

                    existingByKey.set(dedupKey, record);
                    existingByKey.set(fallbackKey, record);
                    imported++;
                }

            } catch (error) {
                console.error(`[Import] Error on ${file.name}:`, error);
                errors++;
            }
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        
        if (statusDiv) {
            this.showStatus(statusDiv, 'Phase 2: Resolving wiki-links...', 'info');
        } else {
            this.showToast('Phase 2: Resolving wiki-links...', 2000);
        }
        await this.resolveWikiLinksWithSegments(collection, source, statusDiv);

        if (statusDiv) {
            this.showStatus(statusDiv, `Done! Imported: ${imported} | Updated: ${updated} | Errors: ${errors}`, 'success');
        } else {
            this.showToast(`Done! Imported: ${imported} | Updated: ${updated} | Errors: ${errors}`, 10000);
        }
        
        return { imported, updated, errors };
    }

    async resolveWikiLinksWithSegments(collection, source = 'obsidian', statusDiv = null) {
        const records = await collection.getAllRecords();
        const nameToRecord = new Map();
        const blockIdToRecord = this.blockIdToRecord || new Map();
        
        for (const record of records) {
            const name = record.getName();
            if (name) {
                nameToRecord.set(name.toLowerCase(), record);
            }
        }
        
        let linksFound = 0;
        let linksResolved = 0;
        
        for (const record of records) {
            try {
                const lineItems = await record.getLineItems();
                
                if (!lineItems || lineItems.length === 0) {
                    continue;
                }
                
                for (let i = 0; i < lineItems.length; i++) {
                    try {
                        const lineItem = lineItems[i];
                        
                        const segments = lineItem.segments || null;
                        
                        if (!segments || segments.length === 0) {
                            continue;
                        }
                        
                        if (source === 'logseq') {
                            const lineText = segments
                                .map(seg => (seg.type === 'text' && typeof seg.text === 'string') ? seg.text : '')
                                .join('');

                            if (/^\s*[-*]?\s*\[x\]\s+/i.test(lineText)) {
                                await this.setTaskStatus(lineItem, 8);
                            } else if (/^\s*[-*]?\s*\[\s\]\s+/.test(lineText)) {
                                await this.setTaskStatus(lineItem, 0);
                            }
                        }

                        let hasLinks = false;
                        for (const segment of segments) {
                            if (segment.type === 'text' && segment.text && (segment.text.includes('[[') || segment.text.includes('(('))) {
                                hasLinks = true;
                                break;
                            }
                        }
                        
                        if (!hasLinks) continue;
                        
                        const newSegments = [];
                        
                        for (const segment of segments) {
                            if (segment.type === 'text' && segment.text && (segment.text.includes('[[') || segment.text.includes('(('))) {
                                const linkRegex = /(\[\[([^\]]+)\]\]|\(\(([^\)]+)\)\))/g;
                                let lastIndex = 0;
                                let match;
                                let matched = false;
                                
                                while ((match = linkRegex.exec(segment.text)) !== null) {
                                    matched = true;
                                    linksFound++;

                                    const pageName = match[2] ? match[2].trim() : null;
                                    const blockId = match[3] ? match[3].trim() : null;

                                    let targetRecord = null;
                                    if (blockId) {
                                        targetRecord = blockIdToRecord.get(blockId.toLowerCase()) || null;
                                    }
                                    if (!targetRecord && pageName) {
                                        targetRecord = nameToRecord.get(pageName.toLowerCase()) || null;
                                    }
                                    
                                    if (match.index > lastIndex) {
                                        const textBefore = segment.text.substring(lastIndex, match.index);
                                        newSegments.push({
                                            type: 'text',
                                            text: textBefore
                                        });
                                    }
                                    
                                    if (targetRecord) {
                                        newSegments.push({
                                            type: 'ref',
                                            text: targetRecord.guid
                                        });
                                        linksResolved++;
                                    } else {
                                        newSegments.push({
                                            type: 'text',
                                            text: match[0]
                                        });
                                    }
                                    
                                    lastIndex = match.index + match[0].length;
                                }
                                
                                if (matched) {
                                    if (lastIndex < segment.text.length) {
                                        const textAfter = segment.text.substring(lastIndex);
                                        newSegments.push({
                                            type: 'text',
                                            text: textAfter
                                        });
                                    }
                                } else {
                                    newSegments.push(segment);
                                }
                            } else {
                                newSegments.push(segment);
                            }
                        }
                        
                        await lineItem.setSegments(newSegments);
                        
                    } catch (lineError) {
                        console.error(`[WikiLinks] Error processing line ${i}:`, lineError);
                    }
                }
                
            } catch (error) {
                console.error(`[WikiLinks] Error processing ${record.getName()}:`, error);
            }
        }
        
        this.showToast(`Found ${linksFound} wiki/block links, resolved ${linksResolved}`, 5000);
    }

    makeDedupKey(path, title) {
        const safePath = (path || '').trim().toLowerCase();
        const safeTitle = (title || '').trim().toLowerCase();
        return `${safePath}||${safeTitle}`;
    }

    rememberBlockIds(blockIds, record) {
        if (!blockIds || !Array.isArray(blockIds)) return;
        if (!this.blockIdToRecord) this.blockIdToRecord = new Map();

        for (const id of blockIds) {
            const key = (id || '').trim().toLowerCase();
            if (!key) continue;
            if (!this.blockIdToRecord.has(key)) {
                this.blockIdToRecord.set(key, record);
            }
        }
    }

    async setTaskStatus(lineItem, doneValue) {
        if (!lineItem || typeof lineItem.setMetaProperties !== 'function') return false;
        try {
            const result = lineItem.setMetaProperties({ done: doneValue });
            if (result && typeof result.then === 'function') {
                await result;
            }
            return true;
        } catch (error) {
            console.error('[Tasks] Failed to set task status', error);
            return false;
        }
    }

    setFrontmatterField(record, frontmatterKey, value) {
        const transformedValue = this.transformValue(value);
        if (Array.isArray(transformedValue) && transformedValue.length === 0) {
            return false;
        }
        const variations = this.getFieldVariations(frontmatterKey);
        
        for (const fieldId of variations) {
            if (this.setFieldValue(record, fieldId, transformedValue)) {
                return true;
            }
        }
        
        return false;
    }

    getFieldVariations(key) {
        const variations = [];
        
        variations.push(this.slugify(key));
        variations.push(key);
        variations.push(key.toLowerCase());
        variations.push(key.toLowerCase().replace(/\s+/g, '_'));
        variations.push(key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());

        const joplinAliases = {
            updated: ['updated_at'],
            created: ['created_at']
        };
        const extra = joplinAliases[key.toLowerCase()];
        if (extra) {
            for (const alias of extra) {
                variations.push(alias);
                variations.push(this.slugify(alias));
            }
        }
        
        return [...new Set(variations)];
    }

    setFieldValue(record, fieldId, value) {
        try {
            const prop = record.prop(fieldId);
            if (!prop) return false;

            if (Array.isArray(value)) {
                const cleaned = value.filter(v => v !== null && v !== undefined && v !== '');
                if (cleaned.length === 0) return false;
                const multi = typeof prop.isMultiValue === 'function' && prop.isMultiValue();
                if (multi) {
                    try {
                        if (typeof prop.setChoice === 'function' && prop.setChoice(cleaned)) {
                            return true;
                        }
                    } catch (e) {
                    }
                    try {
                        prop.set(cleaned);
                        return true;
                    } catch (e) {
                    }
                }
                try {
                    if (cleaned.length === 1 && typeof prop.setChoice === 'function' && prop.setChoice(cleaned[0])) {
                        return true;
                    }
                } catch (e) {
                }
                try {
                    prop.set(cleaned.join(', '));
                    return true;
                } catch (e) {
                    return false;
                }
            }

            if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
                const parsed = new Date(value);
                if (!isNaN(parsed.getTime())) {
                    try {
                        if (typeof prop.setFromDate === 'function') {
                            prop.setFromDate(parsed);
                            return true;
                        }
                    } catch (e) {
                    }
                    try {
                        const dateOnly = value.match(/^\d{4}-\d{2}-\d{2}/)[0];
                        const [year, month, day] = dateOnly.split('-');
                        prop.set({
                            d: year + month + day
                        });
                        return true;
                    } catch (e) {
                        try {
                            prop.set(value);
                            return true;
                        } catch (e2) {
                        }
                    }
                }
            }

            if (typeof value === 'string' && typeof prop.setChoice === 'function') {
                try {
                    if (prop.setChoice(value)) {
                        return true;
                    }
                } catch (e) {
                }
            }

            prop.set(value);
            return true;

        } catch (e) {
            return false;
        }
    }

    transformValue(value) {
        if (value === null || value === undefined) return value;
        
        if (typeof value === 'boolean') {
            return value ? 'true' : 'false';
        }
        
        if (Array.isArray(value)) {
            return value.filter(v => v !== null && v !== undefined && v !== '');
        }

        return value;
    }

    showToast(message, time) {
        this.ui.addToaster({
            title: message,
            dismissible: true,
            autoDestroyTime: time
        });
    }

    showStatus(statusDiv, message, type = 'info') {
        const colors = this.getThemeColors();
        statusDiv.style.display = 'block';
        statusDiv.textContent = message;
        statusDiv.style.padding = '12px';
        statusDiv.style.borderRadius = '4px';
        statusDiv.style.marginTop = '16px';
        
        const typeColors = {
            info: colors.info,
            success: colors.success,
            error: colors.error,
            warning: colors.warning
        };
        
        if (type === 'error') {
            statusDiv.style.background = this.isDarkMode() ? '#3d1f1f' : '#fee';
            statusDiv.style.border = `1px solid ${colors.error}`;
            statusDiv.style.color = colors.error;
        } else if (type === 'success') {
            statusDiv.style.background = this.isDarkMode() ? '#1f3d1f' : '#efe';
            statusDiv.style.border = `1px solid ${colors.success}`;
            statusDiv.style.color = colors.success;
        } else {
            statusDiv.style.background = this.isDarkMode() ? '#1f2d3d' : '#eef';
            statusDiv.style.border = `1px solid ${typeColors[type] || colors.info}`;
            statusDiv.style.color = typeColors[type] || colors.text;
        }
    }

    slugify(text) {
        if (!text) return '';
        return String(text)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
    }

    // ===== Tolaria source =====
    // Imports a Tolaria vault (flat *.md files with YAML frontmatter). Everything here builds on the
    // ImportPlan engine below: parseTolariaVault() is the only part that reads files and returns a plan,
    // performTolariaImport() is the dialog glue (parse -> applyImportPlan -> report).
    //
    // Mapping:
    //   `type: Type` notes      -> collection definitions (never records); only types with notes become collections
    //   other notes             -> records, in the collection of their `type:` (untyped -> "Notes")
    //   related_to / belongs_to -> multi-value record fields (planPropertyLink); target only if unambiguous
    //   [[slug]] / [[slug|x]]   -> planBodyLink (resolved by filename slug); code spans/fences are left alone
    //   ![alt](attachments/x)   -> planAsset
    //   _* keys, visible, color -> dropped (Tolaria UI state)
    // plan.parseReport carries parse-time facts (skipped files, unused types, ...) next to the plan.
    // =========================================================================

    /**
     * Lists the files of a picked folder (File System Access handle, or { kind: 'filelist', files } from the
     * webkitdirectory fallback) as [{ path, name, handle }], with `path` relative to the vault root.
     * If the picked folder holds no .md files itself (the parent of vault + Settings), the child folder
     * with the most .md files is used. Dot-entries and node_modules are never entered.
     */
    async _tolariaListFiles(source) {
        const skipName = (n) => n.startsWith('.') || n === 'node_modules';
        const isMd = (n) => /\.md$/i.test(n);
        const ignoredFolders = new Set();
        const files = [];
        let root = '';

        if (source && source.kind === 'filelist') {
            const entries = [];
            for (const file of source.files || []) {
                if (!file || !file.name) continue;
                const parts = String(file.webkitRelativePath || file.name).split('/').filter(Boolean);
                if (parts.length) entries.push({ parts, file });
            }
            const hasPickedRoot = entries.length > 0 && entries.every(e => e.parts.length > 1);
            if (hasPickedRoot) root = entries[0].parts[0];
            let rel = entries.map(e => ({ parts: hasPickedRoot ? e.parts.slice(1) : e.parts, file: e.file }));
            for (const e of rel) if (e.parts.length > 1 && skipName(e.parts[0])) ignoredFolders.add(e.parts[0]);

            if (!rel.some(e => e.parts.length === 1 && isMd(e.parts[0]) && !skipName(e.parts[0]))) {
                const counts = new Map();
                for (const e of rel) {
                    if (e.parts.length === 2 && isMd(e.parts[1]) && !skipName(e.parts[0])) counts.set(e.parts[0], (counts.get(e.parts[0]) || 0) + 1);
                }
                const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
                if (best) {
                    root = best[0];
                    for (const e of rel) if (e.parts.length > 1 && e.parts[0] !== best[0] && !skipName(e.parts[0])) ignoredFolders.add(e.parts[0]);
                    rel = rel.filter(e => e.parts[0] === best[0]).map(e => ({ parts: e.parts.slice(1), file: e.file }));
                    for (const e of rel) if (e.parts.length > 1 && skipName(e.parts[0])) ignoredFolders.add(e.parts[0]);
                }
            }
            for (const e of rel) {
                if (e.parts.length === 0 || e.parts.some(skipName)) continue;
                files.push({ path: e.parts.join('/'), name: e.parts[e.parts.length - 1], handle: e.file });
            }
            return { root, files, ignoredFolders: Array.from(ignoredFolders).sort() };
        }

        if (!source || typeof source.values !== 'function') throw new Error('Tolaria import needs a folder');
        root = source.name || '';
        let vault = source;
        const top = [];
        for await (const entry of source.values()) top.push(entry);
        if (!top.some(e => e.kind === 'file' && isMd(e.name) && !skipName(e.name))) {
            let best = null;
            for (const dir of top.filter(e => e.kind === 'directory' && !skipName(e.name))) {
                let n = 0;
                for await (const child of dir.values()) if (child.kind === 'file' && isMd(child.name) && !skipName(child.name)) n++;
                if (n > 0 && (!best || n > best.n || (n === best.n && dir.name < best.dir.name))) best = { dir, n };
            }
            if (best) {
                vault = best.dir;
                root = best.dir.name;
                for (const e of top) if (e.kind === 'directory' && e !== best.dir) ignoredFolders.add(e.name);
            }
        }
        const walk = async (dir, prefix) => {
            for await (const entry of dir.values()) {
                if (skipName(entry.name)) {
                    if (entry.kind === 'directory' && !prefix) ignoredFolders.add(entry.name);
                    continue;
                }
                const path = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.kind === 'directory') await walk(entry, path);
                else if (entry.kind === 'file') files.push({ path, name: entry.name, handle: entry });
            }
        };
        await walk(vault, '');
        return { root, files, ignoredFolders: Array.from(ignoredFolders).sort() };
    }

    _tolariaScalar(raw) {
        const s = String(raw).trim();
        let m = s.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
        if (m) return m[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n');
        m = s.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
        if (m) return m[1].replace(/''/g, "'");
        const plain = s.replace(/\s+#.*$/, '').trim();
        return (plain === 'null' || plain === '~') ? null : plain;
    }

    /**
     * Frontmatter + body. Handles what Tolaria writes: quoted/plain scalars, `[a, b]`, block lists, `null`,
     * `|` / `>` blocks, keys with spaces (`sidebar label`). Nested maps are ignored. Values stay strings
     * (true/false/numbers are not converted); lists stay arrays. The existing parseYAML keeps list-item quotes,
     * which breaks `- "[[slug]]"`, hence this parser.
     */
    _tolariaParseNote(raw) {
        const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        const m = text.match(/^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/);
        if (!m) return { frontmatter: {}, body: text, hasFrontmatter: false };
        const frontmatter = {};
        const lines = m[1] ? m[1].split('\n') : [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line) || /^-(\s|$)/.test(line)) continue;
            const km = line.match(/^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:[ \t]+(.*))?$/);
            if (!km) continue;
            const key = this._tolariaScalar(km[1]);
            if (!key) continue;
            const value = (km[2] || '').trim();
            if (value === '' || /^[|>][+-]?$/.test(value)) {
                const block = [];
                let j = i + 1;
                while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]) || /^-(\s|$)/.test(lines[j]))) block.push(lines[j++]);
                i = j - 1;
                if (value !== '') {
                    frontmatter[key] = block.map(l => l.trim()).join(value[0] === '|' ? '\n' : ' ').trim();
                    continue;
                }
                const items = block.map(l => l.match(/^\s*-\s+(.*)$/)).filter(Boolean).map(mm => this._tolariaScalar(mm[1])).filter(v => v !== null && v !== '');
                frontmatter[key] = items.length ? items : null;
            } else if (value.startsWith('[') && !value.startsWith('[[') && /\]\s*(?:#.*)?$/.test(value)) {
                const inner = value.replace(/\]\s*(?:#.*)?$/, '').slice(1);
                frontmatter[key] = this._tolariaSplitFlowList(inner).map(p => this._tolariaScalar(p)).filter(v => v !== null && v !== '');
            } else {
                frontmatter[key] = this._tolariaScalar(value);
            }
        }
        return { frontmatter, body: text.slice(m[0].length), hasFrontmatter: true };
    }

    /** Splits the inside of a YAML flow list on commas that are outside quotes. */
    _tolariaSplitFlowList(inner) {
        const parts = [];
        let current = '';
        let quote = null;
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (quote) {
                current += ch;
                if (ch === '\\' && quote === '"') current += inner[++i] || '';
                else if (ch === quote) quote = null;
            } else if (ch === '"' || ch === "'") {
                quote = ch;
                current += ch;
            } else if (ch === ',') {
                parts.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
        parts.push(current);
        return parts.map(p => p.trim()).filter(Boolean);
    }

    /** Title from the first `# H1` (outside code fences); the H1 line is removed when it opens the note. */
    _tolariaSplitTitle(body) {
        const lines = String(body).split('\n');
        const h1 = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/;
        const first = lines.findIndex(l => l.trim() !== '');
        if (first !== -1 && h1.test(lines[first])) {
            let end = first + 1;
            while (end < lines.length && lines[end].trim() === '') end++;
            return { title: lines[first].match(h1)[1].trim(), body: lines.slice(end).join('\n').trimEnd() };
        }
        let fence = null;
        for (const line of lines) {
            const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
            if (f) { fence = !fence ? f[1] : (f[1][0] === fence[0] && f[1].length >= fence.length ? null : fence); continue; }
            if (!fence && h1.test(line)) return { title: line.match(h1)[1].trim(), body: String(body).trim() };
        }
        return { title: '', body: String(body).trim() };
    }

    /** Applies fn(text) to every part of `text` that is outside fenced blocks and inline code spans. */
    _tolariaMapOutsideCode(text, fn) {
        const chunks = [];
        let current = null;
        let fence = null;
        for (const line of String(text).split('\n')) {
            const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
            const closes = fence && f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1];
            const opens = !fence && f;
            const code = !!fence || !!opens;
            if (!current || current.code !== code) { current = { code, lines: [] }; chunks.push(current); }
            current.lines.push(line);
            if (closes) fence = null;
            else if (opens) fence = f[1];
        }
        return chunks.map(c => c.code ? c.lines.join('\n') : this._tolariaMapInline(c.lines.join('\n'), fn)).join('\n');
    }

    _tolariaMapInline(text, fn) {
        let out = '';
        let plain = '';
        let i = 0;
        while (i < text.length) {
            if (text[i] !== '`') { plain += text[i++]; continue; }
            let n = 0;
            while (text[i + n] === '`') n++;
            const fenceStr = '`'.repeat(n);
            let j = i + n;
            let close = -1;
            while ((j = text.indexOf(fenceStr, j)) !== -1) {
                let k = j;
                while (text[k] === '`') k++;
                if (k - j === n) { close = j; break; }
                j = k;
            }
            if (close === -1) { plain += text.slice(i, i + n); i += n; continue; }
            out += fn(plain) + text.slice(i, close + n);
            plain = '';
            i = close + n;
        }
        return out + fn(plain);
    }

    // Phosphor names Tolaria uses that Tabler spells differently (only ones known to exist in Tabler).
    _tolariaIconAliases() {
        return {
            'calendar-blank': 'calendar', 'arrows-clockwise': 'refresh', 'check-circle': 'circle-check', 'x-circle': 'circle-x',
            'house': 'home', 'magnifying-glass': 'search', 'gear': 'settings', 'lightning': 'bolt', 'lightbulb': 'bulb',
            'bookmark-simple': 'bookmark', 'note-pencil': 'notes', 'notepad': 'notes', 'pencil-simple': 'pencil',
            'users-three': 'users-group', 'folder-simple': 'folder', 'chat-circle': 'message-circle', 'envelope': 'mail',
            'globe': 'world', 'list-checks': 'list-check', 'graduation-cap': 'school', 'wrench': 'tool', 'image': 'photo',
            'desktop': 'device-desktop', 'laptop': 'device-laptop', 'fire': 'flame', 'drop': 'droplet', 'film-strip': 'movie',
            'music-note': 'music', 'airplane': 'plane', 'bicycle': 'bike', 'cooking-pot': 'tools-kitchen-2'
        };
    }

    /** `_icon` (a Tolaria icon name) -> { icon: 'ti-*', fallback } ; falls back when the name is not a Tabler icon. */
    _tolariaIcon(name, iconExists, fallback = 'ti-notebook') {
        const raw = String(name == null ? '' : name).trim().toLowerCase().replace(/^ti-/, '');
        if (!raw || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw)) return { icon: fallback, fallback: !!raw };
        const alias = this._tolariaIconAliases()[raw];
        // With a probe the name is tried as written first; without one an aliased name is assumed to be Phosphor-only.
        const candidates = !alias ? [raw] : (iconExists ? [raw, alias] : [alias]);
        for (const candidate of candidates) {
            if (!iconExists || iconExists(`ti-${candidate}`)) return { icon: `ti-${candidate}`, fallback: false };
        }
        return { icon: fallback, fallback: true };
    }

    _tolariaPluralize(word) {
        const w = String(word).trim();
        if (!w) return w;
        if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
        if (/(s|x|z|ch|sh)$/i.test(w)) return `${w}es`;
        return `${w}s`;
    }

    _tolariaTitleCase(text) {
        return String(text).replace(/[-_]+/g, ' ').trim().replace(/\b[a-z]/g, c => c.toUpperCase());
    }

    _tolariaFirst(value) {
        return Array.isArray(value) ? (value[0] == null ? '' : String(value[0])) : (value == null ? '' : String(value));
    }

    /** "[[slug|label#x]]" -> { ref, label } ; null when the string is not a lone wikilink. */
    _tolariaParseWikilink(text) {
        const m = String(text).trim().match(/^\[\[([^\[\]]+)\]\]$/);
        return m ? this._tolariaSplitWikilink(m[1]) : null;
    }

    _tolariaSplitWikilink(inner) {
        const parts = String(inner).split(/\\?\|/);
        return { ref: parts[0].trim(), label: parts.length > 1 ? parts.slice(1).join('|').trim() || undefined : undefined };
    }

    /**
     * Reads a Tolaria vault and returns an ImportPlan (see the engine section). Only reads files.
     * source: directory handle | { kind: 'filelist', files }
     * opts.iconExists(name 'ti-*') -> boolean   optional check that an icon exists (the dialog probes the DOM)
     * plan.parseReport: { vault, filesRead, typeDefinitions, unusedTypes, undefinedTypes, untypedNotes, skipped,
     *                     droppedKeys, mergedKeys, iconFallbacks, unreferencedAttachments, missingAssets,
     *                     linksToTypeDefinitions, unreadable, warnings }
     */
    async parseTolariaVault(source, opts = {}) {
        const iconExists = typeof opts.iconExists === 'function' ? opts.iconExists : null;
        const listing = await this._tolariaListFiles(source);
        const byPath = new Map(listing.files.map(f => [f.path, f]));
        const byLowerPath = new Map(listing.files.map(f => [f.path.toLowerCase(), f]));
        const byPathOrder = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        const plan = this.createImportPlan('tolaria');
        const report = {
            vault: { root: listing.root, ignoredFolders: listing.ignoredFolders },
            filesRead: 0, typeDefinitions: [], unusedTypes: [], undefinedTypes: [], untypedNotes: [], skipped: [],
            droppedKeys: {}, mergedKeys: {}, iconFallbacks: [], unreferencedAttachments: [], missingAssets: [],
            linksToTypeDefinitions: 0, unreadable: [], warnings: []
        };
        plan.parseReport = report;

        // ---- 1. read every note --------------------------------------------------------------------
        const AGENT_DOCS = new Set(['agents.md', 'claude.md', 'gemini.md', 'license.md']);
        const defs = [];
        const notes = [];
        for (const file of listing.files.filter(f => /\.md$/i.test(f.name)).sort(byPathOrder)) {
            if (file.path.split('/').slice(0, -1).some(seg => seg.toLowerCase() === 'attachments')) {
                report.skipped.push({ path: file.path, reason: 'attachments' });
                continue;
            }
            let parsed;
            try {
                parsed = this._tolariaParseNote(await (await this.getFileFromHandle(file.handle)).text());
            } catch (error) {
                report.unreadable.push({ path: file.path, message: String(error && error.message || error) });
                continue;
            }
            report.filesRead++;
            const type = this._tolariaFirst(parsed.frontmatter.type).trim();
            if (!file.path.includes('/') && AGENT_DOCS.has(file.name.toLowerCase())) {
                report.skipped.push(omitUndefined({ path: file.path, reason: 'agent-doc', type: type || undefined }));
                continue;
            }
            const slug = file.name.replace(/\.md$/i, '');
            const split = this._tolariaSplitTitle(parsed.body);
            const entry = { file, slug, frontmatter: parsed.frontmatter, type, title: split.title, body: split.body };
            (type.toLowerCase() === 'type' ? defs : notes).push(entry);
        }

        // ---- 2. type definitions -> collection definitions -----------------------------------------
        const typeDefs = [];
        const defsByName = new Map();
        for (const d of defs) {
            const fm = d.frontmatter;
            const name = d.title || this._tolariaTitleCase(d.slug);
            const label = this._tolariaFirst(fm['sidebar label'] !== undefined ? fm['sidebar label'] : (fm._sidebar_label !== undefined ? fm._sidebar_label : fm.sidebar_label)).trim();
            const order = parseFloat(this._tolariaFirst(fm._order));
            const def = {
                key: '', path: d.file.path, slug: d.slug, name, singular: name,
                collectionName: label || this._tolariaPluralize(name),
                iconName: this._tolariaFirst(fm._icon).trim(),
                description: d.body.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => { const w = this._tolariaSplitWikilink(inner); return w.label || w.ref; }).replace(/\s+/g, ' ').trim(),
                order: Number.isFinite(order) ? order : Infinity, count: 0, meta: d.slug.toLowerCase() === 'type' || name.toLowerCase() === 'type'
            };
            typeDefs.push(def);
            for (const n of [name, d.slug]) defsByName.set(LinkIndex.normalizeTitle(n), def);
        }
        const typeSlugs = new Set(typeDefs.map(d => d.slug.toLowerCase()));

        // ---- 3. assign notes to collections ---------------------------------------------------------
        const usedKeys = new Set();
        const uniqueKey = (base) => { let k = base || 'collection'; let i = 2; while (usedKeys.has(k)) k = `${base}_${i++}`; usedKeys.add(k); return k; };
        const synthetic = new Map();   // normalized type name -> def for types without a definition
        let untypedDef = null;
        for (const note of notes) {
            let def = note.type ? defsByName.get(LinkIndex.normalizeTitle(note.type)) : null;
            if (def && def.meta) def = null;
            if (!def && note.type) {
                const norm = LinkIndex.normalizeTitle(note.type);
                if (!synthetic.has(norm)) {
                    synthetic.set(norm, { key: '', path: '', slug: this.slugify(note.type), name: note.type, singular: note.type, collectionName: this._tolariaPluralize(note.type), iconName: '', description: '', order: Infinity, count: 0, synthetic: true });
                    report.undefinedTypes.push(note.type);
                }
                def = synthetic.get(norm);
            }
            if (!def) {
                if (!untypedDef) {
                    untypedDef = typeDefs.find(d => !d.meta && d.collectionName.toLowerCase() === 'notes')
                        || { key: '', path: '', slug: 'notes', name: 'Note', singular: 'Note', collectionName: 'Notes', iconName: '', description: 'Notes imported from Tolaria that have no type', order: Infinity, count: 0, synthetic: true };
                }
                def = untypedDef;
                report.untypedNotes.push(note.file.path);
            }
            def.count++;
            note.def = def;
        }
        const collectionDefs = [...typeDefs.filter(d => !d.meta), ...synthetic.values(), ...(untypedDef && untypedDef.synthetic ? [untypedDef] : [])]
            .filter(d => d.count > 0)
            .sort((a, b) => (a.order - b.order) || (a.collectionName < b.collectionName ? -1 : a.collectionName > b.collectionName ? 1 : 0));
        report.unusedTypes = typeDefs.filter(d => !d.meta && d.count === 0).sort((a, b) => (a.order - b.order) || (a.name < b.name ? -1 : 1)).map(d => d.name);
        for (const d of collectionDefs) d.key = uniqueKey(this.slugify(d.collectionName) || this.slugify(d.slug));
        for (const d of typeDefs.filter(d => !d.meta)) {
            const icon = this._tolariaIcon(d.iconName, iconExists);
            d.icon = icon.icon;
            if (icon.fallback && d.count > 0) report.iconFallbacks.push({ type: d.name, requested: d.iconName });
            report.typeDefinitions.push({ name: d.name, slug: d.slug, path: d.path, collection: d.count > 0 ? d.key : null, notes: d.count, icon: d.icon });
        }
        for (const d of [...synthetic.values(), ...(untypedDef && untypedDef.synthetic ? [untypedDef] : [])]) d.icon = 'ti-notebook';

        // ---- 4. properties: one decision per key, merged case-insensitively -------------------------
        const DROP = new Set(['visible', 'color', 'title']);
        const RELATION_KEYS = new Set(['related_to', 'belongs_to']);
        const props = new Map();       // field id -> { id, variants, items, list, relationKey }
        const noteProps = new Map();   // note -> Map(field id -> raw value)
        const fieldIds = new Map();    // lowercased key -> id
        for (const note of notes) {
            const mine = new Map();
            noteProps.set(note, mine);
            for (const [key, raw] of Object.entries(note.frontmatter)) {
                const lower = key.trim().toLowerCase();
                if (lower === 'type') continue;
                if (lower.startsWith('_') || DROP.has(lower)) { report.droppedKeys[key] = (report.droppedKeys[key] || 0) + 1; continue; }
                const items = (Array.isArray(raw) ? raw : [raw]).filter(v => v !== null && v !== undefined && String(v).trim() !== '').map(v => String(v).trim());
                if (items.length === 0) continue;
                if (!fieldIds.has(lower)) {
                    let id = this.slugify(lower) || `field_${fieldIds.size + 1}`;
                    if (id === 'source_path') id = 'source_path_value';
                    fieldIds.set(lower, id);
                }
                const id = fieldIds.get(lower);
                if (!props.has(id)) props.set(id, { id, variants: new Set(), items: [], list: false });
                const prop = props.get(id);
                prop.variants.add(key.trim());
                prop.items.push(...items);
                if (Array.isArray(raw)) prop.list = true;
                if (!mine.has(id)) mine.set(id, items);
            }
        }
        for (const prop of props.values()) {
            const lower = Array.from(prop.variants)[0].toLowerCase();
            if (prop.variants.size > 1) report.mergedKeys[prop.id] = Array.from(prop.variants).sort();
            const label = Array.from(prop.variants).find(v => /[A-Z]/.test(v) && !v.includes('_')) || (lower === 'url' ? 'URL' : this._tolariaTitleCase(lower));
            prop.label = label.trim() === label.trim().toLowerCase() ? this._tolariaTitleCase(label) : label.trim();
            if (RELATION_KEYS.has(prop.id) || prop.items.every(v => this._tolariaParseWikilink(v))) { prop.type = 'record'; prop.many = true; }
            else if (prop.id === 'status' || prop.id === 'kind') { prop.type = 'choice'; prop.many = prop.list; }
            else if (prop.id === 'url') { prop.type = 'url'; prop.many = prop.list; }
            else if (!prop.list && prop.items.every(v => /^-?\d+(\.\d+)?$/.test(v))) { prop.type = 'number'; prop.many = false; }
            else if (!prop.list && prop.items.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) { prop.type = 'datetime'; prop.many = false; }
            else { prop.type = 'text'; prop.many = prop.list; }
        }

        // ---- 5. collections and records (bodies come after, once the link index exists) -------------
        const colByKey = new Map();
        for (const d of collectionDefs) {
            const col = { key: d.key, name: d.collectionName, icon: d.icon, description: d.description || `Imported from Tolaria (${d.name})`, itemName: d.singular, fields: [] };
            colByKey.set(d.key, col);
            plan.collections.push(col);
        }
        const recordOf = new Map();
        for (const note of notes) {
            const col = colByKey.get(note.def.key);
            const fmTitle = this._tolariaFirst(note.frontmatter.title).trim();
            const record = { key: note.file.path, collection: col.key, title: note.title || fmTitle || this._tolariaTitleCase(note.slug), sourcePath: note.file.path, values: {}, body: '' };
            plan.records.push(record);
            recordOf.set(note, record);
            for (const [id, items] of noteProps.get(note)) {
                const prop = props.get(id);
                if (!col.fields.some(f => f.id === id)) {
                    col.fields.push(omitUndefined({ id, label: prop.label, type: prop.type, many: prop.many || undefined }));
                }
                if (prop.type === 'record') continue;
                record.values[id] = prop.type === 'number' ? Number(items[0]) : (prop.many ? items : items[0]);
            }
        }
        // Relations need a LinkIndex over the finished records so `target` can be decided.
        const index = LinkIndex.fromPlan(plan);
        const targetsOf = new Map();   // collection key + field -> Set(target collection keys)
        for (const note of notes) {
            const record = recordOf.get(note);
            for (const [id, items] of noteProps.get(note)) {
                if (props.get(id).type !== 'record') continue;
                for (const item of items) {
                    const wiki = this._tolariaParseWikilink(item);
                    const ref = wiki ? wiki.ref : item;
                    this.planPropertyLink(plan, record.key, id, { ref }, { raw: item });
                    const hit = index.resolve({ ref }, { fromKey: record.key });
                    if (hit.status === 'resolved') {
                        const k = `${record.collection}\u0000${id}`;
                        if (!targetsOf.has(k)) targetsOf.set(k, new Set());
                        targetsOf.get(k).add(index.records.get(hit.key).collection);
                    } else if (typeSlugs.has(LinkIndex.slugOf(ref))) {
                        report.linksToTypeDefinitions++;
                    }
                }
            }
        }
        for (const col of plan.collections) {
            for (const field of col.fields) {
                if (field.type !== 'record') continue;
                const targets = targetsOf.get(`${col.key}\u0000${field.id}`);
                if (targets && targets.size === 1) field.target = Array.from(targets)[0];
            }
        }

        // ---- 6. bodies: wikilinks and local images ---------------------------------------------------
        const referenced = new Set();
        const combined = /(!\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\))|(\[\[([^\[\]\n]+?)\]\])/g;
        for (const note of notes) {
            const record = recordOf.get(note);
            const dir = note.file.path.split('/').slice(0, -1).join('/');
            record.body = this._tolariaMapOutsideCode(note.body, (text) => text.replace(combined, (match, image, alt, url, wiki, inner) => {
                if (wiki) {
                    const link = this._tolariaSplitWikilink(inner);
                    if (!link.ref) return match;
                    if (typeSlugs.has(LinkIndex.slugOf(link.ref)) && !index.resolve({ ref: link.ref }, { fromKey: record.key }).key) report.linksToTypeDefinitions++;
                    return this.planBodyLink(plan, record.key, { ref: link.ref }, { label: link.label, raw: match });
                }
                let ref = url.replace(/^<|>$/g, '').replace(/[#?].*$/, '');
                if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || !ref) return match;
                try { ref = decodeURIComponent(ref); } catch (e) { /* keep as written */ }
                const joined = ref.startsWith('/') ? ref.slice(1) : (dir ? `${dir}/${ref}` : ref);
                const parts = [];
                for (const seg of joined.split('/')) { if (!seg || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
                const path = parts.join('/');
                const file = byPath.get(path) || byLowerPath.get(path.toLowerCase());
                if (!file) { report.missingAssets.push({ record: record.key, ref: url }); return match; }
                referenced.add(file.path);
                return this.planAsset(plan, record.key, {
                    sourcePath: file.path, name: file.name, raw: match,
                    readBytes: async () => (await this.getFileFromHandle(file.handle)).arrayBuffer()
                });
            }));
        }
        report.unreferencedAttachments = listing.files
            .filter(f => f.path.toLowerCase().startsWith('attachments/') && !/\.md$/i.test(f.name) && !referenced.has(f.path))
            .map(f => f.path).sort();
        if (typeDefs.length === 0) report.warnings.push('No Tolaria type definitions (type: Type) found; every note goes by its own `type:` value.');
        if (plan.records.length === 0) report.warnings.push('No Tolaria notes found in the selected folder.');
        return plan;
    }

    /**
     * Probe for "does this Tabler icon exist": the icon font gives `.ti-name::before` a content value.
     * Returns { exists(name) | null, dispose() }; exists is null when the probe cannot be trusted.
     */
    _tolariaIconProbe() {
        const none = { exists: null, dispose() {} };
        try {
            if (typeof document === 'undefined' || !document.body) return none;
            const el = document.createElement('i');
            el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-999px';
            document.body.appendChild(el);
            const has = (name) => {
                el.className = `ti ${name}`;
                const content = getComputedStyle(el, '::before').content;
                return !!content && content !== 'none' && content !== 'normal' && content !== '""';
            };
            const trusted = has('ti-file-text') && !has('ti-no-such-icon-zzz');
            return { exists: trusted ? has : null, dispose() { el.remove(); } };
        } catch (error) {
            return none;
        }
    }

    /** Dialog flow for source === 'tolaria': parse the vault, apply the plan, show the report. */
    async performTolariaImport(dialog, overlay, dirHandle) {
        const statusDiv = dialog.querySelector('#md-status');
        const importBtn = dialog.querySelector('#md-import-btn');
        const cancelBtn = dialog.querySelector('#md-cancel-btn');
        importBtn.disabled = true;
        importBtn.textContent = 'Importing...';
        this.showStatus(statusDiv, 'Reading Tolaria vault...', 'info');
        const probe = this._tolariaIconProbe();
        try {
            const plan = await this.parseTolariaVault(dirHandle, { iconExists: probe.exists });
            if (plan.records.length === 0) {
                this.showStatus(statusDiv, 'No Tolaria notes found in that folder (expected *.md files with frontmatter).', 'error');
                importBtn.disabled = false;
                importBtn.textContent = 'Import';
                return;
            }
            const report = await this.applyImportPlan(plan, {
                onProgress: ({ message, done, total }) => this.showStatus(statusDiv, total ? `${message} (${done}/${total})` : message, 'info')
            });
            this.renderTolariaReport(statusDiv, plan, report);
            importBtn.textContent = 'Imported';
            cancelBtn.textContent = 'Close';
        } catch (error) {
            console.error('[Tolaria Import] Error:', error);
            this.showStatus(statusDiv, `Error: ${error.message}`, 'error');
            importBtn.disabled = false;
            importBtn.textContent = 'Import';
        } finally {
            probe.dispose();
        }
    }

    renderTolariaReport(statusDiv, plan, report) {
        const c = report.counts;
        const p = plan.parseReport || {};
        const failed = report.errors.length > 0 || c.recordsFailed > 0;
        this.showStatus(statusDiv, '', failed ? 'warning' : 'success');
        statusDiv.style.textAlign = 'left';
        const add = (tag, text, style = '') => {
            const el = document.createElement(tag);
            el.textContent = text;
            if (style) el.style.cssText = style;
            statusDiv.appendChild(el);
            return el;
        };
        const list = (items, limit = 30) => {
            const ul = document.createElement('ul');
            ul.style.cssText = 'margin: 4px 0 0 0; padding-left: 20px; font-size: 12px;';
            for (const text of items.slice(0, limit)) { const li = document.createElement('li'); li.textContent = text; ul.appendChild(li); }
            if (items.length > limit) { const li = document.createElement('li'); li.textContent = `...and ${items.length - limit} more`; ul.appendChild(li); }
            statusDiv.appendChild(ul);
        };
        add('div', failed ? 'Import finished with problems' : 'Import complete', 'font-weight: 600;');
        add('div', `Collections: ${c.collectionsCreated} created, ${c.collectionsUpdated} updated`);
        add('div', `Records: ${c.recordsCreated} created, ${c.recordsUpdated} updated${c.recordsFailed ? `, ${c.recordsFailed} failed` : ''}`);
        add('div', `Links: ${c.linksResolved} resolved, ${c.linksUnresolved} unresolved`);
        add('div', `Images: ${c.assetsUploaded} uploaded${c.assetsFailed ? `, ${c.assetsFailed} failed` : ''}`);
        if (p.unusedTypes && p.unusedTypes.length) add('div', `Types with no notes (no collection created): ${p.unusedTypes.join(', ')}`, 'margin-top: 8px; font-size: 12px;');
        if (p.untypedNotes && p.untypedNotes.length) add('div', `Untyped notes (put in "Notes"): ${p.untypedNotes.join(', ')}`, 'margin-top: 4px; font-size: 12px;');
        if (p.skipped && p.skipped.length) add('div', `Skipped: ${p.skipped.map(s => s.path).join(', ')}`, 'margin-top: 4px; font-size: 12px;');
        if (report.unresolvedLinks.length) {
            add('div', 'Unresolved links (left as text):', 'margin-top: 8px; font-weight: 600; font-size: 12px;');
            const typeSlugs = new Set((p.typeDefinitions || []).map(d => String(d.slug).toLowerCase()));
            list(report.unresolvedLinks.map(u => {
                const why = typeSlugs.has(LinkIndex.slugOf(u.ref)) ? 'type definition, not a note' : u.reason;
                return `${u.fromTitle || u.from}: [[${u.ref}]] (${why})`;
            }));
        }
        if (report.errors.length) {
            add('div', 'Errors:', 'margin-top: 8px; font-weight: 600; font-size: 12px;');
            list(report.errors.map(e => `${e.record || e.collection || e.asset || `pass ${e.pass}`}: ${e.message}`));
        }
    }

    // ===== end Tolaria source =====

    // =========================================================================
    // IMPORT PLAN ENGINE
    //
    // A source parser (pure, testable outside Thymer) produces an ImportPlan;
    // applyImportPlan() performs every Thymer write. The existing CSV / Obsidian /
    // Logseq / Joplin / journal flows above do not use this section.
    //
    // ImportPlan (plain data; JSON.stringify-able, functions are simply omitted):
    //   {
    //     version: 1,
    //     source: 'tolaria' | 'notion' | ...,
    //     collections: [{
    //       key, name, icon: 'ti-*', description, itemName?,
    //       fields: [{ id, label, type: 'text'|'number'|'choice'|'datetime'|'url'|'record'|...,
    //                  many?, icon?, choices?: [label | { id?, label, color? }],
    //                  target?: <collection key>   // type 'record': becomes filter_colguid
    //                  numberFormat? }]
    //     }],
    //     records: [{
    //       key,                 // stable source key (unique in the plan)
    //       collection,          // collection key
    //       title, sourcePath,   // sourcePath is stored in the source_path field and drives dedupe
    //       aliases?: [{ kind, value }],   // extra LinkIndex aliases (kind: key|path|notion_id|slug|title)
    //       values: { <fieldId>: scalar | scalar[] },   // NOT record-type fields (use links)
    //       body: markdown       // may contain ⟦link:Lx⟧ / ⟦asset:Ax⟧ placeholders
    //     }],
    //     links: [{
    //       id: 'L1', from: <record key>,
    //       where: 'body' | 'property', field?: <fieldId, when where==='property'>,
    //       target: { ref, kind? },   // ref: path / slug / notion id / title, see LinkIndex
    //       label?,                   // display text for a body ref
    //       raw?                      // text to leave behind if unresolved (e.g. '[[x|y]]')
    //     }],
    //     assets: [{ id: 'A1', record: <record key>, sourcePath, name?, contentType?, raw?,
    //                readBytes?: async () => ArrayBuffer | Uint8Array }],   // body holds ⟦asset:A1⟧
    //     journal: [{ date: 'YYYY-MM-DD', markdown, sourcePath? }]
    //   }
    //
    // Build one with createImportPlan() + planBodyLink() / planPropertyLink() / planAsset(),
    // which return the placeholder to splice into the record body.
    // =========================================================================

    createImportPlan(source = '') {
        return { version: 1, source, collections: [], records: [], links: [], assets: [], journal: [] };
    }

    _planTarget(target) {
        return typeof target === 'string' ? { ref: target } : omitUndefined({ ref: target.ref, kind: target.kind });
    }

    /** Registers a link found in a record body; returns the placeholder to put in the markdown. */
    planBodyLink(plan, recordKey, target, { label, raw } = {}) {
        const id = `L${plan.links.length + 1}`;
        plan.links.push(omitUndefined({ id, from: recordKey, where: 'body', target: this._planTarget(target), label, raw }));
        return `⟦link:${id}⟧`;
    }

    /** Registers a record-reference property value (call once per value, in order, for many-fields). */
    planPropertyLink(plan, recordKey, fieldId, target, { label, raw } = {}) {
        const id = `L${plan.links.length + 1}`;
        plan.links.push(omitUndefined({ id, from: recordKey, where: 'property', field: fieldId, target: this._planTarget(target), label, raw }));
        return id;
    }

    /** Registers an asset referenced from a record body; returns the placeholder to put in the markdown. */
    planAsset(plan, recordKey, { sourcePath, name, contentType, raw, readBytes }) {
        const id = `A${plan.assets.length + 1}`;
        plan.assets.push(omitUndefined({ id, record: recordKey, sourcePath, name, contentType, raw, readBytes }));
        return `⟦asset:${id}⟧`;
    }

    /** Structural problems in a plan, as [{ code, message, ... }]. Never throws. */
    validateImportPlan(plan) {
        const problems = [];
        const add = (code, message, extra = {}) => problems.push({ code, message, ...extra });
        if (!plan || typeof plan !== 'object') return [{ code: 'bad-plan', message: 'plan is not an object' }];
        if (plan.version !== 1) add('bad-version', `unsupported plan version ${plan.version}`);

        const collections = new Map();
        const names = new Set();
        for (const c of plan.collections || []) {
            if (collections.has(c.key)) add('duplicate-collection', `duplicate collection key ${c.key}`, { collection: c.key });
            collections.set(c.key, c);
            const n = String(c.name || '').trim().toLowerCase();
            if (names.has(n)) add('duplicate-collection-name', `two collections are named "${c.name}"`, { collection: c.key });
            names.add(n);
            for (const f of c.fields || []) {
                if (f.type === 'record' && f.target && !(plan.collections || []).some(x => x.key === f.target)) {
                    add('unknown-target-collection', `field ${f.id} targets unknown collection ${f.target}`, { collection: c.key, field: f.id });
                }
            }
        }

        const records = new Map();
        for (const r of plan.records || []) {
            if (records.has(r.key)) add('duplicate-record', `duplicate record key ${r.key}`, { record: r.key });
            records.set(r.key, r);
            const col = collections.get(r.collection);
            if (!col) { add('unknown-collection', `record ${r.key} has unknown collection ${r.collection}`, { record: r.key }); continue; }
            const fieldIds = new Set((col.fields || []).map(f => f.id || this.slugify(f.label)));
            for (const fieldId of Object.keys(r.values || {})) {
                if (!fieldIds.has(fieldId)) add('unknown-field', `record ${r.key} sets undeclared field ${fieldId}`, { record: r.key, field: fieldId });
            }
        }

        const linkIds = new Set();
        for (const l of plan.links || []) {
            if (linkIds.has(l.id)) add('duplicate-link', `duplicate link id ${l.id}`, { link: l.id });
            linkIds.add(l.id);
            const rec = records.get(l.from);
            if (!rec) { add('link-from-unknown-record', `link ${l.id} is from unknown record ${l.from}`, { link: l.id }); continue; }
            if (l.where === 'property') {
                const col = collections.get(rec.collection);
                const field = col && (col.fields || []).find(f => (f.id || this.slugify(f.label)) === l.field);
                if (!field || field.type !== 'record') add('link-field-not-record', `link ${l.id} targets field ${l.field}, which is not a declared record field`, { link: l.id, field: l.field });
            } else if (l.where !== 'body') {
                add('bad-link-where', `link ${l.id} has where=${l.where}`, { link: l.id });
            }
        }
        for (const a of plan.assets || []) {
            if (!records.has(a.record)) add('asset-for-unknown-record', `asset ${a.id} belongs to unknown record ${a.record}`, { asset: a.id });
        }
        return problems;
    }

    /**
     * Performs every Thymer write for a plan, in passes:
     *   1 collections  2 records (scalar props + body with placeholders)
     *   3 links (body refs + record-reference properties)  4 assets  5 journal
     * Data problems never abort the run; they land in the returned report.
     *
     * opts: { onProgress({ pass, message, done, total }),
     *         existing: 'update' (default) | 'skip'   what to do with records already in Thymer,
     *         readAsset(asset) -> bytes               fallback when asset.readBytes is absent,
     *         journalCollection,                       defaults to the workspace's journal,
     *         sleep(ms), settleMs, collectionSettleMs  timing hooks (tests pass instant sleeps) }
     */
    async applyImportPlan(plan, opts = {}) {
        if (!plan || typeof plan !== 'object' || !Array.isArray(plan.records)) {
            throw new TypeError('applyImportPlan: not an ImportPlan');
        }
        const report = {
            source: plan.source || '',
            counts: {
                collectionsCreated: 0, collectionsUpdated: 0,
                recordsCreated: 0, recordsUpdated: 0, recordsSkipped: 0, recordsFailed: 0,
                linksResolved: 0, linksUnresolved: 0,
                assetsUploaded: 0, assetsFailed: 0,
                journalCreated: 0, journalSkipped: 0
            },
            unresolvedLinks: [],
            errors: [],
            warnings: this.validateImportPlan(plan)
        };
        const ctx = {
            plan, opts, report,
            index: LinkIndex.fromPlan(plan),
            collections: new Map(),   // collection key -> { def, api, guid, created, failed }
            records: new Map(),       // record key -> { def, record }
            linkResults: new Map()    // link id -> LinkIndex result
        };
        ctx.progress = (pass, message, done = 0, total = 0) => {
            try { if (typeof opts.onProgress === 'function') opts.onProgress({ pass, message, done, total }); } catch (e) { /* UI errors must not stop the import */ }
        };

        const passes = [
            [1, 'collections', () => this._planPassCollections(ctx)],
            [2, 'records', () => this._planPassRecords(ctx)],
            [3, 'links', () => this._planPassLinks(ctx)],
            [4, 'assets', () => this._planPassAssets(ctx)],
            [5, 'journal', () => this._planPassJournal(ctx)]
        ];
        for (const [pass, name, run] of passes) {
            try {
                await run();
            } catch (error) {
                console.error(`[ImportPlan] pass ${pass} (${name}) crashed:`, error);
                report.errors.push({ pass, message: `pass ${name} crashed: ${error && error.message || error}` });
            }
        }
        return report;
    }

    _planSleep(ctx, ms) {
        return typeof ctx.opts.sleep === 'function' ? ctx.opts.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms));
    }

    _planError(ctx, pass, error, extra = {}) {
        console.error(`[ImportPlan] pass ${pass}:`, error);
        ctx.report.errors.push({ pass, ...extra, message: String(error && error.message || error) });
    }

    // ---- pass 1: collections ------------------------------------------------

    async _planPassCollections(ctx) {
        const defs = ctx.plan.collections || [];
        ctx.progress(1, 'Creating collections', 0, defs.length);
        const byName = new Map();
        for (const c of await this.data.getAllCollections()) {
            if (typeof c.isJournalPlugin === 'function' && c.isJournalPlugin()) continue;
            const n = String(c.getName() || '').trim().toLowerCase();
            if (n && !byName.has(n)) byName.set(n, c);
        }

        // 1a: find or create a shell for every collection, so GUIDs exist before record fields reference them
        for (const def of defs) {
            try {
                const name = String(def.name || '').trim().toLowerCase();
                let api = byName.get(name);
                let created = false;
                if (!api) {
                    api = await this.data.createCollection();
                    if (!api) throw new Error('createCollection returned null');
                    created = true;
                    byName.set(name, api);
                }
                ctx.collections.set(def.key, { def, api, guid: api.getGuid(), created, failed: false });
            } catch (error) {
                this._planError(ctx, 1, error, { collection: def.key });
                ctx.collections.set(def.key, { def, failed: true });
            }
        }

        // 1b: write names / icons / descriptions / fields
        let done = 0;
        for (const entry of ctx.collections.values()) {
            if (entry.failed) continue;
            try {
                const config = entry.api.getConfiguration();
                this._planApplyCollectionConfig(ctx, entry, config);
                if (await entry.api.saveConfiguration(config) === false) {
                    throw new Error('saveConfiguration returned false');
                }
            } catch (error) {
                entry.failed = true;
                this._planError(ctx, 1, error, { collection: entry.def.key });
            }
            ctx.progress(1, `Configured ${entry.def.name}`, ++done, defs.length);
        }

        // 1c: re-read, as the existing collection flow does, and make sure the fields persisted
        await this._planSleep(ctx, ctx.opts.collectionSettleMs ?? 500);
        const fresh = await this.data.getAllCollections();
        for (const entry of ctx.collections.values()) {
            if (entry.failed) continue;
            const api = fresh.find(c => c.getGuid() === entry.guid);
            if (!api) {
                entry.failed = true;
                this._planError(ctx, 1, new Error('collection disappeared after configuration'), { collection: entry.def.key });
                continue;
            }
            const saved = new Set((api.getConfiguration().fields || []).map(f => f.id));
            const missing = this._planFieldConfigs(ctx, entry.def).filter(f => !saved.has(f.id)).map(f => f.id);
            if (missing.length) {
                ctx.report.warnings.push({ code: 'fields-not-persisted', message: `fields missing after save: ${missing.join(', ')}`, collection: entry.def.key });
            }
            entry.api = api;
            ctx.report.counts[entry.created ? 'collectionsCreated' : 'collectionsUpdated']++;
        }
    }

    _planFieldType(fd) { return fd.type || 'text'; }

    _planFieldIcon(fd) {
        if (fd.icon) return fd.icon;
        return this._planFieldType(fd) === 'record' ? 'ti-arrow-right' : this.getFieldIcon(this._planFieldType(fd));
    }

    /** Distinct string values a plan stores in a choice field, in first-seen order. */
    _planChoiceLabels(ctx, def, fieldId, declared) {
        const labels = [];
        const seen = new Set();
        const add = (v) => {
            if (v === null || v === undefined || v === '') return;
            const label = String(v);
            if (!seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); labels.push(label); }
        };
        for (const c of declared || []) add(typeof c === 'string' ? c : c.label);
        for (const rec of ctx.plan.records) {
            if (rec.collection !== def.key || !rec.values || rec.values[fieldId] === undefined) continue;
            const t = this.transformValue(rec.values[fieldId]);
            for (const v of (Array.isArray(t) ? t : [t])) add(v);
        }
        return labels;
    }

    _planChoiceOptions(labels, declared, startIndex = 0, usedIds = new Set()) {
        const byLabel = new Map((declared || []).filter(c => typeof c === 'object').map(c => [c.label, c]));
        return labels.map((label, i) => {
            const d = byLabel.get(label) || {};
            let id = d.id || this.slugify(label) || `choice_${startIndex + i}`;
            while (usedIds.has(id)) id = `${id}_${startIndex + i}`;
            usedIds.add(id);
            return { id, label, icon: d.icon || '', color: d.color !== undefined ? String(d.color) : String((startIndex + i) % 10), active: true };
        });
    }

    /** Thymer field configs (incl. the built-in source_path) for a plan collection. */
    _planFieldConfigs(ctx, def) {
        const out = [];
        const seen = new Set();
        const push = (f) => { if (f.id && !seen.has(f.id)) { seen.add(f.id); out.push(f); } };
        push({ id: 'source_path', label: 'Source Path', type: 'text', icon: 'ti-link', many: false, read_only: true, active: true });
        for (const fd of def.fields || []) {
            const type = this._planFieldType(fd);
            const id = fd.id || this.slugify(fd.label);
            const field = { id, label: fd.label || id, type, icon: this._planFieldIcon(fd), many: fd.many === true, read_only: false, active: true };
            if (type === 'choice') {
                const labels = this._planChoiceLabels(ctx, def, id, fd.choices);
                field.choices = this._planChoiceOptions(labels, fd.choices);
            }
            if (type === 'record' && fd.target) {
                const target = ctx.collections.get(fd.target);
                if (target && target.guid) field.filter_colguid = target.guid;
            }
            if (type === 'number' && fd.numberFormat) field.number_format = fd.numberFormat;
            push(field);
        }
        return out;
    }

    _planApplyCollectionConfig(ctx, entry, config) {
        const def = entry.def;
        const wanted = this._planFieldConfigs(ctx, def);
        if (entry.created) {
            config.name = def.name;
            config.icon = def.icon || 'ti-notebook';
            config.item_name = def.itemName || 'Note';
            config.description = def.description !== undefined ? def.description : `Imported from ${ctx.plan.source || 'Markdown'}`;
            config.fields = wanted;
            config.page_field_ids = wanted.map(f => f.id);
            config.sidebar_record_sort_field_id = wanted[0].id;
            config.sidebar_record_sort_dir = 'desc';
            config.show_sidebar_items = true;
            config.show_cmdpal_items = true;
            config.views = [{
                id: 'table', label: `All ${def.name}`, description: 'Table view', type: 'table', icon: '',
                shown: true, read_only: false, sort_field_id: wanted[0].id, sort_dir: 'asc',
                group_by_field_id: null, field_ids: wanted.map(f => f.id).slice(0, 8), opts: {}
            }];
            return;
        }

        // Existing collection: add what is missing, never remove or retype anything.
        const fields = Array.isArray(config.fields) ? config.fields : [];
        const byId = new Map(fields.map(f => [f.id, f]));
        for (const w of wanted) {
            const have = byId.get(w.id);
            if (!have) {
                fields.push(w);
                if (Array.isArray(config.page_field_ids)) config.page_field_ids.push(w.id);
                continue;
            }
            if (have.type === 'choice' && w.type === 'choice') {
                have.choices = have.choices || [];
                const known = new Set(have.choices.map(c => String(c.label).toLowerCase()));
                const used = new Set(have.choices.map(c => c.id));
                const fresh = w.choices.filter(c => !known.has(c.label.toLowerCase())).map(c => c.label);
                have.choices.push(...this._planChoiceOptions(fresh, [], have.choices.length, used));
            }
            if (have.type === 'record' && !have.filter_colguid && w.filter_colguid) {
                have.filter_colguid = w.filter_colguid;
            }
        }
        config.fields = fields;
        if (!config.icon && def.icon) config.icon = def.icon;
        if (!config.description && def.description) config.description = def.description;
    }

    // ---- pass 2: records ----------------------------------------------------

    async _planWaitForRecord(ctx, collection, guid) {
        const direct = typeof this.data.getRecord === 'function' ? this.data.getRecord(guid) : null;
        if (direct) return direct;
        for (let attempt = 0; attempt < 5; attempt++) {
            await this._planSleep(ctx, 100 + attempt * 50);
            const found = (await collection.getAllRecords()).find(r => r.guid === guid);
            if (found) return found;
        }
        throw new Error(`record ${guid} not found after creation`);
    }

    /** Same dedupe keys as executeImport(): source_path||title, plus title-only for records that have no path. */
    async _planExistingRecords(collection) {
        const byKey = new Map();
        for (const record of await collection.getAllRecords()) {
            const pathValue = typeof record.text === 'function' ? (record.text('source_path') || record.text('path') || '') : '';
            const key = this.makeDedupKey(pathValue, record.getName());
            if (key.trim() !== '||') byKey.set(key, record);
        }
        return byKey;
    }

    /** Deletes a record's body (children first). Never follows references into other records. */
    async _planClearBody(record) {
        let items = (await record.getLineItems(false)).filter(i => i.type !== 'document');
        for (let round = 0; round < 3 && items.length; round++) {
            const failed = [];
            for (const item of items.slice().reverse()) {
                if (!(await item.delete())) failed.push(item);
            }
            items = failed.reverse();
        }
        if (items.length) throw new Error(`could not delete ${items.length} old line items`);
    }

    async _planPassRecords(ctx) {
        const records = ctx.plan.records;
        const existingByCollection = new Map();
        let done = 0;
        ctx.progress(2, 'Creating records', 0, records.length);

        for (const def of records) {
            ctx.progress(2, `Record ${def.title}`, done++, records.length);
            const col = ctx.collections.get(def.collection);
            if (!col || col.failed) {
                ctx.report.counts.recordsFailed++;
                ctx.report.errors.push({ pass: 2, record: def.key, message: `collection ${def.collection} is unavailable` });
                continue;
            }
            try {
                if (!existingByCollection.has(def.collection)) {
                    existingByCollection.set(def.collection, await this._planExistingRecords(col.api));
                }
                const existingByKey = existingByCollection.get(def.collection);
                const pathKey = this.makeDedupKey(def.sourcePath, def.title);
                let found = existingByKey.get(pathKey);
                if (!found) {
                    // Adopt a record that has the same title but no source_path yet, once only
                    // (executeImport() keeps the fallback key, so same-titled files overwrite each other).
                    const fallbackKey = this.makeDedupKey('', def.title);
                    found = existingByKey.get(fallbackKey);
                    if (found) existingByKey.delete(fallbackKey);
                }
                let record = found;
                const isUpdate = !!found;

                if (isUpdate && ctx.opts.existing === 'skip') {
                    ctx.index.bind(def.key, found.guid);
                    ctx.records.set(def.key, { def, record: found, skipped: true });
                    ctx.report.counts.recordsSkipped++;
                    continue;
                }

                if (!isUpdate) {
                    const guid = col.api.createRecord(def.title);
                    if (!guid) throw new Error('createRecord returned null');
                    record = await this._planWaitForRecord(ctx, col.api, guid);
                    await this._planSleep(ctx, ctx.opts.settleMs ?? 300);
                }
                ctx.index.bind(def.key, record.guid);
                existingByKey.set(pathKey, record);
                ctx.records.set(def.key, { def, record });

                if (this.setFieldValue(record, 'source_path', def.sourcePath) === false && def.sourcePath) {
                    ctx.report.warnings.push({ code: 'property-not-set', message: 'source_path not set', record: def.key, field: 'source_path' });
                }
                for (const [fieldId, value] of Object.entries(def.values || {})) {
                    if (value === null || value === undefined || value === '') continue;
                    if (Array.isArray(value) && value.length === 0) continue;
                    if (!this.setFieldValue(record, fieldId, this.transformValue(value))) {
                        ctx.report.warnings.push({ code: 'property-not-set', message: `${fieldId} not set`, record: def.key, field: fieldId });
                    }
                }

                if (isUpdate) await this._planClearBody(record);
                if (def.body) {
                    const ok = await record.insertFromMarkdown(this.prepareMarkdownForThymerImport(def.body), null, null);
                    if (!ok) throw new Error('insertFromMarkdown returned false');
                }
                ctx.report.counts[isUpdate ? 'recordsUpdated' : 'recordsCreated']++;
            } catch (error) {
                ctx.report.counts.recordsFailed++;
                this._planError(ctx, 2, error, { record: def.key });
            }
        }
    }

    // ---- placeholders -------------------------------------------------------

    _planHasPlaceholder(segments, kinds) {
        const re = new RegExp(`⟦(${kinds.join('|')}):[A-Za-z0-9_-]+⟧`);
        return Array.isArray(segments) && segments.some(s => typeof s.text === 'string' && re.test(s.text));
    }

    /**
     * Replaces ⟦kind:id⟧ placeholders inside text/bold/italic/code segments.
     * replacer(kind, id) -> { segment } | { text } (| null to leave the placeholder alone).
     */
    _planRewriteSegments(segments, kinds, replacer) {
        const re = new RegExp(`⟦(${kinds.join('|')}):([A-Za-z0-9_-]+)⟧`, 'g');
        const styled = new Set(['text', 'bold', 'italic', 'code']);
        const out = [];
        let changed = false;
        for (const seg of segments) {
            if (!styled.has(seg.type) || typeof seg.text !== 'string' || !seg.text.includes('⟦')) { out.push(seg); continue; }
            let last = 0;
            let m;
            re.lastIndex = 0;
            const pieces = [];
            while ((m = re.exec(seg.text)) !== null) {
                const rep = replacer(m[1], m[2]);
                if (!rep) continue;
                if (m.index > last) pieces.push({ type: seg.type, text: seg.text.slice(last, m.index) });
                if (rep.segment && seg.type !== 'code') pieces.push(rep.segment);
                else if (rep.text) pieces.push({ type: seg.type, text: rep.text });
                else if (rep.segment) pieces.push({ type: 'code', text: rep.fallback || '' });
                last = m.index + m[0].length;
                changed = true;
            }
            if (last === 0 && pieces.length === 0) { out.push(seg); continue; }
            if (last < seg.text.length) pieces.push({ type: seg.type, text: seg.text.slice(last) });
            out.push(...pieces);
        }
        return { segments: out, changed };
    }

    // ---- pass 3: links ------------------------------------------------------

    _planResolveLink(ctx, link) {
        if (ctx.linkResults.has(link.id)) return ctx.linkResults.get(link.id);
        const result = ctx.index.resolve(link.target, { fromKey: link.from });
        const ok = result.status === 'resolved' && !!result.guid && ctx.records.has(result.key);
        if (ok) {
            ctx.report.counts.linksResolved++;
        } else {
            ctx.report.counts.linksUnresolved++;
            const from = ctx.records.get(link.from);
            ctx.report.unresolvedLinks.push(omitUndefined({
                linkId: link.id, from: link.from, fromTitle: from ? from.def.title : undefined,
                where: link.where, field: link.field, ref: link.target.ref,
                reason: result.status === 'resolved' ? 'target-not-imported' : (result.status === 'ambiguous' ? 'ambiguous' : result.reason),
                candidates: result.candidates
            }));
        }
        ctx.linkResults.set(link.id, ok ? result : null);
        return ctx.linkResults.get(link.id);
    }

    async _planPassLinks(ctx) {
        const links = ctx.plan.links || [];
        ctx.progress(3, 'Resolving links', 0, links.length);
        const byRecord = new Map();
        for (const link of links) {
            if (!byRecord.has(link.from)) byRecord.set(link.from, []);
            byRecord.get(link.from).push(link);
        }
        const linksById = new Map(links.map(l => [l.id, l]));
        let done = 0;
        for (const [key, own] of byRecord) {
            const entry = ctx.records.get(key);
            ctx.progress(3, `Links in ${entry ? entry.def.title : key}`, done += own.length, links.length);
            if (!entry) continue; // the record itself failed in pass 2 and is already in report.errors

            try {
                await this._planApplyPropertyLinks(ctx, entry, own.filter(l => l.where === 'property'));
            } catch (error) {
                this._planError(ctx, 3, error, { record: key });
            }
            const bodyLinks = own.filter(l => l.where === 'body');
            if (bodyLinks.length === 0) continue;
            try {
                await this._planApplyBodyLinks(ctx, entry, bodyLinks, linksById);
            } catch (error) {
                this._planError(ctx, 3, error, { record: key });
            }
        }
    }

    async _planApplyPropertyLinks(ctx, entry, links) {
        const byField = new Map();
        for (const link of links) {
            if (!byField.has(link.field)) byField.set(link.field, []);
            byField.get(link.field).push(link);
        }
        for (const [fieldId, fieldLinks] of byField) {
            const guids = [];
            for (const link of fieldLinks) {
                const result = this._planResolveLink(ctx, link);
                if (result && !guids.includes(result.guid)) guids.push(result.guid);
            }
            if (guids.length === 0) continue;
            const prop = entry.record.prop(fieldId);
            if (!prop) {
                ctx.report.errors.push({ pass: 3, record: entry.def.key, message: `record has no property ${fieldId}` });
                continue;
            }
            const multi = typeof prop.isMultiValue === 'function' && prop.isMultiValue();
            if (!multi && guids.length > 1) {
                ctx.report.warnings.push({ code: 'extra-values-dropped', message: `${fieldId} is single-value; kept the first of ${guids.length}`, record: entry.def.key, field: fieldId });
            }
            prop.set(multi ? guids : guids[0]);
        }
    }

    async _planApplyBodyLinks(ctx, entry, bodyLinks, linksById) {
        const own = new Set(bodyLinks.map(l => l.id));
        const seen = new Set();
        for (const item of await entry.record.getLineItems(false)) {
            if (!this._planHasPlaceholder(item.segments, ['link'])) continue;
            const { segments, changed } = this._planRewriteSegments(item.segments, ['link'], (kind, id) => {
                const link = linksById.get(id);
                if (!link || !own.has(id)) return { text: '' };
                seen.add(id);
                const result = this._planResolveLink(ctx, link);
                const fallback = link.raw !== undefined ? link.raw : (link.label !== undefined ? link.label : link.target.ref);
                if (!result) return { text: fallback };
                return { segment: { type: 'ref', text: omitUndefined({ guid: result.guid, title: link.label }) }, fallback };
            });
            if (changed && (await item.setSegments(segments)) === false) {
                ctx.report.errors.push({ pass: 3, record: entry.def.key, message: 'setSegments returned false while linking' });
            }
        }
        for (const link of bodyLinks) {
            if (!seen.has(link.id)) {
                this._planResolveLink(ctx, link);
                ctx.report.warnings.push({ code: 'placeholder-not-found', message: `body link ${link.id} was not found in the inserted body`, record: entry.def.key, link: link.id });
            }
        }
    }

    // ---- pass 4: assets -----------------------------------------------------

    _planContentType(asset) {
        if (asset.contentType) return asset.contentType;
        const ext = String(asset.name || asset.sourcePath || '').split('.').pop().toLowerCase();
        const map = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
            svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic', avif: 'image/avif', pdf: 'application/pdf'
        };
        return map[ext] || 'application/octet-stream';
    }

    async _planUploadAsset(ctx, asset) {
        const cacheKey = asset.sourcePath || asset.id;
        if (!ctx.blobs) ctx.blobs = new Map();
        if (ctx.blobs.has(cacheKey)) return ctx.blobs.get(cacheKey);
        const read = typeof asset.readBytes === 'function' ? asset.readBytes : (typeof ctx.opts.readAsset === 'function' ? () => ctx.opts.readAsset(asset) : null);
        if (!read) throw new Error('asset has no readBytes and no readAsset option was given');
        const bytes = await read();
        const name = asset.name || String(asset.sourcePath || asset.id).split('/').pop();
        const blob = await this.data.uploadBlob(new File([bytes], name, { type: this._planContentType(asset) }));
        if (!blob) throw new Error('uploadBlob returned null');
        ctx.blobs.set(cacheKey, blob);
        return blob;
    }

    async _planPassAssets(ctx) {
        const assets = ctx.plan.assets || [];
        ctx.progress(4, 'Uploading assets', 0, assets.length);
        const byRecord = new Map();
        for (const a of assets) {
            if (!byRecord.has(a.record)) byRecord.set(a.record, []);
            byRecord.get(a.record).push(a);
        }
        let done = 0;
        for (const [key, own] of byRecord) {
            const entry = ctx.records.get(key);
            if (!entry) continue;
            try {
                await this._planInsertAssets(ctx, entry, own);
            } catch (error) {
                ctx.report.counts.assetsFailed += own.length;
                this._planError(ctx, 4, error, { record: key });
            }
            ctx.progress(4, `Assets in ${entry.def.title}`, done += own.length, assets.length);
        }
    }

    async _planInsertAssets(ctx, entry, assets) {
        const byId = new Map(assets.map(a => [a.id, a]));
        const blobs = new Map();       // asset id -> PluginBlob | null (failed)
        const placed = new Set();
        const items = await entry.record.getLineItems(false);

        const upload = async (asset) => {
            if (blobs.has(asset.id)) return blobs.get(asset.id);
            try {
                const blob = await this._planUploadAsset(ctx, asset);
                blobs.set(asset.id, blob);
                return blob;
            } catch (error) {
                this._planError(ctx, 4, error, { record: entry.def.key, asset: asset.id });
                blobs.set(asset.id, null);
                ctx.report.counts.assetsFailed++;
                return null;
            }
        };
        const insertAfter = async (parent, after, asset, blob) => {
            const type = this._planContentType(asset).startsWith('image/') ? 'image' : 'file';
            const line = await entry.record.createLineItem(parent, after, type, null, null);
            if (!line || (await line.setBlob(blob)) === false) {
                if (line) await line.delete();
                throw new Error(`could not create ${type} line item`);
            }
            return line;
        };

        for (const item of items) {
            if (!this._planHasPlaceholder(item.segments, ['asset'])) continue;
            const ids = [];
            this._planRewriteSegments(item.segments, ['asset'], (kind, id) => { ids.push(id); return null; });
            const parent = item.parent_guid ? (items.find(i => i.guid === item.parent_guid) || null) : null;
            let after = item;
            for (const id of ids) {
                const asset = byId.get(id);
                if (!asset || placed.has(id)) continue;
                placed.add(id);
                const blob = await upload(asset);
                if (!blob) continue;
                try {
                    after = await insertAfter(parent, after, asset, blob);
                    ctx.report.counts.assetsUploaded++;
                } catch (error) {
                    blobs.set(id, null);
                    ctx.report.counts.assetsFailed++;
                    this._planError(ctx, 4, error, { record: entry.def.key, asset: id });
                }
            }
            const fallbackText = (id) => {
                const a = byId.get(id);
                return a ? (a.raw !== undefined ? a.raw : `[${a.name || String(a.sourcePath || id).split('/').pop()}]`) : '';
            };
            const { segments } = this._planRewriteSegments(item.segments, ['asset'], (kind, id) => ({ text: blobs.get(id) ? '' : fallbackText(id) }));
            const empty = segments.every(s => typeof s.text === 'string' && s.text.trim() === '');
            if (!(empty && (await item.delete()))) await item.setSegments(segments.length ? segments : [{ type: 'text', text: '' }]);
        }

        // Assets whose placeholder never made it into the body go at the end of the record.
        const stray = assets.filter(a => !placed.has(a.id));
        if (stray.length) {
            let after = items.filter(i => !i.parent_guid).pop() || null;
            for (const asset of stray) {
                ctx.report.warnings.push({ code: 'asset-placeholder-not-found', message: `asset ${asset.id} was not referenced in the body; appended`, record: entry.def.key, asset: asset.id });
                const blob = await upload(asset);
                if (!blob) continue;
                try {
                    after = await insertAfter(null, after, asset, blob);
                    ctx.report.counts.assetsUploaded++;
                } catch (error) {
                    ctx.report.counts.assetsFailed++;
                    this._planError(ctx, 4, error, { record: entry.def.key, asset: asset.id });
                }
            }
        }
    }

    // ---- pass 5: journal ----------------------------------------------------

    async _planPassJournal(ctx) {
        const entries = ctx.plan.journal || [];
        if (entries.length === 0) return;
        ctx.progress(5, 'Importing journal entries', 0, entries.length);
        let journal = ctx.opts.journalCollection;
        if (!journal) journal = (await this.data.getAllCollections()).find(c => typeof c.isJournalPlugin === 'function' && c.isJournalPlugin());
        const user = this.data.getActiveUsers()[0];
        if (!journal || !user) {
            ctx.report.warnings.push({ code: 'no-journal', message: 'no journal collection or active user; journal entries skipped' });
            ctx.report.counts.journalSkipped += entries.length;
            return;
        }
        let done = 0;
        for (const entry of entries) {
            try {
                const [year, month, day] = String(entry.date).split('-').map(n => parseInt(n, 10));
                const page = await journal.getJournalRecord(user, DateTime.dateOnly(year, month - 1, day));
                if (!page) throw new Error(`no journal page for ${entry.date}`);
                const existing = await page.getLineItems(false);
                if (existing && existing.length) {
                    // Journal pages hold the user's own writing; never replace them on re-import.
                    ctx.report.counts.journalSkipped++;
                    ctx.report.warnings.push({ code: 'journal-page-not-empty', message: `journal page ${entry.date} already has content; skipped` });
                } else if (entry.markdown) {
                    if (!(await page.insertFromMarkdown(this.prepareMarkdownForThymerImport(entry.markdown), null, null))) {
                        throw new Error('insertFromMarkdown returned false');
                    }
                    ctx.report.counts.journalCreated++;
                }
            } catch (error) {
                this._planError(ctx, 5, error, { journal: entry.date });
            }
            ctx.progress(5, `Journal ${entry.date}`, ++done, entries.length);
        }
    }
}
