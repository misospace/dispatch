# Changelog

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
