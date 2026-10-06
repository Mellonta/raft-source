import { createHash } from 'node:crypto';
import { z } from 'zod';
const cleanText = (max: number) => z.string().min(1).max(max).refine(v => !v.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)).transform(v => v.replace(/\r\n?/g, '\n'));
export const releaseEntries = z.array(z.object({
 entryId: z.string().uuid(), ordinal: z.number().int().min(0).max(1000),
 type: z.enum(['feature','fix','improvement','breaking','deprecated']),
 text: cleanText(20000), emphasis: z.boolean(),
}).strict()).min(1).max(200).superRefine((entries, ctx) => {
 for (const key of ['entryId','ordinal'] as const) if(new Set(entries.map(e=>e[key])).size !== entries.length) ctx.addIssue({code:'custom',message:`duplicate ${key}`});
}).transform(entries => entries.sort((a,b)=>a.ordinal-b.ordinal || a.entryId.localeCompare(b.entryId)));
export const releaseMutation = z.object({
 expectedGeneration: z.number().int().nonnegative(),
 expectedRevision: z.number().int().nonnegative(),
 idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
 reason: cleanText(2000),
 entries: releaseEntries.optional(),
 version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(100).optional(),
 tag: z.string().min(1).max(200).optional(),
 date: z.string().date().optional(),
}).strict();
export function snapshotHash(entries: z.infer<typeof releaseEntries>): string {
 return createHash('sha256').update(JSON.stringify(entries.map(e=>({emphasis:e.emphasis,entry_id:e.entryId,text:e.text,type:e.type})))).digest('hex');
}
