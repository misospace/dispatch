# Licensing and corresponding source

Dispatch is licensed under [AGPL-3.0-only](../LICENSE). Commercial and private use are permitted under its terms. Independent third-party components retain their respective licenses.

Distributors must convey required notices and complete corresponding source under the applicable licenses. Operators of modified versions supporting remote network interaction must prominently offer the actual deployed version's corresponding source to remote users at no charge under AGPL section 13. Provide the exact deployed modifications, required build and installation scripts and other required corresponding source; linking upstream main is not sufficient for a modified deployment. No secrets or unrelated repositories need to be published.

Canonical source: https://github.com/misospace/dispatch. Match releases to their exact source revision. Image license metadata describes Dispatch, not the independent OS packages or tools packaged with it.

The Prisma CLI runs separately for database migrations. Its Studio dependency includes elkjs 0.11.1 (EPL-2.0); no direct Dispatch source imports of elkjs or @prisma/studio-core were found in the migration audit. Preserve its independent license and review whether Studio can be excluded from shipped images or updated through a supported Prisma release. A dependency-tree relationship alone does not establish a combined work or complete redistribution compliance.

Automating version-specific source offers and verifying actual published artifacts are separate follow-up work, not completed by this license declaration.
