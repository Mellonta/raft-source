import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApiTest } from '../test/integration/apiTest';
import { getDb } from '../db/index';
import { featureFlagRules } from '../db/schema';
import { SERVER_GUEST_FEATURE_FLAG_KEY } from '../services/featureFlagService';
import { transitionMemberRole } from '../services/serverService';
import { createMessage } from '../services/messageService';
import { getFollowedThreads } from '../services/channelService';
import { seedThreadFixture, headers, recordTestInboxFact } from './channels.api.fixtures';
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
test('review: revoked Guest thread must disappear from Activity', async ({app}) => {
 const f = await seedThreadFixture(app.baseUrl);
 await getDb().insert(featureFlagRules).values({id:randomUUID(),flagKey:SERVER_GUEST_FEATURE_FLAG_KEY,stage:'server',priority:0,decision:'allow',values:[f.serverId]});
 const reply = await createMessage(f.threadId,'user',f.ownerId,'secret-review-thread-reply');
 await recordTestInboxFact({serverId:f.serverId,receiverId:f.followerId,kind:'thread',sourceChannelId:f.threadId,message:reply});
 const h = headers(f.followerToken,f.serverId);
 const read = async (path:string) => { const r=await fetch(`${app.baseUrl}/api/${path}`,{headers:h}); return {status:r.status,body:await r.json()}; };
 const directBefore=await read(`messages/channel/${f.threadId}`);
 assert.equal(directBefore.status,200,'same direct endpoint must work before downgrade');
 const before=await read('channels/inbox?filter=all');
 assert.equal(before.status,200);
 assert.ok(JSON.stringify(before.body).includes(f.threadId),'positive control must contain followed thread');
 await transitionMemberRole({serverId:f.serverId,actorUserId:f.ownerId,targetUserId:f.followerId,nextRole:'guest',guestTransitionsEnabled:true});
 const transactionVisibleThreads = await getDb().transaction((executor) => getFollowedThreads(
  f.serverId,
  f.followerId,
  undefined,
  { executor },
 ));
 assert.ok(
  !transactionVisibleThreads.some((thread) => thread.threadChannelId === f.threadId),
  'caller-owned transaction must retain Guest revocation while filtering followed threads',
 );
 const direct=await read(`messages/channel/${f.threadId}`);
 const newSend=await fetch(`${app.baseUrl}/api/messages`,{method:'POST',headers:headers(f.ownerToken,f.serverId),body:JSON.stringify({channelId:f.threadId,content:'new-secret-after-guest-downgrade'})});
 assert.equal(newSend.status,200, JSON.stringify(await newSend.json()));
 const all=await read('channels/inbox?filter=all');
 const unread=await read('channels/inbox?filter=unread');
 assert.equal(direct.status,403,'direct read denied after downgrade');
 assert.equal(all.status,200);
 assert.ok(!JSON.stringify(all.body).includes(f.threadId),'inaccessible thread must not remain in Activities');
 assert.equal(unread.status,200);
 assert.ok(!JSON.stringify(unread.body).includes(f.threadId),'inaccessible thread must not remain in Unread');
});
