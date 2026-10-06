import { createHash } from 'node:crypto';
import { Router, type Router as ExpressRouter } from 'express';
import { and, desc, eq, isNotNull, lt, or } from 'drizzle-orm';
import { getDb } from '../db/index';
import { releaseNotes, releaseNoteRevisions, releaseNoteRevisionItems } from '../db/schema';

export const releaseNotesRouter: ExpressRouter = Router();
releaseNotesRouter.get('/', async (req, res, next) => {
  try {
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({code: 'invalid_limit'}); return;
    }
    let after: {date: string; id: string} | undefined;
    if (req.query.cursor !== undefined) {
      try {
        if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 256) throw new Error();
        after = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8'));
        if (!after || !/^\d{4}-\d{2}-\d{2}$/.test(after.date) || !/^[0-9a-f-]{36}$/.test(after.id)) throw new Error();
      } catch { res.status(400).json({code: 'invalid_cursor'}); return; }
    }
    const db = getDb();
    const rows = await db.select({
      releaseId: releaseNotes.id, releaseKey: releaseNotes.releaseKey,
      version: releaseNotes.version, tag: releaseNotes.tag, date: releaseNotes.date,
      revision: releaseNoteRevisions.revision, snapshotHash: releaseNoteRevisions.snapshotHash,
      publishedAt: releaseNoteRevisions.publishedAt, retractedAt: releaseNotes.retractedAt,
    }).from(releaseNotes).innerJoin(releaseNoteRevisions, and(
      eq(releaseNotes.id, releaseNoteRevisions.releaseId),
      eq(releaseNotes.currentRevision, releaseNoteRevisions.revision),
    )).where(and(isNotNull(releaseNotes.currentRevision), after ? or(
      lt(releaseNotes.date, after.date), and(eq(releaseNotes.date, after.date), lt(releaseNotes.id, after.id)),
    ) : undefined)).orderBy(desc(releaseNotes.date), desc(releaseNotes.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const items = await Promise.all(page.map(async row => {
      const {retractedAt, ...publicRow} = row;
      const entries = retractedAt ? [] : await db.select({entryId: releaseNoteRevisionItems.entryId,
        type: releaseNoteRevisionItems.type, text: releaseNoteRevisionItems.text,
        emphasis: releaseNoteRevisionItems.emphasis, ordinal: releaseNoteRevisionItems.ordinal,
      }).from(releaseNoteRevisionItems).where(and(eq(releaseNoteRevisionItems.releaseId, row.releaseId),
        eq(releaseNoteRevisionItems.revision, row.revision))).orderBy(releaseNoteRevisionItems.ordinal);
      return {...publicRow, state: retractedAt ? 'retracted' : 'published', entries};
    }));
    const last = page.at(-1);
    const body = {items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({date:last.date,id:last.releaseId})).toString('base64url') : null};
    const etag = '"' + createHash('sha256').update(JSON.stringify(body)).digest('hex') + '"';
    res.set('ETag',etag).set('Cache-Control','public, max-age=30');
    if (req.headers['if-none-match'] === etag) {res.status(304).end(); return;}
    res.json(body);
  } catch (err) { next(err); }
});

// Public detail by release id: published entries, or a retracted stub without entries.
releaseNotesRouter.get('/:releaseId', async (req, res, next) => {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.releaseId)) {
      res.status(400).json({code: 'invalid_release_id'}); return;
    }
    const db = getDb();
    const [row] = await db.select({
      releaseId: releaseNotes.id, releaseKey: releaseNotes.releaseKey,
      version: releaseNotes.version, tag: releaseNotes.tag, date: releaseNotes.date,
      revision: releaseNoteRevisions.revision, snapshotHash: releaseNoteRevisions.snapshotHash,
      publishedAt: releaseNoteRevisions.publishedAt, retractedAt: releaseNotes.retractedAt,
    }).from(releaseNotes).innerJoin(releaseNoteRevisions, and(
      eq(releaseNotes.id, releaseNoteRevisions.releaseId),
      eq(releaseNotes.currentRevision, releaseNoteRevisions.revision),
    )).where(and(eq(releaseNotes.id, req.params.releaseId), isNotNull(releaseNotes.currentRevision))).limit(1);
    if (!row) { res.status(404).json({code: 'not_found'}); return; }
    const {retractedAt, ...publicRow} = row;
    const entries = retractedAt ? [] : await db.select({entryId: releaseNoteRevisionItems.entryId,
      type: releaseNoteRevisionItems.type, text: releaseNoteRevisionItems.text,
      emphasis: releaseNoteRevisionItems.emphasis, ordinal: releaseNoteRevisionItems.ordinal,
    }).from(releaseNoteRevisionItems).where(and(eq(releaseNoteRevisionItems.releaseId, row.releaseId),
      eq(releaseNoteRevisionItems.revision, row.revision))).orderBy(releaseNoteRevisionItems.ordinal);
    const body = {...publicRow, state: retractedAt ? 'retracted' : 'published', entries};
    const etag = '"' + createHash('sha256').update(JSON.stringify(body)).digest('hex') + '"';
    res.set('ETag', etag).set('Cache-Control', 'public, max-age=30');
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.json(body);
  } catch (err) { next(err); }
});
