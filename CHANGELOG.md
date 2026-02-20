## [1.1.1](https://github.com/NicolasTobias/cloudflare-switchover/compare/v1.1.0...v1.1.1) (2026-02-20)


### Bug Fixes

* **k8s:** add DOMAIN_RECORDS with real values to prod overlay ([126eec1](https://github.com/NicolasTobias/cloudflare-switchover/commit/126eec12a98c317191e71d6b1a1058b93d160572))
* **k8s:** add real DOMAIN_RECORDS to prod overlay and show version in startup notification ([d3f9356](https://github.com/NicolasTobias/cloudflare-switchover/commit/d3f9356f8daeeb74b21b8af6b248da42e60f30cf))

# [1.1.0](https://github.com/NicolasTobias/cloudflare-switchover/compare/v1.0.2...v1.1.0) (2026-02-20)


### Features

* state machine, CF trace verification, and content-based health checks ([5b3b22a](https://github.com/NicolasTobias/cloudflare-switchover/commit/5b3b22a65b170317454f0dd271c5a753c2b9f14d))

## [1.0.2](https://github.com/NicolasTobias/cloudflare-switchover/compare/v1.0.1...v1.0.2) (2026-02-19)


### Bug Fixes

* new secrets ([9abb390](https://github.com/NicolasTobias/cloudflare-switchover/commit/9abb390742eeb4b3b46785c11d6cae48b6c0bc02))

## [1.0.1](https://github.com/NicolasTobias/cloudflare-switchover/compare/v1.0.0...v1.0.1) (2026-02-19)


### Bug Fixes

* **k8s:** deploy to monitoring namespace ([b8102a7](https://github.com/NicolasTobias/cloudflare-switchover/commit/b8102a7de5367d10edd7c566bd35bf9d8e453b26))

# 1.0.0 (2026-02-19)


### Bug Fixes

* add solution to multiple domaisn ([be038f3](https://github.com/NicolasTobias/cloudflare-switchover/commit/be038f34bc17420b1f3c615b13e5245f2ba5a770))
* **ci:** bump Node to 22 in release workflow ([ca6f5f8](https://github.com/NicolasTobias/cloudflare-switchover/commit/ca6f5f85ffa97671465516c0b939481989c6c644))
* DOMAIN_RECORDS via shell env to avoid .env quoting issue ([6592b10](https://github.com/NicolasTobias/cloudflare-switchover/commit/6592b109924f30db28d2fde2e9dc652c71dcef1e))
* regenerate package-lock.json with missing dependencies ([4094871](https://github.com/NicolasTobias/cloudflare-switchover/commit/4094871f59f0082ab7af00b46614e8d7ae0d56bc))


### Features

* add start.sh to export DOMAIN_RECORDS and launch compose ([9b65131](https://github.com/NicolasTobias/cloudflare-switchover/commit/9b6513104daafc3fb38aba25daf7c115b368e702))
* ArgoCD application manifest ([c92bb4f](https://github.com/NicolasTobias/cloudflare-switchover/commit/c92bb4f0daa87958f00f9570536d9bcc5bee477b))
* core switchover service ([1c5b3e6](https://github.com/NicolasTobias/cloudflare-switchover/commit/1c5b3e6768008d8671d0b10628141094a1fcbacc))
* Dockerfile and docker-compose for local development ([3d55d12](https://github.com/NicolasTobias/cloudflare-switchover/commit/3d55d12abc6ca6bf1672891eb63a8274890fb35a))
* k8s manifests with kustomize base and prod overlay ([16228bd](https://github.com/NicolasTobias/cloudflare-switchover/commit/16228bd9229749e54ab9df8c67f7867b602e7024))
* **nginx:** add elpapeo.com server block ([4cacf58](https://github.com/NicolasTobias/cloudflare-switchover/commit/4cacf58deca305f4f59a0c85552e38d0ff54206b))
* **nginx:** docker-compose and Let's Encrypt cert init script ([8ab8ba0](https://github.com/NicolasTobias/cloudflare-switchover/commit/8ab8ba01d592d20f0fe1977f3cf4c352d1c46cfe))
* **nginx:** proxy HTTPS via origin subdomain instead of direct IP ([eacc404](https://github.com/NicolasTobias/cloudflare-switchover/commit/eacc404bc9717d09d9ce81690abf0989a42643f3))
* support Telegram thread_id for supergroup topics ([7810568](https://github.com/NicolasTobias/cloudflare-switchover/commit/78105687388860f04137c434919055196669e7aa))
