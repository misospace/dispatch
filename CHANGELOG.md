# Changelog

## [0.5.72](https://github.com/misospace/dispatch/compare/v0.5.71...v0.5.72) (2026-10-26)


### Features

* **deps:** update dependency lucide-react (1.59.0 → 1.60.0) ([#1318](https://github.com/misospace/dispatch/issues/1318)) ([c7dc3ad](https://github.com/misospace/dispatch/commit/c7dc3ad57476bf4ea43c5f2c955663b644dace2f))
* **deps:** update dependency lucide-react (1.60.0 → 1.61.0) ([#1333](https://github.com/misospace/dispatch/issues/1333)) ([24e3ccf](https://github.com/misospace/dispatch/commit/24e3ccfc53fb5aeae847e3d5c7030f5660c83546))
* **groomer:** expose evidence revision, freshness, and mutation validation in run history ([#1067](https://github.com/misospace/dispatch/issues/1067)) ([#1294](https://github.com/misospace/dispatch/issues/1294)) ([5758161](https://github.com/misospace/dispatch/commit/57581615e4a7fb3a9807becbbb4e5a4832c49bc4))
* **lifecycle:** durable run-to-fix-round association projected into the chain ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([ee781d1](https://github.com/misospace/dispatch/commit/ee781d19922ed7d7e872d15abb642db38018fa8d))
* **lifecycle:** expose PR-fix history as distinct classified evidence events ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([0fa54fc](https://github.com/misospace/dispatch/commit/0fa54fc184f531ef66b172fbaf408d3dbdb21821))
* **lifecycle:** link authoritative PR merges and expose claim-to-merge timelines ([#1203](https://github.com/misospace/dispatch/issues/1203)) ([#1296](https://github.com/misospace/dispatch/issues/1296)) ([9f7ac6a](https://github.com/misospace/dispatch/commit/9f7ac6ab610dfd9b2214d2e7aa82f88f0a2ee9da))
* **lifecycle:** link worker attempts and PR-fix rounds into one delivery chain ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([272dc09](https://github.com/misospace/dispatch/commit/272dc0957e82e848b0a595faa29bd0c07658a37e))
* **lifecycle:** link worker attempts and PR-fix rounds into one delivery chain ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([110ede1](https://github.com/misospace/dispatch/commit/110ede1c81fe12bb70aa5175ef6ee77bf930a98e))
* **observability:** export standalone queue, ownership and execution signals ([#1252](https://github.com/misospace/dispatch/issues/1252)) ([#1332](https://github.com/misospace/dispatch/issues/1332)) ([3656b5c](https://github.com/misospace/dispatch/commit/3656b5c56d7bdba572d2421ff4bded47c784b6d5))
* **observability:** opt-in metrics exporter, portable alert evaluator, packaged assets ([#1255](https://github.com/misospace/dispatch/issues/1255)) ([#1433](https://github.com/misospace/dispatch/issues/1433)) ([7f9477d](https://github.com/misospace/dispatch/commit/7f9477d088295f3bae643df63834fe59127a3a4d))
* **ownership:** optional worker renewal capability + fenced claim evidence ([#1251](https://github.com/misospace/dispatch/issues/1251)) ([#1300](https://github.com/misospace/dispatch/issues/1300)) ([a26e7d7](https://github.com/misospace/dispatch/commit/a26e7d7c2052219ef406cd1016382278c97ef002))
* **ownership:** reconcile abandoned claims with fenced audit-first release ([#1254](https://github.com/misospace/dispatch/issues/1254)) ([#1344](https://github.com/misospace/dispatch/issues/1344)) ([530876a](https://github.com/misospace/dispatch/commit/530876acfc8d3dff33c37ad4a2baea445c2a2e2c))
* **pr-fix-queue:** adopt the CI-park lifecycle routes (cipark / cireserve / cirepair) ([#1422](https://github.com/misospace/dispatch/issues/1422)) ([4b7db55](https://github.com/misospace/dispatch/commit/4b7db55aef8e29a368ae95d88368ed56697e18b6))
* **pr-fix-queue:** mechanical rebase lane for DIRTY PRs ([#1327](https://github.com/misospace/dispatch/issues/1327)) ([#1356](https://github.com/misospace/dispatch/issues/1356)) ([72f1004](https://github.com/misospace/dispatch/commit/72f1004b416a3575be7297c52bf7d3b559bd7cec))
* **pr-fix-queue:** recover dead acknowledged hand-outs in single-agent lanes ([#1419](https://github.com/misospace/dispatch/issues/1419)) ([7370538](https://github.com/misospace/dispatch/commit/7370538cd05b85249a1c26fdb0a706f80bb9d160))
* **pr-fix-queue:** recover dead acknowledged hand-outs in single-agent lanes ([#1419](https://github.com/misospace/dispatch/issues/1419)) ([413e045](https://github.com/misospace/dispatch/commit/413e0452b8bf9bc6977222c107a83ce1ee6165c9))
* **pr-fix:** reactivate on fresh feedback with bounded reconciliation ([#1253](https://github.com/misospace/dispatch/issues/1253)) ([#1304](https://github.com/misospace/dispatch/issues/1304)) ([a75d8b8](https://github.com/misospace/dispatch/commit/a75d8b86bf5c1995efe607d9f0110537486cf75f))
* **rate-limit:** throttle mutating endpoints still unthrottled after [#1307](https://github.com/misospace/dispatch/issues/1307) ([#1323](https://github.com/misospace/dispatch/issues/1323)) ([#1346](https://github.com/misospace/dispatch/issues/1346)) ([25db384](https://github.com/misospace/dispatch/commit/25db38480ea7fb017350b933916330d542423178))


### Bug Fixes

* **agent-work:** checkpoint selects current claim's work via shared ordering rule ([#1328](https://github.com/misospace/dispatch/issues/1328)) ([#1330](https://github.com/misospace/dispatch/issues/1330)) ([2bcd8cb](https://github.com/misospace/dispatch/commit/2bcd8cbc8f111775a87d410d3c474496d23f0ab0))
* **agent-work:** close the re-read-to-delete lease window with a post-consume verification abort ([#1390](https://github.com/misospace/dispatch/issues/1390)) ([e783104](https://github.com/misospace/dispatch/commit/e783104c5f0293fd833aa4721c928c4e8fb54bca))
* **agent-work:** commit old-owner lease teardown with the row move; never wedge a reassign guard ([#1407](https://github.com/misospace/dispatch/issues/1407) review) ([b1c5b5c](https://github.com/misospace/dispatch/commit/b1c5b5c73c4651ea55f9a0664c379f65f3c31b73))
* **agent-work:** drop the released owner from the repair mirror and the minted receipt on a failed label add ([#1407](https://github.com/misospace/dispatch/issues/1407) review) ([b0bb020](https://github.com/misospace/dispatch/commit/b0bb020970397983dea12cbcbfbfaf4cc6386315))
* **agent-work:** exclude the renewed receipt from the in-tx old-owner lease teardown ([#1407](https://github.com/misospace/dispatch/issues/1407) review round 2) ([68749e7](https://github.com/misospace/dispatch/commit/68749e7cc8b8a8fef412cf373baeb90e80707634))
* **agent-work:** finish selects current claim's work via shared ordering rule ([#1331](https://github.com/misospace/dispatch/issues/1331)) ([#1351](https://github.com/misospace/dispatch/issues/1351)) ([50e22b6](https://github.com/misospace/dispatch/commit/50e22b6cdedb267df0f24726ee51509d5b5855bb))
* **agent-work:** key the same-owner replay's release evidence apart from the surviving epoch ([#1407](https://github.com/misospace/dispatch/issues/1407) review round 3) ([339fa90](https://github.com/misospace/dispatch/commit/339fa9023d95e0d2619179ecfea79f88526becaf))
* **agent-work:** move the claim (lease row + agent label) to the new owner on an operator reassign ([#1395](https://github.com/misospace/dispatch/issues/1395)) ([56cac40](https://github.com/misospace/dispatch/commit/56cac40707a963b807a1154963cbb27ee41a4b8f))
* **agent-work:** move the claim (lease row + agent label) to the new owner on an operator reassign ([#1395](https://github.com/misospace/dispatch/issues/1395)) ([8805d14](https://github.com/misospace/dispatch/commit/8805d142c4e04c68c0988efa82da87513b67e746))
* **agent-work:** narrow stale sweep lease release to the marked claim epoch ([#1317](https://github.com/misospace/dispatch/issues/1317)) ([#1319](https://github.com/misospace/dispatch/issues/1319)) ([30d6763](https://github.com/misospace/dispatch/commit/30d67634fc321dffb7a3b249b9c6f7fda8ab78d1))
* **agent-work:** normalize issueId in parseStartAgentWorkInput ([#1355](https://github.com/misospace/dispatch/issues/1355)) ([85a61eb](https://github.com/misospace/dispatch/commit/85a61eb209d8a0b59730cec18790a4507d8e1d34))
* **agent-work:** normalize issueId in parseStartAgentWorkInput ([#1355](https://github.com/misospace/dispatch/issues/1355)) ([912cca8](https://github.com/misospace/dispatch/commit/912cca87190ab657c03d609adf6a60f22b2a912e))
* **agent-work:** preserve stale-AgentWork rows still owed a claim release ([#1350](https://github.com/misospace/dispatch/issues/1350)) ([#1389](https://github.com/misospace/dispatch/issues/1389)) ([29d4168](https://github.com/misospace/dispatch/commit/29d4168e0c87a1ca02bcf733ce2baacf8e647fb4))
* **agent-work:** re-read the lease set inside the cleanup transaction so a lease taken mid-flight protects the row ([dbb0ab4](https://github.com/misospace/dispatch/commit/dbb0ab452d128213fdbba1eec6dca415e0cb35d4))
* **agent-work:** re-read the lease set inside the cleanup transaction so a lease taken mid-flight protects the row ([#1390](https://github.com/misospace/dispatch/issues/1390)) ([a64224d](https://github.com/misospace/dispatch/commit/a64224d1a4149434b7882fabdb40ca666622a40f))
* **agent-work:** release the old owner's label when the new owner's is already on the issue ([#1407](https://github.com/misospace/dispatch/issues/1407) review) ([f26d433](https://github.com/misospace/dispatch/commit/f26d433259ccf80a08b01aee10e999fbed34c02a))
* **agent-work:** settle the stale-release marker when operator reassign rewrites a sweep-marked row ([#1391](https://github.com/misospace/dispatch/issues/1391)) ([#1393](https://github.com/misospace/dispatch/issues/1393)) ([db41e63](https://github.com/misospace/dispatch/commit/db41e63e60540bf654e47e5906fac153dcd5d040))
* **agent-work:** trim the operator reassign path's workId and newAgentName ([#1406](https://github.com/misospace/dispatch/issues/1406)) ([fc36e10](https://github.com/misospace/dispatch/commit/fc36e10889b617fcab2a9452a60fa8c0085f9bf8))
* **agent-work:** trim the operator reassign path's workId and newAgentName ([#1406](https://github.com/misospace/dispatch/issues/1406)) ([97c68e1](https://github.com/misospace/dispatch/commit/97c68e1f58099bdc562871cd445a2cffa9df1d78))
* **agent-work:** trim the operator release path's agentName, workId and leaseId ([#1402](https://github.com/misospace/dispatch/issues/1402)) ([49baca8](https://github.com/misospace/dispatch/commit/49baca8dfcd86aae2aafbe174a83321605458f68))
* **agent-work:** trim the operator release path's agentName, workId and leaseId ([#1402](https://github.com/misospace/dispatch/issues/1402)) ([#1405](https://github.com/misospace/dispatch/issues/1405)) ([d177d70](https://github.com/misospace/dispatch/commit/d177d702d55d273bfbe981f5fac4a3b37b161eaa))
* **agent-work:** trim the operator release path's issueId ([#1399](https://github.com/misospace/dispatch/issues/1399)) ([fc82dec](https://github.com/misospace/dispatch/commit/fc82dec6bc76c1db114f4d22e5ebcab6f37024f7))
* **agent-work:** trim the operator release path's issueId ([#1399](https://github.com/misospace/dispatch/issues/1399)) ([#1401](https://github.com/misospace/dispatch/issues/1401)) ([b1b9afb](https://github.com/misospace/dispatch/commit/b1b9afbaeed6ebef1ecb5e7501ff292f3a2d41a5))
* **agent-work:** use the error instanceof Error convention in audit writes ([1d315ca](https://github.com/misospace/dispatch/commit/1d315ca37f2789ae0202df1e55fab07109abc81d))
* **api:** clamp and validate limit query param on list endpoints ([#1308](https://github.com/misospace/dispatch/issues/1308)) ([#1378](https://github.com/misospace/dispatch/issues/1378)) ([c475b26](https://github.com/misospace/dispatch/commit/c475b262fd6e1bdb5871f8b429f50f3e34b1e323))
* **api:** remove deprecated POST /api/repos compatibility endpoint ([#1310](https://github.com/misospace/dispatch/issues/1310)) ([#1382](https://github.com/misospace/dispatch/issues/1382)) ([b584d4b](https://github.com/misospace/dispatch/commit/b584d4b4191421d100d6ef7b2ed4ffa2f4d2c723))
* **auth:** derive rate-limit keys from the credential, not x-agent-name ([#1322](https://github.com/misospace/dispatch/issues/1322)) ([#1338](https://github.com/misospace/dispatch/issues/1338)) ([d2366a6](https://github.com/misospace/dispatch/commit/d2366a687c9501efe7e93fbbf9126bfd21da4712))
* **automation-sync:** persist merged PRs so the lifecycle backfill has an authoritative merge time ([#1320](https://github.com/misospace/dispatch/issues/1320)) ([504c987](https://github.com/misospace/dispatch/commit/504c9878a1d69260dc50984de46b5222cca0d62f))
* **automation-sync:** refresh closed-unmerged PR rows to state closed ([#1321](https://github.com/misospace/dispatch/issues/1321)) ([313bc5a](https://github.com/misospace/dispatch/commit/313bc5a773a33569d779ce80d4aea89536e0324a))
* **automation-sync:** refresh closed-unmerged PR rows to state closed ([#1321](https://github.com/misospace/dispatch/issues/1321)) ([5be26a2](https://github.com/misospace/dispatch/commit/5be26a2add0fa143cf5c2bb1ed51e211428fb943))
* **automation:** reject partially numeric runId with strict whole-string validation ([#1379](https://github.com/misospace/dispatch/issues/1379)) ([52f7096](https://github.com/misospace/dispatch/commit/52f7096427b0169cb3cf066632f02d3e94d3e888))
* **automation:** surface failed rerun responses on repo detail page ([#1388](https://github.com/misospace/dispatch/issues/1388)) ([#1396](https://github.com/misospace/dispatch/issues/1396)) ([8af9e5c](https://github.com/misospace/dispatch/commit/8af9e5c165d0f26ce0f4356831336ae8ffee9a31))
* **automation:** surface failed sync responses on repo detail page ([f1adeca](https://github.com/misospace/dispatch/commit/f1adeca7c2db1c718c1195f92c8baccf5b2ad2f9))
* **automation:** surface failed sync responses on repo detail page ([#1385](https://github.com/misospace/dispatch/issues/1385)) ([05126ab](https://github.com/misospace/dispatch/commit/05126ab2d589fd1e8c6a174c0e8f2d72e961045e))
* **automation:** surface failed/in-progress per-repo sync responses ([#1324](https://github.com/misospace/dispatch/issues/1324)) ([#1384](https://github.com/misospace/dispatch/issues/1384)) ([0afd7a5](https://github.com/misospace/dispatch/commit/0afd7a5e9b3abf94ff0257314f645f15931db108))
* **claim:** return retryable 503 when the stale-work cleanup aborts, keeping the guard releasable ([#1390](https://github.com/misospace/dispatch/issues/1390)) ([74dbece](https://github.com/misospace/dispatch/commit/74dbece42fa63829f4d91e9db9a1d103ab8324fc))
* **claim:** trim the operator-supplied agentName before persisting ([#1412](https://github.com/misospace/dispatch/issues/1412)) ([#1416](https://github.com/misospace/dispatch/issues/1416)) ([a64cd3f](https://github.com/misospace/dispatch/commit/a64cd3fc67a668a9967fbcde183c1520a2256410))
* **deps:** clear last prod advisory and pin advisory ranges ([#1386](https://github.com/misospace/dispatch/issues/1386)) ([1bbf37a](https://github.com/misospace/dispatch/commit/1bbf37ac848c28944170b819963b4568c83b0d0d))
* **deps:** clear last prod advisory and pin advisory ranges ([#1386](https://github.com/misospace/dispatch/issues/1386)) ([9e54221](https://github.com/misospace/dispatch/commit/9e54221d2eff43d89adbe7250e9d1de846922bd9))
* **deps:** update dependency @modelcontextprotocol/sdk (1.32.1 → 1.32.2) ([#1380](https://github.com/misospace/dispatch/issues/1380)) ([f32b639](https://github.com/misospace/dispatch/commit/f32b6390fb6c31243f102782f61911bd5c5ea5aa))
* **deps:** update dependency astro (7.4.0 → 7.4.1) ([#1311](https://github.com/misospace/dispatch/issues/1311)) ([049ec4b](https://github.com/misospace/dispatch/commit/049ec4b6702a1fcf74478bf85a167d25fd6ec842))
* **deps:** update dependency astro (7.4.1 → 7.4.2) ([#1339](https://github.com/misospace/dispatch/issues/1339)) ([2725802](https://github.com/misospace/dispatch/commit/272580200d585f79ad6b646a1a8453c0afa38567))
* **deps:** update nextjs monorepo (16.4.2 → 16.4.3) ([#1364](https://github.com/misospace/dispatch/issues/1364)) ([3c62510](https://github.com/misospace/dispatch/commit/3c6251077535b0ffff3086b0cb8d5f134573e4e1))
* **groomer:** clamp issueNumber query param so bad input cannot 500 ([#1379](https://github.com/misospace/dispatch/issues/1379)) ([16a205f](https://github.com/misospace/dispatch/commit/16a205fba6ace4802a787be61ec50d2bca946d12))
* **groomer:** clamp issueNumber query param so bad input cannot 500 ([#1379](https://github.com/misospace/dispatch/issues/1379)) ([c9840a2](https://github.com/misospace/dispatch/commit/c9840a235dd803a4c6e190fc699c603f7f347aa4))
* **groomer:** fence the lease release on the exact acquired receipt (CAS) ([4bdbc86](https://github.com/misospace/dispatch/commit/4bdbc86d988205e6c3c1006500e857810013cf96))
* **groomer:** release only a lease row the hosted groomer minted ([e5e7d72](https://github.com/misospace/dispatch/commit/e5e7d72374df4d83bbef99f7b94655c5e4a541d6))
* **groomer:** release only a lease row the hosted groomer minted ([d3e96d7](https://github.com/misospace/dispatch/commit/d3e96d7171d3dbc735d30eb0d5b7ac5a8367bf8c)), closes [#1362](https://github.com/misospace/dispatch/issues/1362)
* **groomer:** sanitize repository-context warnings before they reach GroomingRun.contextWarnings ([#1353](https://github.com/misospace/dispatch/issues/1353)) ([5883234](https://github.com/misospace/dispatch/commit/5883234741579ea5f3520be66558e31337dc60f2)), closes [#1297](https://github.com/misospace/dispatch/issues/1297)
* **guard:** re-stamp the guard row at commit so a long fenced region cannot look stealable ([#1367](https://github.com/misospace/dispatch/issues/1367)) ([323341c](https://github.com/misospace/dispatch/commit/323341ca2f2be2e5d16e0b890386084d4a4f880b))
* **issues:** durable idempotent replay of completed issue capacity handoffs ([#1262](https://github.com/misospace/dispatch/issues/1262)) ([#1295](https://github.com/misospace/dispatch/issues/1295)) ([f1ff7c8](https://github.com/misospace/dispatch/commit/f1ff7c86030403b8fa76e75a8b9b374559335532))
* **lifecycle:** agent-aware run attribution and normalized pr-fix read ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([02a2a1d](https://github.com/misospace/dispatch/commit/02a2a1d2875cb22edacdea0a11506151d07ed9db))
* **lifecycle:** derive attempt id from the claim's dedupe identity ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([554e214](https://github.com/misospace/dispatch/commit/554e214c53847b7a172c77dffbfc1dd35555ed4f))
* **lifecycle:** deterministic tiebreaker on the bounded pr-fix history read ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([aeb2774](https://github.com/misospace/dispatch/commit/aeb27746a5909aaa04e13bbe8f7789ab6b073f5d))
* **lifecycle:** gate fix-round stamp on implementing outcomes; note out-of-range generations ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([c33489f](https://github.com/misospace/dispatch/commit/c33489f18e5e8bc11bbb8b34a1fe81b80773d4fe))
* **lifecycle:** merge a fact's evidence across its observations ([#1183](https://github.com/misospace/dispatch/issues/1183)) ([bd596bd](https://github.com/misospace/dispatch/commit/bd596bd3b86f36959bed8522fc418838237b9b5f))
* **next-task:** the REBASE lane gate follows hand-out ownership, not a clock ([#1327](https://github.com/misospace/dispatch/issues/1327)) ([#1426](https://github.com/misospace/dispatch/issues/1426)) ([fde202f](https://github.com/misospace/dispatch/commit/fde202fdd193e9cce23baaeb81aabc4509db91de))
* **ownership:** a blocked park owns its row's lease expiry so the stale sweep cannot reclaim it ([#1316](https://github.com/misospace/dispatch/issues/1316)) ([#1335](https://github.com/misospace/dispatch/issues/1335)) ([bb8530b](https://github.com/misospace/dispatch/commit/bb8530b9e2df19ba7b00641f7d85fe0202384bbd))
* **ownership:** align per-issue lease selection with the scan's activity key ([#1312](https://github.com/misospace/dispatch/issues/1312)) ([#1354](https://github.com/misospace/dispatch/issues/1354)) ([482cafe](https://github.com/misospace/dispatch/commit/482cafeb951aa1cd313cc93413b7312b387b3bc5))
* **ownership:** fold repo casing in the ownership-inspect pr-fix read ([#1357](https://github.com/misospace/dispatch/issues/1357)) ([#1371](https://github.com/misospace/dispatch/issues/1371)) ([1227ace](https://github.com/misospace/dispatch/commit/1227acee56f2b6f7253b658ce0485d9696978666))
* **ownership:** fold repo casing in the ownership-reconciliation pr-fix reads ([#1370](https://github.com/misospace/dispatch/issues/1370)) ([#1373](https://github.com/misospace/dispatch/issues/1373)) ([65ca72c](https://github.com/misospace/dispatch/commit/65ca72c6e231b0b9328d55febd5d7514b4886b69))
* **ownership:** renew commits its lease CAS and AgentWork liveness write atomically ([#1315](https://github.com/misospace/dispatch/issues/1315)) ([#1336](https://github.com/misospace/dispatch/issues/1336)) ([2ceba56](https://github.com/misospace/dispatch/commit/2ceba56184e4b13f18ebc04e3567fd99cae901a9))
* **pr-fix-queue/ack:** honor maintainer authority for body agentName ([#1425](https://github.com/misospace/dispatch/issues/1425)) ([#1432](https://github.com/misospace/dispatch/issues/1432)) ([7081c2e](https://github.com/misospace/dispatch/commit/7081c2e41175c5dda307bf9f907c25c8a24eedc6))
* **pr-fix-queue/mark:** bind the idempotent WAITING_EXTERNAL replay to the agent that started the wait ([#1430](https://github.com/misospace/dispatch/issues/1430)) ([#1435](https://github.com/misospace/dispatch/issues/1435)) ([a162ce3](https://github.com/misospace/dispatch/commit/a162ce3db3e1fb80d772337071f4bc61f64c1037))
* **pr-fix-queue/mark:** scope worker-tier marks to the hand-out holder ([#1428](https://github.com/misospace/dispatch/issues/1428)) ([#1431](https://github.com/misospace/dispatch/issues/1431)) ([ea8e9ff](https://github.com/misospace/dispatch/commit/ea8e9ff29612ead0feea0acbe21f42aef02eab76))
* **pr-fix:** address review minors on the fenced-only hand-out release ([#1340](https://github.com/misospace/dispatch/issues/1340)) ([35688f1](https://github.com/misospace/dispatch/commit/35688f1de91a510e671fd3f2e19cb4935292fd98))
* **pr-fix:** CAS-pin the hand-out release and cover skipped settlements ([#1340](https://github.com/misospace/dispatch/issues/1340) review) ([f81c101](https://github.com/misospace/dispatch/commit/f81c101b13525714f93dc47382b5659394f9cfe5))
* **pr-fix:** fence the settled hand-out release to the issued receipt token ([#1340](https://github.com/misospace/dispatch/issues/1340) review) ([7a0e8e6](https://github.com/misospace/dispatch/commit/7a0e8e6768680762085eef5e665b6e432426ded4))
* **pr-fix:** fold repo casing in the reconcileStalePrFixItems read ([#1372](https://github.com/misospace/dispatch/issues/1372)) ([#1376](https://github.com/misospace/dispatch/issues/1376)) ([dd9cb26](https://github.com/misospace/dispatch/commit/dd9cb26a96bd1d62f3a0acef6ae6e3f4eb970a1a))
* **pr-fix:** require the echoed handout token to release a settled hand-out ([#1340](https://github.com/misospace/dispatch/issues/1340) review) ([4630b29](https://github.com/misospace/dispatch/commit/4630b29b1a1a1fcbdb95b6a43a5b6d6b945dad62))
* **pr-fix:** restrict [#940](https://github.com/misospace/dispatch/issues/940) stale-FIXED reopen to actionable evidence versions ([#1303](https://github.com/misospace/dispatch/issues/1303)) ([#1314](https://github.com/misospace/dispatch/issues/1314)) ([b589fe4](https://github.com/misospace/dispatch/commit/b589fe430238f7fe6ad4ac8de77770c970740dd4))
* **pr-fix:** settle worker-reported needs-human endings and release settled hand-outs ([#1340](https://github.com/misospace/dispatch/issues/1340)) ([245ed24](https://github.com/misospace/dispatch/commit/245ed240c146b444884b31ce0b362663bb5f8f72))
* **pr-fix:** settle worker-reported needs-human endings and release settled hand-outs ([#1340](https://github.com/misospace/dispatch/issues/1340)) ([bdf48ad](https://github.com/misospace/dispatch/commit/bdf48ad7b15776c061e04210e59265518cf3a6b1))
* **query-limit:** reject partially numeric query parameters ([154514b](https://github.com/misospace/dispatch/commit/154514b78f20dd5a907ba3080d47bc961ce11ff6))
* **rate-limit:** throttle the remaining mutating POST routes ([#1307](https://github.com/misospace/dispatch/issues/1307)) ([#1325](https://github.com/misospace/dispatch/issues/1325)) ([61c5447](https://github.com/misospace/dispatch/commit/61c544745deb40e1c6cd4a338f109023210f1325))
* **review:** enable specialist Anthropic effort support ([#1352](https://github.com/misospace/dispatch/issues/1352)) ([e0aa13b](https://github.com/misospace/dispatch/commit/e0aa13bfaaddc5f0bfa7402e5b74ca81678bab8a))
* **stale-sweep:** retry arm refuses a same-agent re-claim that postdates the mark ([#1359](https://github.com/misospace/dispatch/issues/1359)) ([#1365](https://github.com/misospace/dispatch/issues/1365)) ([9178cdb](https://github.com/misospace/dispatch/commit/9178cdbec127b834419c499804de5edd0cf96b37))
* **stale-work:** live execution lease shields workers from heartbeat-silence reclaim ([#1418](https://github.com/misospace/dispatch/issues/1418)) ([#1429](https://github.com/misospace/dispatch/issues/1429)) ([d6f04fa](https://github.com/misospace/dispatch/commit/d6f04faffc7dcb6c9e0d16eabe12f48e7a8cdf6e))
* **unassign:** base the unassign label set on live GitHub labels instead of the cached row ([#1377](https://github.com/misospace/dispatch/issues/1377)) ([6fd6613](https://github.com/misospace/dispatch/commit/6fd6613eeaf01289ecfcffeb9d9694bb0e12bb0c))
* **unassign:** fence the remote label write in POST /api/issues/unassign ([#1361](https://github.com/misospace/dispatch/issues/1361)) ([#1368](https://github.com/misospace/dispatch/issues/1368)) ([60eb0d2](https://github.com/misospace/dispatch/commit/60eb0d29fcca6fcd90d32efb4f941d7b9babb377))
* **unclaim:** anchor the remote agent-label release under the per-issue mutation guard ([#1367](https://github.com/misospace/dispatch/issues/1367)) ([9a8800e](https://github.com/misospace/dispatch/commit/9a8800eac762f004b907310181c7527f8dd74e4d))
* **unclaim:** anchor the remote agent-label release under the per-issue mutation guard ([#1367](https://github.com/misospace/dispatch/issues/1367)) ([3b7c6e0](https://github.com/misospace/dispatch/commit/3b7c6e04b178a3a233a66d2f3e129719f414586a))
* **unclaim:** derive the fenced region budget from the observed label set ([#1367](https://github.com/misospace/dispatch/issues/1367)) ([cb2e15e](https://github.com/misospace/dispatch/commit/cb2e15e88aaec45d4e5f0c8dc915356698fe79c8))
* **untriaged:** cap the untriaged intake list in the query ([#1309](https://github.com/misospace/dispatch/issues/1309)) ([#1381](https://github.com/misospace/dispatch/issues/1381)) ([2e9a5d1](https://github.com/misospace/dispatch/commit/2e9a5d1902c34ac27c625114e2f8c23e229c4828))


### Chores

* **agent-work:** collapse the duplicated operator identifier normalizers ([#1413](https://github.com/misospace/dispatch/issues/1413)) ([775c257](https://github.com/misospace/dispatch/commit/775c2579c51e6bccf203e4f871160dbc2119b81a))
* **agent-work:** collapse the duplicated operator identifier normalizers ([#1413](https://github.com/misospace/dispatch/issues/1413)) ([41923cb](https://github.com/misospace/dispatch/commit/41923cb2252597001888a84986c39ebf9fb15748))
* **audit:** dedupe the reconciler's per-pass annotations ([#1363](https://github.com/misospace/dispatch/issues/1363)) ([29c8b28](https://github.com/misospace/dispatch/commit/29c8b2818e59fa6d01fefbfce49187256a2064f1))
* **audit:** dedupe the reconciler's per-pass annotations ([#1363](https://github.com/misospace/dispatch/issues/1363)) ([d604040](https://github.com/misospace/dispatch/commit/d6040409aa3a99746d618436448ef5149f377ca8))
* **deps:** lock file maintenance ([#1306](https://github.com/misospace/dispatch/issues/1306)) ([f9a381b](https://github.com/misospace/dispatch/commit/f9a381bac8564467b823902b2273b3a83bf54798))
* **deps:** refresh lock within ranges to clear npm audit gate ([71520e8](https://github.com/misospace/dispatch/commit/71520e85f7057d68d89fcf63fec7636d39cfba20))
* **dev:** add reproducible Node development bootstrap ([#1337](https://github.com/misospace/dispatch/issues/1337)) ([c69e53e](https://github.com/misospace/dispatch/commit/c69e53e683ceb7ed410f1dad8fb4a2103ebd221d))
* **pr-fix:** normalize operator-chain indentation in the evidence test fake ([#1340](https://github.com/misospace/dispatch/issues/1340) review) ([7315a67](https://github.com/misospace/dispatch/commit/7315a679a047a00b28208a0b206b1244c446800c))


### Documentation

* **agent-work:** state the same-owner replay exception in the epoch-key comment ([#1407](https://github.com/misospace/dispatch/issues/1407) review round 2, minor) ([95a0c7f](https://github.com/misospace/dispatch/commit/95a0c7ff342088672040988c6f2e273985755f3b))
* **groomer:** document the TTL-bounded recovery of a left-renewed lease ([f852ace](https://github.com/misospace/dispatch/commit/f852acea139605ada1cce118c4f663625d7d6c53))
* **pr-fix:** align releaseAgentHandout fencing JSDoc indentation ([#1340](https://github.com/misospace/dispatch/issues/1340) review minor) ([3ed45e5](https://github.com/misospace/dispatch/commit/3ed45e55abf0f92092662f36e4fad27d96961600))


### Styles

* **groomer:** reflow fence comment and align test-mock indent ([433f7c1](https://github.com/misospace/dispatch/commit/433f7c171abeca99fe9d99936ab35ff5953ee100))


### Refactors

* **pr-fix-surfacing:** share surface plumbing across blocked/parked/unblock notices ([#1358](https://github.com/misospace/dispatch/issues/1358)) ([c28571c](https://github.com/misospace/dispatch/commit/c28571c245c5ad7528a52b6fc8529d6b72c03d67))

## [0.5.71](https://github.com/misospace/dispatch/compare/v0.5.70...v0.5.71) (2026-10-18)


### Features

* **deps:** update dependency astro (5.18.2 → 7.4.0) ([#1281](https://github.com/misospace/dispatch/issues/1281)) ([f548ef8](https://github.com/misospace/dispatch/commit/f548ef8423af4fc33533fb40fbdd6e42c4ac2139))
* **deps:** update dependency eslint (10.12.0 → 10.13.0) ([#1288](https://github.com/misospace/dispatch/issues/1288)) ([89b6f22](https://github.com/misospace/dispatch/commit/89b6f22fd4d9060e5d8891c091aa50995b11c496))
* **deps:** update dependency lucide-react (1.57.0 → 1.58.0) ([#1284](https://github.com/misospace/dispatch/issues/1284)) ([a5f3305](https://github.com/misospace/dispatch/commit/a5f33059568f8c735449e204142ad4fc958ad144))
* **deps:** update dependency lucide-react (1.58.0 → 1.59.0) ([#1290](https://github.com/misospace/dispatch/issues/1290)) ([91a78b4](https://github.com/misospace/dispatch/commit/91a78b479f1eb7a31ced278d363dffba5246a381))
* **pr-fix:** persist authoritative evidence versions and attempt-snapshot freshness ([#1249](https://github.com/misospace/dispatch/issues/1249)) ([#1276](https://github.com/misospace/dispatch/issues/1276)) ([d292094](https://github.com/misospace/dispatch/commit/d2920948ce2c54bcaec5992fdb49eee89216978e))
* **pr-fix:** structured external-wait dependency contract and fail-closed holds ([#1273](https://github.com/misospace/dispatch/issues/1273)) ([ef4feaa](https://github.com/misospace/dispatch/commit/ef4feaa4df892960a6371e1d536de7417b4cb43b))
* **review:** adopt repository skills and v3.6.0 ([#1301](https://github.com/misospace/dispatch/issues/1301)) ([b093bbd](https://github.com/misospace/dispatch/commit/b093bbd616c47261eeae99ac9b400d8782f2967a))


### Bug Fixes

* **api:** reject status transitions on closed issues in POST /api/issues/status ([#1285](https://github.com/misospace/dispatch/issues/1285)) ([d4e532a](https://github.com/misospace/dispatch/commit/d4e532a0abca10756e3bd2003d8b5817a3cb9698)), closes [#1206](https://github.com/misospace/dispatch/issues/1206)
* **auth:** accept pkcs1 github app keys ([#1302](https://github.com/misospace/dispatch/issues/1302)) ([5bce482](https://github.com/misospace/dispatch/commit/5bce482e9f5393aca63aa7a5aa9a0d8ea8f8e643))
* **ci:** isolate external-wait queue assertions ([#1283](https://github.com/misospace/dispatch/issues/1283)) ([c2ea489](https://github.com/misospace/dispatch/commit/c2ea489aea6d71c127ab05f0ee4b0f29a529a26c))
* **deps:** update dependency @prisma/adapter-pg (7.10.0 → 7.10.1) ([#1267](https://github.com/misospace/dispatch/issues/1267)) ([8f7284c](https://github.com/misospace/dispatch/commit/8f7284cdea42642bccd4bdb6fdc092c8ba345b65))
* **deps:** update dependency @prisma/client (7.10.0 → 7.10.1) ([#1268](https://github.com/misospace/dispatch/issues/1268)) ([24ee983](https://github.com/misospace/dispatch/commit/24ee9837a13008d467b0e6cb925b8cbcebe608b2))
* **deps:** update dependency jsdom (30.1.2 → 30.1.3) ([#1264](https://github.com/misospace/dispatch/issues/1264)) ([f8d8537](https://github.com/misospace/dispatch/commit/f8d853730482a6ccc6d52ca4a6068f75446b5096))
* **deps:** update dependency prisma (7.10.0 → 7.10.1) ([#1269](https://github.com/misospace/dispatch/issues/1269)) ([270ac1a](https://github.com/misospace/dispatch/commit/270ac1ac7bc62ae14f5efad73eae70cc682ed2a9))
* **deps:** update nextjs monorepo (16.4.1 → 16.4.2) ([#1272](https://github.com/misospace/dispatch/issues/1272)) ([4132528](https://github.com/misospace/dispatch/commit/4132528ea64b78d355824fc030ea4fa562435b59))
* **deps:** update vitest monorepo (5.0.4 → 5.0.5) ([#1265](https://github.com/misospace/dispatch/issues/1265)) ([0021632](https://github.com/misospace/dispatch/commit/00216329deb0c0f4087f4f992fba045c5667fd6a))
* **groomer:** sanitize evidence-snapshot errorMessage so captured GitHub warnings cannot carry control bytes ([#1298](https://github.com/misospace/dispatch/issues/1298)) ([3aa0d58](https://github.com/misospace/dispatch/commit/3aa0d58daa97a7eca647688796026818edf2f99c))
* **issues:** reject status transitions on closed issues in move and legacy groom ([#1286](https://github.com/misospace/dispatch/issues/1286)) ([#1292](https://github.com/misospace/dispatch/issues/1292)) ([aa5fd8e](https://github.com/misospace/dispatch/commit/aa5fd8eab969337b05ed2fc796b7945d997c5018))
* **test:** pin PR-fix comment footer clock and drop brittle 99 guard ([#1257](https://github.com/misospace/dispatch/issues/1257)) ([#1271](https://github.com/misospace/dispatch/issues/1271)) ([572d2fa](https://github.com/misospace/dispatch/commit/572d2fa2b9a418631d7b4b73cc9ca9a65f71b163))
* **webhook:** guard issue-label cache writes with compare-and-swap ([#1220](https://github.com/misospace/dispatch/issues/1220)) ([#1266](https://github.com/misospace/dispatch/issues/1266)) ([1b4b976](https://github.com/misospace/dispatch/commit/1b4b976b68c0672be3bd640b269c8e9894d9c02f))


### Chores

* **ci:** disable experimental requirement tracing ([#1289](https://github.com/misospace/dispatch/issues/1289)) ([c50c838](https://github.com/misospace/dispatch/commit/c50c838578d23c22f3bb223d720d1fb80c594d2e))


### Documentation

* **recovery:** design PR-fix reactivation on fresh evidence ([#1244](https://github.com/misospace/dispatch/issues/1244)) ([#1248](https://github.com/misospace/dispatch/issues/1248)) ([bce947c](https://github.com/misospace/dispatch/commit/bce947c950416189d3bf13337fb8d298deb845b3))

## [0.5.70](https://github.com/misospace/dispatch/compare/v0.5.69...v0.5.70) (2026-10-14)


### Features

* **deps:** update dependency lucide-react (1.55.0 → 1.56.0) ([#1241](https://github.com/misospace/dispatch/issues/1241)) ([e50a0ee](https://github.com/misospace/dispatch/commit/e50a0ee9c6df1b1962d1c8992273121b42d728bc))
* **deps:** update dependency lucide-react (1.56.0 → 1.57.0) ([#1258](https://github.com/misospace/dispatch/issues/1258)) ([384ca59](https://github.com/misospace/dispatch/commit/384ca5967b6813824bcc93acd05dee1c7905640d))
* **lifecycle:** persist idempotent claim and status transition evidence ([#1202](https://github.com/misospace/dispatch/issues/1202)) ([#1247](https://github.com/misospace/dispatch/issues/1247)) ([bcae9a0](https://github.com/misospace/dispatch/commit/bcae9a0b0dbf70e73b5e1f894ccc710f9ceb2db0))
* **recovery:** add fenced capacity-exhaustion handoffs ([#1259](https://github.com/misospace/dispatch/issues/1259)) ([d2786d2](https://github.com/misospace/dispatch/commit/d2786d2555392daff2ac9f5b8775f2e68e78c317))


### Bug Fixes

* **deps:** update dependency @testing-library/user-event (14.6.7 → 14.6.8) ([#1242](https://github.com/misospace/dispatch/issues/1242)) ([caf1467](https://github.com/misospace/dispatch/commit/caf1467b60aba77c122b263c3732d48888958e17))
* **deps:** update nextjs monorepo (16.4.0 → 16.4.1) ([#1261](https://github.com/misospace/dispatch/issues/1261)) ([b8141b4](https://github.com/misospace/dispatch/commit/b8141b4e0c916ca714a04e9f963ea56064323af9))
* **deps:** update react monorepo (19.3.0 → 19.3.1) ([#1260](https://github.com/misospace/dispatch/issues/1260)) ([250d651](https://github.com/misospace/dispatch/commit/250d651ed1640c53768bf0d38089a9dd947211a7))
* **dockerfile:** parse FROM --platform flag in splitIntoStages ([#1178](https://github.com/misospace/dispatch/issues/1178)) ([#1240](https://github.com/misospace/dispatch/issues/1240)) ([a8fd35e](https://github.com/misospace/dispatch/commit/a8fd35e27ca678ffce34eed4ca0fba8cd51c3cec))


### Documentation

* **observability:** standalone portable observability design ([#1237](https://github.com/misospace/dispatch/issues/1237)) ([#1239](https://github.com/misospace/dispatch/issues/1239)) ([941f426](https://github.com/misospace/dispatch/commit/941f426d497e925bfa1eafdb61bcc893fd9eafac))
* **recovery:** ownership reconciliation design ([#1245](https://github.com/misospace/dispatch/issues/1245)) ([#1246](https://github.com/misospace/dispatch/issues/1246)) ([3894ab1](https://github.com/misospace/dispatch/commit/3894ab11ecc249c987b92da043b3298afca58be3))

## [0.5.69](https://github.com/misospace/dispatch/compare/v0.5.68...v0.5.69) (2026-10-12)


### Features

* **auth:** bind worker bearer tokens to agent names ([#1129](https://github.com/misospace/dispatch/issues/1129)) ([#1207](https://github.com/misospace/dispatch/issues/1207)) ([616dbd1](https://github.com/misospace/dispatch/commit/616dbd1e220abdf6b75b178e54f023a7577c0790))
* **deps:** update dependency @radix-ui/react-slot (1.4.0 → 1.5.0) ([#1228](https://github.com/misospace/dispatch/issues/1228)) ([38ca2c7](https://github.com/misospace/dispatch/commit/38ca2c76574e238b24bac7a2499daa5771fafb9d))
* **deps:** update dependency lucide-react (1.52.0 → 1.53.0) ([#1196](https://github.com/misospace/dispatch/issues/1196)) ([99c93f5](https://github.com/misospace/dispatch/commit/99c93f52953b3bcdd7c1c5d27064dfc1d06e6cb9))
* **deps:** update dependency lucide-react (1.53.0 → 1.54.0) ([#1208](https://github.com/misospace/dispatch/issues/1208)) ([7ee3e66](https://github.com/misospace/dispatch/commit/7ee3e66d77d1804738dea269a96b59eb82efbf9c))
* **deps:** update dependency lucide-react (1.54.0 → 1.55.0) ([#1213](https://github.com/misospace/dispatch/issues/1213)) ([ab41eac](https://github.com/misospace/dispatch/commit/ab41eacdc64bb835ba277328019226b25a644b71))
* **helm:** update chart common (5.2.1 → 5.3.0) ([#1216](https://github.com/misospace/dispatch/issues/1216)) ([3c61ef8](https://github.com/misospace/dispatch/commit/3c61ef8a35fe33d41887d8c2f9116f12232a643e))
* **pr-fix:** accept external waits without charging fix attempts ([#1233](https://github.com/misospace/dispatch/issues/1233)) ([6888ff3](https://github.com/misospace/dispatch/commit/6888ff30f828331a9a2a52f21f6f194e73419f5d))
* **report:** accept already_done that closes an issue via the close policy ([#1143](https://github.com/misospace/dispatch/issues/1143)) ([#1219](https://github.com/misospace/dispatch/issues/1219)) ([7ae2b38](https://github.com/misospace/dispatch/commit/7ae2b380df519dd9cbd77b993153a05054c62940))


### Bug Fixes

* **deps:** update dependency @types/node (24.19.1 → 24.19.2) ([#1209](https://github.com/misospace/dispatch/issues/1209)) ([7ae16a4](https://github.com/misospace/dispatch/commit/7ae16a4eda80454242d51d0cf97dc5cd63cefe33))
* **deps:** update dependency zod (4.6.5 → 4.6.6) ([#1223](https://github.com/misospace/dispatch/issues/1223)) ([f1a3058](https://github.com/misospace/dispatch/commit/f1a305833eaf8c6fc31dc60e54304eff0f34aa97))
* **deps:** update dependency zod (4.6.6 → 4.6.7) ([#1234](https://github.com/misospace/dispatch/issues/1234)) ([9d59419](https://github.com/misospace/dispatch/commit/9d594191f1c660675f4f47d73a68d86d609f7fcc))
* **deps:** update vitest monorepo (5.0.3 → 5.0.4) ([#1232](https://github.com/misospace/dispatch/issues/1232)) ([b5f69da](https://github.com/misospace/dispatch/commit/b5f69da9b42c2a2d952dc64e8095bc00b2e2703a))
* **dispatch:** retire external groom task dispatch ([#1200](https://github.com/misospace/dispatch/issues/1200)) ([#1201](https://github.com/misospace/dispatch/issues/1201)) ([e7ac005](https://github.com/misospace/dispatch/commit/e7ac005243810534d1ac24a0a2d5b338d512120f))
* **groomer:** gate contributor-facing replies to external users ([#1198](https://github.com/misospace/dispatch/issues/1198)) ([#1199](https://github.com/misospace/dispatch/issues/1199)) ([b42cecf](https://github.com/misospace/dispatch/commit/b42cecfbe291091edaf5b20c9c50dbe01a44a5fb))
* **groomer:** guard already_done closes against reopen/regression evidence ([#1204](https://github.com/misospace/dispatch/issues/1204)) ([89e1b78](https://github.com/misospace/dispatch/commit/89e1b78413a440b87530eb6b4eb6f1f30d96a783))
* **groomer:** sanitize GitHub-authored error text at mutation errorMessage helpers ([#1164](https://github.com/misospace/dispatch/issues/1164)) ([#1215](https://github.com/misospace/dispatch/issues/1215)) ([366edf9](https://github.com/misospace/dispatch/commit/366edf9f14afbe63982c23da357b3eb752865bd8))
* **helm:** decouple liveness from database availability ([#1171](https://github.com/misospace/dispatch/issues/1171)) ([#1235](https://github.com/misospace/dispatch/issues/1235)) ([c8d9b93](https://github.com/misospace/dispatch/commit/c8d9b93a096f7771b2728c6e84d70c07ba21dd2a))
* **pr-fix:** reclaim unacknowledged hand-outs safely ([#1211](https://github.com/misospace/dispatch/issues/1211)) ([#1212](https://github.com/misospace/dispatch/issues/1212)) ([8a9b642](https://github.com/misospace/dispatch/commit/8a9b642420d56359c0ba200a1628b4b6c5b41627))
* **pr-fix:** separate human decisions from retry exhaustion ([#1218](https://github.com/misospace/dispatch/issues/1218)) ([#1221](https://github.com/misospace/dispatch/issues/1221)) ([60c8213](https://github.com/misospace/dispatch/commit/60c821332f75eb68a5f2512d3bbc8078435197ce))
* **pr-fix:** skip explicitly consumed generations ([#1225](https://github.com/misospace/dispatch/issues/1225)) ([#1227](https://github.com/misospace/dispatch/issues/1227)) ([bf090c3](https://github.com/misospace/dispatch/commit/bf090c392855307cdeeae36b6111a64de18a1f43))
* **report:** restrict already_done to issue implementation ([#1229](https://github.com/misospace/dispatch/issues/1229)) ([#1230](https://github.com/misospace/dispatch/issues/1230)) ([fd6bc88](https://github.com/misospace/dispatch/commit/fd6bc88996b41158c05a81841a3c6a12b0d95a4d))
* **tasks:** accept neutral handed-off reports ([#1224](https://github.com/misospace/dispatch/issues/1224)) ([#1226](https://github.com/misospace/dispatch/issues/1226)) ([685fcd2](https://github.com/misospace/dispatch/commit/685fcd24f6a649bf420e31bd9ae504357fb866c6))

## [0.5.68](https://github.com/misospace/dispatch/compare/v0.5.67...v0.5.68) (2026-10-08)


### Features

* **deps:** update dependency @modelcontextprotocol/sdk (1.31.0 → 1.32.0) ([#1160](https://github.com/misospace/dispatch/issues/1160)) ([05039a6](https://github.com/misospace/dispatch/commit/05039a6f119cedd240d479f22e72921cb78e54a3))
* **deps:** update dependency @radix-ui/react-slot (1.3.3 → 1.4.0) ([#1185](https://github.com/misospace/dispatch/issues/1185)) ([73133e7](https://github.com/misospace/dispatch/commit/73133e7377e6bfe3a2f3acb6e4edf2f0c623a2ed))
* **deps:** update dependency eslint (10.11.0 → 10.12.0) ([#1161](https://github.com/misospace/dispatch/issues/1161)) ([ba8217f](https://github.com/misospace/dispatch/commit/ba8217faa880ef4f6e2455132d21bde9e789a1ff))
* **deps:** update dependency lucide-react (1.48.0 → 1.49.0) ([#1139](https://github.com/misospace/dispatch/issues/1139)) ([278135c](https://github.com/misospace/dispatch/commit/278135cf2e23ece1e8051d714c27818bdd22c48f))
* **deps:** update dependency lucide-react (1.49.0 → 1.50.0) ([#1159](https://github.com/misospace/dispatch/issues/1159)) ([049cf41](https://github.com/misospace/dispatch/commit/049cf4116bc5d88d66bae4778f97bcc50dde28b2))
* **deps:** update dependency lucide-react (1.50.0 → 1.51.0) ([#1170](https://github.com/misospace/dispatch/issues/1170)) ([9556f61](https://github.com/misospace/dispatch/commit/9556f61f843d6e3e99b7f3ff21e9be779845f644))
* **deps:** update dependency lucide-react (1.51.0 → 1.52.0) ([#1176](https://github.com/misospace/dispatch/issues/1176)) ([535520c](https://github.com/misospace/dispatch/commit/535520c08c6ca63ba20dd2e44d0d01c35255bb7e))
* **deps:** update dependency lucide-react (1.52.0 → 1.53.0) ([#1195](https://github.com/misospace/dispatch/issues/1195)) ([2925a9f](https://github.com/misospace/dispatch/commit/2925a9f23973db14ea492a42a71cd25aefa8545c))
* **deps:** update nextjs monorepo (16.3.8 → 16.4.0) ([#1187](https://github.com/misospace/dispatch/issues/1187)) ([890a8fa](https://github.com/misospace/dispatch/commit/890a8faa48be2f3b61f14f342a98889f6c5713ab))
* **groomer:** create bounded child issues idempotently for decomposition plans ([#1066](https://github.com/misospace/dispatch/issues/1066)) ([#1186](https://github.com/misospace/dispatch/issues/1186)) ([381003e](https://github.com/misospace/dispatch/commit/381003e708b6c23ec7f87b53d88fbeb4546552f9))
* **pr-fix:** accept an explicit already_addressed settlement without a push ([#1142](https://github.com/misospace/dispatch/issues/1142)) ([889e451](https://github.com/misospace/dispatch/commit/889e4513da5c43e7c575e337dd496e2cd4664610))
* **tasks/report:** accept worker startedAt so AgentRun durations are real ([#1120](https://github.com/misospace/dispatch/issues/1120)) ([#1168](https://github.com/misospace/dispatch/issues/1168)) ([4d9af7a](https://github.com/misospace/dispatch/commit/4d9af7a4e8a66671f0f66024418a26b13f0c6940))


### Bug Fixes

* **auth:** guard GET /api/automation/repos/[...repo] with authorizeRequest ([#1151](https://github.com/misospace/dispatch/issues/1151)) ([6a9c552](https://github.com/misospace/dispatch/commit/6a9c552a1cab5f563406f89adf112c848fe74c4c))
* **ci:** pass --include=optional in audit script so --omit=dev survives .npmrc include=dev ([#1162](https://github.com/misospace/dispatch/issues/1162)) ([#1169](https://github.com/misospace/dispatch/issues/1169)) ([cca5600](https://github.com/misospace/dispatch/commit/cca5600dc347c11ab6f02f35bfc4c2928f73fb9f))
* **ci:** scope the npm audit gate to production dependencies ([#1166](https://github.com/misospace/dispatch/issues/1166)) ([#1172](https://github.com/misospace/dispatch/issues/1172)) ([f683575](https://github.com/misospace/dispatch/commit/f683575809abec9dda53c92cfa46d99ba7f60db6))
* **deps:** update dependency @modelcontextprotocol/sdk (1.32.0 → 1.32.1) ([#1181](https://github.com/misospace/dispatch/issues/1181)) ([148b435](https://github.com/misospace/dispatch/commit/148b435aa311f7874ba7d422a14bf55fa496f140))
* **deps:** update dependency @types/node (24.19.0 → 24.19.1) ([#1155](https://github.com/misospace/dispatch/issues/1155)) ([b593d4f](https://github.com/misospace/dispatch/commit/b593d4f356e557f11c1c011d0d250113c91e1eeb))
* **deps:** update dependency @vitejs/plugin-react (6.1.1 → 6.1.2) ([#1180](https://github.com/misospace/dispatch/issues/1180)) ([459c52e](https://github.com/misospace/dispatch/commit/459c52eab54179aae9e3345a3897948c9247b7dd))
* **deps:** update dependency jsdom (30.1.1 → 30.1.2) ([#1177](https://github.com/misospace/dispatch/issues/1177)) ([01b6bad](https://github.com/misospace/dispatch/commit/01b6bad90187297f7da7e760aefb10131b05a476))
* **deps:** update nextjs monorepo (16.3.6 → 16.3.7) ([#1136](https://github.com/misospace/dispatch/issues/1136)) ([edc1afb](https://github.com/misospace/dispatch/commit/edc1afbe6eaab4db302c028dfc388b44608d9e73))
* **deps:** update nextjs monorepo (16.3.7 → 16.3.8) ([#1146](https://github.com/misospace/dispatch/issues/1146)) ([d6d4db3](https://github.com/misospace/dispatch/commit/d6d4db34dfbbf9b0b30984de9fdfa4e2851e3fa4))
* **deps:** update vitest monorepo (5.0.2 → 5.0.3) ([#1144](https://github.com/misospace/dispatch/issues/1144)) ([e1e657e](https://github.com/misospace/dispatch/commit/e1e657e695b1c1e3ce56dfd1b08c03d285f72151))
* **groomer:** align apply-time head precondition with search-rechecked freshness ([#1153](https://github.com/misospace/dispatch/issues/1153)) ([ba5f607](https://github.com/misospace/dispatch/commit/ba5f607f52709eb2dab0a38d5c95ce7619ec56b1)), closes [#1116](https://github.com/misospace/dispatch/issues/1116)
* **groomer:** capture repository-context empty searches in the freshness baseline ([#1138](https://github.com/misospace/dispatch/issues/1138)) ([f22dae4](https://github.com/misospace/dispatch/commit/f22dae468a590a4db1132c21c169c94eb3a22796))
* **groomer:** sanitize provider error text before it reaches GroomingRun.errorMessage ([#1157](https://github.com/misospace/dispatch/issues/1157)) ([#1163](https://github.com/misospace/dispatch/issues/1163)) ([34f0162](https://github.com/misospace/dispatch/commit/34f016231ed849dbce001582598db22577b80e1a))
* **groomer:** strip NUL and C0 control chars from model text before validation and persistence ([#1156](https://github.com/misospace/dispatch/issues/1156)) ([05db272](https://github.com/misospace/dispatch/commit/05db272ad2bdf161ee13364ae90e1c312f02ab82))
* **mcp:** ship only the runtime closure in the -mcp image (prod deps + tsx layer) ([#1175](https://github.com/misospace/dispatch/issues/1175)) ([752d4a9](https://github.com/misospace/dispatch/commit/752d4a9190b6a0e631f2d7e0e2b9197befef407c))
* **next-task:** make the PR-fix queue own linked-PR follow-up ([#1192](https://github.com/misospace/dispatch/issues/1192)) ([a1797e3](https://github.com/misospace/dispatch/commit/a1797e3532c9a0da6045b600de57b84d80718a82))
* **pr-fix-queue:** pin enqueue post-dispatch append to its keys snapshot ([#1134](https://github.com/misospace/dispatch/issues/1134)) ([#1158](https://github.com/misospace/dispatch/issues/1158)) ([c9dd382](https://github.com/misospace/dispatch/commit/c9dd3826b0d685d0ec3aa8c27c02453ff30a4741))


### Chores

* **ai-review:** upgrade reviewer to v3.2.0 ([#1165](https://github.com/misospace/dispatch/issues/1165)) ([b0863de](https://github.com/misospace/dispatch/commit/b0863de9a4d2fec17fc5d38110955d7df69d818c))


### Documentation

* **auth:** document token tiers and correct stale endpoint auth tables ([#1193](https://github.com/misospace/dispatch/issues/1193)) ([a19accb](https://github.com/misospace/dispatch/commit/a19accb873aee480e307e38e600a354a4d626d4d)), closes [#1140](https://github.com/misospace/dispatch/issues/1140)

## [0.5.67](https://github.com/misospace/dispatch/compare/v0.5.66...v0.5.67) (2026-09-29)


### Features

* **auth:** split bearer auth into worker and maintainer token tiers ([#1122](https://github.com/misospace/dispatch/issues/1122)) ([12328f8](https://github.com/misospace/dispatch/commit/12328f82e790379f17bffa5041ff36a3591290e3))
* **deps:** update dependency @modelcontextprotocol/sdk (1.30.1 → 1.31.0) ([#1132](https://github.com/misospace/dispatch/issues/1132)) ([6147a2e](https://github.com/misospace/dispatch/commit/6147a2ea588f1f772a2577a37c4812c9069ed99c))


### Bug Fixes

* **groomer:** back off after failed runs ([#1125](https://github.com/misospace/dispatch/issues/1125)) ([#1127](https://github.com/misospace/dispatch/issues/1127)) ([22d3a7d](https://github.com/misospace/dispatch/commit/22d3a7d98fd1daaafddebccd3089a6b8361677da))
* **groomer:** repair or degrade on evidence-reference validation errors ([#1126](https://github.com/misospace/dispatch/issues/1126)) ([#1128](https://github.com/misospace/dispatch/issues/1128)) ([3ee30a1](https://github.com/misospace/dispatch/commit/3ee30a10a3e6555a7ca08419c63ce811bc57fe1b))
* **pr-fix:** deliver post-dispatch evidence as a fresh attempt ([#1119](https://github.com/misospace/dispatch/issues/1119)) ([#1124](https://github.com/misospace/dispatch/issues/1124)) ([3a5ecd7](https://github.com/misospace/dispatch/commit/3a5ecd71b1df6cbc14fda093e6a3c6c3995a5723))
* **pr-fix:** stop re-handing consumed pr-fix generations and settle failed reports ([#1133](https://github.com/misospace/dispatch/issues/1133)) ([#1135](https://github.com/misospace/dispatch/issues/1135)) ([add7d54](https://github.com/misospace/dispatch/commit/add7d54155f11fac04c6c02b324b2d68f7526605))

## [0.5.66](https://github.com/misospace/dispatch/compare/v0.5.65...v0.5.66) (2026-09-27)


### Features

* **groomer:** recheck saved empty searches for freshness ([#1114](https://github.com/misospace/dispatch/issues/1114)) ([ecddbec](https://github.com/misospace/dispatch/commit/ecddbeca4cab4880ae9e0bce1840cb2f4bbfac78))
* **queue:** honor native GitHub blocked_by dependencies ([#1095](https://github.com/misospace/dispatch/issues/1095)) ([47c7353](https://github.com/misospace/dispatch/commit/47c7353956f336564b3f6ad6924768091e2cca22))


### Bug Fixes

* **groomer:** ground already_done closes in the issue's own acceptance ([#1100](https://github.com/misospace/dispatch/issues/1100)) ([124b5b2](https://github.com/misospace/dispatch/commit/124b5b21d46716456f1361650a71fae7c02430f3)), closes [#1099](https://github.com/misospace/dispatch/issues/1099)
* **pr-fix:** cap fix attempts, not evidence, and always baseline fresh attempts ([#1107](https://github.com/misospace/dispatch/issues/1107)) ([babe44b](https://github.com/misospace/dispatch/commit/babe44be7f8defbad71647a46a4f645092d47e13))
* **pr-fix:** keep the item URL as the PR URL when CI evidence re-enqueues it ([#1117](https://github.com/misospace/dispatch/issues/1117)) ([f94ba28](https://github.com/misospace/dispatch/commit/f94ba28bc2eceadafc24a3549906dea165397a4b))
* **pr-fix:** retract needs-human on every exit from BLOCKED ([#1108](https://github.com/misospace/dispatch/issues/1108)) ([0bbdaf7](https://github.com/misospace/dispatch/commit/0bbdaf73d211818088a73793974386d9e0acd0f1)), closes [#1105](https://github.com/misospace/dispatch/issues/1105)
* **pr-fix:** stale PR-fix items in archived repos and refuse requeuing them ([#1109](https://github.com/misospace/dispatch/issues/1109)) ([cadc05c](https://github.com/misospace/dispatch/commit/cadc05ca2045b71d0a410b3a25b75a6ab087dfef))


### Documentation

* **groomer:** define close proof policy ([#1112](https://github.com/misospace/dispatch/issues/1112)) ([7c0348e](https://github.com/misospace/dispatch/commit/7c0348ecb170529121d5974159fc8e43380d25f1))

## [0.5.65](https://github.com/misospace/dispatch/compare/v0.5.64...v0.5.65) (2026-09-27)


### Features

* **deps:** update dependency @types/node (24.13.6 → 24.19.0) ([#1075](https://github.com/misospace/dispatch/issues/1075)) ([8567c2e](https://github.com/misospace/dispatch/commit/8567c2ec9870a1a2cf401985bf32e75593ac3bb9))
* **groomer:** add bounded related-work evidence tools ([#1061](https://github.com/misospace/dispatch/issues/1061)) ([#1077](https://github.com/misospace/dispatch/issues/1077)) ([f010c22](https://github.com/misospace/dispatch/commit/f010c22d5331d5e23ebf5768679b98302a6915cb))
* **groomer:** capture revision-pinned evidence snapshot before analysis ([#1073](https://github.com/misospace/dispatch/issues/1073)) ([f6e966f](https://github.com/misospace/dispatch/commit/f6e966fa931b091b0398b471349e6bc06747fc0b))
* **groomer:** persist grooming freshness and re-groom on evidence changes ([#1064](https://github.com/misospace/dispatch/issues/1064)) ([#1089](https://github.com/misospace/dispatch/issues/1089)) ([27259b4](https://github.com/misospace/dispatch/commit/27259b43ddad51aafe8a0b656698d819d465ca04))
* **groomer:** structured evidence-backed GroomingPlan contract ([#1090](https://github.com/misospace/dispatch/issues/1090)) ([3fa3b22](https://github.com/misospace/dispatch/commit/3fa3b2242863e2026a207337532ef42ebf6ca894))
* **groomer:** validate preconditions and apply grooming mutations idempotently ([#1093](https://github.com/misospace/dispatch/issues/1093)) ([aabd9b8](https://github.com/misospace/dispatch/commit/aabd9b8f7ae79d596aa942f0f7be92f4c000682c))
* **mcp:** pass an optional generation through mark_pr_fix ([#1081](https://github.com/misospace/dispatch/issues/1081)) ([8bfca74](https://github.com/misospace/dispatch/commit/8bfca741d8ce5d81c6cfe3a2e3488e23ae25b1fe))
* **queue:** gate claimability on open ‘depends on #N’ blockers ([#1038](https://github.com/misospace/dispatch/issues/1038)) ([#1057](https://github.com/misospace/dispatch/issues/1057)) ([f6bdfc1](https://github.com/misospace/dispatch/commit/f6bdfc19dd23520358922eb1d12523dd9891a5df))
* **queue:** opt-in grooming freshness admission before worker pickup ([#1094](https://github.com/misospace/dispatch/issues/1094)) ([2191a25](https://github.com/misospace/dispatch/commit/2191a255d5e1f68d71b6007d7e940ab4ff6d75ea))


### Bug Fixes

* **ci:** drop unsupported labels permission from Label Sync ([#1082](https://github.com/misospace/dispatch/issues/1082)) ([8268938](https://github.com/misospace/dispatch/commit/826893841d9805a5c681b0a671a0524d541b0cea))
* **deps:** update vitest monorepo (5.0.1 → 5.0.2) ([#1071](https://github.com/misospace/dispatch/issues/1071)) ([f68bfc1](https://github.com/misospace/dispatch/commit/f68bfc12a8b36585dbc63091da1d373a42090203))
* **lanes:** derive classifyLaneFromSignals fallback instead of hardcoded "normal" ([#1080](https://github.com/misospace/dispatch/issues/1080)) ([d5db2f9](https://github.com/misospace/dispatch/commit/d5db2f99bed82a4d44412ada4449cc8909bf699c)), closes [#1049](https://github.com/misospace/dispatch/issues/1049)
* **pr-followup-webhook:** read issue_comment and check_run from GitHub's real payload shapes ([#1088](https://github.com/misospace/dispatch/issues/1088)) ([5325163](https://github.com/misospace/dispatch/commit/53251636cd27b18f0451f38c1bb2aadfc0921b12))
* **queue:** derive PR-fix lane from resolved request lane ([#1046](https://github.com/misospace/dispatch/issues/1046)) ([#1058](https://github.com/misospace/dispatch/issues/1058)) ([3725b27](https://github.com/misospace/dispatch/commit/3725b27327037a64d1e83dd69f3ff0e8c479f852))
* **queue:** settle only the issued PR-fix attempt and start head ([#1074](https://github.com/misospace/dispatch/issues/1074)) ([#1079](https://github.com/misospace/dispatch/issues/1079)) ([bbf4234](https://github.com/misospace/dispatch/commit/bbf4234be0ae98e6c0a013f36ad30a7544126e99))


### Chores

* **env:** document missing env vars in .env.example and guard drift ([#1085](https://github.com/misospace/dispatch/issues/1085)) ([cbdd195](https://github.com/misospace/dispatch/commit/cbdd1953e276bc670b87664e0496fbc29ea7716f))

## [0.5.64](https://github.com/misospace/dispatch/compare/v0.5.63...v0.5.64) (2026-09-25)


### Features

* **deps:** update dependency lucide-react (1.47.0 → 1.48.0) ([#1056](https://github.com/misospace/dispatch/issues/1056)) ([1d9844e](https://github.com/misospace/dispatch/commit/1d9844ea1440dd93649a397b22850587cd833a18))
* **groomer:** DISPATCH_LLM_RESPONSE_FORMAT toggle ([#1070](https://github.com/misospace/dispatch/issues/1070)) ([05c3814](https://github.com/misospace/dispatch/commit/05c38142e5f737a2155027c3f8780b4bf5d270a4))


### Bug Fixes

* **deps:** update dependency @modelcontextprotocol/sdk (1.30.0 → 1.30.1) ([#1054](https://github.com/misospace/dispatch/issues/1054)) ([a6b3ea5](https://github.com/misospace/dispatch/commit/a6b3ea5bfa05404499da2df0cf026c78558008c2))
* **deps:** update dependency jsdom (30.1.0 → 30.1.1) ([#1047](https://github.com/misospace/dispatch/issues/1047)) ([48e5d62](https://github.com/misospace/dispatch/commit/48e5d62392eaf73cd26b10f73a81cdee8863db75))
* **deps:** update nextjs monorepo (16.3.5 → 16.3.6) ([#1053](https://github.com/misospace/dispatch/issues/1053)) ([fb23bd2](https://github.com/misospace/dispatch/commit/fb23bd206d1a57707cae652c302dbd62ed3c2581))

## [0.5.63](https://github.com/misospace/dispatch/compare/v0.5.62...v0.5.63) (2026-09-21)


### Features

* **deps:** update dependency eslint (10.10.0 → 10.11.0) ([#1035](https://github.com/misospace/dispatch/issues/1035)) ([197c87a](https://github.com/misospace/dispatch/commit/197c87af5b5d26e921484df25e5e63cc9a282469))
* **queue:** expose PR-fix work generations ([#1044](https://github.com/misospace/dispatch/issues/1044)) ([c16f04f](https://github.com/misospace/dispatch/commit/c16f04f28547b73fc894f4d480afec7a6888ddfa))


### Bug Fixes

* **claims:** gate claim/assign/status decisions on live GitHub labels ([#1037](https://github.com/misospace/dispatch/issues/1037)) ([#1042](https://github.com/misospace/dispatch/issues/1042)) ([bacac7b](https://github.com/misospace/dispatch/commit/bacac7b023df539aaecdc3e7559b3c06049f64b9))
* **deps:** update dependency @types/node (24.13.5 → 24.13.6) ([#1036](https://github.com/misospace/dispatch/issues/1036)) ([cb7bd79](https://github.com/misospace/dispatch/commit/cb7bd793d62afd76b820fc8fb1ab96413e03d543))
* **deps:** update dependency tsx (4.23.13 → 4.23.15) ([#1039](https://github.com/misospace/dispatch/issues/1039)) ([6555743](https://github.com/misospace/dispatch/commit/6555743d591b7334873961b28a0cff79c02995d5))
* **helm:** update chart common (5.2.0 → 5.2.1) ([#1030](https://github.com/misospace/dispatch/issues/1030)) ([073bc93](https://github.com/misospace/dispatch/commit/073bc931bf6ebdf032ce04fbd02c4867fdc5c304))

## [0.5.62](https://github.com/misospace/dispatch/compare/v0.5.61...v0.5.62) (2026-09-17)


### Features

* **ci-failures:** route scan/CVE failures to escalation lane ([#1025](https://github.com/misospace/dispatch/issues/1025)) ([7a7ef31](https://github.com/misospace/dispatch/commit/7a7ef3193bb77e13af7e6b236902c324b6e70c63)), closes [#988](https://github.com/misospace/dispatch/issues/988)
* **deps:** update dependency jsdom (30.0.1 → 30.1.0) ([#1024](https://github.com/misospace/dispatch/issues/1024)) ([3595fa8](https://github.com/misospace/dispatch/commit/3595fa8c3d160d6026a5654048c40f158b1ef199))
* **deps:** update dependency lucide-react (1.45.0 → 1.46.0) ([#1011](https://github.com/misospace/dispatch/issues/1011)) ([e3a554f](https://github.com/misospace/dispatch/commit/e3a554f051fa5280b0eb74b8c352b0fec825f60e))
* **deps:** update dependency lucide-react (1.46.0 → 1.47.0) ([#1029](https://github.com/misospace/dispatch/issues/1029)) ([edbd4f7](https://github.com/misospace/dispatch/commit/edbd4f762c8f4c1a49ffaca4169ac2c2f2376a7f))
* **helm:** update chart common (5.1.0 → 5.2.0) ([#1021](https://github.com/misospace/dispatch/issues/1021)) ([7d4de92](https://github.com/misospace/dispatch/commit/7d4de9269d9ee1957ad75fca02349de1372083d6))


### Bug Fixes

* **deps:** update dependency @types/node (24.13.4 → 24.13.5) ([#1019](https://github.com/misospace/dispatch/issues/1019)) ([6b1a5c0](https://github.com/misospace/dispatch/commit/6b1a5c027c94478ace4b1feb20c6a0e66ac16504))
* **deps:** update dependency zod (4.6.4 → 4.6.5) ([#1007](https://github.com/misospace/dispatch/issues/1007)) ([6b7ef11](https://github.com/misospace/dispatch/commit/6b7ef11bdb3b71acddfaddd70eddfd77e855dce6))
* **deps:** update vitest monorepo (5.0.0 → 5.0.1) ([#1016](https://github.com/misospace/dispatch/issues/1016)) ([dc9893a](https://github.com/misospace/dispatch/commit/dc9893a881e9162c0d980d94e27f2a303b31e805))
* **github:** paginate code-search results and add a co-located client test ([#1012](https://github.com/misospace/dispatch/issues/1012)) ([41381f6](https://github.com/misospace/dispatch/commit/41381f6c02c0a11d421510ba449eaaf6e762d514)), closes [#1006](https://github.com/misospace/dispatch/issues/1006)
* **groomer:** cap derived exploration budget ([#1023](https://github.com/misospace/dispatch/issues/1023)) ([33b8851](https://github.com/misospace/dispatch/commit/33b88519b4ff338dbb934a026600919b6271aa4f))
* **pr-followup:** route recurring scan failures ([#1028](https://github.com/misospace/dispatch/issues/1028)) ([6b7ff0d](https://github.com/misospace/dispatch/commit/6b7ff0d8d90345c79de781d6d5c3b19b2fd50400))


### Chores

* **deps:** lock file maintenance ([#1010](https://github.com/misospace/dispatch/issues/1010)) ([ef57a6a](https://github.com/misospace/dispatch/commit/ef57a6ae02c146a796b4351acc7612f37f580293))
* **renovate:** exclude SHA-pinned trivy-action to stop no-result lookup ([#1009](https://github.com/misospace/dispatch/issues/1009)) ([89f3d29](https://github.com/misospace/dispatch/commit/89f3d292041b5c43e25bb9a5cae8e764faf03971))
* update native loop settings ([#1027](https://github.com/misospace/dispatch/issues/1027)) ([12a4efc](https://github.com/misospace/dispatch/commit/12a4efc1bac638fc3fdd385b8b13d511400988d9))

## [0.5.61](https://github.com/misospace/dispatch/compare/v0.5.60...v0.5.61) (2026-09-13)


### Features

* **deps:** update dependency tailwind-merge (3.6.0 → 3.7.0) ([#997](https://github.com/misospace/dispatch/issues/997)) ([9f67de0](https://github.com/misospace/dispatch/commit/9f67de0bb49750b86c8cebe7736ff37630372184))


### Bug Fixes

* **deps:** update dependency zod (4.6.2 → 4.6.4) ([#998](https://github.com/misospace/dispatch/issues/998)) ([0bed6b5](https://github.com/misospace/dispatch/commit/0bed6b58c1d76b814ad34523aa894da943ebfee4))
* **pr-fix:** stop the merged-PR and human-review fix loops ([#1003](https://github.com/misospace/dispatch/issues/1003)) ([a2a412f](https://github.com/misospace/dispatch/commit/a2a412fea6195f4078b944f76a732e11f11ffbdf))

## [0.5.60](https://github.com/misospace/dispatch/compare/v0.5.59...v0.5.60) (2026-09-11)


### Features

* **ci-failures:** enrich scan-failure issue bodies with parsed grype/trivy findings ([#995](https://github.com/misospace/dispatch/issues/995)) ([84c74fd](https://github.com/misospace/dispatch/commit/84c74fd1862078509d3ec85d83856784543be3cf)), closes [#994](https://github.com/misospace/dispatch/issues/994)
* **deps:** update dependency lucide-react (1.43.0 → 1.44.0) ([#985](https://github.com/misospace/dispatch/issues/985)) ([ea28470](https://github.com/misospace/dispatch/commit/ea284705994e7ff65d4019b79eccf3ee2161fdb2))
* **deps:** update dependency lucide-react (1.44.0 → 1.45.0) ([#990](https://github.com/misospace/dispatch/issues/990)) ([519f53d](https://github.com/misospace/dispatch/commit/519f53dd6e1c76e83428398f8cb475d40f32d251))


### Bug Fixes

* **ci-failures:** stop hashing the job name into the failure signature ([#989](https://github.com/misospace/dispatch/issues/989)) ([448078b](https://github.com/misospace/dispatch/commit/448078b480590bc2971c70aa1a582834ec27838e)), closes [#986](https://github.com/misospace/dispatch/issues/986)
* **deps:** update dependency zod (4.6.0 → 4.6.1) ([#983](https://github.com/misospace/dispatch/issues/983)) ([26bfe78](https://github.com/misospace/dispatch/commit/26bfe78b24af2fc798dde235dd4f79d4cb5b4e7c))
* **deps:** update dependency zod (4.6.1 → 4.6.2) ([#987](https://github.com/misospace/dispatch/issues/987)) ([a865373](https://github.com/misospace/dispatch/commit/a865373cdadd073a6dbef60aa6337129be80c562))
* **deps:** update nextjs monorepo (16.3.4 → 16.3.5) ([#993](https://github.com/misospace/dispatch/issues/993)) ([85bb0cf](https://github.com/misospace/dispatch/commit/85bb0cf89378183ba4da01bd8a2bda9cded91539))
* **issue-sync:** always full-fetch open issues so old untouched ones are not stranded ([#992](https://github.com/misospace/dispatch/issues/992)) ([1e6ef1d](https://github.com/misospace/dispatch/commit/1e6ef1dc88b2d6c2f91d19355b5eac6aed16529b)), closes [#991](https://github.com/misospace/dispatch/issues/991)

## [0.5.59](https://github.com/misospace/dispatch/compare/v0.5.58...v0.5.59) (2026-09-09)


### Features

* **deps:** update dependency zod (4.5.4 → 4.6.0) ([#982](https://github.com/misospace/dispatch/issues/982)) ([07af5df](https://github.com/misospace/dispatch/commit/07af5df3ef83b3c3f01a4812df32a7437a80b220))
* **deps:** update react monorepo (19.2.18 → 19.3.0) ([#980](https://github.com/misospace/dispatch/issues/980)) ([b86bafe](https://github.com/misospace/dispatch/commit/b86bafe8bf62bb782b1a1d61d6277b4ac0be9409))


### Bug Fixes

* **agent-runs:** keep touchedIssueUrls URL-only ([#973](https://github.com/misospace/dispatch/issues/973)) ([5293195](https://github.com/misospace/dispatch/commit/52931956e9f5f9f3178bc9f0b9ab67d7b884d62e)), closes [#971](https://github.com/misospace/dispatch/issues/971)
* **auth:** fail fast at startup when OIDC env vars are missing ([#975](https://github.com/misospace/dispatch/issues/975)) ([ab46bbf](https://github.com/misospace/dispatch/commit/ab46bbf20e4e60f240ffac4dddd623aeab7fc1d3)), closes [#972](https://github.com/misospace/dispatch/issues/972)
* **ci-failures:** normalize UUIDs and temp paths in the failure signature ([#978](https://github.com/misospace/dispatch/issues/978)) ([df38ab0](https://github.com/misospace/dispatch/commit/df38ab00dc22727049e37d1a56f3114e87360c77))
* **deps:** update dependency @types/node (24.13.3 → 24.13.4) ([#981](https://github.com/misospace/dispatch/issues/981)) ([84973c5](https://github.com/misospace/dispatch/commit/84973c5002853a516d07b47f9db59f3a4bf3a966))
* **groomer:** heartbeat the run lock so a mid-groom rollout stalls grooming ~90s, not 30 min ([#968](https://github.com/misospace/dispatch/issues/968)) ([866032b](https://github.com/misospace/dispatch/commit/866032b61fbe4f132029cad807d078bf58beeabd)), closes [#967](https://github.com/misospace/dispatch/issues/967)
* **groomer:** retry transient litellm connection drops ([#979](https://github.com/misospace/dispatch/issues/979)) ([75f20c4](https://github.com/misospace/dispatch/commit/75f20c419b64baabee7d8a7df93f37d7473e0ec9)), closes [#976](https://github.com/misospace/dispatch/issues/976)
* **lesson-feed:** stop firing an LLM call on every FIXED pr-fix transition ([#974](https://github.com/misospace/dispatch/issues/974)) ([7af794d](https://github.com/misospace/dispatch/commit/7af794dccd312d03908fc0a224c44c446e4b0139)), closes [#970](https://github.com/misospace/dispatch/issues/970)

## [0.5.58](https://github.com/misospace/dispatch/compare/v0.5.57...v0.5.58) (2026-09-08)


### Bug Fixes

* **lanes:** start ingested issues on the configured default lane, not a hardcoded "normal" ([#965](https://github.com/misospace/dispatch/issues/965)) ([61dfeeb](https://github.com/misospace/dispatch/commit/61dfeeb4477d40d727fe829818ba36a94788c498))

## [0.5.57](https://github.com/misospace/dispatch/compare/v0.5.56...v0.5.57) (2026-09-08)


### Features

* **deps:** update dependency lucide-react (1.42.0 → 1.43.0) ([#959](https://github.com/misospace/dispatch/issues/959)) ([304cb48](https://github.com/misospace/dispatch/commit/304cb481bb50e48ea898cecd4b009375520093bf))


### Bug Fixes

* **ci-failures:** re-verify before filing so a stale listing cannot duplicate ([#962](https://github.com/misospace/dispatch/issues/962)) ([39759a9](https://github.com/misospace/dispatch/commit/39759a977aedb215450ff8ce960457b8532cf4a8))
* **groomer:** verify issue premise against base branch and act on already_done ([#958](https://github.com/misospace/dispatch/issues/958)) ([7ed19eb](https://github.com/misospace/dispatch/commit/7ed19eb4f060c236a3ce9ab7a38f6d32edad6f4a)), closes [#957](https://github.com/misospace/dispatch/issues/957)

## [0.5.56](https://github.com/misospace/dispatch/compare/v0.5.55...v0.5.56) (2026-09-07)


### Bug Fixes

* **ci-failures:** only close an issue for the workflow that went green ([#955](https://github.com/misospace/dispatch/issues/955)) ([cc5df2f](https://github.com/misospace/dispatch/commit/cc5df2f8e147caac5cca73630ece82db947699f1))

## [0.5.55](https://github.com/misospace/dispatch/compare/v0.5.54...v0.5.55) (2026-09-07)


### Features

* **deps:** update dependency lucide-react (1.41.0 → 1.42.0) ([#951](https://github.com/misospace/dispatch/issues/951)) ([ebe8506](https://github.com/misospace/dispatch/commit/ebe8506eacd46654bc6d4e3fc56efc01872fdff1))


### Bug Fixes

* **ci-failures:** require two consecutive greens before closing an issue ([#954](https://github.com/misospace/dispatch/issues/954)) ([89d8baa](https://github.com/misospace/dispatch/commit/89d8baaeab89fcd9978c38828791af0b44f9fc28)), closes [#953](https://github.com/misospace/dispatch/issues/953)


### Chores

* **deps:** lock file maintenance ([#950](https://github.com/misospace/dispatch/issues/950)) ([6834727](https://github.com/misospace/dispatch/commit/683472702911cf4dae97ee72e7f2a256ce2212dd))

## [0.5.54](https://github.com/misospace/dispatch/compare/v0.5.53...v0.5.54) (2026-09-06)


### Features

* **deps:** update dependency eslint (10.9.1 → 10.10.0) ([#946](https://github.com/misospace/dispatch/issues/946)) ([ee09a82](https://github.com/misospace/dispatch/commit/ee09a82d710dbd029039913498b9a33e04443858))
* **lanes:** expose the lane topology and enforce role uniqueness ([#948](https://github.com/misospace/dispatch/issues/948)) ([6ab4acf](https://github.com/misospace/dispatch/commit/6ab4acf0e391804d10755cb940dccc9a5eb2eca8))


### Bug Fixes

* **groomer:** enforce exactly one status/* label after a groom ([#943](https://github.com/misospace/dispatch/issues/943)) ([4e4e358](https://github.com/misospace/dispatch/commit/4e4e35884f34d5a5d442bd5b6a15c768a9a4a7fa)), closes [#941](https://github.com/misospace/dispatch/issues/941)

## [0.5.53](https://github.com/misospace/dispatch/compare/v0.5.52...v0.5.53) (2026-09-06)


### Features

* **ci-failures:** file issues from repeated default-branch workflow failures ([#932](https://github.com/misospace/dispatch/issues/932)) ([2dd1387](https://github.com/misospace/dispatch/commit/2dd138794e32854ffe1d845960995adac1ee5ae3)), closes [#931](https://github.com/misospace/dispatch/issues/931)
* **deps:** update dependency lucide-react (1.39.0 → 1.40.0) ([#928](https://github.com/misospace/dispatch/issues/928)) ([934d3c4](https://github.com/misospace/dispatch/commit/934d3c4cfce2aad142e503aa16a45d32f6e3cf7f))
* **deps:** update dependency lucide-react (1.40.0 → 1.41.0) ([#938](https://github.com/misospace/dispatch/issues/938)) ([15cd8e2](https://github.com/misospace/dispatch/commit/15cd8e2b08f3bc6b873bbbd545be7824add30133))
* **deps:** update vitest monorepo (4.1.11 → 5.0.0) ([#929](https://github.com/misospace/dispatch/issues/929)) ([936de51](https://github.com/misospace/dispatch/commit/936de5175edcca52cbf0b62db05c807d6f3292a5))
* **groomer:** let the groomer assign the escalation lane on merit ([#922](https://github.com/misospace/dispatch/issues/922)) ([599eca6](https://github.com/misospace/dispatch/commit/599eca68c503164e3ca23d4319d9534f28241d32))
* **pr-followup:** link a PR to its issue from commit messages when the body has none ([#923](https://github.com/misospace/dispatch/issues/923)) ([4b2a8dc](https://github.com/misospace/dispatch/commit/4b2a8dc0776af5d85b7af846e192ea8f4d0e8a66))


### Bug Fixes

* **deps:** update dependency @eslint/compat (2.1.0 → 2.1.1) ([#930](https://github.com/misospace/dispatch/issues/930)) ([543150d](https://github.com/misospace/dispatch/commit/543150d39c65d8f0ed91e7b2223cd753e4c20e59))
* **deps:** update dependency @types/react-dom (19.2.5 → 19.2.7) ([#927](https://github.com/misospace/dispatch/issues/927)) ([1beae56](https://github.com/misospace/dispatch/commit/1beae56d868c91dd736320c0586833c446c4d2b4))
* **github:** retry transient 429/5xx in remaining GitHub API fetchers ([#926](https://github.com/misospace/dispatch/issues/926)) ([488f2bc](https://github.com/misospace/dispatch/commit/488f2bc837a306a9f03d9da14f791a9eb1fc9866)), closes [#917](https://github.com/misospace/dispatch/issues/917)
* **groomer:** warn the model before its exploration rounds run out ([#919](https://github.com/misospace/dispatch/issues/919)) ([b5052b9](https://github.com/misospace/dispatch/commit/b5052b9bbc8267148b7f95671032f084cc7a4384))
* **issue-claim:** stop unclaim from overwriting GitHub labels from the stale local cache ([#925](https://github.com/misospace/dispatch/issues/925)) ([4d83229](https://github.com/misospace/dispatch/commit/4d83229e5d46c3dbc112d0609e882b78f3d689d7)), closes [#921](https://github.com/misospace/dispatch/issues/921)
* **labels:** prune unmanaged blocked/infra-attempt/* and blocked/infra-model/* drift ([#936](https://github.com/misospace/dispatch/issues/936)) ([97702a0](https://github.com/misospace/dispatch/commit/97702a0256c776d194a165dac7828c0c915e0b95)), closes [#916](https://github.com/misospace/dispatch/issues/916)
* **lesson-feed:** use Dispatch LLM configuration with legacy fallbacks ([#937](https://github.com/misospace/dispatch/issues/937)) ([5caef62](https://github.com/misospace/dispatch/commit/5caef62d3c19bea9c1c424c632c7d09427604245)), closes [#913](https://github.com/misospace/dispatch/issues/913)
* **pr-fix-queue:** refuse FIXED on no-progress and reopen stale tombstones ([#942](https://github.com/misospace/dispatch/issues/942)) ([e145d89](https://github.com/misospace/dispatch/commit/e145d8934f06b5d461634ca3c6e3b395fc9d6b95))
* **types:** point at jest-dom's vitest matcher types ([#933](https://github.com/misospace/dispatch/issues/933)) ([248a4a8](https://github.com/misospace/dispatch/commit/248a4a8e1473522eebd4b076aee396e3720874f6))


### Documentation

* **env:** document DISPATCH_STALE_WORK_INTERVAL_MS ([#935](https://github.com/misospace/dispatch/issues/935)) ([a7a28be](https://github.com/misospace/dispatch/commit/a7a28be64e68050da4b7ab450847f4c672c56f39))

## [0.5.52](https://github.com/misospace/dispatch/compare/v0.5.51...v0.5.52) (2026-09-02)


### Features

* **groomer:** give repository exploration its own budget ([#918](https://github.com/misospace/dispatch/issues/918)) ([fe138e8](https://github.com/misospace/dispatch/commit/fe138e85cf9b80a4d39fa2e4e4769da1b3b5ed10))


### Bug Fixes

* **deps:** update dependency @testing-library/user-event (14.6.6 → 14.6.7) ([#911](https://github.com/misospace/dispatch/issues/911)) ([0145810](https://github.com/misospace/dispatch/commit/01458108757943ce5e4b85e51365f443ca031a16))
* **prisma:** turn TLS on when DATABASE_URL uses sslmode=no-verify ([#910](https://github.com/misospace/dispatch/issues/910)) ([204f200](https://github.com/misospace/dispatch/commit/204f200173b08a42246b9e08b9d22f66a5277423)), closes [#899](https://github.com/misospace/dispatch/issues/899)

## [0.5.51](https://github.com/misospace/dispatch/compare/v0.5.50...v0.5.51) (2026-09-01)


### Features

* **groomer:** drive repo exploration with tools instead of one-shot context ([#908](https://github.com/misospace/dispatch/issues/908)) ([10ed2b2](https://github.com/misospace/dispatch/commit/10ed2b2494f893306ba21ec92815fb2a45ea1373))


### Bug Fixes

* **middleware:** serve static assets without auth so the favicon loads on the OIDC login page ([#905](https://github.com/misospace/dispatch/issues/905)) ([349dbbf](https://github.com/misospace/dispatch/commit/349dbbff3c7de0dbc76963a6c2c9648d9964509e))

## [0.5.50](https://github.com/misospace/dispatch/compare/v0.5.49...v0.5.50) (2026-09-01)


### Features

* **deps:** update dependency lucide-react (1.37.0 → 1.38.0) ([#895](https://github.com/misospace/dispatch/issues/895)) ([cc81874](https://github.com/misospace/dispatch/commit/cc8187466c9510f6f2d0bbd416f5e2b31285a49b))
* **deps:** update dependency lucide-react (1.38.0 → 1.39.0) ([#903](https://github.com/misospace/dispatch/issues/903)) ([fd6698d](https://github.com/misospace/dispatch/commit/fd6698d3ddb6c57d2f57fa85532098f19221634d))


### Bug Fixes

* **deps:** update nextjs monorepo (16.3.3 → 16.3.4) ([#902](https://github.com/misospace/dispatch/issues/902)) ([088936c](https://github.com/misospace/dispatch/commit/088936c8ed62d312e3b7d277045626e36bc33285))
* **groomer:** stop treating its own comments as authority to defer ([#904](https://github.com/misospace/dispatch/issues/904)) ([67f6f27](https://github.com/misospace/dispatch/commit/67f6f27378df4f8c1671fe92d1fffe7480e963bb))


### Chores

* **deps:** lock file maintenance ([#894](https://github.com/misospace/dispatch/issues/894)) ([aa80e52](https://github.com/misospace/dispatch/commit/aa80e52ae668b1fccd77e83605f13584436c0311))

## [0.5.49](https://github.com/misospace/dispatch/compare/v0.5.48...v0.5.49) (2026-08-31)


### Features

* **deps:** update dependency lucide-react (1.34.0 → 1.35.0) ([#884](https://github.com/misospace/dispatch/issues/884)) ([c60ddd3](https://github.com/misospace/dispatch/commit/c60ddd35a0cd172cfa2e9f6742c839065277e725))
* **deps:** update dependency lucide-react (1.35.0 → 1.37.0) ([#888](https://github.com/misospace/dispatch/issues/888)) ([803db7b](https://github.com/misospace/dispatch/commit/803db7be8f70b3b6beeaed7611527ef0637a9f38))
* **deps:** update dependency zod (4.4.3 → 4.5.1) ([#885](https://github.com/misospace/dispatch/issues/885)) ([2201c4c](https://github.com/misospace/dispatch/commit/2201c4c139f82f05e35689d38a521bcd7540dd85))


### Bug Fixes

* **auth:** send state as well as pkce, and document sslmode ([#893](https://github.com/misospace/dispatch/issues/893)) ([18bf4bf](https://github.com/misospace/dispatch/commit/18bf4bf5a1e05cacdc52640cf655b8a1b74ca23f))
* **deps:** update dependency @vitejs/plugin-react (6.1.0 → 6.1.1) ([#883](https://github.com/misospace/dispatch/issues/883)) ([49e2cee](https://github.com/misospace/dispatch/commit/49e2ceef3be9592eebd6f5eb689aabc37e86c649))
* **deps:** update dependency tsx (4.23.12 → 4.23.13) ([#892](https://github.com/misospace/dispatch/issues/892)) ([ba0f827](https://github.com/misospace/dispatch/commit/ba0f827ff1fcd9f6b6cb165c80297979d6d67ef0))
* **deps:** update dependency zod (4.5.1 → 4.5.2) ([#887](https://github.com/misospace/dispatch/issues/887)) ([f48fb02](https://github.com/misospace/dispatch/commit/f48fb029632c2242f05c7b3a193c95c7fbbb0585))
* **deps:** update dependency zod (4.5.2 → 4.5.4) ([#890](https://github.com/misospace/dispatch/issues/890)) ([d93df03](https://github.com/misospace/dispatch/commit/d93df0391f6fd7a06abe8cc6591ea450881161dd))

## [0.5.48](https://github.com/misospace/dispatch/compare/v0.5.47...v0.5.48) (2026-08-27)


### Bug Fixes

* **deps:** update dependency @testing-library/react (16.3.2 → 16.3.3) ([#880](https://github.com/misospace/dispatch/issues/880)) ([a0e5729](https://github.com/misospace/dispatch/commit/a0e572902c16f949c4b00d56e25e2653ea1eb146))
* **groomer:** stop fabricated deferrals from parking issues forever ([#881](https://github.com/misospace/dispatch/issues/881)) ([b7258b3](https://github.com/misospace/dispatch/commit/b7258b32ef97c3dc5f4754d1ff7efbdd174983c0))

## [0.5.47](https://github.com/misospace/dispatch/compare/v0.5.46...v0.5.47) (2026-08-27)


### Bug Fixes

* **scheduler:** share liveness state across chunk graphs ([#877](https://github.com/misospace/dispatch/issues/877)) ([79a2789](https://github.com/misospace/dispatch/commit/79a278981a851dbd5646a397cdfb9f885867704a))
* **sync-lock:** key the lock per job so jobs stop starving each other ([#879](https://github.com/misospace/dispatch/issues/879)) ([430e84a](https://github.com/misospace/dispatch/commit/430e84a3d61c6e1f2db72a02741470f28242b7df))

## [0.5.46](https://github.com/misospace/dispatch/compare/v0.5.45...v0.5.46) (2026-08-27)


### Bug Fixes

* **agent-work:** reclaim stale claims automatically ([#874](https://github.com/misospace/dispatch/issues/874)) ([8255215](https://github.com/misospace/dispatch/commit/8255215551c7be3dd1d6fe1ba40783e4d3e5e553))
* **pr-fix:** resolve queued items from tasks/report ([#868](https://github.com/misospace/dispatch/issues/868)) ([#872](https://github.com/misospace/dispatch/issues/872)) ([21ca74b](https://github.com/misospace/dispatch/commit/21ca74bfed752f1a834584b9a048acf51b75ac87))
* **scheduler:** detect and recover when a job's timer stops firing ([#875](https://github.com/misospace/dispatch/issues/875)) ([2de79de](https://github.com/misospace/dispatch/commit/2de79ded7cb393d56d720592ac0550f8686cb7b9))
* **smoke:** assert the CSP from inside the cluster, not from the runner ([#876](https://github.com/misospace/dispatch/issues/876)) ([242c616](https://github.com/misospace/dispatch/commit/242c61628f4dfa30e361f09f3d2c4c416d1b01f3))
* **unclaim:** make the resting status predictable for every status ([#873](https://github.com/misospace/dispatch/issues/873)) ([39fbcb6](https://github.com/misospace/dispatch/commit/39fbcb6601e096d3191c59621c48659dd524b27b)), closes [#869](https://github.com/misospace/dispatch/issues/869)


### Documentation

* correct drift between the docs and the running system ([#870](https://github.com/misospace/dispatch/issues/870)) ([523fcc4](https://github.com/misospace/dispatch/commit/523fcc435381d3d4a166c8a5936698b2616bb582))

## [0.5.45](https://github.com/misospace/dispatch/compare/v0.5.44...v0.5.45) (2026-08-25)


### Bug Fixes

* **deps:** update nextjs monorepo (16.3.2 → 16.3.3) ([#860](https://github.com/misospace/dispatch/issues/860)) ([5395214](https://github.com/misospace/dispatch/commit/539521409565bff1474d44ce7f35ae3ecdd988bc))
* make status/blocked recoverable ([#863](https://github.com/misospace/dispatch/issues/863)) ([37b26a4](https://github.com/misospace/dispatch/commit/37b26a4fcf82aefc0b2e9fcba1a9fb1c0e78dd91))
* **smoke:** probe Postgres over TCP so readiness means what the workflow assumes ([#864](https://github.com/misospace/dispatch/issues/864)) ([b396908](https://github.com/misospace/dispatch/commit/b396908842c9558ed6bdcd6ad4ebe3dd489bd0db))

## [0.5.44](https://github.com/misospace/dispatch/compare/v0.5.43...v0.5.44) (2026-08-25)


### Features

* **deps:** update dependency prisma (7.9.1 → 7.10.0) ([#857](https://github.com/misospace/dispatch/issues/857)) ([c672896](https://github.com/misospace/dispatch/commit/c6728964456091c060c59d91f59279b4b1ac6de9))
* **deps:** update prisma monorepo (7.9.1 → 7.10.0) ([#856](https://github.com/misospace/dispatch/issues/856)) ([9df3342](https://github.com/misospace/dispatch/commit/9df33423bd75a4ae486ebb0fb7054691b85cf030))


### Bug Fixes

* **board:** fit every column on screen and scroll long columns internally ([#858](https://github.com/misospace/dispatch/issues/858)) ([dcf72aa](https://github.com/misospace/dispatch/commit/dcf72aa95f9d775b2d2297529916dcca5cd2df9e))

## [0.5.43](https://github.com/misospace/dispatch/compare/v0.5.42...v0.5.43) (2026-08-25)


### Bug Fixes

* **sync:** acquire the lock without raising inside the transaction ([#853](https://github.com/misospace/dispatch/issues/853)) ([a497ae4](https://github.com/misospace/dispatch/commit/a497ae43b3745b989ac5e5642571d4e72b9849e3))

## [0.5.42](https://github.com/misospace/dispatch/compare/v0.5.41...v0.5.42) (2026-08-24)


### Features

* **deps:** update dependency lucide-react (1.33.0 → 1.34.0) ([#837](https://github.com/misospace/dispatch/issues/837)) ([3887606](https://github.com/misospace/dispatch/commit/38876061bcad275819321ea01045836bec288262))


### Bug Fixes

* **csp:** serve the theme initialiser from a static file and add a per-request CSP nonce ([#845](https://github.com/misospace/dispatch/issues/845)) ([5fdfe51](https://github.com/misospace/dispatch/commit/5fdfe515bd6a53d8f068f5fb3497e3d23011403d))
* **deps:** update dependency @types/react-dom (19.2.4 → 19.2.5) ([#834](https://github.com/misospace/dispatch/issues/834)) ([4d79ac7](https://github.com/misospace/dispatch/commit/4d79ac779020b01b1735549ffb3fb1bca0ab980d))
* **deps:** update dependency eslint (10.9.0 → 10.9.1) ([#846](https://github.com/misospace/dispatch/issues/846)) ([7102b99](https://github.com/misospace/dispatch/commit/7102b992cbf93d5aaad34c56f8a2f8f143a1093c))
* **groomer:** degrade instead of failing runs when notReadyReason is omitted ([#842](https://github.com/misospace/dispatch/issues/842)) ([503d73b](https://github.com/misospace/dispatch/commit/503d73b8997b349d3811493c1a5e1e592c027ca8))
* **prisma:** make fresh database migrations succeed ([#848](https://github.com/misospace/dispatch/issues/848)) ([5213255](https://github.com/misospace/dispatch/commit/521325545a31fbd5601363e2a574370d5b9d644c))
* **sync:** make sync-lock acquisition survive stale and orphaned lock rows ([#843](https://github.com/misospace/dispatch/issues/843)) ([80a5c87](https://github.com/misospace/dispatch/commit/80a5c87eac38934feb495aa7819442be8d3a980e))


### Chores

* **deps:** lock file maintenance ([#836](https://github.com/misospace/dispatch/issues/836)) ([aecacbb](https://github.com/misospace/dispatch/commit/aecacbbeba0b189f70ae5f7ae0ed2f8e9f915683))

## [0.5.41](https://github.com/misospace/dispatch/compare/v0.5.40...v0.5.41) (2026-08-22)


### Features

* **deps:** update dependency @vitejs/plugin-react (6.0.5 → 6.1.0) ([#816](https://github.com/misospace/dispatch/issues/816)) ([4c8260b](https://github.com/misospace/dispatch/commit/4c8260b111253438a08deb7a6720b18fa70a0fb9))
* **deps:** update dependency eslint (10.8.1 → 10.9.0) ([#823](https://github.com/misospace/dispatch/issues/823)) ([d9bafc4](https://github.com/misospace/dispatch/commit/d9bafc4d378ff18c0e28982013b6d972c945d30d))
* **mcp:** publish a stdio MCP server image ([#824](https://github.com/misospace/dispatch/issues/824)) ([8b1ba6c](https://github.com/misospace/dispatch/commit/8b1ba6c65566353168bf9e30daddd40d8a8842b0))


### Bug Fixes

* **api:** apply enforceRateLimit to mutating POST endpoints ([#796](https://github.com/misospace/dispatch/issues/796)) ([#819](https://github.com/misospace/dispatch/issues/819)) ([3ff68ee](https://github.com/misospace/dispatch/commit/3ff68ee3836c41f42bc711672d934df9694c228f))
* **deps:** update dependency @testing-library/user-event (14.6.5 → 14.6.6) ([#828](https://github.com/misospace/dispatch/issues/828)) ([5e495fb](https://github.com/misospace/dispatch/commit/5e495fb620b3637b7a99ef761e11643dbbb02535))
* **deps:** update nextjs monorepo (16.3.1 → 16.3.2) ([#821](https://github.com/misospace/dispatch/issues/821)) ([31db0b7](https://github.com/misospace/dispatch/commit/31db0b7c135d2e8c7425316775733bc9eac45262))
* **github:** retry transient 429/5xx responses with exponential backoff ([#820](https://github.com/misospace/dispatch/issues/820)) ([f48c9ef](https://github.com/misospace/dispatch/commit/f48c9efa928ff8b25933750703587fc0523000e2)), closes [#795](https://github.com/misospace/dispatch/issues/795)
* **groomer:** let targeted re-groom bypass the parked-issue exclusion ([#818](https://github.com/misospace/dispatch/issues/818)) ([cc17ecd](https://github.com/misospace/dispatch/commit/cc17ecd0c9d9ad5b8e269377b7b455d731ef357e)), closes [#793](https://github.com/misospace/dispatch/issues/793)
* **groomer:** persist not-ready reasons from hosted decisions ([#833](https://github.com/misospace/dispatch/issues/833)) ([bf74114](https://github.com/misospace/dispatch/commit/bf74114e80e5bfd44be3e3449da342e806153078))
* **lease:** make upsertLease atomic against the (agentName, issueId) unique constraint ([#826](https://github.com/misospace/dispatch/issues/826)) ([b4adce6](https://github.com/misospace/dispatch/commit/b4adce648553730012ca6010feba4adf0dd5fc5f)), closes [#797](https://github.com/misospace/dispatch/issues/797)
* **mcp:** ship only the server's import closure ([#825](https://github.com/misospace/dispatch/issues/825)) ([e4eaba8](https://github.com/misospace/dispatch/commit/e4eaba8aa5267df430ddc920f9672a05ee94b1e1))
* **security:** remove unsafe inline scripts from CSP ([#829](https://github.com/misospace/dispatch/issues/829)) ([3c0d642](https://github.com/misospace/dispatch/commit/3c0d642987acacbfa8185fe3c3712c89fe347f64)), closes [#798](https://github.com/misospace/dispatch/issues/798)
* **sync:** lock pr follow-up and reconciliation jobs ([#822](https://github.com/misospace/dispatch/issues/822)) ([0d1c2a8](https://github.com/misospace/dispatch/commit/0d1c2a87d70ad330e6535b8acb7c6de78ca8538f)), closes [#801](https://github.com/misospace/dispatch/issues/801)


### Documentation

* **env:** align .env.example scheduler defaults with scheduler.ts ([#827](https://github.com/misospace/dispatch/issues/827)) ([d44b12c](https://github.com/misospace/dispatch/commit/d44b12c35deeb51f5593d83361101718017e20f2)), closes [#802](https://github.com/misospace/dispatch/issues/802)

## [0.5.40](https://github.com/misospace/dispatch/compare/v0.5.39...v0.5.40) (2026-08-19)


### Features

* **pr-fix:** surface blocked handoffs ([#815](https://github.com/misospace/dispatch/issues/815)) ([94229af](https://github.com/misospace/dispatch/commit/94229af0d8952b70fa3ac94781d598f3199a6343))


### Bug Fixes

* **api:** align bridge issue number payloads ([#813](https://github.com/misospace/dispatch/issues/813)) ([ef065b6](https://github.com/misospace/dispatch/commit/ef065b67f81dd103c361495065f6a47b3a75115f))
* **board:** scroll the columns sideways instead of wrapping Done ([#814](https://github.com/misospace/dispatch/issues/814)) ([be394b5](https://github.com/misospace/dispatch/commit/be394b554f76acfe5bf4eab5e34eda31b1dbbd04))
* **helm:** point liveness/readiness probes at /api/health ([#810](https://github.com/misospace/dispatch/issues/810)) ([ea3fff7](https://github.com/misospace/dispatch/commit/ea3fff7eadf92ce47fa9c9821fae0d242175888f)), closes [#800](https://github.com/misospace/dispatch/issues/800)

## [0.5.39](https://github.com/misospace/dispatch/compare/v0.5.38...v0.5.39) (2026-08-19)


### Features

* **deps:** update dependency lucide-react (1.30.0 → 1.31.0) ([#753](https://github.com/misospace/dispatch/issues/753)) ([6737737](https://github.com/misospace/dispatch/commit/6737737ca59a6788a4a11851215e866a8e0a3726))
* **deps:** update dependency lucide-react (1.31.0 → 1.32.0) ([#789](https://github.com/misospace/dispatch/issues/789)) ([09e8098](https://github.com/misospace/dispatch/commit/09e809876077024bacba4acd2b726b8f89f4258c))
* **deps:** update dependency lucide-react (1.32.0 → 1.33.0) ([#805](https://github.com/misospace/dispatch/issues/805)) ([baa0c3d](https://github.com/misospace/dispatch/commit/baa0c3d1d652435b60fe4344890779f3f45fdaf4))
* **groomer:** attribute hosted groomer aborts to pool member ([#779](https://github.com/misospace/dispatch/issues/779)) ([259952f](https://github.com/misospace/dispatch/commit/259952f28e239ce8af690a5057f5532a139c4290)), closes [#747](https://github.com/misospace/dispatch/issues/747)
* **helm:** update chart common (5.0.1 → 5.1.0) ([#773](https://github.com/misospace/dispatch/issues/773)) ([3a4b140](https://github.com/misospace/dispatch/commit/3a4b140965c4f4efecd22c6ce20e7f7b1a57a291))


### Bug Fixes

* **build:** pin NODE_ENV=production in the build script ([#768](https://github.com/misospace/dispatch/issues/768)) ([c03c0b9](https://github.com/misospace/dispatch/commit/c03c0b987bbfde909db673b5404782ba9f96322b))
* **deps:** override deepmerge-ts to clear GHSA-ggr8-5vv4-36mx ([#785](https://github.com/misospace/dispatch/issues/785)) ([e53a6ec](https://github.com/misospace/dispatch/commit/e53a6ecdf020dfbca37e663872a68f0da584776d))
* **deps:** update dependency @testing-library/jest-dom (7.0.0 → 7.0.1) ([#755](https://github.com/misospace/dispatch/issues/755)) ([7f7ccb8](https://github.com/misospace/dispatch/commit/7f7ccb87d46289a636c545ea39a764a7bbad1ad5))
* **deps:** update dependency @testing-library/user-event (14.6.3 → 14.6.4) ([#760](https://github.com/misospace/dispatch/issues/760)) ([a3a9ee5](https://github.com/misospace/dispatch/commit/a3a9ee5dd5313d69f428009351ed4c291b44a275))
* **deps:** update dependency @testing-library/user-event (14.6.4 → 14.6.5) ([#787](https://github.com/misospace/dispatch/issues/787)) ([b4efe45](https://github.com/misospace/dispatch/commit/b4efe45c4344b131871a8ada5ef351451feb6f92))
* **deps:** update dependency tsx (4.23.11 → 4.23.12) ([#756](https://github.com/misospace/dispatch/issues/756)) ([d2e218c](https://github.com/misospace/dispatch/commit/d2e218c2f30cc4ff0f878b773b5b191aaf13b72d))
* **deps:** update nextjs monorepo (16.3.0 → 16.3.1) ([#767](https://github.com/misospace/dispatch/issues/767)) ([0aa4c84](https://github.com/misospace/dispatch/commit/0aa4c840654793577ccad01fffb34eecdc888308))
* **deps:** update vitest monorepo (4.1.10 → 4.1.11) ([#790](https://github.com/misospace/dispatch/issues/790)) ([59623e6](https://github.com/misospace/dispatch/commit/59623e604079da6fda0d6791b6865c9dceed01af))
* implement fail-closed webhook signature verification ([#752](https://github.com/misospace/dispatch/issues/752)) ([305ba55](https://github.com/misospace/dispatch/commit/305ba55f729358aab17c01bc30758bbd571bf81d)), closes [#717](https://github.com/misospace/dispatch/issues/717)
* **pr-followup-webhook:** reject GitHub deliveries on HMAC before authorizeRequest ([#761](https://github.com/misospace/dispatch/issues/761)) ([#782](https://github.com/misospace/dispatch/issues/782)) ([9399d61](https://github.com/misospace/dispatch/commit/9399d61e415dec03529dc42e1d62a77d4f58e25e))


### Chores

* **deps:** lock file maintenance ([#757](https://github.com/misospace/dispatch/issues/757)) ([dc1e758](https://github.com/misospace/dispatch/commit/dc1e7589f6b78cad9cff4ad3a4a5dc5bb84591c3))
* **deps:** lock file maintenance ([#778](https://github.com/misospace/dispatch/issues/778)) ([96e90c9](https://github.com/misospace/dispatch/commit/96e90c9cd3df0433ca8bbf1b4147cca684be2ebe))


### Documentation

* issue contract for the autonomous loop (template + AGENTS.md) ([#759](https://github.com/misospace/dispatch/issues/759)) ([9d4d4db](https://github.com/misospace/dispatch/commit/9d4d4dbb19dff78ee11ab439bf749ac8c9b44bc7))


### Refactors

* **github:** split client by domain ([#766](https://github.com/misospace/dispatch/issues/766)) ([6f9cf5b](https://github.com/misospace/dispatch/commit/6f9cf5b42becc2b022347ba2ed04f6c141b7c02d))
