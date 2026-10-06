-- Backfill thread_id on thread parents where getOrCreateThread left it NULL.
--
-- Until this release, getOrCreateThread inserted the thread channel and then
-- stamped the parent message's thread_id as two separate autocommit
-- statements. When the stamp failed after the insert committed (it peaked at
-- the 15 s statement timeout during GIN pending-list flushes), the thread
-- survived without its parent pointing at it. The write path now does both in
-- one transaction.
--
-- Full read-only scan of prod (2026-09-27, all 771,840 live threads):
--   762,249 consistent, 9,533 without a parent message (joint projections and
--   deleted parents; nothing to stamp), 0 pointing at another thread, and
--   58 parents with thread_id NULL, created 2026-06-16 .. 2026-09-22.
--   All 58 carry getOrCreateThread's `thread-<parent>` name; 47 have no reply.
--
-- The pairs are listed explicitly so this stays a handful of primary-key
-- updates inside the migration statement timeout (a generic scan is ~772k
-- parent lookups). Every row is still guarded by the full invariant, so the
-- statement is a no-op wherever a pair does not match (other environments,
-- already-repaired rows). Parents that already carry a thread_id are left alone.
--
-- The old write path keeps running until this release, so a second statement
-- covers threads created after the scan's cutoff (2026-09-27T00:00Z, overlapping
-- the scan by ~13 h): a sequential scan of channels (~110 MB) plus one parent
-- lookup per recent thread, a few thousand rows at release time. At most one
-- live thread exists per parent (idx_channels_active_thread_parent).
UPDATE "messages" AS pm
SET "thread_id" = pairs.thread_id::text
FROM (VALUES
	('8fce98a8-ce50-416e-8ba6-c79d5413392e'::uuid, 'f88679b5-2149-435e-92d5-6a0115a55e1e'::uuid),
	('e91903bc-3c14-4212-996c-e7e2bb114233'::uuid, '498ff25e-d477-4fcf-b3fd-35dd548f23f6'::uuid),
	('50157422-0d70-42fb-aaad-6cc792655033'::uuid, '9ba5747d-1ed4-472d-9f78-f75ca61922c9'::uuid),
	('62f982c6-01a6-4e28-8239-e010b47fe1d8'::uuid, '1fdfec0d-d436-43ef-9720-91cd9c01cf2d'::uuid),
	('d148b7fe-d5ff-425f-9706-66678c8fa2ce'::uuid, '17187600-592e-4f4a-b737-a0c4c07553df'::uuid),
	('fbd3cf84-93d2-498c-95cd-2eb8391363cc'::uuid, 'd5fc10e1-808d-4977-b13a-b5be47db6241'::uuid),
	('d853f7af-b2e6-49fc-b74e-ad5ff3263504'::uuid, '5f1f1cfe-6840-40a6-9001-ae982d861957'::uuid),
	('8320e0fa-5699-4a5a-a30a-fde3411f4ac5'::uuid, 'd54bdfe7-a671-47db-84fb-c5055327d9d9'::uuid),
	('41006a5c-815a-444e-b9b0-a3d414368310'::uuid, '02c5cce5-7400-452f-9d19-3ea2a8c0e0fd'::uuid),
	('c490ac5d-df0d-4986-85d7-96a5f37b5b7d'::uuid, '12e21afe-bceb-4c6f-8129-909873d2c76c'::uuid),
	('a2647ee8-7f9e-4066-ad9d-b07db4b1e1c3'::uuid, '12e30e3c-2dd0-45a5-a8d4-7214b4a255d1'::uuid),
	('26d92f1d-bc27-4c26-b246-7563357295f2'::uuid, 'f6d58b15-27a0-4ffb-a6e8-eb02ec867cb3'::uuid),
	('1d038696-a7ff-4588-8fab-d4c77e884419'::uuid, '1e883e1d-ccb6-4819-ad91-d69c9c2d7d20'::uuid),
	('a7f4b571-fd0e-4036-9bb6-688887f9d774'::uuid, '498d1f7c-f864-48b1-b38e-aae6fff9821e'::uuid),
	('a475f3e5-5fda-4055-b510-45915f51551d'::uuid, 'b8314d85-697f-491e-9979-cead8456c056'::uuid),
	('c2c6f1d8-a524-424d-8e10-03ab260fa100'::uuid, 'a3b1118d-7ef1-4250-a6b3-832979a90e3c'::uuid),
	('3ad50d94-1420-4c49-96ac-1bd5f122d093'::uuid, '12180ce7-288f-4b1a-a320-b8531fc67f2a'::uuid),
	('e0b477bd-72c8-4c7f-b2d9-0946851d4cfe'::uuid, 'fa1dd382-6041-4f7b-b55d-68b50ee0ef74'::uuid),
	('6464c1fc-0137-4651-82ef-338345159d9d'::uuid, 'dc118d62-09f1-4075-821a-121408ef2845'::uuid),
	('89a6683c-d280-4e25-b007-59477948d3b1'::uuid, '4fdf8881-5917-4335-aeb8-f0fc7cf9b4db'::uuid),
	('c88db960-265b-4803-86cd-c00657a25cee'::uuid, '8b3ce819-d0f0-41e4-84cb-052bdd988ee3'::uuid),
	('2dbed08d-be62-45cc-8022-6d61b205eed5'::uuid, '3fd8f611-f8b6-4baa-9c3d-6cd3387f1a89'::uuid),
	('b9a4393d-f900-49ea-b8f3-976144bb820b'::uuid, 'e01270b2-4965-4479-b9b7-22be8ad0b1eb'::uuid),
	('2331a148-1a9b-46ee-8d71-64348a6b5e14'::uuid, '9577740c-e974-4d70-a4d4-20645a4901dd'::uuid),
	('2fdf7b67-1de2-437c-bb2f-a929bc9d8158'::uuid, '0f3c963d-77d5-42a6-841b-2d6ae32c1807'::uuid),
	('6a8edff5-6400-44b4-83a7-06a22bff86b2'::uuid, 'ea35049f-74fe-45b8-a7ef-14d74239e3be'::uuid),
	('56b31b33-c7bf-477f-9007-8f29a1f81dc5'::uuid, 'd869ee2f-1ead-4a08-8b4b-7950e71af48a'::uuid),
	('968672ec-8e47-4d0f-bf66-5979bd47ba85'::uuid, '55c3d0f2-d3f7-4433-b7df-9951c3b19ce1'::uuid),
	('2170285c-4a96-414e-bbf5-0cfbd0d7be11'::uuid, '2fe530d3-c81f-4d91-b482-c4000f9bc05e'::uuid),
	('a1824a74-4330-45da-9b10-720851fdfd9c'::uuid, '8d79b45f-b91b-468a-8025-4a40d7735437'::uuid),
	('3481dcce-e505-4b8b-a743-a36f73ed4ccb'::uuid, 'ccd829ea-ea05-4e9d-aeb7-c3df9d090eae'::uuid),
	('ac26bfeb-5f28-47d7-8871-87b8cdbd0822'::uuid, '7eebc8b8-9e49-4b8b-9c9a-8f8315572794'::uuid),
	('ab65d16c-7461-42a1-8739-1be1cb320dee'::uuid, '6c3f4413-3ec0-43a9-a419-5fd5f5088f17'::uuid),
	('8992f88a-506c-47d1-9ff6-e4228dd39b3b'::uuid, '1b0784be-0c3b-4815-aff1-0cf7a1464ae8'::uuid),
	('d54f4892-2637-4f90-b2d1-8b6a7c3c4b4e'::uuid, '2c51e09d-6720-4d5c-83a0-a7dc4b63a72d'::uuid),
	('7dd1c557-535a-4438-969a-214f9cf960bd'::uuid, 'd9a4549f-5df3-4f09-94c8-f3ddbeaa2662'::uuid),
	('19a080bb-6988-4f2c-9f80-0ced10d32e6e'::uuid, '57ff958a-cbb5-4495-8bb0-f58483d2a0f6'::uuid),
	('e5751a85-4c6e-4d6c-a190-b3ccb6f45883'::uuid, '6e0b5321-1c27-40e2-b9d7-4151fd1ea7b4'::uuid),
	('846a9600-d737-4a70-b6e2-b42dc597e981'::uuid, '24b40865-ec23-4ff4-96f1-07a3b46f5e09'::uuid),
	('6815d7b3-8342-4275-b03d-b1d4e74bb4ab'::uuid, '8d3d274a-d5aa-4b7a-bfc4-6802c92f9bbe'::uuid),
	('ea14c629-da43-4d41-a84e-738a86a38bf5'::uuid, '061827d1-f139-4b55-b59c-6daab8a1047a'::uuid),
	('d3c74e87-4e9f-43f9-b365-9577dacbd292'::uuid, 'c0a68f98-c423-444d-a048-0dd2f869e913'::uuid),
	('3af7d819-0680-40a7-b6c5-e07c56481662'::uuid, '4a6c1bd2-f9f4-4789-b738-43bbeccf8c82'::uuid),
	('5b4c8d6b-c74d-4c87-ac9d-38856dc1c7c9'::uuid, 'f03c86aa-a5bc-4d92-8169-8589058fdc69'::uuid),
	('a7d7ea8a-31d8-4bd1-a115-f1e246adcf24'::uuid, 'b524889f-e1e1-4a46-bbd2-793268760537'::uuid),
	('ee2b0238-f8f2-4dd3-b9a0-b547b27d304a'::uuid, '9e4601b2-7bd3-491c-b285-d07539def869'::uuid),
	('fc3a9398-ae90-47ec-80d3-53bf54fe82ec'::uuid, '734e0586-7e02-4b03-9431-91d974712afc'::uuid),
	('88759512-33bb-4743-a017-5a0418e2ed22'::uuid, 'ae846428-4ce3-4ed6-9cc8-032037094216'::uuid),
	('e83d07a2-ac5e-4388-8018-f9c032ac2f3a'::uuid, '37f816ba-346d-4413-ab6e-7ab382192ccd'::uuid),
	('6d51b75c-b2db-44be-8fe8-d67c1f4178f2'::uuid, 'bd7c655e-a856-4460-8c0a-91ae9320a1fa'::uuid),
	('82a0f14b-04a6-47ae-ac2c-3b28449ce833'::uuid, '34b32ac4-281b-4935-9ef9-f975f4830b9f'::uuid),
	('c9dce0df-b952-4714-9da5-d7af7aa3e47d'::uuid, 'da76d681-f7db-4252-9b0c-ffa6cb249a3c'::uuid),
	('74a97098-f0f8-4947-9d18-45a93096c2a9'::uuid, '585cb97e-1ffd-46f2-9dc0-508d13398cc9'::uuid),
	('f2569b8a-221f-4a05-8472-aef7aa38f9c7'::uuid, '4d41e0bb-f6c5-4eb5-81fd-626b21033241'::uuid),
	('09e62163-0963-4a52-bb53-8ca20b6f6b4e'::uuid, '4868262e-4930-4799-8115-947b82d80f06'::uuid),
	('a2e82c59-14e7-4a60-a77a-ca40f59697e3'::uuid, '71231e07-2ae5-405d-9439-d85b0a1c91f5'::uuid),
	('d18074fc-be58-45d8-994e-1907ffbb4ac2'::uuid, 'cf3145e6-b27e-48de-857d-6fb278787401'::uuid),
	('19e3b4c7-b662-4971-8767-1035a8ec2648'::uuid, 'd9c642f8-84ad-4537-a760-375b144697bf'::uuid)
) AS pairs(thread_id, parent_message_id)
JOIN "channels" AS t
  ON t.id = pairs.thread_id
 AND t.parent_message_id = pairs.parent_message_id
 AND t.type = 'thread'
 AND t.deleted_at IS NULL
WHERE pm.id = pairs.parent_message_id
  AND pm.thread_id IS NULL;
--> statement-breakpoint
UPDATE "messages" AS pm
SET "thread_id" = t.id::text
FROM "channels" AS t
WHERE t.type = 'thread'
  AND t.deleted_at IS NULL
  AND t.created_at >= '2026-09-27T00:00:00Z'
  AND t.parent_message_id = pm.id
  AND pm.thread_id IS NULL;
