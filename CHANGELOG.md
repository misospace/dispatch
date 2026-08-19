# Changelog

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
