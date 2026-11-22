// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers (section 5), and writes every change or none. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const isWsOnly = (s: string): boolean => /^[ \t]*$/.test(s);

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

/** Positions i >= from where O matches lines[i..] at the tier. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (normLine(lines[i + k]!, tier) !== normLine(O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(O: string[], lines: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` line. */
interface BodyLine {
  kind: string;
  text: string;
}

/** O and N of a hunk or chunk, and for each line of N the index in O when it is a context line. */
function bodyON(body: BodyLine[]): { O: string[]; N: string[]; nToO: (number | null)[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nToO: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      nToO.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      nToO.push(null);
      N.push(b.text);
    }
  }
  return { O, N, nToO };
}

/**
 * N with context lines taken from the file's own matched lines and tier-2
 * re-indentation applied to the rest (SPEC.md section 5).
 */
function mappedN(N: string[], nToO: (number | null)[], f: FileState, pos: number, O: string[], tier: number): string[] {
  const out: string[] = [];
  const F = O.length > 0 ? leadWs(f.lines[pos] ?? '') : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  for (let i = 0; i < N.length; i += 1) {
    const o = nToO[i];
    if (o !== null && o !== undefined) {
      out.push(f.lines[pos + o]!);
      continue;
    }
    const line = N[i]!;
    if (tier === 2 && line !== '' && !isWsOnly(line) && line.startsWith(P)) out.push(F + line.slice(P.length));
    else out.push(line);
  }
  return out;
}

/** Replace O's lines at pos with N (context lines from the file, tier-2 re-indent). */
function replaceAt(f: FileState, pos: number, O: string[], N: string[], nToO: (number | null)[], tier: number): FileState {
  const next = mappedN(N, nToO, f, pos, O, tier);
  return { lines: [...f.lines.slice(0, pos), ...next, ...f.lines.slice(pos + O.length)], br: f.br, final: f.final };
}

/** Insert N after line idx (0 is the top), with no re-indentation. */
function insertAt(f: FileState, idx: number, N: string[]): FileState {
  const at = Math.max(0, Math.min(idx, f.lines.length));
  return { lines: [...f.lines.slice(0, at), ...N, ...f.lines.slice(at)], br: f.br, final: f.final };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified section: its old-file start line and its body lines. */
interface Hunk {
  a: number;
  body: BodyLine[];
  /** a `\` line follows this hunk's last context or `+` line */
  noEol: boolean;
}

interface SectionData {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function diffPath(raw: string): string | null {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

/** All `+` lines of a section's hunks, in order. */
function sectionPlusLines(sec: SectionData): string[] {
  const out: string[] = [];
  for (const h of sec.hunks) for (const b of h.body) if (b.kind === '+') out.push(b.text);
  return out;
}

/** Whether a `\` line follows the section's last `+` line (for a created file's final break). */
function sectionPlusNoEol(sec: SectionData): boolean {
  for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
    const body = sec.hunks[hi]!.body;
    for (let k = body.length - 1; k >= 0; k -= 1) {
      if (body[k]!.kind === '+') return k + 1 < body.length && body[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** One unified section as an edit (SPEC.md section 6). */
function unifiedEdit(sec: SectionData, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld ?? null;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew ?? null;
    const isCreation = sec.pairOld === null || sec.newFile;
    const isDeletion = !isCreation && (sec.pairNew === null || sec.deletedFile);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreation) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus = sectionPlusLines(sec);
      const content = plus.length === 0 ? '' : plus.join('\n') + (sectionPlusNoEol(sec) ? '' : '\n');
      tree.now.set(newP, content);
      return;
    }
    if (isDeletion) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const oldContent = tree.get(oldP!);
    if (oldContent === null) throw new Fail('missing', oldP!);
    const isMove = newP !== null && newP !== oldP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let f = parseFile(oldContent);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N, nToO } = bodyON(h.body);
      if (O.length > 0) {
        const found = findTier(O, f.lines, 0, strict);
        if (found === null) throw new Fail('no-match', oldP!);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        for (const p of found.occ) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const atEnd = best + O.length === f.lines.length;
        f = replaceAt(f, best, O, N, nToO, found.tier);
        if (atEnd) f.final = !h.noEol;
        d += N.length - O.length;
      } else {
        const idx = Math.min(Math.max(0, h.a + d), f.lines.length);
        const atEnd = idx === f.lines.length;
        f = insertAt(f, idx, N);
        if (atEnd) f.final = !h.noEol;
        d += N.length;
      }
    }
    const content = renderFile(f);
    if (isMove) {
      tree.now.set(newP!, content);
      tree.now.set(oldP!, null);
      tree.moves.push([oldP!, newP!]);
    } else {
      tree.now.set(oldP!, content);
    }
  };
}

/** Read a patch as unified diffs (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: SectionData[] = [];
  let cur: SectionData | null = null;
  const fresh = (): SectionData => {
    const s: SectionData = {
      pairOld: undefined,
      pairNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      diffOld: undefined,
      diffNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '' });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: c, text: bl.slice(1) });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === ' ' && last.text === '') body.pop();
        else break;
      }
      let noEol = false;
      for (let k = body.length - 1; k >= 0; k -= 1) {
        if (body[k]!.kind === ' ' || body[k]!.kind === '+') {
          noEol = k + 1 < body.length && body[k + 1]!.kind === '\\';
          break;
        }
      }
      cur.hunks.push({ a, body, noEol });
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.pairOld === undefined && cur.hunks.length === 0) {
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(lines[i + 1]!);
      } else {
        cur = fresh();
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block as an edit (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const content = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      tree.now.set(path, content);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(oldLines, f.lines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const nToO: (number | null)[] = newLines.map(() => null);
    const nf = replaceAt(f, found.occ[0]!, oldLines, newLines, nToO, found.tier);
    tree.now.set(path, renderFile(nf));
  };
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplace = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/** One chunk of a V4A Update File section: its anchor, whether it is end-of-file, and its body. */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** A V4A Add File section as an edit (SPEC.md section 8). */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const content = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
    tree.now.set(path, content);
  };
}

/** A V4A Delete File section as an edit (SPEC.md section 8). */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** A V4A Update File section as an edit (SPEC.md section 8). */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier([ch.anchor], f.lines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { O, N, nToO } = bodyON(ch.body);
      if (O.length > 0) {
        const found = findTier(O, f.lines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let occ = found.occ;
        if (ch.eof) occ = occ.filter((p) => p + O.length === f.lines.length);
        if (occ.length === 0) throw new Fail('no-match', path);
        const pos = occ[0]!;
        f = replaceAt(f, pos, O, N, nToO, found.tier);
        cursor = pos + N.length;
      } else {
        const idx = ch.eof ? f.lines.length : cursor;
        f = insertAt(f, idx, N);
        cursor = idx + N.length;
      }
    }
    const content = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, content);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}

/** Read a patch as V4A (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice(13).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice(16).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice(16).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const raw: number[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      raw.push(j);
      j += 1;
    }
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const idx of raw) {
        const l = lines[idx]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (const idx of raw) {
        if (!blank(lines[idx]!)) throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (k < raw.length && lines[raw[k]!]!.startsWith('*** Move to:')) {
        moveTo = lines[raw[k]!]!.slice(12).trim();
        k += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let ended = false;
      for (; k < raw.length; k += 1) {
        const idx = raw[k]!;
        const l = lines[idx]!;
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          ended = false;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          ended = true;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0 && !ended) {
              cur = { anchor: null, eof: false, body: [] };
            } else {
              throw new Exit2(`error: parse ${idx + 1}`);
            }
          }
          cur.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0]!, text: l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string; path: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p });
  }
  for (const [oldP, newP] of tree.moves) {
    const dIdx = changed.findIndex((c) => c.path === oldP && c.line.startsWith('D '));
    const aIdx = changed.findIndex((c) => c.path === newP && c.line.startsWith('A '));
    if (dIdx < 0 || aIdx < 0) continue;
    const [hi, lo] = dIdx > aIdx ? [dIdx, aIdx] : [aIdx, dIdx];
    changed.splice(hi, 1);
    changed.splice(lo, 1);
    changed.push({ key: newP, line: `R ${oldP} -> ${newP}`, path: newP });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
