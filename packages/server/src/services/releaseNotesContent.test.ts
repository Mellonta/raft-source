import { releaseEntries,releaseMutation,snapshotHash } from './releaseNotesContent';
describe('release notes content',()=>{
 const e={entryId:'00000000-0000-4000-8000-000000000001',ordinal:0,type:'fix',text:'中文 → test',emphasis:false};
 it('preserves Unicode and normalizes newlines',()=>{expect(releaseEntries.parse([{...e,text:'中文\r\nx'}])[0].text).toBe('中文\nx');});
 it('rejects ambiguous identities and unsafe content',()=>{
  for(const entries of [[e,e],[{...e,text:'x\0'}],[{...e,text:'\ud800'}],[{...e,type:'html'}]]) expect(releaseEntries.safeParse(entries).success).toBe(false);
 });
 it('does not accept an actor from a request',()=>{expect(releaseMutation.safeParse({expectedGeneration:0,expectedRevision:0,reason:'x',actorId:'fake'}).success).toBe(false);});
 it('hash excludes ordinal but is sensitive to content',()=>{
  const a=releaseEntries.parse([e]);
  expect(snapshotHash(a)).toBe(snapshotHash(releaseEntries.parse([{...e,ordinal:5}])));
  expect(snapshotHash(a)).not.toBe(snapshotHash(releaseEntries.parse([{...e,text:'changed'}])));
 });
});
